/**
 * MasonZeroNetwork: skoll-zero の mason 用 NN。
 *
 * - fenrir の `TransformerNetwork` (`mason_collective` config) をラップ
 * - `vote` head (14-dim per-seat) を policy head として流用
 * - value head は TransformerNetwork 標準の scalar (tanh 済み)
 *
 * forward:
 *   1. rootObs (1030-dim Float32Array) を TransformerNetwork.forward に投入
 *   2. vote logits を取得、state.alive & ~(1<<masonSeat) で masking
 *   3. softmax で正規化 → policy Map<seat, prob>
 *   4. value はそのまま返す（tanh 済み）
 *
 * state は legal action mask にのみ使う。rollout 中の alive 変化は反映されるが、
 * rootObs 自体は MCTS 開始時の観測固定 (Phase 1 の割り切り)。
 */

import type { HeadName, MasonZeroNN, NNOutput, RootObservation } from '../mcts/nn.ts'
import type { SimState } from '../simulator/world-state.ts'
import type { TransformerNetwork } from '../../fenrir/src/ml/transformer-network.ts'
import { createSkollZeroNetwork } from './config.ts'

const SEATS = 14

export class MasonZeroNetwork implements MasonZeroNN {
  readonly net: TransformerNetwork

  /**
   * @param net  完成品の TransformerNetwork（省略時は fresh ネット）
   * @param opts.zeroValueHead  true なら value head を zero reset (default true)。
   *   false にすると warm-start 元の checkpoint が持つ value head をそのまま使う
   *   (ablation 用: SL で学習した value signal が ISMCTS に効くか検証)。
   */
  constructor(net?: TransformerNetwork, opts: { zeroValueHead?: boolean } = {}) {
    this.net = net ?? createSkollZeroNetwork()
    const zeroValueHead = opts.zeroValueHead ?? true
    if (zeroValueHead) {
      // value head は skoll-zero では zero init が初期設計（tanh(0)=0）。
      // 学習前 or warm start 時に中立評価を返すため。
      this.net.zeroInitValueHead()
    }
  }

  forward(rootObs: RootObservation, state: SimState, masonSeat: number, headName: HeadName = 'execute'): NNOutput {
    const result = this.net.forward(rootObs)
    const logits = result.policies.get(headName)
    if (!logits) {
      throw new Error(`MasonZeroNetwork: head '${headName}' not found in policies`)
    }
    const policy = softmaxMasked(logits, state.alive, masonSeat)
    return { policy, value: result.value }
  }
}

/**
 * 生存非自席のみ softmax。dead / self は policy Map に出さない（prior=0 相当）。
 *
 * 数値安定化のため max を引いてから exp。
 *
 * Seat 規約: `alive` ビットマスクは 1-based（bit 1 = seat 1）、vote logits は
 * 14-dim 0-indexed（logits[0] = seat 1 の logit）。policy Map の key は 1-based seat。
 */
function softmaxMasked(logits: Float32Array, alive: number, masonSeat: number): Map<number, number> {
  const legalMask = alive & ~(1 << masonSeat)
  const legal: number[] = []
  let m = legalMask
  while (m !== 0) {
    const bit = m & (-m)
    legal.push(31 - Math.clz32(bit))  // 1..14 (seat number)
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
    // 理論上は起きないが念のため: uniform フォールバック
    const p = 1 / legal.length
    for (const s of legal) policy.set(s, p)
    return policy
  }
  for (let i = 0; i < legal.length; i++) {
    policy.set(legal[i], exps[i] / sumExp)
  }
  return policy
}
