/**
 * WolfImitationNetwork: skoll-zero の wolf 用 imitation NN。
 *
 * - wolf NN (trainable, `WOLF_IMITATION_ZERO_NETWORK_CONFIG`) をラップ
 * - frozen skoll-zero standard NN (= 村側 NN) を「真占いだったら」base policy として参照
 * - `claim_fake` / `morning` head の policy を凸結合で mix 出力
 *
 * Forward:
 *   1. wolf NN.forward(rootObs) → wolf logits + outcomeDist
 *   2. headName が claim_fake / morning なら frozen village NN.forward(virtualViewerObs)
 *      - claim_seer_fake / morning → viewer='seer'
 *      - claim_medium_fake         → viewer='medium'
 *      - claim_bg_fake             → viewer='bodyguard'
 *      - claim_nekomata_fake       → viewer='nekomata'
 *   3. mix:
 *      - claim_fake: skip 部分を α_claim と π_v_co で凸結合、claimer 部分は wolf を再正規化
 *      - morning: target 部分を α_morning と π_v_target で凸結合、white/black は wolf morning_res
 *   4. 既存 head 名 (`claim_fake` 15-dim, `morning` 28-dim) と互換の softmax 確率分布を返す
 *
 * State の alive は legal action mask 用 (per-seat head のみ使用)。
 */

import type { HeadName, MasonZeroNN, NNOutput, RootObservation } from '../mcts/nn.ts'
import { uniformOutcomeDist } from '../mcts/nn.ts'
import type { SimState } from '../simulator/world-state.ts'
import type { TransformerNetwork } from '../../fenrir/src/ml/transformer-network.ts'
import type { ForwardResult } from '../../fenrir/src/ml/nn.ts'
import { createWolfImitationZeroNetwork } from './config.ts'

const SEATS = 14
const CLAIM_FAKE_SIZE = 1 + SEATS  // 15: skip + claimer seat
const MORNING_SIZE = SEATS * 2     // 28: target × {white, black}

export class WolfImitationNetwork implements MasonZeroNN {
  readonly net: TransformerNetwork
  /** frozen skoll-zero standard NN — 真占い base policy を提供 (no grad) */
  readonly frozenVillage: TransformerNetwork

  /**
   * @param frozenVillage 真占い base 用の skoll-zero standard NN (deep clone 済を期待)
   * @param net           完成品の wolf imitation NN（省略時は fresh ネット）
   * @param opts.zeroValueHead true なら legacy scalar value head を zero reset (default true)
   */
  constructor(
    frozenVillage: TransformerNetwork,
    net?: TransformerNetwork,
    opts: { zeroValueHead?: boolean } = {},
  ) {
    this.net = net ?? createWolfImitationZeroNetwork()
    this.frozenVillage = frozenVillage
    const zeroValueHead = opts.zeroValueHead ?? true
    if (zeroValueHead) {
      this.net.zeroInitValueHead()
    }
  }

  /**
   * MasonZeroNN.forward 実装。execute / attack のみ対応 (純 wolf head)。
   *
   * claim_fake / morning は virtualViewerObs が必要なため、Module 側で `mixForward` を
   * 直接呼ぶ必要がある (4 引数ではこれら head を呼ぶと throw)。
   */
  forward(
    rootObs: RootObservation,
    state: SimState,
    wolfSeat: number,
    headName: HeadName = 'execute',
  ): NNOutput {
    if (headName !== 'execute' && headName !== 'attack') {
      throw new Error(
        `WolfImitationNetwork.forward: head '${headName}' requires virtualViewerObs. ` +
        `Use mixForward(rootObs, virtualViewerObs, ...) for claim_fake / morning.`,
      )
    }
    const wolfResult = this.net.forward(rootObs)
    const logits = wolfResult.policies.get(headName)
    if (!logits) throw new Error(`WolfImitationNetwork: head '${headName}' not found`)
    const policy = softmaxMaskedPerSeat(logits, state.alive, wolfSeat)
    const outcomeDist = wolfResult.outcomeDist ?? uniformOutcomeDist()
    return { policy, outcomeDist }
  }

  /**
   * Wolf imitation 専用の mix forward。virtualViewerObs を必要とする claim_fake / morning
   * 用。execute / attack で呼ぶと内部的に通常 forward と同じ結果を返す (Module 側で
   * 分岐ミス時の安全策)。
   *
   * @param rootObs          wolf 観測 (1212 dim)
   * @param virtualViewerObs virtual viewer obs (1029 dim、wolfSeat を真 {seer / medium /
   *                         bodyguard / nekomata} と仮定。caller が phase / actionMode から
   *                         viewer role を選択して構築する)
   * @param state            legal action mask 用 (per-seat head)
   * @param wolfSeat         行動主体の seat
   * @param headName         'execute' | 'attack' | 'claim_fake' | 'morning'
   */
  mixForward(
    rootObs: RootObservation,
    virtualViewerObs: Float32Array,
    state: SimState,
    wolfSeat: number,
    headName: HeadName,
  ): NNOutput {
    const wolfResult = this.net.forward(rootObs)
    const outcomeDist = wolfResult.outcomeDist ?? uniformOutcomeDist()

    if (headName === 'execute' || headName === 'attack') {
      const logits = wolfResult.policies.get(headName)
      if (!logits) throw new Error(`WolfImitationNetwork: head '${headName}' not found`)
      const policy = softmaxMaskedPerSeat(logits, state.alive, wolfSeat)
      return { policy, outcomeDist }
    }

    // claim_fake / morning は mix
    const villageResult = this.frozenVillage.forward(virtualViewerObs)

    if (headName === 'claim_fake') {
      const policy = mixClaimFake(wolfResult, villageResult)
      return { policy, outcomeDist }
    }
    if (headName === 'morning') {
      const policy = mixMorning(wolfResult, villageResult)
      return { policy, outcomeDist }
    }
    throw new Error(`WolfImitationNetwork.mixForward: unsupported head '${headName}'`)
  }
}

// ============================================================
// Mix 計算
// ============================================================

/**
 * claim_fake (15-dim) の mix。
 *
 *   π_v_co       = softmax(village.claim_true)  // 2-dim [skip, co]
 *   π_w_full     = softmax(wolf.claim_fake_dev) // 15-dim
 *   α_claim      = softmax(wolf.alpha_claim)[1] // scalar [0,1]
 *
 *   final[skip]      = (1-α) × π_v_co[0] + α × π_w_full[0]
 *   final[claimer i] = π_w_full[i] / Σ_{j=1..14} π_w_full[j] × (1 - final[skip])
 *
 * これにより Σ final = 1 (確率分布として正規化済)。
 */
export function mixClaimFake(wolf: ForwardResult, village: ForwardResult): Map<number, number> {
  const wolfDev = requireLogits(wolf, 'claim_fake_dev')
  const wolfAlpha = requireLogits(wolf, 'alpha_claim')
  const villageCo = requireLogits(village, 'claim_true')

  const piVCo = softmaxArray(villageCo)         // 2-dim
  const piWFull = softmaxArray(wolfDev)         // 15-dim
  const alphaClaim = softmaxArray(wolfAlpha)[1] // [0,1]

  const finalSkip = (1 - alphaClaim) * piVCo[0] + alphaClaim * piWFull[0]
  const wolfNonSkipSum = 1 - piWFull[0]
  const targetNonSkipSum = 1 - finalSkip

  const out = new Map<number, number>()
  out.set(0, finalSkip)
  if (wolfNonSkipSum > 1e-9) {
    const scale = targetNonSkipSum / wolfNonSkipSum
    for (let i = 1; i < CLAIM_FAKE_SIZE; i++) {
      out.set(i, piWFull[i] * scale)
    }
  } else {
    // 退化ケース: wolf が skip を 100% 出した。claimer 部分を uniform 配分。
    const u = targetNonSkipSum / SEATS
    for (let i = 1; i < CLAIM_FAKE_SIZE; i++) out.set(i, u)
  }
  return out
}

/**
 * morning (28-dim) の mix。action = target_idx × 2 + color (0=white, 1=black)。
 *
 *   π_v_target  = softmax(village.divine)       // 14-dim, 真占い対象 base
 *   π_w_target  = softmax(wolf.morning_tgt_dev) // 14-dim, 偽占い対象 deviation
 *   α_morning   = softmax(wolf.alpha_morning)[1]
 *
 *   target[i]   = (1-α) × π_v_target[i] + α × π_w_target[i]
 *   white[i]    = sigmoid(wolf.morning_res[i])
 *
 *   final[i*2+0] = target[i] × white[i]
 *   final[i*2+1] = target[i] × (1 - white[i])
 *
 * Σ final = Σ_i target[i] = 1。
 */
export function mixMorning(wolf: ForwardResult, village: ForwardResult): Map<number, number> {
  const wolfTgtDev = requireLogits(wolf, 'morning_tgt_dev')
  const wolfRes = requireLogits(wolf, 'morning_res')
  const wolfAlpha = requireLogits(wolf, 'alpha_morning')
  const villageDivine = requireLogits(village, 'divine')

  const piVTarget = softmaxArray(villageDivine)
  const piWTarget = softmaxArray(wolfTgtDev)
  const alphaMorning = softmaxArray(wolfAlpha)[1]

  const out = new Map<number, number>()
  for (let i = 0; i < SEATS; i++) {
    const target = (1 - alphaMorning) * piVTarget[i] + alphaMorning * piWTarget[i]
    const whiteProb = 1 / (1 + Math.exp(-wolfRes[i]))
    out.set(i * 2 + 0, target * whiteProb)
    out.set(i * 2 + 1, target * (1 - whiteProb))
  }
  return out
}

// ============================================================
// Utility
// ============================================================

function requireLogits(result: ForwardResult, headName: string): Float32Array {
  const logits = result.policies.get(headName)
  if (!logits) throw new Error(`forward result missing head '${headName}'`)
  return logits
}

/** 数値安定化付き softmax (Float32Array → Float32Array) */
function softmaxArray(logits: Float32Array): Float32Array {
  const out = new Float32Array(logits.length)
  if (logits.length === 0) return out
  let max = -Infinity
  for (const v of logits) if (v > max) max = v
  let sum = 0
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - max)
    sum += out[i]
  }
  if (sum === 0) {
    const u = 1 / logits.length
    out.fill(u)
    return out
  }
  for (let i = 0; i < logits.length; i++) out[i] /= sum
  return out
}

/**
 * 生存非自席のみ softmax (per-seat head 用)。
 * mason-zero.ts と同じロジック (将来共通化候補)。
 */
function softmaxMaskedPerSeat(
  logits: Float32Array,
  alive: number,
  wolfSeat: number,
): Map<number, number> {
  const legalMask = alive & ~(1 << wolfSeat)
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
