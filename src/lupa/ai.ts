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
    case 'seer':      return decideSeerNight(state, player, rng)
    case 'bodyguard':  return decideBodyguardNight(state, player, rng)
    case 'werewolf':   return decideWerewolfNight(state, player, rng)
    default:           return { type: 'none' }
  }
}

// ---- 占い師 ----
// 自分以外の生存者から選択。未占い者を優先、全員占い済みなら既占いも可。
function decideSeerNight(state: GameState, seer: PlayerState, rng: Rng): NightAction {
  const all = alivePlayersExcept(state, seer.seat)
  if (all.length === 0) return { type: 'none' }
  const divined = new Set(Array.from(seer.divineHistory.values()).map(d => d.target))
  const undivined = all.filter(p => !divined.has(p.seat))
  const candidates = undivined.length > 0 ? undivined : all
  return { type: 'divine', target: rng.pick(candidates).seat }
}

// ---- 狩人 ----
// 占いCO者を優先。前夜と同一対象の連続護衛は不可。
function decideBodyguardNight(state: GameState, guard: PlayerState, rng: Rng): NightAction {
  const all = alivePlayersExcept(state, guard.seat)
  // 前夜の護衛先を除外（連続護衛不可）
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
// 非狼生存者を襲撃。能力者CO者を50%で優先。
function decideWerewolfNight(state: GameState, wolf: PlayerState, rng: Rng): NightAction {
  const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
  if (aliveWolves[0].seat !== wolf.seat) return { type: 'none' }

  const wolfSeats = new Set(aliveWolves.map(w => w.seat))
  const candidates = alivePlayers(state).filter(p => !wolfSeats.has(p.seat))

  // 50% で能力者CO者を優先
  if (rng.next() < 0.5) {
    const claimers = candidates.filter(p => p.claimedRole !== null)
    if (claimers.length > 0) return { type: 'attack', target: rng.pick(claimers).seat }
  }
  return { type: 'attack', target: rng.pick(candidates).seat }
}

// ============================================================
// 昼CO
// ============================================================

export function decideDayClaim(
  state: GameState, player: PlayerState, day: number,
  lastExecutedSeat: number | null, rng: Rng,
): DayClaim {
  switch (player.role) {
    case 'seer':      return decideSeerClaim(state, player, day, rng)
    case 'possessed':  return decidePossessedClaim(state, player, day, rng)
    case 'medium':     return decideMediumClaim(state, player, day, lastExecutedSeat, rng)
    default:           return { type: 'none' }
  }
}

// ---- 占い師 ----
// Day1: 80%でCO。Day2: 未COなら必ずCO。CO済みなら毎日結果報告。
function decideSeerClaim(
  _state: GameState, seer: PlayerState, day: number, rng: Rng,
): DayClaim {
  if (seer.claimedRole === 'seer') {
    // CO済み → 最新結果を報告
    const latest = seer.divineHistory.get(day - 1)
    if (!latest) return { type: 'none' }
    return { type: 'seer_result', target: latest.target, result: latest.result }
  }

  // 未CO → COするか判断
  const shouldCO = day >= 2 || rng.next() < 0.8
  if (!shouldCO) return { type: 'none' }

  const results = Array.from(seer.divineHistory.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ target: v.target, result: v.result }))
  return { type: 'seer_co', results }
}

// ---- 狂人 ----
// Day1: 70%で偽占いCO。Day2: 未COなら必ずCO。
// 偽結果はCO時に生成（狼→○、非狼→ランダムに●）。
function decidePossessedClaim(
  state: GameState, possessed: PlayerState, day: number, rng: Rng,
): DayClaim {
  if (possessed.claimedRole === 'seer') {
    // CO済み → 最新偽結果を生成して報告
    const night = day - 1
    generateFakeResult(state, possessed, night, rng)
    const latest = possessed.fakeDivineHistory.get(night)
    if (!latest) return { type: 'none' }
    return { type: 'seer_result', target: latest.target, result: latest.result }
  }

  // 未CO → COするか判断
  const shouldCO = day >= 2 || rng.next() < 0.7
  if (!shouldCO) return { type: 'none' }

  // CO: これまでの夜分の偽結果をまとめて生成
  for (let n = 0; n < day; n++) {
    if (!possessed.fakeDivineHistory.has(n)) {
      generateFakeResult(state, possessed, n, rng)
    }
  }
  const results = Array.from(possessed.fakeDivineHistory.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ target: v.target, result: v.result }))
  return { type: 'seer_co', results }
}

/** 偽占い結果を1夜分生成: 狼→○、非狼→● */
function generateFakeResult(
  state: GameState, possessed: PlayerState, night: number, rng: Rng,
): void {
  if (possessed.fakeDivineHistory.has(night)) return
  const divined = new Set(Array.from(possessed.fakeDivineHistory.values()).map(d => d.target))
  const candidates = alivePlayersExcept(state, possessed.seat).filter(p => !divined.has(p.seat))
  if (candidates.length === 0) return

  const target = rng.pick(candidates)
  const result: EnumSpecies = target.role === 'werewolf' ? 'human' : 'wolf'
  possessed.fakeDivineHistory.set(night, { target: target.seat, result })
}

// ---- 霊能者 ----
// Day1: 80%でCO。Day2: 未COなら必ずCO。CO済みなら毎日結果報告。
function decideMediumClaim(
  state: GameState, _medium: PlayerState, day: number,
  lastExecutedSeat: number | null, rng: Rng,
): DayClaim {
  if (_medium.claimedRole === 'medium') {
    // CO済み → 結果報告
    if (lastExecutedSeat !== null) {
      const target = state.players.find(p => p.seat === lastExecutedSeat)!
      const result = getMediumResult(target.role)
      return { type: 'medium_result', result }
    }
    return { type: 'none' }
  }

  // 未CO → COするか判断
  const shouldCO = day >= 2 || rng.next() < 0.8
  if (!shouldCO) return { type: 'none' }

  return { type: 'medium_co' }
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
    // 自分以外の占いCO者 → 対抗 = 真占い候補
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

export function resolveVotes(votes: Map<number, number>): number {
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
  return Math.min(...maxTargets)
}
