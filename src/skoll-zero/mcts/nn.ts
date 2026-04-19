import { hasSeat } from '../../hati/types.ts'
import type { SimState } from '../simulator/world-state.ts'

/**
 * mason_zero NN の interface。M3 で本物の NN に差し替え可能。
 *
 * - `policy`: action (vote 先 seat) → prior probability。合計は 1 想定
 * - `value`: mason 視点の状態価値 [-1, +1]
 *
 * `state.world` は determinized world（ISMCTS の rollout ごとに変わる）。
 * NN は infoset ではなく world 込みで forward する（Phase 1 の設計）。
 */
export type NNOutput = {
  policy: Map<number, number>
  value: number
}

export interface MasonZeroNN {
  forward(state: SimState, masonSeat: number): NNOutput
}

/**
 * Dummy NN: uniform policy（全合法 action に等確率）+ value 0。
 *
 * M2 では本物 NN がないので、UCB の探索項のみで木が広がる。
 * value=0 は「中立評価」を意味し、終端まで到達した rollout だけが backup
 * で確かな信号を返す。
 */
export class DummyNN implements MasonZeroNN {
  forward(state: SimState, masonSeat: number): NNOutput {
    const policy = new Map<number, number>()
    let mask = state.alive & ~(1 << masonSeat)
    const candidates: number[] = []
    while (mask !== 0) {
      const bit = mask & (-mask)
      candidates.push(31 - Math.clz32(bit))
      mask ^= bit
    }
    if (candidates.length === 0) return { policy, value: 0 }
    const p = 1 / candidates.length
    for (const c of candidates) policy.set(c, p)
    return { policy, value: 0 }
  }
}

/** 生存非自席を全列挙（dummy NN と一致する legal action 集合） */
export function legalVoteActions(alive: number, voterSeat: number): number[] {
  const result: number[] = []
  let mask = alive & ~(1 << voterSeat)
  while (mask !== 0) {
    const bit = mask & (-mask)
    result.push(31 - Math.clz32(bit))
    mask ^= bit
  }
  return result
}

/** mason が生きているか */
export function isMasonAlive(state: SimState, masonSeat: number): boolean {
  return hasSeat(state.alive, masonSeat)
}
