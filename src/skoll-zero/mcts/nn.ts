import { hasSeat } from '../../hati/types.ts'
import type { SimState } from '../simulator/world-state.ts'

/**
 * MCTS root で一度だけキャプチャする生観測。
 * fenrir `mason_collective` 観測エンコーダの出力（1030-dim Float32Array）を想定。
 *
 * Phase 1 の割り切り: NN は rollout 中の alive/role 変化を観測に反映しない。
 * Q は terminal backup から学ぶ。
 */
export type RootObservation = Float32Array

/**
 * mason_zero NN の interface。M3 で本物の NN に差し替え可能。
 *
 * - `policy`: action (vote 先 seat) → prior probability。合計は 1 想定
 * - `value`: mason 視点の状態価値 [-1, +1]
 *
 * `rootObs` は MCTS 開始時にキャプチャ、rollout 中は固定。
 * `state.world` は determinized world（ISMCTS の rollout ごとに変わる）。
 * NN は root 観測で policy/value を評価、state は legal action mask にのみ使う。
 */
export type NNOutput = {
  policy: Map<number, number>
  value: number
}

/**
 * policy を読み出す head 名。
 *
 * Phase 1 (MCTS per-seat softmax):
 * - `vote`: 昼投票 (default、全役職)
 * - `attack`: wolf の噛み先
 * - `divine`: seer の占い先
 * - `guard`: bodyguard の護衛先
 *
 * Stage 3 (MCTS global heads):
 * - `claim_true`: 真役職の真 CO 判断 (2-dim: skip / CO)
 * - `claim_fake`: 狼/狂の偽 CO 判断 (15-dim: skip + claimer seat)
 * - `morning`: 偽占い報告 (28-dim: target_idx × {human, wolf})
 *
 * Phase 2 (NN-direct、MCTS 不使用):
 * - `target`: 占い/護衛/forecast/defensiveClaim target (per-seat softmax)
 * - `claim`: 昼 claim (categorical 10)
 * - `comm`: communication signal (categorical 119)
 * - `leader`: leadership response (categorical 3)
 * - `propose`: 処刑提案 (per-seat sigmoid)
 * - `predict`: 配役予想 (per-seat sigmoid 154)
 */
export type HeadName =
  | 'execute' | 'attack' | 'divine' | 'guard' | 'target'
  | 'claim_true' | 'claim_fake' | 'morning'
  | 'claim' | 'comm' | 'leader'
  | 'propose' | 'predict'

export interface MasonZeroNN {
  /**
   * @param headName どの per-seat head から policy を取り出すか (default 'execute')。
   *   該当 head を持たないネットで非対応 head 名が渡された場合は実装が throw する。
   */
  forward(rootObs: RootObservation, state: SimState, masonSeat: number, headName?: HeadName): NNOutput
}

/**
 * Dummy NN: uniform policy（全合法 action に等確率）+ value 0。
 *
 * M2 では本物 NN がないので、UCB の探索項のみで木が広がる。
 * value=0 は「中立評価」を意味し、終端まで到達した rollout だけが backup
 * で確かな信号を返す。
 *
 * rootObs / headName は無視（DummyNN は観測と head に依存しない）。
 */
export class DummyNN implements MasonZeroNN {
  forward(_rootObs: RootObservation, state: SimState, masonSeat: number, _headName: HeadName = 'execute'): NNOutput {
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
