import { applyExecution, applyFollowDeaths, checkOutcome, simulateNight } from '../../hati/simulate.ts'
import type { SimState } from './world-state.ts'

/**
 * 1 day の集団意思決定。heuristic 経由ではなく、呼び出し側が処刑先 seat を直接渡す。
 * `executedSeat` が -1 なら処刑スキップ（abstain）。
 */
export type DayDecision = {
  executedSeat: number
}

/**
 * 1 night の全行動。呼び出し側が全 action を明示する。heuristic fallback はない。
 *
 * - `attackTarget`: 狼の噛み先 seat。null or -1 なら襲撃なし（狼不在や guard でブロックされた想定の上位扱い）
 * - `guardTarget`: bodyguard の護衛先 seat。null なら護衛なし
 * - `seerTargets`: seerMask の low-bit 順に並べた各占い師の対象 seat 配列。-1 なら占わない
 */
export type NightDecision = {
  attackTarget: number | null
  guardTarget: number | null
  seerTargets: number[]
}

/**
 * Day-Night サイクルを進める。全 action は呼び出し側が決定した前提で受ける。
 *
 * - state.phase が 'day' なら day.executedSeat を処刑し夜へ
 * - state.phase が 'night' なら day をスキップして夜行動だけ進める（root night action 用）
 * - state は in-place mutate（rollout 内で短命なため OK）
 *
 * 戻り値: mutate 後の同 state。state.phase が 'terminal' になっていれば state.outcome に勝敗が入る。
 */
export function stepDayNightCycle(
  state: SimState,
  day: DayDecision,
  night: NightDecision,
): SimState {
  if (state.phase === 'terminal') return state

  if (state.phase === 'day') {
    if (day.executedSeat >= 0) {
      state.alive = applyExecution(state.alive, day.executedSeat)
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

  if (night.attackTarget !== null && night.attackTarget >= 0) {
    const result = simulateNight(
      state.world,
      state.alive,
      night.attackTarget,
      night.guardTarget,
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
