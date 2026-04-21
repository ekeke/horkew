import { applyExecution, applyFollowDeaths, checkOutcome, simulateNight } from '../../hati/simulate.ts'
import type { GameOutcome } from '../../hati/simulate.ts'
import { decideNightHeuristic, tallyVotes } from './heuristic-policy.ts'
import type { SimState } from './world-state.ts'

/**
 * 夜フェーズの heuristic を上書きするための構造体。
 *
 * - `attackTarget`: 狼の噛み先。未指定なら heuristic (wolfBiteTarget)。
 * - `seerDivines`: seer seat → divine target の map。指定された seer のみ上書き、
 *   他 seer は heuristic。占いの「結果」は simulateNight 内で world 参照して求まる。
 * - `guardTarget`: bodyguard の護衛先。未指定なら heuristic。
 */
export type NightOverride = {
  attackTarget?: number
  seerDivines?: Map<number, number>
  guardTarget?: number
}

/**
 * Day 1 サイクル（vote → execute → checkOutcome → night → simulate → checkOutcome）を進める。
 *
 * - `masonVoteOverride` で mason 席の投票先を強制できる（MCTS の root action 注入用）。
 *   Map<voterSeat, targetSeat> の形式。複数 mason がある場合は両方を override 可能。
 * - `nightOverride` で狼襲撃先・seer 占い先・bodyguard 護衛先を強制指定できる。
 *   指定がない夜行動は heuristic に従う。
 * - state は in-place mutate（rollout 内で短命なため OK）。caller が状態を保持したい
 *   場合は事前に `cloneSimState` すること。
 *
 * 戻り値: mutate 後の同 state（流暢な API のため）。state.phase が 'terminal' に
 * なっていれば state.outcome に勝敗が入る。
 */
export function stepDayNightCycle(
  state: SimState,
  masonVoteOverride: Map<number, number> | null = null,
  nightOverride: NightOverride | null = null,
): SimState {
  if (state.phase === 'terminal') return state

  // --- Day phase: vote → execute ---
  if (state.phase === 'day') {
    const executed = tallyVotes(state.world, state.alive, masonVoteOverride)
    if (executed >= 0) {
      state.alive = applyExecution(state.alive, executed)
      state.alive = applyFollowDeaths(state.alive, state.world)
    }
    const outcome = checkOutcome(state.world, state.alive)
    if (outcome !== 'ongoing') {
      state.outcome = outcome
      state.phase = 'terminal'
      return state
    }
    state.phase = 'night'
  }

  // --- Night phase ---
  const night = decideNightHeuristic(state.world, state.alive)
  const attackTarget = nightOverride?.attackTarget ?? night.wolfBiteTarget
  const guardTarget = nightOverride?.guardTarget !== undefined
    ? nightOverride.guardTarget
    : night.bodyguardTarget
  const seerTargets = applySeerDivineOverride(state.world, night.seerTargets, nightOverride?.seerDivines)
  // wolfBiteTarget=-1 は「狼不在」で本来到達しないが、防御的に skip
  if (attackTarget >= 0) {
    const result = simulateNight(
      state.world,
      state.alive,
      attackTarget,
      guardTarget,
      seerTargets,
    )
    state.alive = result.nextAlive
    state.alive = applyFollowDeaths(state.alive, state.world)
  }
  const outcome = checkOutcome(state.world, state.alive)
  if (outcome !== 'ongoing') {
    state.outcome = outcome
    state.phase = 'terminal'
    return state
  }
  state.day += 1
  state.phase = 'day'
  return state
}

/**
 * heuristic が返した seerTargets 配列の中で、override で指定された seer の
 * divine 先を上書きする。seerTargets の各要素と seerMask の seat 順は同じ前提。
 */
function applySeerDivineOverride(
  world: { seerMask: number },
  heuristicTargets: number[],
  overrides: Map<number, number> | undefined,
): number[] {
  if (!overrides || overrides.size === 0) return heuristicTargets
  const result = [...heuristicTargets]
  let mask = world.seerMask
  let idx = 0
  while (mask !== 0 && idx < result.length) {
    const bit = mask & (-mask)
    const seerSeat = 31 - Math.clz32(bit)
    mask ^= bit
    const target = overrides.get(seerSeat)
    if (target !== undefined) result[idx] = target
    idx++
  }
  return result
}

/**
 * 終端まで rollout を実行し、勝敗を返す。
 *
 * MCTS の leaf evaluation で NN が無いとき or 検証用。
 * Phase 1 の AlphaZero では本来「leaf で NN 評価 → backup」なので
 * rollout to terminal は不要だが、M1 の動作確認と sanity check で使う。
 *
 * `masonVoteOverride` は最初の 1 step のみ適用。それ以降は heuristic。
 *
 * `maxDays` で無限ループを防ぐ（保険、通常は到達しない）。
 */
export function runRollout(
  state: SimState,
  masonVoteOverride: Map<number, number> | null = null,
  maxDays: number = 100,
): GameOutcome {
  let override = masonVoteOverride
  const startDay = state.day
  while (state.phase !== 'terminal') {
    if (state.day - startDay > maxDays) {
      // 無限ループ防御。理論上ここに来ないはず（vote/bite で alive は単調減少）
      throw new Error(`runRollout exceeded maxDays=${maxDays}`)
    }
    stepDayNightCycle(state, override)
    override = null
  }
  return state.outcome ?? 'ongoing'
}
