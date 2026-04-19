import { applyExecution, applyFollowDeaths, checkOutcome, simulateNight } from '../../hati/simulate.ts'
import type { GameOutcome } from '../../hati/simulate.ts'
import { decideNightHeuristic, tallyVotes } from './heuristic-policy.ts'
import type { SimState } from './world-state.ts'

/**
 * Day 1 サイクル（vote → execute → checkOutcome → night → simulate → checkOutcome）を進める。
 *
 * - `masonVoteOverride` で mason 席の投票先を強制できる（MCTS の root action 注入用）。
 *   Map<voterSeat, targetSeat> の形式。複数 mason がある場合は両方を override 可能。
 * - state は in-place mutate（rollout 内で短命なため OK）。caller が状態を保持したい
 *   場合は事前に `cloneSimState` すること。
 *
 * 戻り値: mutate 後の同 state（流暢な API のため）。state.phase が 'terminal' に
 * なっていれば state.outcome に勝敗が入る。
 */
export function stepDayNightCycle(
  state: SimState,
  masonVoteOverride: Map<number, number> | null = null,
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
  // wolfBiteTarget=-1 は「狼不在」で本来到達しないが、防御的に skip
  if (night.wolfBiteTarget >= 0) {
    const result = simulateNight(
      state.world,
      state.alive,
      night.wolfBiteTarget,
      night.bodyguardTarget,
      night.seerTargets,
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
