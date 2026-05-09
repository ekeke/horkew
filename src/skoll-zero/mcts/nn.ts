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
 * - `policy`: action → prior probability。合計は 1 想定
 * - `outcomeDist`: 終局 outcome の確率分布 (Stage 4)。
 *   配列順は OUTCOME_ORDER (network/config.ts) で定義。skoll-zero では
 *   [P_village_win, P_wolf_win, P_hamster_win, P_draw] の 4-vec。
 *   value scalar への変換は ISMCTS 側で `outcomeDistToFactionValue` を使う。
 *
 * `rootObs` は MCTS 開始時にキャプチャ、rollout 中は固定。
 * `state.world` は determinized world（ISMCTS の rollout ごとに変わる）。
 * NN は root 観測で policy/outcomeDist を評価、state は legal action mask にのみ使う。
 */
export type NNOutput = {
  policy: Map<number, number>
  outcomeDist: Float32Array
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
 * Wolf imitation A案 (joint distribution):
 * - `claim_decision`: 偽 CO 種別 + claimer の同時分布 (57-dim: skip + 4 役職 × 14 claimer)
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
  | 'claim_true' | 'claim_fake' | 'claim_decision' | 'morning'
  | 'claim' | 'comm' | 'leader'
  | 'propose' | 'predict'

export interface MasonZeroNN {
  /**
   * @param headName どの per-seat head から policy を取り出すか (default 'execute')。
   *   該当 head を持たないネットで非対応 head 名が渡された場合は実装が throw する。
   */
  forward(rootObs: RootObservation, state: SimState, masonSeat: number, headName?: HeadName): NNOutput

  /**
   * Batched forward (optional)。複数の (rootObs, state, actorSeat) を 1 batch で
   * 推論する。同じ headName の inputs のみを 1 batch にまとめる前提 (caller 責任)。
   *
   * 実装が無い (undefined) ネットでは batched MCTS 側が forward を N 回呼んで fallback する。
   * TF.js GPU 実装でのみ真の batch tensor forward を行い、レイテンシを N 倍まで償却する。
   *
   * 出力は inputs と同順、長さ等しい NNOutput[]。
   */
  forwardBatch?(
    rootObsList: RootObservation[],
    states: SimState[],
    actorSeats: number[],
    headName?: HeadName,
  ): NNOutput[]
}

/**
 * Dummy NN: uniform policy（全合法 action に等確率）+ uniform outcome distribution。
 *
 * M2 では本物 NN がないので、UCB の探索項のみで木が広がる。
 * outcomeDist は均等 (1/4) で「中立評価」、終端まで到達した rollout だけが backup
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
    const outcomeDist = uniformOutcomeDist()
    if (candidates.length === 0) return { policy, outcomeDist }
    const p = 1 / candidates.length
    for (const c of candidates) policy.set(c, p)
    return { policy, outcomeDist }
  }
}

/** 均等な outcome distribution (4 outcomes、各 0.25) — DummyNN や fallback 用 */
export function uniformOutcomeDist(): Float32Array {
  const dist = new Float32Array(4)
  dist.fill(0.25)
  return dist
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
