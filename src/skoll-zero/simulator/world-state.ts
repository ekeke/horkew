import type { World } from '../../hati/types.ts'
import type { GameOutcome } from '../../hati/simulate.ts'

/**
 * MCTS rollout 用の決定論的 game state。
 *
 * lupa の GameState と異なり、bitmask + 真role world だけで動く軽量版。
 * CO / claim / divine history 等は持たない。Phase 1 では vote+night のみ simulate。
 *
 * `world` は immutable と仮定（rollout 中に mutate しない）。enumerateWorlds が
 * 共有バッファを emit する場合は呼び出し側で `cloneWorld` してから渡すこと。
 */
export type SimState = {
  world: World
  alive: number
  day: number
  phase: 'day' | 'night' | 'terminal'
  outcome: GameOutcome | null
}

export function createSimState(
  world: World,
  alive: number,
  day: number = 1,
  phase: 'day' | 'night' = 'day',
): SimState {
  return { world, alive, day, phase, outcome: null }
}

/** state 単位の浅複製。world は共有（immutable 前提） */
export function cloneSimState(state: SimState): SimState {
  return {
    world: state.world,
    alive: state.alive,
    day: state.day,
    phase: state.phase,
    outcome: state.outcome,
  }
}

export function isTerminal(state: SimState): boolean {
  return state.phase === 'terminal'
}
