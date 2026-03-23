import type { EnumSpecies } from '../types/index.ts'
import type { GameState, PlayerState, NightAction, DayClaim } from './types.ts'
import { alivePlayers, alivePlayersExcept, getMediumResult, isWerewolfAligned } from './roles.ts'
import type { Rng } from './random.ts'

// ==== 夜アクション ====

export function decideNightAction(
  state: GameState, player: PlayerState, _night: number, rng: Rng,
): NightAction {
  switch (player.role) {
    case 'seer':
      return decideSeerNight(state, player, rng)
    case 'bodyguard':
      return decideBodyguardNight(state, player, rng)
    case 'werewolf':
      return decideWerewolfNight(state, player, rng)
    case 'possessed':
      return decidePossessedNight(state, player, rng)
    default:
      return { type: 'none' }
  }
}

function decideSeerNight(state: GameState, seer: PlayerState, rng: Rng): NightAction {
  const divined = new Set(Array.from(seer.divineHistory.values()).map(d => d.target))
  const candidates = alivePlayersExcept(state, seer.seat).filter(p => !divined.has(p.seat))
  if (candidates.length === 0) return { type: 'none' }
  return { type: 'divine', target: rng.pick(candidates).seat }
}

function decideBodyguardNight(state: GameState, guard: PlayerState, rng: Rng): NightAction {
  const alive = alivePlayersExcept(state, guard.seat)
  const seerClaimers = alive.filter(p => p.claimedRole === 'seer')
  if (seerClaimers.length > 0) return { type: 'guard', target: rng.pick(seerClaimers).seat }
  return { type: 'guard', target: rng.pick(alive).seat }
}

function decideWerewolfNight(state: GameState, wolf: PlayerState, rng: Rng): NightAction {
  // 複数狼がいる場合、最もseat番号が小さい狼だけが襲撃を決める
  const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
  if (aliveWolves[0].seat !== wolf.seat) return { type: 'none' }

  const wolfSeats = new Set(aliveWolves.map(w => w.seat))
  const candidates = alivePlayers(state).filter(p => !wolfSeats.has(p.seat))
  return { type: 'attack', target: rng.pick(candidates).seat }
}

function decidePossessedNight(state: GameState, possessed: PlayerState, rng: Rng): NightAction {
  const divined = new Set(Array.from(possessed.fakeDivineHistory.values()).map(d => d.target))
  const candidates = alivePlayersExcept(state, possessed.seat).filter(p => !divined.has(p.seat))
  if (candidates.length === 0) return { type: 'none' }

  const target = rng.pick(candidates)
  const result: EnumSpecies = target.role === 'werewolf' ? 'human' : 'wolf'
  return { type: 'fake_divine', target: target.seat, result }
}

// ==== 昼CO ====

export function decideDayClaim(
  state: GameState, player: PlayerState, day: number,
  lastExecutedSeat: number | null, _rng: Rng,
): DayClaim {
  switch (player.role) {
    case 'seer':
      return decideSeerClaim(state, player, day)
    case 'possessed':
      return decidePossessedClaim(state, player, day)
    case 'medium':
      return decideMediumClaim(state, player, day, lastExecutedSeat)
    default:
      return { type: 'none' }
  }
}

function decideSeerClaim(_state: GameState, seer: PlayerState, day: number): DayClaim {
  if (day === 1) {
    // 初回CO: 全占い履歴を発表
    const results = Array.from(seer.divineHistory.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ target: v.target, result: v.result }))
    return { type: 'seer_co', results }
  }
  // Day 2+: 最新の結果のみ
  const latest = seer.divineHistory.get(day - 1)
  if (!latest) return { type: 'none' }
  return { type: 'seer_result', target: latest.target, result: latest.result }
}

function decidePossessedClaim(_state: GameState, possessed: PlayerState, day: number): DayClaim {
  if (day === 1) {
    const results = Array.from(possessed.fakeDivineHistory.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ target: v.target, result: v.result }))
    return { type: 'seer_co', results }
  }
  const latest = possessed.fakeDivineHistory.get(day - 1)
  if (!latest) return { type: 'none' }
  return { type: 'seer_result', target: latest.target, result: latest.result }
}

function decideMediumClaim(
  state: GameState, _medium: PlayerState, day: number,
  lastExecutedSeat: number | null,
): DayClaim {
  if (day === 1) {
    return { type: 'medium_co' }
  }
  if (lastExecutedSeat !== null) {
    const target = state.players.find(p => p.seat === lastExecutedSeat)!
    const result = getMediumResult(target.role)
    return { type: 'medium_result', result }
  }
  return { type: 'none' }
}

// ==== 投票 ====

export function decideVote(
  state: GameState, voter: PlayerState, rng: Rng,
): number {
  const candidates = alivePlayersExcept(state, voter.seat)

  if (voter.role === 'werewolf') {
    const villageCOs = candidates.filter(p =>
      p.claimedRole && !isWerewolfAligned(p.role) && p.role !== 'werewolf'
    )
    const nonWolves = candidates.filter(p => p.role !== 'werewolf')
    if (villageCOs.length > 0) return rng.pick(villageCOs).seat
    if (nonWolves.length > 0) return rng.pick(nonWolves).seat
    return rng.pick(candidates).seat
  }

  // 黒出しされたプレイヤーがいれば優先
  const seerBlackTargets = collectBlackTargets(state)
  const blackTargets = candidates.filter(p => seerBlackTargets.has(p.seat))
  if (blackTargets.length > 0) return rng.pick(blackTargets).seat

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

// ==== 投票集計 ====

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
