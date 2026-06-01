/**
 * WolfImitationNetwork: skoll-zero の wolf 用 imitation NN。
 *
 * - wolf NN (trainable, `WOLF_IMITATION_ZERO_NETWORK_CONFIG`) をラップ
 * - frozen skoll-zero standard NN (= 村側 NN) を「真役職だったら」base policy として参照
 * - `claim_decision` / `morning` head の policy を凸結合で mix 出力
 *
 * Forward:
 *   1. wolf NN.forward(rootObs) → wolf logits + outcomeDist
 *   2. headName が claim_decision なら 4 種 virtualViewerObs (seer/medium/bg/nekomata) を
 *      frozen village NN.forward に投げて 4 つの claim_true を取得 → village base 57-dim を構築
 *      headName が morning なら virtualViewerObs.seer を frozen village に投げて divine を取得
 *   3. mix:
 *      - claim_decision: 57-dim (skip + 4 役職 × 14 claimer) を α_claim と凸結合
 *      - morning: target 部分を α_morning と π_v_target で凸結合、white/black は wolf morning_res
 *   4. 既存 head 名 (`claim_decision` 57-dim, `morning` 28-dim) と互換の softmax 確率分布を返す
 *
 * State の alive は legal action mask 用 (per-seat head のみ使用)。
 */

import type { SystemRole } from '../../types/index.ts'
import type { HeadName, MasonZeroNN, NNOutput, RootObservation } from '../mcts/nn.ts'
import { uniformOutcomeDist } from '../mcts/nn.ts'
import type { SimState } from '../simulator/world-state.ts'
import { CLAIM_DECISION_ROLES, CLAIM_DECISION_SEATS_PER_ROLE } from '../simulator/rollout-sim.ts'
import type { TransformerNetwork } from '../../fenrir/src/ml/transformer-network.ts'
import type { ForwardResult } from '../../fenrir/src/ml/nn.ts'
import { createWolfImitationZeroNetwork } from './config.ts'

/** mixClaimDecisionFromBatched: 順序固定 (CLAIM_DECISION_ROLES と整合) で 4 viewer の claim_true policy を渡す */
const VIEWER_ORDER: ReadonlyArray<SystemRole> = CLAIM_DECISION_ROLES

const SEATS = 14
const CLAIM_DECISION_SIZE = 1 + CLAIM_DECISION_ROLES.length * CLAIM_DECISION_SEATS_PER_ROLE  // 57

/**
 * 4 種 viewer 観測の bundle。caller (Module) が viewer role 別に encode して渡す。
 * key の順序は CLAIM_DECISION_ROLES と整合: seer / medium / bodyguard / nekomata。
 */
export type VirtualViewerObsBundle = {
  seer: Float32Array
  medium: Float32Array
  bodyguard: Float32Array
  nekomata: Float32Array
}

export class WolfImitationNetwork implements MasonZeroNN {
  readonly net: TransformerNetwork
  /** frozen skoll-zero standard NN — 真役職 base policy を提供 (no grad)。morning 経路で使う */
  readonly frozenVillage: TransformerNetwork
  /**
   * Optional: 4 viewer obs を batched で forward する経路 (claim_decision 用)。
   *
   * 通常は ProxiedMasonZeroNN ('frozenVillage' slot) を渡し、worker → main GPU の
   * 1 batched forward に集約する。未指定の場合は frozenVillage (Pure JS) で個別 forward
   * (4 回) で fallback する (test 環境 / sequential mode 用)。
   */
  readonly frozenVillageBatched: MasonZeroNN | undefined

  /**
   * @param frozenVillage 真役職 base 用の skoll-zero standard NN (deep clone 済を期待)
   * @param net           完成品の wolf imitation NN（省略時は fresh ネット）
   * @param opts.zeroValueHead true なら legacy scalar value head を zero reset (default true)
   * @param opts.frozenVillageBatched 4 viewer batched forward 用 (claim_decision 専用、proxy 経路)
   */
  constructor(
    frozenVillage: TransformerNetwork,
    net?: TransformerNetwork,
    opts: { zeroValueHead?: boolean, frozenVillageBatched?: MasonZeroNN } = {},
  ) {
    this.net = net ?? createWolfImitationZeroNetwork()
    this.frozenVillage = frozenVillage
    this.frozenVillageBatched = opts.frozenVillageBatched
    const zeroValueHead = opts.zeroValueHead ?? true
    if (zeroValueHead) {
      this.net.zeroInitValueHead()
    }
  }

  /**
   * MasonZeroNN.forward 実装。execute / attack のみ対応 (純 wolf head)。
   *
   * claim_decision / morning は virtualViewerObs(Bundle) が必要なため、Module 側で
   * `mixForward` を直接呼ぶ必要がある (4 引数ではこれら head を呼ぶと throw)。
   */
  forward(
    rootObs: RootObservation,
    state: SimState,
    wolfSeat: number,
    headName: HeadName = 'execute',
  ): NNOutput {
    if (headName !== 'execute' && headName !== 'attack') {
      throw new Error(
        `WolfImitationNetwork.forward: head '${headName}' requires virtualViewerObs(Bundle). ` +
        `Use mixForward(rootObs, virtualViewerObs(Bundle), ...) for claim_decision / morning.`,
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
   * Wolf imitation 専用の mix forward。virtualViewerObs(Bundle) を必要とする
   * claim_decision / morning 用。
   *
   * - claim_decision: virtualViewerObs は Bundle (4 種 obs) を要求
   * - morning: virtualViewerObs は seer obs (Float32Array 単体) を要求
   * - execute / attack で呼ぶと内部的に通常 forward と同じ結果を返す (Module 側の保険)
   *
   * @param rootObs          wolf 観測 (1212 dim)
   * @param virtualViewerObs claim_decision なら Bundle、morning なら seer obs (Float32Array)
   * @param state            legal action mask 用 (per-seat head)
   * @param wolfSeat         行動主体の seat
   * @param headName         'execute' | 'attack' | 'claim_decision' | 'morning'
   */
  mixForward(
    rootObs: RootObservation,
    virtualViewerObs: Float32Array | VirtualViewerObsBundle,
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

    if (headName === 'claim_decision') {
      if (virtualViewerObs instanceof Float32Array) {
        throw new Error('WolfImitationNetwork.mixForward: claim_decision requires VirtualViewerObsBundle (4 viewer obs)')
      }
      const batched = this.frozenVillageBatched
      const forwardBatch = batched?.forwardBatch?.bind(batched)
      if (forwardBatch) {
        // Batched 経路: 4 viewer obs を 1 forwardBatch にまとめて main GPU forward server
        // へ proxy 経由で投げる。worker 跨ぎ集約で batch ~140 まで拡大可能。
        // claim_true は global head なので state.alive / actorSeat は softmax mask に
        // 使われないが、MasonZeroNN.forwardBatch interface 上必要なので渡す。
        const obsList: Float32Array[] = [
          virtualViewerObs.seer,
          virtualViewerObs.medium,
          virtualViewerObs.bodyguard,
          virtualViewerObs.nekomata,
        ]
        const fakeStates: SimState[] = obsList.map(() => state)
        const seats = obsList.map(() => wolfSeat)
        const outputs = forwardBatch(obsList, fakeStates, seats, 'claim_true')
        const policy = mixClaimDecisionFromBatched(wolfResult, outputs)
        return { policy, outcomeDist }
      }
      // Pure JS fallback (test / sequential mode、proxy 経路 disabled)
      const villageResults: Record<SystemRole, ForwardResult> = {
        seer: this.frozenVillage.forward(virtualViewerObs.seer),
        medium: this.frozenVillage.forward(virtualViewerObs.medium),
        bodyguard: this.frozenVillage.forward(virtualViewerObs.bodyguard),
        nekomata: this.frozenVillage.forward(virtualViewerObs.nekomata),
      } as Record<SystemRole, ForwardResult>
      const policy = mixClaimDecision(wolfResult, villageResults)
      return { policy, outcomeDist }
    }

    if (headName === 'morning') {
      // morning は seer 視点のみ (偽占い結果 = 真 seer の divine head と mix)
      const seerObs = virtualViewerObs instanceof Float32Array
        ? virtualViewerObs
        : virtualViewerObs.seer
      const villageResult = this.frozenVillage.forward(seerObs)
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
 * claim_decision (57-dim) の mix。
 *
 * action 0       = skip
 * action 1..14   = seer 騙り (claimer 1..14)
 * action 15..28  = medium 騙り
 * action 29..42  = bodyguard 騙り
 * action 43..56  = nekomata 騙り
 *
 * 入力:
 *   π_w_full       = softmax(wolf.claim_decision_dev)  // 57-dim
 *   α_claim        = softmax(wolf.alpha_claim)[1]
 *   π_v_co_role[2] = softmax(village_role.claim_true)  // 各役職 viewer の [skip, co]
 *
 * Village base 57-dim (4 viewer の意見を等加重 1/4 で混合):
 *   base[skip]                = (1/4) × Σ_role π_v_co_role[skip]   = avg(skip_role)
 *   base[role × 14 + claimer] = (1/4) × π_v_co_role[co] / 14       (claimer 内 uniform)
 *
 * Σ base = (1/4) × Σ_role (skip_role + co_role) = (1/4) × 4 = 1 (normalize 不要)
 *
 * Final:
 *   final = (1 - α_claim) × base + α_claim × π_w_full
 *
 * 解釈: 「seer 騙りすべきか」「medium 騙りすべきか」… を独立な viewer claim_true で評価し、
 * 4 viewer の意見を等加重で混合する。各 role の co 確率は claimer 14 席で uniform に
 * 配分 (村 NN は claimer 嗜好を持たない、wolf NN の deviation で偏らせる)。
 */
export function mixClaimDecision(
  wolf: ForwardResult,
  village: Record<SystemRole, ForwardResult>,
): Map<number, number> {
  const wolfDev = requireLogits(wolf, 'claim_decision_dev')
  const wolfAlpha = requireLogits(wolf, 'alpha_claim')
  const piWFull = softmaxArray(wolfDev)         // 57-dim
  const alphaClaim = softmaxArray(wolfAlpha)[1] // [0,1]

  const numRoles = CLAIM_DECISION_ROLES.length
  // village base 57-dim 構築
  const base = new Float32Array(CLAIM_DECISION_SIZE)
  let baseSkipSum = 0
  for (let roleIdx = 0; roleIdx < numRoles; roleIdx++) {
    const role = CLAIM_DECISION_ROLES[roleIdx]
    const villageCo = requireLogits(village[role], 'claim_true')
    const piVCo = softmaxArray(villageCo) // 2-dim [skip, co]
    baseSkipSum += piVCo[0]
    // 各 role の co prob を 1/numRoles で weight、claimer 14 席で uniform
    const coUniform = piVCo[1] / (numRoles * SEATS)
    const offset = 1 + roleIdx * SEATS
    for (let i = 0; i < SEATS; i++) {
      base[offset + i] = coUniform
    }
  }
  base[0] = baseSkipSum / numRoles

  // mix
  const out = new Map<number, number>()
  const oneMinusAlpha = 1 - alphaClaim
  for (let i = 0; i < CLAIM_DECISION_SIZE; i++) {
    out.set(i, oneMinusAlpha * base[i] + alphaClaim * piWFull[i])
  }
  return out
}

/**
 * mixClaimDecision の batched 入力版。
 *
 * `mixClaimDecision` と同じ計算を、4 viewer の `claim_true` policy (global head の softmax 済
 * Map<0, p_skip> + Map<1, p_co>) を順序固定 (CLAIM_DECISION_ROLES = seer/medium/bg/nekomata)
 * で受け取って実行する。
 *
 * proxy 経路 (ProxiedMasonZeroNN.forwardBatch) からの戻り値 (NNOutput[]) を直接渡せるよう
 * に NNOutput を受け取る (内部で .policy のみ使う、outcomeDist は無視)。
 *
 * 数値的には `mixClaimDecision` と同等 (softmax 済 vs raw logits の違いだけ)。
 */
export function mixClaimDecisionFromBatched(
  wolf: ForwardResult,
  villageBatched: NNOutput[],
): Map<number, number> {
  if (villageBatched.length !== VIEWER_ORDER.length) {
    throw new Error(
      `mixClaimDecisionFromBatched: expected ${VIEWER_ORDER.length} viewers, got ${villageBatched.length}`,
    )
  }
  const wolfDev = requireLogits(wolf, 'claim_decision_dev')
  const wolfAlpha = requireLogits(wolf, 'alpha_claim')
  const piWFull = softmaxArray(wolfDev)         // 57-dim
  const alphaClaim = softmaxArray(wolfAlpha)[1] // [0,1]

  const numRoles = VIEWER_ORDER.length
  const base = new Float32Array(CLAIM_DECISION_SIZE)
  let baseSkipSum = 0
  for (let roleIdx = 0; roleIdx < numRoles; roleIdx++) {
    const policy = villageBatched[roleIdx].policy
    const pSkip = policy.get(0) ?? 0
    const pCo = policy.get(1) ?? 0
    baseSkipSum += pSkip
    const coUniform = pCo / (numRoles * SEATS)
    const offset = 1 + roleIdx * SEATS
    for (let i = 0; i < SEATS; i++) {
      base[offset + i] = coUniform
    }
  }
  base[0] = baseSkipSum / numRoles

  const out = new Map<number, number>()
  const oneMinusAlpha = 1 - alphaClaim
  for (let i = 0; i < CLAIM_DECISION_SIZE; i++) {
    out.set(i, oneMinusAlpha * base[i] + alphaClaim * piWFull[i])
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
