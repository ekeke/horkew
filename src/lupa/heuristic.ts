import type { EnumSpecies } from '../types/index.ts'
import type { GameState, PlayerState, NightAction, DayClaim } from './types.ts'
import type { Signal, CommunicationAction } from './communication.ts'
import type { Proposal, LeadershipResponse } from './leadership.ts'
import type { Strategy, DecisionContext } from './strategy.ts'
import { alivePlayers, alivePlayersExcept, getMediumResult, isWerewolfAligned } from './roles.ts'
import type { Rng } from './random.ts'

const CO_PROBABILITY = 0.4
const FORECAST_PROBABILITY = 0.3

export class HeuristicStrategy implements Strategy {
  // ============================================================
  // 夜アクション
  // ============================================================

  decideNightAction(ctx: DecisionContext): NightAction {
    const { gameState: state, myPlayer: player, day, rng } = ctx
    const night = ctx.phase === 'night' ? day - 1 : day
    switch (player.role) {
      case 'seer':      return decideSeerNight(state, player, night, rng)
      case 'bodyguard':  return decideBodyguardNight(state, player, rng)
      case 'werewolf':   return decideWerewolfNight(state, player, rng)
      default:           return { type: 'none' }
    }
  }

  // ============================================================
  // 昼CO
  // ============================================================

  decideDayClaim(ctx: DecisionContext): DayClaim {
    const { gameState: state, myPlayer: player, day, lastExecutedSeat, rng } = ctx
    switch (player.role) {
      case 'seer':
        return decideSeerClaim(state, player, day, rng)
      case 'medium':
        return decideMediumClaim(state, player, day, lastExecutedSeat, rng)
      case 'possessed':
        return decideFakeSeerClaim(state, player, day, rng)
      case 'werewolf':
        return decideWerewolfClaim(state, player, day, lastExecutedSeat, rng)
      case 'werehamster':
        return decideWerehamsterClaim(state, player, day, lastExecutedSeat, rng)
      case 'bodyguard':
        return decideBodyguardClaim(state, player, day, rng)
      case 'fanatic':
        return decideFakeSeerClaim(state, player, day, rng)
      case 'immoralist':
        return decideWerehamsterClaim(state, player, day, lastExecutedSeat, rng)
      case 'mason':
        return decideMasonClaim(state, player, day, rng)
      case 'nekomata':
        return decideNekomataClam(state, player, day, rng)
      default:
        return { type: 'none' }
    }
  }

  // ============================================================
  // 予告
  // ============================================================

  decideForecast(ctx: DecisionContext): DayClaim {
    const { gameState: state, myPlayer: player, rng } = ctx
    if (player.claimedRole !== 'seer') return { type: 'none' }
    if (rng.next() >= FORECAST_PROBABILITY) return { type: 'none' }

    const all = alivePlayersExcept(state, player.seat)
    if (all.length === 0) return { type: 'none' }

    const history = player.role === 'seer' ? player.divineHistory : player.fakeDivineHistory
    const divined = new Set(Array.from(history.values()).map(d => d.target))
    const undivined = all.filter(p => !divined.has(p.seat))
    const candidates = undivined.length > 0 ? undivined : all

    return { type: 'forecast', target: rng.pick(candidates).seat }
  }

  // ============================================================
  // 投票
  // ============================================================

  decideVote(ctx: DecisionContext): number {
    const { gameState: state, myPlayer: voter, rng, proposals } = ctx
    const candidates = alivePlayersExcept(state, voter.seat)

    // 指揮者の処刑指示がある場合、陣営に応じた確率で従う
    const executeOrder = proposals.find(p => p.type === 'execute_order')
    if (executeOrder) {
      const target = candidates.find(p => p.seat === executeOrder.target)
      if (target) {
        const followRate = getFollowRate(voter.role)
        if (rng.next() < followRate) return target.seat
      }
    }

    switch (voter.role) {
      case 'werewolf':
        return decideWerewolfVote(candidates, rng)
      case 'possessed':
      case 'fanatic':
        return decidePossessedVote(candidates, voter, rng)
      default:
        return decideDefaultVote(state, candidates, rng)
    }
  }

  // ============================================================
  // コミュニケーション
  // ============================================================

  decideCommunication(ctx: DecisionContext): CommunicationAction {
    const { gameState: state, myPlayer: player, rng, signals, day } = ctx
    const others = alivePlayersExcept(state, player.seat)
    const noAction: CommunicationAction = { signal: { type: 'no_signal' }, proposals: [] }

    // === propose head: 処刑提案 ===
    const proposals: number[] = []

    // 黒出し先を処刑提案
    const blackTargets = collectBlackTargets(state)
    const aliveBlacks = others.filter(p => blackTargets.has(p.seat))
    if (aliveBlacks.length > 0 && rng.next() < 0.6) {
      for (const p of aliveBlacks) proposals.push(p.seat)
    }

    // 霊能ローラー: 霊能CO者が2人以上いたら全員提案
    const mediumClaimers = others.filter(p => p.claimedRole === 'medium')
    if (mediumClaimers.length >= 2 && rng.next() < 0.5) {
      for (const p of mediumClaimers) {
        if (!proposals.includes(p.seat)) proposals.push(p.seat)
      }
    }

    // === comm head: シグナル ===

    // PP判定: 狼陣営が生存者の過半数
    if (player.role === 'werewolf') {
      const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf').length
      const aliveTotal = alivePlayers(state).length
      const aliveFoxes = alivePlayers(state).filter(p => p.role === 'werehamster').length
      if (aliveWolves >= aliveTotal - aliveWolves - aliveFoxes && rng.next() < 0.8) {
        return { signal: { type: 'werewolf_co' }, proposals }
      }
    }

    // LWCO: 最後の狼 & day > 3
    if (player.role === 'werewolf' && day > 3) {
      const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
      if (aliveWolves.length === 1 && aliveWolves[0].seat === player.seat && rng.next() < 0.1) {
        return { signal: { type: 'werewolf_co' }, proposals }
      }
    }

    // demand_wolf_co: 村陣営 & day > 3
    if (!isWerewolfAligned(player.role) && player.role !== 'werehamster' && player.role !== 'immoralist' && day > 3) {
      if (rng.next() < 0.1) {
        return { signal: { type: 'demand_wolf_co' }, proposals }
      }
    }

    // 後半ラウンド: 既存シグナルに反応 (agree/disagree with target)
    if (signals.length > 0 && rng.next() < 0.3) {
      const targetSignal = rng.pick(signals)
      const signal: Signal = rng.next() < 0.6
        ? { type: 'agree', target: targetSignal.sender }
        : { type: 'disagree', target: targetSignal.sender }
      return { signal, proposals }
    }

    // 狼陣営: ランダムsuspicionか沈黙
    if (isWerewolfAligned(player.role)) {
      if (rng.next() < 0.3) {
        const candidates = others.filter(p => p.role !== 'werewolf')
        if (candidates.length > 0) {
          return { signal: { type: 'suspicion', target: rng.pick(candidates).seat }, proposals }
        }
      }
      return { ...noAction, proposals }
    }

    // accuse_wolf: 黒出し先を狼告発
    if (aliveBlacks.length > 0 && rng.next() < 0.15) {
      return { signal: { type: 'accuse_wolf', target: rng.pick(aliveBlacks).seat }, proposals }
    }

    // accuse_fox: 狼CO後のLWCO支援
    const wolfCOExists = state.players.some(p => p.alive && p.claimedRole === 'werewolf')
    if (wolfCOExists && rng.next() < 0.2 && others.length > 0) {
      return { signal: { type: 'accuse_fox', target: rng.pick(others).seat }, proposals }
    }

    // vote_intent: 投票先を事前宣言
    if (rng.next() < 0.15 && others.length > 0) {
      return { signal: { type: 'vote_intent', target: rng.pick(others).seat }, proposals }
    }

    // 占いCO者を信用するシグナル
    const seerClaimers = others.filter(p => p.claimedRole === 'seer')
    if (seerClaimers.length === 1 && rng.next() < 0.3) {
      return { signal: { type: 'trust', target: seerClaimers[0].seat }, proposals }
    }

    return { ...noAction, proposals }
  }

  // ============================================================
  // 指揮者提案
  // ============================================================

  decideProposal(ctx: DecisionContext): Proposal | null {
    const { gameState: state, myPlayer: player, rng } = ctx
    if (ctx.commander !== player.seat) return null

    // 黒出し先がいれば処刑指示
    const blackTargets = collectBlackTargets(state)
    const aliveBlacks = alivePlayersExcept(state, player.seat)
      .filter(p => blackTargets.has(p.seat))
    if (aliveBlacks.length > 0) {
      return { type: 'execute_order', target: rng.pick(aliveBlacks).seat }
    }

    // CO者の中で怪しい人を処刑指示
    const suspicious = alivePlayersExcept(state, player.seat)
      .filter(p => p.claimedRole !== null)
    if (suspicious.length > 0 && rng.next() < 0.4) {
      return { type: 'execute_order', target: rng.pick(suspicious).seat }
    }

    return null
  }

  // ============================================================
  // 指揮者への対応
  // ============================================================

  decideLeadershipResponse(ctx: DecisionContext, _proposal: Proposal): LeadershipResponse {
    const { myPlayer: player, rng } = ctx
    const followRate = getFollowRate(player.role)
    if (rng.next() < followRate) return 'follow'
    return 'defy'
  }
}

// ============================================================
// 指揮者追従率
// ============================================================

function getFollowRate(role: string): number {
  switch (role) {
    case 'werewolf':
    case 'possessed':
    case 'fanatic':
      return 0.3
    case 'werehamster':
    case 'immoralist':
      return 0.5
    default:
      return 0.8
  }
}

// ============================================================
// 夜アクション（内部）
// ============================================================

function decideSeerNight(state: GameState, seer: PlayerState, _night: number, rng: Rng): NightAction {
  const all = alivePlayersExcept(state, seer.seat)
  if (all.length === 0) return { type: 'none' }

  const forecastTarget = seer.forecastTarget
  if (forecastTarget != null) {
    const target = all.find(p => p.seat === forecastTarget)
    if (target) return { type: 'divine', target: target.seat }
  }

  const divined = new Set(Array.from(seer.divineHistory.values()).map(d => d.target))
  const undivined = all.filter(p => !divined.has(p.seat))
  const candidates = undivined.length > 0 ? undivined : all
  return { type: 'divine', target: rng.pick(candidates).seat }
}

function decideBodyguardNight(state: GameState, guard: PlayerState, rng: Rng): NightAction {
  const all = alivePlayersExcept(state, guard.seat)
  const lastNight = Math.max(...Array.from(guard.guardHistory.keys()), -1)
  const lastTarget = guard.guardHistory.get(lastNight)
  const eligible = lastTarget !== undefined
    ? all.filter(p => p.seat !== lastTarget)
    : all
  const candidates = eligible.length > 0 ? eligible : all

  const seerClaimers = candidates.filter(p => p.claimedRole === 'seer')
  if (seerClaimers.length > 0) return { type: 'guard', target: rng.pick(seerClaimers).seat }
  return { type: 'guard', target: rng.pick(candidates).seat }
}

function decideWerewolfNight(state: GameState, wolf: PlayerState, rng: Rng): NightAction {
  const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
  if (aliveWolves[0].seat !== wolf.seat) return { type: 'none' }

  const wolfSeats = new Set(aliveWolves.map(w => w.seat))
  const candidates = alivePlayers(state).filter(p => !wolfSeats.has(p.seat))

  if (rng.next() < 0.5) {
    const claimers = candidates.filter(p => p.claimedRole !== null)
    if (claimers.length > 0) return { type: 'attack', target: rng.pick(claimers).seat }
  }
  return { type: 'attack', target: rng.pick(candidates).seat }
}

// ============================================================
// 昼CO（内部）
// ============================================================

function decideSeerClaim(
  _state: GameState, seer: PlayerState, day: number, rng: Rng,
): DayClaim {
  if (seer.claimedRole === 'seer') {
    const latest = seer.divineHistory.get(day - 1)
    if (!latest) return { type: 'none' }
    return { type: 'seer_result', target: latest.target, result: latest.result }
  }

  if (rng.next() >= CO_PROBABILITY) return { type: 'none' }

  const results = Array.from(seer.divineHistory.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ target: v.target, result: v.result }))
  return { type: 'seer_co', results }
}

function decideMediumClaim(
  state: GameState, medium: PlayerState, day: number,
  lastExecutedSeat: number | null, rng: Rng,
): DayClaim {
  if (medium.claimedRole === 'medium') {
    if (lastExecutedSeat !== null) {
      const target = state.players.find(p => p.seat === lastExecutedSeat)!
      const result = getMediumResult(target.role)
      return { type: 'medium_result', result }
    }
    return { type: 'none' }
  }

  if (rng.next() >= CO_PROBABILITY) return { type: 'none' }

  const pastResults = collectPastMediumResults(state, day)
  return { type: 'medium_co', pastResults }
}

function collectPastMediumResults(state: GameState, day: number): EnumSpecies[] {
  const results: EnumSpecies[] = []
  for (let d = 1; d < day; d++) {
    const seat = state.executionHistory.get(d)
    if (seat == null) continue
    const player = state.players.find(p => p.seat === seat)!
    results.push(getMediumResult(player.role))
  }
  return results
}

function collectFakeMediumResults(state: GameState, day: number, rng: Rng): EnumSpecies[] {
  const results: EnumSpecies[] = []
  for (let d = 1; d < day; d++) {
    if (!state.executionHistory.has(d)) continue
    results.push(rng.next() < 0.5 ? 'human' : 'wolf')
  }
  return results
}

function decideFakeSeerClaim(
  state: GameState, player: PlayerState, day: number, rng: Rng,
): DayClaim {
  if (player.claimedRole === 'seer') {
    return reportFakeSeerResult(state, player, day, rng)
  }

  if (rng.next() >= CO_PROBABILITY) return { type: 'none' }

  for (let n = 0; n < day; n++) {
    generateFakeDivineResult(state, player, n, rng)
  }
  const results = Array.from(player.fakeDivineHistory.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ target: v.target, result: v.result }))
  return { type: 'seer_co', results }
}

function decideWerewolfClaim(
  state: GameState, player: PlayerState, day: number,
  lastExecutedSeat: number | null, rng: Rng,
): DayClaim {
  if (player.claimedRole === 'seer') {
    return reportFakeSeerResult(state, player, day, rng)
  }
  if (player.claimedRole === 'medium') {
    return reportFakeMediumResult(state, lastExecutedSeat, rng)
  }

  if (rng.next() >= 0.2) return { type: 'none' }

  return pickFakeCO(state, player, day, rng)
}

function decideWerehamsterClaim(
  state: GameState, player: PlayerState, day: number,
  lastExecutedSeat: number | null, rng: Rng,
): DayClaim {
  if (player.claimedRole === 'seer') {
    return reportFakeSeerResult(state, player, day, rng)
  }
  if (player.claimedRole === 'medium') {
    return reportFakeMediumResult(state, lastExecutedSeat, rng)
  }

  if (rng.next() >= 0.2) return { type: 'none' }

  return pickFakeCO(state, player, day, rng)
}

function decideBodyguardClaim(
  _state: GameState, guard: PlayerState, _day: number, rng: Rng,
): DayClaim {
  if (guard.claimedRole) return { type: 'none' }

  if (rng.next() >= 0.1) return { type: 'none' }

  const targets = Array.from(guard.guardHistory.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, seat]) => seat)
  return { type: 'bodyguard_co', targets }
}

function decideMasonClaim(
  state: GameState, mason: PlayerState, _day: number, rng: Rng,
): DayClaim {
  if (mason.claimedRole) return { type: 'none' }

  if (rng.next() >= CO_PROBABILITY) return { type: 'none' }

  const partner = state.players.find(p =>
    p.seat !== mason.seat && p.role === 'mason'
  )
  if (!partner) return { type: 'none' }
  return { type: 'mason_co', partner: partner.seat }
}

function decideNekomataClam(
  _state: GameState, neko: PlayerState, _day: number, rng: Rng,
): DayClaim {
  if (neko.claimedRole) return { type: 'none' }
  if (rng.next() >= 0.1) return { type: 'none' }
  return { type: 'nekomata_co' }
}

// ============================================================
// 偽CO共通ユーティリティ
// ============================================================

function pickFakeCO(
  state: GameState, player: PlayerState, day: number, rng: Rng,
): DayClaim {
  const r = rng.next()
  if (r < 0.50) return initFakeSeerCO(state, player, day, rng)
  if (r < 0.75) return initFakeMediumCO(state, player, day, rng)
  if (r < 0.85) return initFakeBodyguardCO(state, player, day, rng)
  if (r < 0.95) return initFakeMasonCO(state, player, day, rng)
  return initFakeNekomataC0(player, day)
}

function initFakeBodyguardCO(
  state: GameState, player: PlayerState, day: number, rng: Rng,
): DayClaim {
  player.claimedRole = 'bodyguard'
  player.claimedDay = day
  const targets: number[] = []
  const alive = alivePlayersExcept(state, player.seat)
  for (let n = 0; n < day; n++) {
    if (alive.length > 0) targets.push(rng.pick(alive).seat)
  }
  return { type: 'bodyguard_co', targets }
}

function initFakeMasonCO(
  state: GameState, player: PlayerState, day: number, rng: Rng,
): DayClaim {
  player.claimedRole = 'mason'
  player.claimedDay = day
  const candidates = alivePlayersExcept(state, player.seat)
  if (candidates.length === 0) return { type: 'none' }
  return { type: 'mason_co', partner: rng.pick(candidates).seat }
}

function initFakeNekomataC0(player: PlayerState, day: number): DayClaim {
  player.claimedRole = 'nekomata'
  player.claimedDay = day
  return { type: 'nekomata_co' }
}

function initFakeMediumCO(
  state: GameState, player: PlayerState, day: number, rng: Rng,
): DayClaim {
  player.claimedRole = 'medium'
  player.claimedDay = day
  const pastResults = collectFakeMediumResults(state, day, rng)
  return { type: 'medium_co', pastResults }
}

function initFakeSeerCO(
  state: GameState, player: PlayerState, day: number, rng: Rng,
): DayClaim {
  for (let n = 0; n < day; n++) {
    generateFakeDivineResult(state, player, n, rng)
  }
  const results = Array.from(player.fakeDivineHistory.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ target: v.target, result: v.result }))
  player.claimedRole = 'seer'
  player.claimedDay = day
  return { type: 'seer_co', results }
}

function generateFakeDivineResult(
  state: GameState, player: PlayerState, night: number, rng: Rng,
): void {
  if (player.fakeDivineHistory.has(night)) return
  const divined = new Set(Array.from(player.fakeDivineHistory.values()).map(d => d.target))
  const candidates = alivePlayersExcept(state, player.seat).filter(p => !divined.has(p.seat))
  if (candidates.length === 0) return

  const target = rng.pick(candidates)
  const result: EnumSpecies = target.role === 'werewolf' ? 'human' : 'wolf'
  player.fakeDivineHistory.set(night, { target: target.seat, result })
}

function reportFakeSeerResult(
  state: GameState, player: PlayerState, day: number, rng: Rng,
): DayClaim {
  const night = day - 1
  generateFakeDivineResult(state, player, night, rng)
  const latest = player.fakeDivineHistory.get(night)
  if (!latest) return { type: 'none' }
  return { type: 'seer_result', target: latest.target, result: latest.result }
}

function reportFakeMediumResult(
  _state: GameState, lastExecutedSeat: number | null, rng: Rng,
): DayClaim {
  if (lastExecutedSeat === null) return { type: 'none' }
  const result: EnumSpecies = rng.next() < 0.5 ? 'human' : 'wolf'
  return { type: 'medium_result', result }
}

// ============================================================
// 投票（内部）
// ============================================================

function decideWerewolfVote(candidates: PlayerState[], rng: Rng): number {
  const nonWolves = candidates.filter(p => p.role !== 'werewolf')
  const pool = nonWolves.length > 0 ? nonWolves : candidates

  if (rng.next() < 0.5) {
    const claimers = pool.filter(p => p.claimedRole !== null)
    if (claimers.length > 0) return rng.pick(claimers).seat
  }
  return rng.pick(pool).seat
}

function decidePossessedVote(
  candidates: PlayerState[], possessed: PlayerState, rng: Rng,
): number {
  if (rng.next() < 0.5) {
    const rivals = candidates.filter(p =>
      p.claimedRole === 'seer' && p.seat !== possessed.seat
    )
    if (rivals.length > 0) return rng.pick(rivals).seat
  }
  return rng.pick(candidates).seat
}

function decideDefaultVote(
  state: GameState, candidates: PlayerState[], rng: Rng,
): number {
  if (rng.next() < 0.7) {
    const blackTargets = collectBlackTargets(state)
    const blacks = candidates.filter(p => blackTargets.has(p.seat))
    if (blacks.length > 0) return rng.pick(blacks).seat
  }
  return rng.pick(candidates).seat
}

function collectBlackTargets(state: GameState): Set<number> {
  const targets = new Set<number>()
  for (const player of state.players) {
    if (!player.claimedRole) continue
    for (const [, d] of player.divineHistory) {
      if (d.result === 'wolf') targets.add(d.target)
    }
    for (const [, d] of player.fakeDivineHistory) {
      if (d.result === 'wolf') targets.add(d.target)
    }
  }
  return targets
}

// ============================================================
// 真役職の強制CO
// ============================================================

export function forceTrueRoleCO(
  state: GameState, player: PlayerState, _day: number,
  _lastExecutedSeat: number | null,
): DayClaim {
  switch (player.role) {
    case 'seer': {
      const results = Array.from(player.divineHistory.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ target: v.target, result: v.result }))
      return { type: 'seer_co', results }
    }
    case 'medium':
      return { type: 'medium_co' }
    case 'bodyguard': {
      const targets = Array.from(player.guardHistory.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, seat]) => seat)
      return { type: 'bodyguard_co', targets }
    }
    case 'mason': {
      const partner = state.players.find(p =>
        p.seat !== player.seat && p.role === 'mason'
      )
      if (!partner) return { type: 'none' }
      return { type: 'mason_co', partner: partner.seat }
    }
    case 'nekomata':
      return { type: 'nekomata_co' }
    default:
      return { type: 'none' }
  }
}

// ============================================================
// 投票集計（エンジン用ユーティリティ）
// ============================================================

export function resolveVotes(votes: Map<number, number>): { decided: number } | { tied: number[] } {
  const counts = new Map<number, number>()
  for (const target of votes.values()) {
    counts.set(target, (counts.get(target) ?? 0) + 1)
  }
  let maxCount = 0
  let maxTargets: number[] = []
  for (const [target, count] of counts) {
    if (count > maxCount) {
      maxCount = count
      maxTargets = [target]
    } else if (count === maxCount) {
      maxTargets.push(target)
    }
  }
  if (maxTargets.length === 1) return { decided: maxTargets[0] }
  return { tied: maxTargets.sort((a, b) => a - b) }
}
