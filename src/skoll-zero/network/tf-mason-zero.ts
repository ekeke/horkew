/**
 * TfMasonZeroNetwork: TF.js GPU 推論用 wrapper。
 *
 * MasonZeroNetwork (Pure JS) と同じ MasonZeroNN interface を実装し、
 * 内部で TfTransformerNetwork.forward を呼んで GPU 推論する。
 *
 * 切替は `SKOLLZ_INFER_GPU=1` 環境変数で行い、phase/runner.ts の buildSlot で
 * `inferNet` field を構築する形で経路を分ける。default は Pure JS (既存挙動)。
 *
 * 重み同期: tfNet 自体を wrap するので、学習で更新された重みが推論にも即反映される。
 * Pure JS net への loadWeights 経路 (multi-trainer の sync) は不要。
 *
 * 設計の注意:
 * - TF.js GPU は 1-sample forward では tensor 作成 + dataSync で latency overhead が
 *   支配的になる可能性が高い。本実装は実験用で、batching MCTS には対応しない
 * - softmax は CPU 側で行う (Pure JS と同じ実装)。GPU で softmax しても結果は同じ
 *   だが、現状 TF.js 側は logits のみ返すので、wrapper で softmax を担う
 */

import type { HeadName, MasonZeroNN, NNOutput, RootObservation } from '../mcts/nn.ts'
import { uniformOutcomeDist } from '../mcts/nn.ts'
import type { SimState } from '../simulator/world-state.ts'
import type { TfTransformerNetwork } from '../../fenrir/src/ml/nn-tf-transformer.ts'

const SEATS = 14

export class TfMasonZeroNetwork implements MasonZeroNN {
  readonly net: TfTransformerNetwork
  private readonly perSeatHeads: ReadonlySet<string>

  constructor(net: TfTransformerNetwork) {
    this.net = net
    this.perSeatHeads = new Set(net.tConfig.perSeatHeads)
  }

  forward(rootObs: RootObservation, state: SimState, masonSeat: number, headName: HeadName = 'execute'): NNOutput {
    const result = this.net.forward(rootObs)
    const logits = result.policies.get(headName)
    if (!logits) {
      throw new Error(`TfMasonZeroNetwork: head '${headName}' not found in policies`)
    }
    const isPerSeat = this.perSeatHeads.has(headName)
    const policy = isPerSeat
      ? softmaxMaskedPerSeat(logits, state.alive, masonSeat)
      : softmaxGlobal(logits)
    const outcomeDist = result.outcomeDist ?? uniformOutcomeDist()
    return { policy, outcomeDist }
  }

  /**
   * 複数 obs を 1 batch tensor で TF.js GPU forward。batched MCTS 用。
   *
   * states と actorSeats は softmax mask の per-sample 引数 (alive bit と masonSeat)。
   * outputs は inputs と同順。
   */
  forwardBatch(
    rootObsList: RootObservation[],
    states: SimState[],
    actorSeats: number[],
    headName: HeadName = 'execute',
  ): NNOutput[] {
    const N = rootObsList.length
    if (N === 0) return []
    const results = this.net.forwardBatch(rootObsList)
    const isPerSeat = this.perSeatHeads.has(headName)
    const outputs: NNOutput[] = []
    for (let i = 0; i < N; i++) {
      const logits = results[i].policies.get(headName)
      if (!logits) {
        throw new Error(`TfMasonZeroNetwork.forwardBatch: head '${headName}' not found in policies`)
      }
      const policy = isPerSeat
        ? softmaxMaskedPerSeat(logits, states[i].alive, actorSeats[i])
        : softmaxGlobal(logits)
      const outcomeDist = results[i].outcomeDist ?? uniformOutcomeDist()
      outputs.push({ policy, outcomeDist })
    }
    return outputs
  }
}

/**
 * 生存非自席のみ softmax (per-seat head 用)。MasonZeroNetwork と同じ実装。
 * 共有関数化候補だが、依存方向 (Pure JS / TF.js wrapper の独立性) を優先して duplicate。
 */
function softmaxMaskedPerSeat(logits: Float32Array, alive: number, masonSeat: number): Map<number, number> {
  const legalMask = alive & ~(1 << masonSeat)
  const legal: number[] = []
  let m = legalMask
  while (m !== 0) {
    const bit = m & (-m)
    legal.push(31 - Math.clz32(bit))
    m ^= bit
  }
  const policy = new Map<number, number>()
  if (legal.length === 0) return policy

  let maxLogit = -Infinity
  for (const s of legal) {
    if (s < 1 || s > SEATS) continue
    const v = logits[s - 1]
    if (v > maxLogit) maxLogit = v
  }
  let sumExp = 0
  const exps: number[] = []
  for (const s of legal) {
    const e = (s >= 1 && s <= SEATS) ? Math.exp(logits[s - 1] - maxLogit) : 0
    exps.push(e)
    sumExp += e
  }
  if (sumExp === 0) {
    const p = 1 / legal.length
    for (const s of legal) policy.set(s, p)
    return policy
  }
  for (let i = 0; i < legal.length; i++) {
    policy.set(legal[i], exps[i] / sumExp)
  }
  return policy
}

function softmaxGlobal(logits: Float32Array): Map<number, number> {
  const policy = new Map<number, number>()
  if (logits.length === 0) return policy
  let maxLogit = -Infinity
  for (const v of logits) if (v > maxLogit) maxLogit = v
  let sumExp = 0
  const exps = new Float32Array(logits.length)
  for (let i = 0; i < logits.length; i++) {
    exps[i] = Math.exp(logits[i] - maxLogit)
    sumExp += exps[i]
  }
  if (sumExp === 0) {
    const u = 1 / logits.length
    for (let i = 0; i < logits.length; i++) policy.set(i, u)
    return policy
  }
  for (let i = 0; i < logits.length; i++) {
    policy.set(i, exps[i] / sumExp)
  }
  return policy
}
