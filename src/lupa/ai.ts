import type { EnumSpecies } from '../types/index.ts'
import type { GameState, PlayerState, GameEvent } from './types.ts'
import { alivePlayers, alivePlayersExcept, getSeerResult, isWerewolfAligned } from './roles.ts'
import type { Rng } from './random.ts'

// ---- 占い師 ----

/** 占い対象を選ぶ (未占い・生存・自分以外) */
export function seerChooseTarget(state: GameState, seer: PlayerState, rng: Rng): number | null {
  const divined = new Set(Array.from(seer.divineHistory.values()).map(d => d.target))
  const candidates = alivePlayersExcept(state, seer.seat).filter(p => !divined.has(p.seat))
  if (candidates.length === 0) return null
  return rng.pick(candidates).seat
}

/** 占いを実行して結果を記録 */
export function seerDivine(state: GameState, seer: PlayerState, night: number, target: number): EnumSpecies {
  const targetPlayer = state.players.find(p => p.seat === target)!
  const result = getSeerResult(targetPlayer.role)
  seer.divineHistory.set(night, { target, result })
  return result
}

/** 占いCOイベントを生成 */
export function seerClaimEvent(seer: PlayerState): GameEvent {
  const results = Array.from(seer.divineHistory.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ target: v.target, result: v.result }))
  return { type: 'seer_claim', actor: seer.seat, results }
}

// ---- 霊能者 ----

/** 霊能結果を計算 (前日の処刑者の白黒) */
export function mediumResult(state: GameState, executedSeat: number): EnumSpecies {
  const target = state.players.find(p => p.seat === executedSeat)!
  const role = target.role
  return getSeerResult(role) // mediumResult と seerResult は同じ値を返す (systemRoles参照)
}

// ---- 狩人 ----

/** 護衛対象を選ぶ (占いCO者優先、自分以外) */
export function bodyguardChooseTarget(
  state: GameState, guard: PlayerState, rng: Rng,
): number {
  const alive = alivePlayersExcept(state, guard.seat)
  // 占いCO者がいればそちらを優先
  const seerClaimers = alive.filter(p => p.claimedRole === 'seer')
  if (seerClaimers.length > 0) return rng.pick(seerClaimers).seat
  return rng.pick(alive).seat
}

// ---- 人狼 ----

/** 襲撃対象を選ぶ (非狼・生存) */
export function wolvesChooseTarget(state: GameState, rng: Rng): number {
  const wolves = alivePlayers(state).filter(p => p.role === 'werewolf')
  const wolfSeats = new Set(wolves.map(w => w.seat))
  const candidates = alivePlayers(state).filter(p => !wolfSeats.has(p.seat))
  return rng.pick(candidates).seat
}

// ---- 狂人 (偽占い) ----

/** 偽占い結果を生成: 狼→○、ランダム村人→● */
export function possessedFakeDivine(
  state: GameState, possessed: PlayerState, night: number, rng: Rng,
): void {
  const divined = new Set(Array.from(possessed.fakeDivineHistory.values()).map(d => d.target))
  const candidates = alivePlayersExcept(state, possessed.seat).filter(p => !divined.has(p.seat))
  if (candidates.length === 0) return

  const target = rng.pick(candidates)
  // 狼を○、非狼を●
  const result: EnumSpecies = target.role === 'werewolf' ? 'human' : 'wolf'
  possessed.fakeDivineHistory.set(night, { target: target.seat, result })
}

/** 狂人の占いCOイベントを生成 */
export function possessedClaimEvent(possessed: PlayerState): GameEvent {
  const results = Array.from(possessed.fakeDivineHistory.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ target: v.target, result: v.result }))
  return { type: 'seer_claim', actor: possessed.seat, results }
}

// ---- 投票 ----

/** 投票先を決める */
export function decideVote(
  state: GameState, voter: PlayerState, rng: Rng,
  seerBlackTargets: Set<number>,
): number {
  const candidates = alivePlayersExcept(state, voter.seat)

  if (voter.role === 'werewolf') {
    // 人狼: 村側CO者に投票
    const villageCOs = candidates.filter(p =>
      p.claimedRole && !isWerewolfAligned(p.role) && p.role !== 'werewolf'
    )
    // 仲間の狼は避ける
    const nonWolves = candidates.filter(p => p.role !== 'werewolf')
    if (villageCOs.length > 0) return rng.pick(villageCOs).seat
    if (nonWolves.length > 0) return rng.pick(nonWolves).seat
    return rng.pick(candidates).seat
  }

  // 黒出しされたプレイヤーがいれば優先
  const blackTargets = candidates.filter(p => seerBlackTargets.has(p.seat))
  if (blackTargets.length > 0) return rng.pick(blackTargets).seat

  return rng.pick(candidates).seat
}

/** 全員の投票を集計して処刑対象を決める */
export function resolveVotes(
  votes: Map<number, number>,
): number {
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
  // 同票ならseat番号が小さい方 (決定論的)
  return Math.min(...maxTargets)
}
