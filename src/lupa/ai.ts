import type { EnumSpecies } from '../types/index.ts'
import type { GameState, PlayerState, NightAction, DayClaim } from './types.ts'
import { alivePlayers, alivePlayersExcept, getMediumResult } from './roles.ts'
import type { Rng } from './random.ts'

// ============================================================
// 夜アクション
// ============================================================

export function decideNightAction(
  state: GameState, player: PlayerState, _night: number, rng: Rng,
): NightAction {
  switch (player.role) {
    case 'seer':      return decideSeerNight(state, player, _night, rng)
    case 'bodyguard':  return decideBodyguardNight(state, player, rng)
    case 'werewolf':   return decideWerewolfNight(state, player, rng)
    default:           return { type: 'none' }
  }
}

// ---- 占い師 ----
function decideSeerNight(state: GameState, seer: PlayerState, night: number, rng: Rng): NightAction {
  const all = alivePlayersExcept(state, seer.seat)
  if (all.length === 0) return { type: 'none' }

  // 予告先が生存していればそちらを占う
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

// ---- 狩人 ----
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

// ---- 人狼 ----
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
// 昼CO
// ============================================================

const CO_PROBABILITY = 0.4

export function decideDayClaim(
  state: GameState, player: PlayerState, day: number,
  lastExecutedSeat: number | null, rng: Rng,
): DayClaim {
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

// ---- 占い師 (真) ----
// 毎日40%でCO。CO済みなら結果報告。
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

// ---- 霊能者 (真) ----
// 毎日40%でCO。CO済みなら結果報告。
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

  // CO時に過去の処刑結果をまとめて報告
  const pastResults = collectPastMediumResults(state, day)
  return { type: 'medium_co', pastResults }
}

/** 過去の処刑者の霊能結果を収集（真霊能用） */
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

/** 過去の処刑者の偽霊能結果を生成 */
function collectFakeMediumResults(state: GameState, day: number, rng: Rng): EnumSpecies[] {
  const results: EnumSpecies[] = []
  for (let d = 1; d < day; d++) {
    if (!state.executionHistory.has(d)) continue
    results.push(rng.next() < 0.5 ? 'human' : 'wolf')
  }
  return results
}

// ---- 狂人 ----
// 毎日40%で偽占いCO。
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

// ---- 人狼 ----
// 20%で偽CO。偽占いか偽霊能をランダムに選択。
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

// ---- 妖狐 ----
// 20%で偽CO。偽占いか偽霊能をランダムに選択。
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

// ---- 狩人 ----
// 10%でCO。
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

// ---- 共有者 ----
// 40%でCO。相方を宣言。
function decideMasonClaim(
  state: GameState, mason: PlayerState, _day: number, rng: Rng,
): DayClaim {
  if (mason.claimedRole) return { type: 'none' }

  if (rng.next() >= CO_PROBABILITY) return { type: 'none' }

  // 相方を探す
  const partner = state.players.find(p =>
    p.seat !== mason.seat && p.role === 'mason'
  )
  if (!partner) return { type: 'none' }
  return { type: 'mason_co', partner: partner.seat }
}

// ---- 猫又 ----
// 10%でCO。
function decideNekomataClam(
  _state: GameState, neko: PlayerState, _day: number, rng: Rng,
): DayClaim {
  if (neko.claimedRole) return { type: 'none' }
  if (rng.next() >= 0.1) return { type: 'none' }
  return { type: 'nekomata_co' }
}

// ============================================================
// 占い予告
// ============================================================

const FORECAST_PROBABILITY = 0.3

/** 占いCO済みプレイヤーが予告するか決定 */
export function decideForecast(
  state: GameState, player: PlayerState, rng: Rng,
): DayClaim {
  if (player.claimedRole !== 'seer') return { type: 'none' }
  if (rng.next() >= FORECAST_PROBABILITY) return { type: 'none' }

  const all = alivePlayersExcept(state, player.seat)
  if (all.length === 0) return { type: 'none' }

  // 真占い師: 未占い先を優先
  // 偽占い師: ランダム
  const history = player.role === 'seer' ? player.divineHistory : player.fakeDivineHistory
  const divined = new Set(Array.from(history.values()).map(d => d.target))
  const undivined = all.filter(p => !divined.has(p.seat))
  const candidates = undivined.length > 0 ? undivined : all

  return { type: 'forecast', target: rng.pick(candidates).seat }
}

// ============================================================
// 真役職の強制CO（対抗が出た場合）
// ============================================================

/** 対抗が出ている真役職を強制的にCOさせる */
export function forceTrueRoleCO(
  state: GameState, player: PlayerState, day: number,
  lastExecutedSeat: number | null,
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
// 偽CO共通ユーティリティ
// ============================================================

/** 偽COの役職をランダム選択（占い50%, 霊能25%, 狩人10%, 共有10%, 猫又5%） */
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

/** 偽狩人COを開始（適当な護衛先履歴を生成） */
function initFakeBodyguardCO(
  state: GameState, player: PlayerState, day: number, rng: Rng,
): DayClaim {
  player.claimedRole = 'bodyguard'
  player.claimedDay = day
  // 適当な護衛先を生成
  const targets: number[] = []
  const alive = alivePlayersExcept(state, player.seat)
  for (let n = 0; n < day; n++) {
    if (alive.length > 0) targets.push(rng.pick(alive).seat)
  }
  return { type: 'bodyguard_co', targets }
}

/** 偽共有COを開始（適当な相方を指名） */
function initFakeMasonCO(
  state: GameState, player: PlayerState, day: number, rng: Rng,
): DayClaim {
  player.claimedRole = 'mason'
  player.claimedDay = day
  // 生存者からランダムに相方を指名
  const candidates = alivePlayersExcept(state, player.seat)
  if (candidates.length === 0) return { type: 'none' }
  return { type: 'mason_co', partner: rng.pick(candidates).seat }
}

/** 偽猫又COを開始 */
function initFakeNekomataC0(player: PlayerState, day: number): DayClaim {
  player.claimedRole = 'nekomata'
  player.claimedDay = day
  return { type: 'nekomata_co' }
}

/** 偽霊能COを開始（過去結果付き） */
function initFakeMediumCO(
  state: GameState, player: PlayerState, day: number, rng: Rng,
): DayClaim {
  player.claimedRole = 'medium'
  player.claimedDay = day
  const pastResults = collectFakeMediumResults(state, day, rng)
  return { type: 'medium_co', pastResults }
}

/** 偽占いCOを開始 */
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

/** 偽占い結果を1夜分生成: 狼→○、非狼→● */
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

/** CO済み偽占い師の日次結果報告 */
function reportFakeSeerResult(
  state: GameState, player: PlayerState, day: number, rng: Rng,
): DayClaim {
  const night = day - 1
  generateFakeDivineResult(state, player, night, rng)
  const latest = player.fakeDivineHistory.get(night)
  if (!latest) return { type: 'none' }
  return { type: 'seer_result', target: latest.target, result: latest.result }
}

/** CO済み偽霊能者の日次結果報告 */
function reportFakeMediumResult(
  _state: GameState, lastExecutedSeat: number | null, rng: Rng,
): DayClaim {
  if (lastExecutedSeat === null) return { type: 'none' }
  // ランダムに○か●
  const result: EnumSpecies = rng.next() < 0.5 ? 'human' : 'wolf'
  return { type: 'medium_result', result }
}

// ============================================================
// 投票
// ============================================================

export function decideVote(
  state: GameState, voter: PlayerState, rng: Rng,
): number {
  const candidates = alivePlayersExcept(state, voter.seat)

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

// 人狼: 仲間以外に投票。50%で能力者CO者を優先。
function decideWerewolfVote(candidates: PlayerState[], rng: Rng): number {
  const nonWolves = candidates.filter(p => p.role !== 'werewolf')
  const pool = nonWolves.length > 0 ? nonWolves : candidates

  if (rng.next() < 0.5) {
    const claimers = pool.filter(p => p.claimedRole !== null)
    if (claimers.length > 0) return rng.pick(claimers).seat
  }
  return rng.pick(pool).seat
}

// 狂人: 占い対抗者(真占い)に50%で投票。いなければランダム。
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

// その他: 黒出し先に70%で投票。いなければランダム。
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
// 投票集計
// ============================================================

/** 投票結果を集計。単独最多なら確定、同票なら候補リストを返す */
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
