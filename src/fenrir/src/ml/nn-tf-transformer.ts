/**
 * tf.js-node-gpu ベースの Transformer Network 実装
 *
 * TfNeuralNetwork と同じインターフェースを維持。
 * Transformer Encoder で観測をトークン化して処理する。
 */

// @ts-ignore — tf.js-node-gpu は CJS だが ESM から import 可能
import * as tf from '@tensorflow/tfjs-node-gpu'
import type { NetworkConfig, ForwardResult, TransformerNetworkConfig } from './nn.ts'
import {
  SEATS, NUM_ROLES,
  HISTORY_WINDOW, OBSERVATION_SIZE,
  PLAN_TOKEN_FEATURES, MAX_PLAN_TOKENS,
  ROLE_TOKEN_FEATURES, NUM_ROLE_TOKENS, ROLE_INDEX, CO_ROLES,
  type ObservationMode,
} from '../observation.ts'

let _tfTransformerId = 0

// ============================================================
// Token index maps (pre-computed for tf.gather)
// ============================================================

// observation.tsのオフセット定数を再計算（importできないのでここで定義）
const GLOBAL_SIZE = 19
const PER_SEAT_SIZE = 25
const PER_SEAT_START = GLOBAL_SIZE
const PRIVATE_START = PER_SEAT_START + SEATS * PER_SEAT_SIZE  // 369
const DIVINE_START = PRIVATE_START
const WOLF_TEAM_START = DIVINE_START + SEATS
const MASON_PARTNER_START = WOLF_TEAM_START + SEATS
const GUARD_HISTORY_START = MASON_PARTNER_START + 1
const KNOWN_HAMSTER_START = GUARD_HISTORY_START + SEATS
const PRIVATE_SIZE = SEATS + SEATS + 1 + SEATS + 1
const REVOTE_START = PRIVATE_START + PRIVATE_SIZE
const REVOTE_ROUND_START = REVOTE_START
const REVOTE_CANDIDATES_START = REVOTE_START + 1
const REVOTE_SIZE = 1 + SEATS
const HISTORY_START = REVOTE_START + REVOTE_SIZE
const HISTORY_DAY_SIZE = SEATS * 5
const HISTORY_SIZE = HISTORY_WINDOW * HISTORY_DAY_SIZE
const RETAR_START = HISTORY_START + HISTORY_SIZE
const RETAR_SIZE = SEATS * NUM_ROLES
const GLOBAL_RETAR_START = RETAR_START + RETAR_SIZE
const GLOBAL_RETAR_SIZE = SEATS * NUM_ROLES
const PLAN_START = GLOBAL_RETAR_START + GLOBAL_RETAR_SIZE
const PLAN_INCLUDED_START = PLAN_START
const PLAN_POSITION_START = PLAN_START + SEATS
const PLAN_GLOBAL_START = PLAN_START + SEATS * 2
const PLAN_SIZE = SEATS * 2 + 3  // 31
const PLAN_APPROVED_START = PLAN_START + PLAN_SIZE
const PLAN_APPROVED_SIZE = SEATS
const NEW_SIGNALS_PER_SEAT = 4
const NEW_SIGNALS_START = PLAN_APPROVED_START + PLAN_APPROVED_SIZE
const NEW_SIGNALS_SIZE = SEATS * NEW_SIGNALS_PER_SEAT
const PLAN_TOKENS_SIZE = 1 + MAX_PLAN_TOKENS * PLAN_TOKEN_FEATURES
const TSUMI_START = NEW_SIGNALS_START + NEW_SIGNALS_SIZE + PLAN_TOKENS_SIZE

// Team offsets
const TEAM_SIZE_START = OBSERVATION_SIZE
const TEAM_IS_MY_TEAM_START = TEAM_SIZE_START + 1
const TEAM_IS_CURRENT_ACTOR_START = TEAM_IS_MY_TEAM_START + SEATS
const TEAM_FAKE_DIVINE_START = TEAM_IS_CURRENT_ACTOR_START + SEATS

// Collective offsets (OBSERVATION_SIZEの直後に配置)
const COLLECTIVE_TEAM_SIZE_START = OBSERVATION_SIZE
const WOLF_COLL_FAKE_DIVINE_START = COLLECTIVE_TEAM_SIZE_START + 1
const WOLF_COLL_VILLAGE_PREDICT_START = WOLF_COLL_FAKE_DIVINE_START + SEATS
const WOLF_COLL_VILLAGE_TRUST_START = WOLF_COLL_VILLAGE_PREDICT_START + SEATS * NUM_ROLES

// Fanatic offsets (OBSERVATION_SIZEの直後に配置 — team_sizeなし)
const FANATIC_VILLAGE_PREDICT_START = OBSERVATION_SIZE
const FANATIC_VILLAGE_TRUST_START = FANATIC_VILLAGE_PREDICT_START + SEATS * NUM_ROLES

/** CLSトークンのインデックス配列を構築 */
function buildClsIndices(mode: ObservationMode): number[] {
  const indices: number[] = []
  // global (19)
  for (let i = 0; i < GLOBAL_SIZE; i++) indices.push(i)
  // mason_partner (1)
  indices.push(MASON_PARTNER_START)
  // known_hamster (1)
  indices.push(KNOWN_HAMSTER_START)
  // revote_round (1)
  indices.push(REVOTE_ROUND_START)
  // plan_global (3)
  indices.push(PLAN_GLOBAL_START, PLAN_GLOBAL_START + 1, PLAN_GLOBAL_START + 2)
  // tsumi (1)
  indices.push(TSUMI_START)
  // team_size (1) — team/collective共通
  if (mode === 'team') indices.push(TEAM_SIZE_START)
  else if (mode === 'wolf_collective' || mode === 'mason_collective') indices.push(COLLECTIVE_TEAM_SIZE_START)
  return indices
}

/** 全席トークンのインデックス配列を構築 [SEATS * seatFeatures] */
function buildSeatIndices(mode: ObservationMode): number[] {
  const indices: number[] = []
  for (let s = 0; s < SEATS; s++) {
    // per_seat (25)
    const psOff = PER_SEAT_START + s * PER_SEAT_SIZE
    for (let i = 0; i < PER_SEAT_SIZE; i++) indices.push(psOff + i)
    // private per-seat (4)
    indices.push(DIVINE_START + s)
    indices.push(WOLF_TEAM_START + s)
    indices.push(GUARD_HISTORY_START + s)
    indices.push(REVOTE_CANDIDATES_START + s)
    // history (3 × 5 = 15)
    for (let w = 0; w < HISTORY_WINDOW; w++) {
      const hOff = HISTORY_START + w * HISTORY_DAY_SIZE + s * 5
      for (let i = 0; i < 5; i++) indices.push(hOff + i)
    }
    // retar — 自分視点 (11)
    const rOff = RETAR_START + s * NUM_ROLES
    for (let i = 0; i < NUM_ROLES; i++) indices.push(rOff + i)
    // global retar — 公開情報のみ (11)
    const grOff = GLOBAL_RETAR_START + s * NUM_ROLES
    for (let i = 0; i < NUM_ROLES; i++) indices.push(grOff + i)
    // plan (2)
    indices.push(PLAN_INCLUDED_START + s)
    indices.push(PLAN_POSITION_START + s)
    // plan_approved (1)
    indices.push(PLAN_APPROVED_START + s)
    // new signals (4): confirm_human, confirm_wolf, vote_for, vote_against
    const nsOff = NEW_SIGNALS_START + s * NEW_SIGNALS_PER_SEAT
    for (let i = 0; i < NEW_SIGNALS_PER_SEAT; i++) indices.push(nsOff + i)
    // team per-seat (3): is_my_team, is_current_actor, fake_divine
    if (mode === 'team') {
      indices.push(TEAM_IS_MY_TEAM_START + s)
      indices.push(TEAM_IS_CURRENT_ACTOR_START + s)
      indices.push(TEAM_FAKE_DIVINE_START + s)
    }
    // wolf_collective per-seat (+13): village_predict(11), village_trust(1), fake_divine(1)
    if (mode === 'wolf_collective') {
      const vpOff = WOLF_COLL_VILLAGE_PREDICT_START + s * NUM_ROLES
      for (let i = 0; i < NUM_ROLES; i++) indices.push(vpOff + i)
      indices.push(WOLF_COLL_VILLAGE_TRUST_START + s)
      indices.push(WOLF_COLL_FAKE_DIVINE_START + s)
    }
    // mason_collective: same as individual (no extra per-seat)
    // fanatic per-seat (+12): village_predict(11), village_trust(1)
    if (mode === 'fanatic') {
      const vpOff = FANATIC_VILLAGE_PREDICT_START + s * NUM_ROLES
      for (let i = 0; i < NUM_ROLES; i++) indices.push(vpOff + i)
      indices.push(FANATIC_VILLAGE_TRUST_START + s)
    }
  }
  return indices
}

/**
 * Role tokenインデックス構築 — CO可能5役職ごとに、各席のclaimed_role one-hotの該当位置を返す
 * 結果: [NUM_ROLE_TOKENS * (1 + SEATS)] のインデックス配列
 * 各Role token: co_count_placeholder(1, 後で計算) + co_seats(14, 各席のclaimed_role[roleIdx])
 */
function buildRoleTokenSeatClaimIndices(): { roleIdx: number, seatClaimOffsets: number[] }[] {
  return CO_ROLES.map(role => {
    const roleIdx = ROLE_INDEX.get(role)!
    const seatClaimOffsets: number[] = []
    for (let s = 0; s < SEATS; s++) {
      // claimed_role one-hot starts at per_seat offset + 1 (after alive flag)
      seatClaimOffsets.push(PER_SEAT_START + s * PER_SEAT_SIZE + 1 + roleIdx)
    }
    return { roleIdx, seatClaimOffsets }
  })
}

// ============================================================
// TfTransformerNetwork
// ============================================================

export class TfTransformerNetwork {
  readonly config: NetworkConfig
  readonly tConfig: TransformerNetworkConfig

  // Input projection weights
  private projClsW: tf.Variable
  private projClsB: tf.Variable
  private projSeatW: tf.Variable
  private projSeatB: tf.Variable
  private projRoleW: tf.Variable
  private projRoleB: tf.Variable

  // Transformer layer type
  private static readonly LayerShape = {} as {
    ln1Scale: tf.Variable, ln1Bias: tf.Variable
    wQ: tf.Variable, bQ: tf.Variable
    wK: tf.Variable, bK: tf.Variable
    wV: tf.Variable, bV: tf.Variable
    wO: tf.Variable, bO: tf.Variable
    ln2Scale: tf.Variable, ln2Bias: tf.Variable
    ffnW1: tf.Variable, ffnB1: tf.Variable
    ffnW2: tf.Variable, ffnB2: tf.Variable
  }
  // 2-stage encoder layers
  private seatLayers: (typeof TfTransformerNetwork.LayerShape)[]
  private seatFinalLnScale: tf.Variable
  private seatFinalLnBias: tf.Variable
  private stratLayers: (typeof TfTransformerNetwork.LayerShape)[]
  private stratFinalLnScale: tf.Variable
  private stratFinalLnBias: tf.Variable

  // Learnable Forward/Endgame embeddings
  private forwardEmbeddings: tf.Variable    // [numForward, dModel]
  private endgameEmbeddings: tf.Variable    // [numEndgame, dModel]

  // Pointer mechanism
  private pointerQueryW: tf.Variable
  private pointerQueryB: tf.Variable
  private pointerKeyW: tf.Variable
  private pointerKeyB: tf.Variable
  private specialKeys: tf.Variable          // [3, dModel] grayran/next/stop

  // Head weights
  private perSeatHeadWeights: Map<string, [tf.Variable, tf.Variable]>  // [dModel, 1]
  private perSeatSigmoidHeadWeights: Map<string, [tf.Variable, tf.Variable]>
  private globalHeadWeights: Map<string, [tf.Variable, tf.Variable]>
  private globalSigmoidHeadWeights: Map<string, [tf.Variable, tf.Variable]>
  private nightSeatW: tf.Variable | null = null
  private nightSeatB: tf.Variable | null = null
  private nightClsW: tf.Variable | null = null
  private nightClsB: tf.Variable | null = null
  private valueW: tf.Variable
  private valueB: tf.Variable

  private allVariables: tf.Variable[]
  /** trunk + plan head のみ (supervised pretrain で他 head を凍結するため) */
  private trunkAndPlanVariables: tf.Variable[]
  private optimizer: tf.AdamOptimizer

  // Pre-computed index tensors for tokenization
  private clsGatherIndices: tf.Tensor1D
  private seatGatherIndices: tf.Tensor1D

  // Config
  private readonly observationMode: ObservationMode
  private readonly dm: number
  private readonly numHeads: number
  private readonly dHead: number

  constructor(config: NetworkConfig, lr: number = 3e-4, isTeam: boolean | ObservationMode = false) {
    if (!config.transformer) throw new Error('NetworkConfig.transformer required')

    const prefix = `tftr${_tfTransformerId++}_`
    this.config = config
    this.tConfig = config.transformer
    // 後方互換: boolean → ObservationMode
    if (typeof isTeam === 'boolean') {
      this.observationMode = isTeam ? 'team' : 'individual'
    } else {
      this.observationMode = isTeam
    }
    this.allVariables = []

    const tc = this.tConfig
    this.dm = tc.dModel
    this.numHeads = tc.numHeads
    this.dHead = tc.dModel / tc.numHeads


    const dm = this.dm
    const cf = tc.clsFeatures
    const sf = tc.seatFeatures

    // Gather indices
    this.clsGatherIndices = tf.tensor1d(buildClsIndices(this.observationMode), 'int32')
    this.seatGatherIndices = tf.tensor1d(buildSeatIndices(this.observationMode), 'int32')

    // Input projections
    const rf = tc.roleFeatures ?? ROLE_TOKEN_FEATURES
    this.projClsW = this.makeVar([cf, dm], cf, `${prefix}proj_cls_w`)
    this.projClsB = this.makeZeroVar([dm], `${prefix}proj_cls_b`)
    this.projSeatW = this.makeVar([sf, dm], sf, `${prefix}proj_seat_w`)
    this.projSeatB = this.makeZeroVar([dm], `${prefix}proj_seat_b`)
    this.projRoleW = this.makeVar([rf, dm], rf, `${prefix}proj_role_w`)
    this.projRoleB = this.makeZeroVar([dm], `${prefix}proj_role_b`)

    const makeTransformerLayers = (count: number, tag: string) => {
      const layers: (typeof TfTransformerNetwork.LayerShape)[] = []
      for (let l = 0; l < count; l++) {
        const layer = {
          ln1Scale: tf.variable(tf.ones([dm]), true, `${prefix}${tag}${l}_ln1_s`),
          ln1Bias: this.makeZeroVar([dm], `${prefix}${tag}${l}_ln1_b`),
          wQ: this.makeVar([dm, dm], dm, `${prefix}${tag}${l}_wq`),
          bQ: this.makeZeroVar([dm], `${prefix}${tag}${l}_bq`),
          wK: this.makeVar([dm, dm], dm, `${prefix}${tag}${l}_wk`),
          bK: this.makeZeroVar([dm], `${prefix}${tag}${l}_bk`),
          wV: this.makeVar([dm, dm], dm, `${prefix}${tag}${l}_wv`),
          bV: this.makeZeroVar([dm], `${prefix}${tag}${l}_bv`),
          wO: this.makeVar([dm, dm], dm, `${prefix}${tag}${l}_wo`),
          bO: this.makeZeroVar([dm], `${prefix}${tag}${l}_bo`),
          ln2Scale: tf.variable(tf.ones([dm]), true, `${prefix}${tag}${l}_ln2_s`),
          ln2Bias: this.makeZeroVar([dm], `${prefix}${tag}${l}_ln2_b`),
          ffnW1: this.makeVar([dm, tc.dFf], dm, `${prefix}${tag}${l}_ff1w`),
          ffnB1: this.makeZeroVar([tc.dFf], `${prefix}${tag}${l}_ff1b`),
          ffnW2: this.makeVar([tc.dFf, dm], tc.dFf, `${prefix}${tag}${l}_ff2w`),
          ffnB2: this.makeZeroVar([dm], `${prefix}${tag}${l}_ff2b`),
        }
        this.allVariables.push(
          layer.ln1Scale, layer.ln1Bias,
          layer.wQ, layer.bQ, layer.wK, layer.bK, layer.wV, layer.bV, layer.wO, layer.bO,
          layer.ln2Scale, layer.ln2Bias,
          layer.ffnW1, layer.ffnB1, layer.ffnW2, layer.ffnB2,
        )
        layers.push(layer)
      }
      return layers
    }

    // Seat Transformer (N layers)
    const numSeatLayers = tc.seatLayers ?? tc.numLayers ?? 3
    this.seatLayers = makeTransformerLayers(numSeatLayers, 'seat')
    this.seatFinalLnScale = tf.variable(tf.ones([dm]), true, `${prefix}seat_fln_s`)
    this.seatFinalLnBias = this.makeZeroVar([dm], `${prefix}seat_fln_b`)
    this.allVariables.push(this.seatFinalLnScale, this.seatFinalLnBias)

    // Strategy Layer (M layers)
    const numStratLayers = tc.strategyLayers ?? 2
    this.stratLayers = makeTransformerLayers(numStratLayers, 'strat')
    this.stratFinalLnScale = tf.variable(tf.ones([dm]), true, `${prefix}strat_fln_s`)
    this.stratFinalLnBias = this.makeZeroVar([dm], `${prefix}strat_fln_b`)
    this.allVariables.push(this.stratFinalLnScale, this.stratFinalLnBias)

    // Learnable Forward/Endgame embeddings
    const numForward = tc.numForwardTokens ?? 8
    const numEndgame = tc.numEndgameTokens ?? 4
    this.forwardEmbeddings = tf.variable(
      tf.randomNormal([numForward, dm], 0, 0.02), true, `${prefix}fwd_emb`,
    )
    this.endgameEmbeddings = tf.variable(
      tf.randomNormal([numEndgame, dm], 0, 0.02), true, `${prefix}eg_emb`,
    )
    this.allVariables.push(this.forwardEmbeddings, this.endgameEmbeddings)

    // Pointer mechanism
    this.pointerQueryW = this.makeVar([dm, dm], dm, `${prefix}ptr_q_w`)
    this.pointerQueryB = this.makeZeroVar([dm], `${prefix}ptr_q_b`)
    this.pointerKeyW = this.makeVar([dm, dm], dm, `${prefix}ptr_k_w`)
    this.pointerKeyB = this.makeZeroVar([dm], `${prefix}ptr_k_b`)
    this.specialKeys = tf.variable(
      tf.randomNormal([3, dm], 0, 0.02), true, `${prefix}special_keys`,
    )
    this.allVariables.push(this.pointerQueryW, this.pointerQueryB,
      this.pointerKeyW, this.pointerKeyB, this.specialKeys)

    // Heads
    const perSeatSet = new Set(tc.perSeatHeads)
    const perSeatSigmoidSet = new Set(tc.perSeatSigmoidHeads ?? [])

    this.perSeatHeadWeights = new Map()
    this.perSeatSigmoidHeadWeights = new Map()
    this.globalHeadWeights = new Map()
    this.globalSigmoidHeadWeights = new Map()

    for (const [name, outputSize] of Object.entries(config.heads)) {
      if (name === 'night') {
        this.nightSeatW = this.makeVar([dm, 1], dm, `${prefix}h_night_seat_w`)
        this.nightSeatB = this.makeZeroVar([1], `${prefix}h_night_seat_b`)
        this.nightClsW = this.makeVar([dm, 1], dm, `${prefix}h_night_cls_w`)
        this.nightClsB = this.makeZeroVar([1], `${prefix}h_night_cls_b`)
        this.allVariables.push(this.nightSeatW, this.nightSeatB, this.nightClsW, this.nightClsB)
      } else if (perSeatSet.has(name)) {
        const w = this.makeVar([dm, 1], dm, `${prefix}h_${name}_w`)
        const b = this.makeZeroVar([1], `${prefix}h_${name}_b`)
        this.perSeatHeadWeights.set(name, [w, b])
        this.allVariables.push(w, b)
      } else {
        const w = this.makeVar([dm, outputSize], dm, `${prefix}h_${name}_w`)
        const b = this.makeZeroVar([outputSize], `${prefix}h_${name}_b`)
        this.globalHeadWeights.set(name, [w, b])
        this.allVariables.push(w, b)
      }
    }

    for (const [name, outputSize] of Object.entries(config.sigmoidHeads ?? {})) {
      if (perSeatSigmoidSet.has(name)) {
        const perDim = outputSize / SEATS
        const w = this.makeVar([dm, perDim], dm, `${prefix}h_${name}_w`)
        const b = this.makeZeroVar([perDim], `${prefix}h_${name}_b`)
        this.perSeatSigmoidHeadWeights.set(name, [w, b])
        this.allVariables.push(w, b)
      } else {
        const w = this.makeVar([dm, outputSize], dm, `${prefix}h_${name}_w`)
        const b = this.makeZeroVar([outputSize], `${prefix}h_${name}_b`)
        this.globalSigmoidHeadWeights.set(name, [w, b])
        this.allVariables.push(w, b)
      }
    }

    this.valueW = this.makeVar([dm, 1], dm, `${prefix}value_w`)
    this.valueB = this.makeZeroVar([1], `${prefix}value_b`)
    this.allVariables.push(this.valueW, this.valueB)

    // trunk + plan head のみ: action heads (h_*) と value head を除外
    this.trunkAndPlanVariables = this.allVariables.filter(v => {
      const n = v.name
      if (n.includes('value_')) return false
      if (n.includes('_h_')) return false
      return true
    })

    this.optimizer = tf.train.adam(lr)
  }

  /** 学習率を変更（optimizer を再作成） */
  setLearningRate(lr: number): void {
    this.optimizer = tf.train.adam(lr)
  }

  // ============================================================
  // Helper: variable creation
  // ============================================================

  private makeVar(shape: number[], fanIn: number, name: string): tf.Variable {
    const v = tf.variable(
      tf.randomNormal(shape, 0, Math.sqrt(2 / fanIn)),
      true, name,
    )
    return v
  }

  private makeZeroVar(shape: number[], name: string): tf.Variable {
    return tf.variable(tf.zeros(shape), true, name)
  }

  // ============================================================
  // Tokenize: obs tensor → token sequence
  // ============================================================

  /**
   * バッチ観測テンソルからトークンシーケンスを構築 (Seat Transformer入力: CLS+Seat+Role = 20)
   */
  private tokenizeAndProject(obsTensor: tf.Tensor2D): tf.Tensor3D {
    const batch = obsTensor.shape[0]
    const sf = this.tConfig.seatFeatures
    const numRoles = this.tConfig.numRoleTokens ?? NUM_ROLE_TOKENS
    const rf = this.tConfig.roleFeatures ?? ROLE_TOKEN_FEATURES

    // CLS: [batch, clsFeatures] → [batch, 1, dModel]
    const clsRaw = tf.gather(obsTensor, this.clsGatherIndices, 1)
    const clsProj = tf.add(tf.matMul(clsRaw, this.projClsW), this.projClsB)
    const clsToken = clsProj.reshape([batch, 1, this.dm])

    // Seats: [batch, SEATS*sf] → [batch, SEATS, dModel]
    const seatRaw = tf.gather(obsTensor, this.seatGatherIndices, 1)
    const seatProj = tf.add(
      tf.matMul(seatRaw.reshape([batch * SEATS, sf]), this.projSeatW),
      this.projSeatB,
    )
    const seatTokens = seatProj.reshape([batch, SEATS, this.dm])

    // Role tokens: build from claimed_role in observation
    // For each CO role, extract co_count + co_seats from per-seat data
    const roleInfo = buildRoleTokenSeatClaimIndices()
    const roleFeatureArrays: tf.Tensor[] = []
    for (const { seatClaimOffsets } of roleInfo) {
      // Gather claimed_role flags for this role from all seats: [batch, SEATS]
      const claimFlags = tf.gather(obsTensor, tf.tensor1d(seatClaimOffsets, 'int32'), 1)
      // co_count: sum of flags, normalized by SEATS
      const coCount = tf.sum(claimFlags, 1, true).div(tf.scalar(SEATS))  // [batch, 1]
      // [batch, 1 + SEATS] = [co_count, co_seats]
      roleFeatureArrays.push(tf.concat([coCount, claimFlags], 1))
    }
    // Stack: [batch, numRoles, rf]
    const roleRaw = tf.stack(roleFeatureArrays, 1)  // [batch, numRoles, rf]
    const roleProj = tf.add(
      tf.matMul(roleRaw.reshape([batch * numRoles, rf]), this.projRoleW),
      this.projRoleB,
    )
    const roleTokens = roleProj.reshape([batch, numRoles, this.dm])

    // Concat: [CLS, Seat0..13, Role0..4] → [batch, 20, dModel]
    return tf.concat([clsToken, seatTokens, roleTokens], 1) as tf.Tensor3D
  }

  // ============================================================
  // Transformer forward
  // ============================================================

  /**
   * LayerNorm: normalize last dim
   * x: [..., dModel], scale/bias: [dModel]
   */
  private layerNorm(x: tf.Tensor, scale: tf.Variable, bias: tf.Variable): tf.Tensor {
    const mean = tf.mean(x, -1, true)
    const variance = tf.mean(tf.square(tf.sub(x, mean)), -1, true)
    const normalized = tf.div(tf.sub(x, mean), tf.sqrt(tf.add(variance, tf.scalar(1e-5))))
    return tf.add(tf.mul(normalized, scale), bias)
  }

  /**
   * Multi-head self-attention
   * tokens: [batch, seq, dModel]
   * Returns: [batch, seq, dModel]
   */
  private multiHeadAttention(
    tokens: tf.Tensor3D,
    wQ: tf.Variable, bQ: tf.Variable,
    wK: tf.Variable, bK: tf.Variable,
    wV: tf.Variable, bV: tf.Variable,
    wO: tf.Variable, bO: tf.Variable,
  ): tf.Tensor3D {
    const batch = tokens.shape[0]
    const seq = tokens.shape[1]
    const nh = this.numHeads
    const dh = this.dHead

    // Reshape tokens for batched matmul: [batch * seq, dModel]
    const flat = tokens.reshape([batch * seq, this.dm])

    // QKV projections: [batch * seq, dModel]
    const qFlat = tf.add(tf.matMul(flat, wQ), bQ)
    const kFlat = tf.add(tf.matMul(flat, wK), bK)
    const vFlat = tf.add(tf.matMul(flat, wV), bV)

    // Reshape to [batch, seq, heads, d_head] → transpose to [batch, heads, seq, d_head]
    const q = qFlat.reshape([batch, seq, nh, dh]).transpose([0, 2, 1, 3])
    const k = kFlat.reshape([batch, seq, nh, dh]).transpose([0, 2, 1, 3])
    const v = vFlat.reshape([batch, seq, nh, dh]).transpose([0, 2, 1, 3])

    // Attention: [batch, heads, seq, seq]
    const scores = tf.mul(
      tf.matMul(q, k, false, true),
      tf.scalar(1 / Math.sqrt(dh)),
    )
    const attnWeights = tf.softmax(scores, -1)

    // Weighted sum: [batch, heads, seq, d_head]
    const context = tf.matMul(attnWeights, v)

    // Reshape back: [batch, seq, dModel]
    const contextFlat = context.transpose([0, 2, 1, 3]).reshape([batch * seq, this.dm])

    // Output projection
    const output = tf.add(tf.matMul(contextFlat, wO), bO)
    return output.reshape([batch, seq, this.dm]) as tf.Tensor3D
  }

  /**
   * Transformer encoder forward (汎用: 任意のlayer配列+finalLN)
   */
  private forwardEncoder(
    tokens: tf.Tensor3D,
    layers: (typeof TfTransformerNetwork.LayerShape)[],
    finalLnScale: tf.Variable,
    finalLnBias: tf.Variable,
  ): tf.Tensor3D {
    let x = tokens

    for (const layer of layers) {
      const normed1 = this.layerNorm(x, layer.ln1Scale, layer.ln1Bias) as tf.Tensor3D
      const attnOut = this.multiHeadAttention(
        normed1,
        layer.wQ, layer.bQ, layer.wK, layer.bK, layer.wV, layer.bV, layer.wO, layer.bO,
      )
      x = tf.add(x, attnOut) as tf.Tensor3D

      const normed2 = this.layerNorm(x, layer.ln2Scale, layer.ln2Bias) as tf.Tensor3D
      const batch = x.shape[0]
      const seq = x.shape[1]
      const flat = normed2.reshape([batch * seq, this.dm])
      const hidden = tf.relu(tf.add(tf.matMul(flat, layer.ffnW1), layer.ffnB1))
      const ffnOut = tf.add(tf.matMul(hidden, layer.ffnW2), layer.ffnB2)
      x = tf.add(x, ffnOut.reshape([batch, seq, this.dm])) as tf.Tensor3D
    }

    return this.layerNorm(x, finalLnScale, finalLnBias) as tf.Tensor3D
  }

  // ============================================================
  // Head readout helpers
  // ============================================================

  /**
   * Per-seat head logits: seat_outputs @ w + b → [batch, SEATS]
   * seatOutputs: [batch, SEATS, dModel], w: [dModel, 1], b: [1]
   */
  private perSeatLogits(seatOutputs: tf.Tensor3D, w: tf.Variable, b: tf.Variable): tf.Tensor2D {
    const batch = seatOutputs.shape[0]
    // [batch * SEATS, dModel] @ [dModel, 1] → [batch * SEATS, 1]
    const flat = seatOutputs.reshape([batch * SEATS, this.dm])
    const logits = tf.add(tf.matMul(flat, w), b)
    return logits.reshape([batch, SEATS]) as tf.Tensor2D
  }

  /**
   * Per-seat sigmoid head: [batch, SEATS, dModel] → [batch, SEATS * perDim]
   */
  private perSeatSigmoidLogits(seatOutputs: tf.Tensor3D, w: tf.Variable, b: tf.Variable): tf.Tensor2D {
    const batch = seatOutputs.shape[0]
    const perDim = w.shape[1]!
    const flat = seatOutputs.reshape([batch * SEATS, this.dm])
    const logits = tf.add(tf.matMul(flat, w), b)
    return logits.reshape([batch, SEATS * perDim]) as tf.Tensor2D
  }

  /**
   * Trunk forward: obs → Seat Transformer → Strategy Layer → outputs
   */
  private forwardTrunk(obsTensor: tf.Tensor2D): {
    clsOut: tf.Tensor2D
    seatOutputs: tf.Tensor3D
    planForwardLogits: tf.Tensor2D   // [batch, numForward * vocabSize]
    planEndgameLogits: tf.Tensor2D   // [batch, numEndgame * vocabSize]
  } {
    const batch = obsTensor.shape[0]
    const numRoles = this.tConfig.numRoleTokens ?? NUM_ROLE_TOKENS
    const numForward = this.tConfig.numForwardTokens ?? 8
    const numEndgame = this.tConfig.numEndgameTokens ?? 4
    const seatSeqLen = 1 + SEATS + numRoles  // 20

    // Stage 1: Seat Transformer
    const seatInput = this.tokenizeAndProject(obsTensor)  // [batch, 20, dm]
    const seatEncoded = this.forwardEncoder(
      seatInput, this.seatLayers, this.seatFinalLnScale, this.seatFinalLnBias,
    )  // [batch, 20, dm]

    // Stage 2: Strategy Layer
    // Append Forward + Endgame embeddings (broadcast to batch)
    const fwdEmb = this.forwardEmbeddings.expandDims(0).tile([batch, 1, 1])  // [batch, numForward, dm]
    const egEmb = this.endgameEmbeddings.expandDims(0).tile([batch, 1, 1])   // [batch, numEndgame, dm]
    const stratInput = tf.concat([seatEncoded, fwdEmb, egEmb], 1) as tf.Tensor3D  // [batch, 32, dm]
    const stratEncoded = this.forwardEncoder(
      stratInput, this.stratLayers, this.stratFinalLnScale, this.stratFinalLnBias,
    )  // [batch, 32, dm]

    // Extract outputs
    const clsOut = stratEncoded.slice([0, 0, 0], [batch, 1, this.dm]).reshape([batch, this.dm]) as tf.Tensor2D
    const seatOutputs = stratEncoded.slice([0, 1, 0], [batch, SEATS, this.dm]) as tf.Tensor3D

    // Pointer mechanism for Forward and Endgame tokens
    // Keys from seat + role tokens: [batch, SEATS+numRoles, dm]
    const targetTokens = stratEncoded.slice([0, 1, 0], [batch, SEATS + numRoles, this.dm])
    // Project keys: [batch * (SEATS+numRoles), dm]
    const numTargets = SEATS + numRoles
    const targetFlat = targetTokens.reshape([batch * numTargets, this.dm])
    const projectedKeys = tf.add(tf.matMul(targetFlat, this.pointerKeyW), this.pointerKeyB)
      .reshape([batch, numTargets, this.dm])  // [batch, 19, dm]
    // Append special keys: [batch, 19+3, dm] = [batch, 22, dm]
    const specialExpanded = this.specialKeys.expandDims(0).tile([batch, 1, 1])  // [batch, 3, dm]
    const allKeys = tf.concat([projectedKeys, specialExpanded], 1) as tf.Tensor3D  // [batch, 22, dm]

    const computePointer = (startIdx: number, count: number): tf.Tensor2D => {
      // Extract plan tokens: [batch, count, dm]
      const planTokens = stratEncoded.slice([0, startIdx, 0], [batch, count, this.dm])
      // Project queries: [batch * count, dm]
      const queryFlat = planTokens.reshape([batch * count, this.dm])
      const queries = tf.add(tf.matMul(queryFlat, this.pointerQueryW), this.pointerQueryB)
        .reshape([batch, count, this.dm])  // [batch, count, dm]
      // Dot product: [batch, count, 22] — 14 seats + 5 roles + 3 special = PLAN_VOCAB.SIZE
      const scale = tf.scalar(1 / Math.sqrt(this.dm))
      const scores = tf.mul(tf.matMul(queries, allKeys, false, true), scale)  // [batch, count, 22]
      // Flatten: [batch, count * 22]
      return scores.reshape([batch, count * (numTargets + 3)]) as tf.Tensor2D
    }

    const planForwardLogits = computePointer(seatSeqLen, numForward)
    const planEndgameLogits = computePointer(seatSeqLen + numForward, numEndgame)

    return { clsOut, seatOutputs, planForwardLogits, planEndgameLogits }
  }

  /**
   * All head logits from trunk outputs.
   * Returns Map<headName, [batch, headSize]>
   */
  private computeAllHeadLogits(
    clsOut: tf.Tensor2D, seatOutputs: tf.Tensor3D,
    planForwardLogits: tf.Tensor2D, planEndgameLogits: tf.Tensor2D,
  ): Map<string, tf.Tensor2D> {
    const result = new Map<string, tf.Tensor2D>()

    // Per-seat softmax heads
    for (const [name, [w, b]] of this.perSeatHeadWeights) {
      result.set(name, this.perSeatLogits(seatOutputs, w, b))
    }

    // Night head
    if (this.nightSeatW) {
      const seatPart = this.perSeatLogits(seatOutputs, this.nightSeatW, this.nightSeatB!)
      const clsPart = tf.add(tf.matMul(clsOut, this.nightClsW!), this.nightClsB!) as tf.Tensor2D
      result.set('night', tf.concat([seatPart, clsPart], 1) as tf.Tensor2D)
    }

    // Per-seat sigmoid heads
    for (const [name, [w, b]] of this.perSeatSigmoidHeadWeights) {
      result.set(name, this.perSeatSigmoidLogits(seatOutputs, w, b))
    }

    // Global heads
    for (const [name, [w, b]] of this.globalHeadWeights) {
      result.set(name, tf.add(tf.matMul(clsOut, w), b) as tf.Tensor2D)
    }
    for (const [name, [w, b]] of this.globalSigmoidHeadWeights) {
      result.set(name, tf.add(tf.matMul(clsOut, w), b) as tf.Tensor2D)
    }

    // Plan pointer logits
    result.set('plan_forward', planForwardLogits)
    result.set('plan_endgame', planEndgameLogits)

    return result
  }

  // ============================================================
  // Public API
  // ============================================================

  /** 単一サンプルの推論 */
  forward(input: Float32Array): ForwardResult {
    const policies = new Map<string, Float32Array>()
    let value = 0

    tf.tidy(() => {
      const obsTensor = tf.tensor2d(input, [1, this.config.inputSize])
      const { clsOut, seatOutputs, planForwardLogits, planEndgameLogits } = this.forwardTrunk(obsTensor)

      const allLogits = this.computeAllHeadLogits(clsOut, seatOutputs, planForwardLogits, planEndgameLogits)
      for (const [name, logits] of allLogits) {
        policies.set(name, logits.dataSync() as Float32Array)
      }

      const rawValue = tf.add(tf.matMul(clsOut, this.valueW), this.valueB).dataSync()[0]
      value = Math.tanh(rawValue)
    })

    return { policies, value }
  }

  /**
   * PPOバッチ学習
   */
  trainBatch(batch: {
    observations: Float32Array[]
    actionHeads: string[]
    actionIndices: number[]
    oldLogProbs: number[]
    advantages: number[]
    returns: number[]
    sigmoidActions?: (Float32Array | undefined)[]
    trueRoles?: (Float32Array | undefined)[]
    planForwardActions?: (number[] | undefined)[]
    planForwardLogProbs?: (number[] | undefined)[]
    planEndgameActions?: (number[] | undefined)[]
    planEndgameLogProbs?: (number[] | undefined)[]
    predictLossCoeff?: number
    clipEpsilon: number
    valueLossCoeff: number
    entropyCoeff: number
    /** plan head の PPO 更新を凍結 (pretrain 後の知識保持用) */
    freezePlan?: boolean
    /** Reference policy logits for plan forward tokens [numFwd * vocabSize] per step */
    refPlanForwardLogits?: (Float32Array | undefined)[]
    /** Reference policy logits for plan endgame tokens [numEg * vocabSize] per step */
    refPlanEndgameLogits?: (Float32Array | undefined)[]
    /** KL penalty coefficient (β). >0 で KL(π_new || π_ref) を loss に加算 */
    klCoeff?: number
  }): { policyLoss: number, valueLoss: number, entropy: number, predictLoss: number, klLoss: number, grammarLoss: number } {
    const n = batch.observations.length
    if (n === 0) return { policyLoss: 0, valueLoss: 0, entropy: 0, predictLoss: 0, klLoss: 0, grammarLoss: 0 }

    const inputSize = this.config.inputSize
    const sigmoidHeadNames = new Set(Object.keys(this.config.sigmoidHeads ?? {}))
    const predictLossCoeff = batch.predictLossCoeff ?? 0

    const obsData = new Float32Array(n * inputSize)
    for (let i = 0; i < n; i++) {
      obsData.set(batch.observations[i], i * inputSize)
    }

    const result = { policyLoss: 0, valueLoss: 0, entropy: 0, predictLoss: 0, klLoss: 0, grammarLoss: 0 }

    // ヘッド別グループ化
    const headGroups = new Map<string, number[]>()
    for (let i = 0; i < n; i++) {
      const head = batch.actionHeads[i]
      if (!headGroups.has(head)) headGroups.set(head, [])
      headGroups.get(head)!.push(i)
    }

    const lossFunc = () => {
      const obsTensor = tf.tensor2d(obsData, [n, inputSize])
      const { clsOut, seatOutputs, planForwardLogits, planEndgameLogits } = this.forwardTrunk(obsTensor)

      // Value loss
      const rawValues = tf.add(tf.matMul(clsOut, this.valueW), this.valueB).squeeze([1])
      const values = tf.tanh(rawValues)
      const returnsTensor = tf.tensor1d(batch.returns)
      const vLoss = tf.mul(
        tf.scalar(batch.valueLossCoeff),
        tf.mean(tf.squaredDifference(values, returnsTensor)),
      )

      // Compute all head logits
      const allLogits = this.computeAllHeadLogits(clsOut, seatOutputs, planForwardLogits, planEndgameLogits)

      let totalPolicyLoss = tf.scalar(0)
      let totalEntropy = tf.scalar(0)

      // Strategy head: plan token PPO loss + predict BCE (combined step)
      const strategyIndices = headGroups.get('strategy')
      if (strategyIndices && strategyIndices.length > 0 && !batch.freezePlan) {
        // 通常モード: plan PPO loss + predict BCE 両方計算
        const tc = this.config.transformer!
        const numFwd = tc.numForwardTokens ?? 8
        const numEg = tc.numEndgameTokens ?? 4
        const vocabSize = tc.planVocabSize ?? 22

        const si = strategyIndices
        const m = si.length

        const computePlanLoss = (
          logitsTensor: tf.Tensor2D, // [n, numTokens * vocabSize]
          numTokens: number,
          getActions: (i: number) => number[] | undefined,
          getLogProbs: (i: number) => number[] | undefined,
          getRefLogits?: (i: number) => Float32Array | undefined,
        ): { loss: tf.Scalar, entropy: tf.Scalar, kl: tf.Scalar, grammarLoss: tf.Scalar } => {
          const planLogits = tf.gather(logitsTensor, si)  // [m, numTokens * vocabSize]
          const reshaped = planLogits.reshape([m, numTokens, vocabSize])
          const probs = tf.softmax(reshaped, 2)

          const actionData = new Int32Array(m * numTokens)
          const oldLpData = new Float32Array(m)
          for (let j = 0; j < m; j++) {
            const actions = getActions(si[j])
            const logProbs = getLogProbs(si[j])
            if (actions) {
              for (let k = 0; k < numTokens; k++) actionData[j * numTokens + k] = actions[k] ?? 0
            }
            if (logProbs) {
              for (let k = 0; k < numTokens; k++) oldLpData[j] += logProbs[k] ?? 0
            }
          }

          const actionMask = tf.oneHot(
            tf.tensor2d(actionData, [m, numTokens], 'int32'), vocabSize,
          )
          const selectedProbs = tf.sum(tf.mul(probs, actionMask), 2)
          const posLogProbs = tf.log(tf.add(selectedProbs, tf.scalar(1e-8)))
          const newLogProbs = tf.sum(posLogProbs, 1)

          const headAdvantages = si.map(i => batch.advantages[i])
          const ratio = tf.exp(tf.sub(newLogProbs, tf.tensor1d(oldLpData)))
          const advTensor = tf.tensor1d(headAdvantages)
          const surr1 = tf.mul(ratio, advTensor)
          const surr2 = tf.mul(
            tf.clipByValue(ratio, 1 - batch.clipEpsilon, 1 + batch.clipEpsilon), advTensor,
          )
          const loss = tf.neg(tf.mean(tf.minimum(surr1, surr2))) as tf.Scalar
          const logNewProbs = tf.log(tf.add(probs, tf.scalar(1e-8)))
          const ent = tf.neg(tf.mean(tf.sum(tf.mul(probs, logNewProbs), 2))) as tf.Scalar

          // Full categorical KL(π_new || π_ref) = Σ_v π_new(v) * [log π_new(v) - log π_ref(v)]
          // 常に非負。TF.js 内で完結するため数値誤差なし。
          let kl = tf.scalar(0) as tf.Scalar
          if (getRefLogits) {
            const refLogitsData = new Float32Array(m * numTokens * vocabSize)
            let hasRef = false
            for (let j = 0; j < m; j++) {
              const rl = getRefLogits(si[j])
              if (rl) {
                refLogitsData.set(rl, j * numTokens * vocabSize)
                hasRef = true
              }
            }
            if (hasRef) {
              const refReshaped = tf.tensor3d(refLogitsData, [m, numTokens, vocabSize])
              const refProbs = tf.softmax(refReshaped, 2)
              const logRefProbs = tf.log(tf.add(refProbs, tf.scalar(1e-8)))
              // KL per token = Σ_v π_new(v) * (log π_new(v) - log π_ref(v))
              const klPerToken = tf.sum(tf.mul(probs, tf.sub(logNewProbs, logRefProbs)), 2) // [m, numTokens]
              // mean over tokens and batch
              kl = tf.mean(klPerToken) as tf.Scalar
            }
          }

          // Grammar auxiliary loss: 違反トークン位置に CE(target=STOP) を適用
          // 違反1: STOP 後の非 STOP トークン
          // 違反3: 同一グループ内の重複トークン
          const STOP_IDX = vocabSize - 1
          const NEXT_IDX = vocabSize - 2
          const grammarMaskData = new Float32Array(m * numTokens)
          let grammarCount = 0

          for (let j = 0; j < m; j++) {
            let seenStop = false
            let groupStart = 0

            for (let k = 0; k < numTokens; k++) {
              const idx = j * numTokens + k
              const action = actionData[idx]

              // 違反1: STOP 後に非 STOP
              if (seenStop) {
                if (action !== STOP_IDX) {
                  grammarMaskData[idx] = 1
                  grammarCount++
                }
                continue
              }

              if (action === STOP_IDX) {
                seenStop = true
                continue
              }

              if (action === NEXT_IDX) {
                groupStart = k + 1
                continue
              }

              // 違反3: 同一グループ内で同じトークンが既出
              for (let p = groupStart; p < k; p++) {
                const prev = actionData[j * numTokens + p]
                if (prev === action && prev !== NEXT_IDX && prev !== STOP_IDX) {
                  grammarMaskData[idx] = 1
                  grammarCount++
                  break
                }
              }
            }
          }

          let grammarLoss = tf.scalar(0) as tf.Scalar
          if (grammarCount > 0) {
            // probs[:, :, STOP_IDX] = 各位置で STOP を出す確率
            const stopProbs = probs.slice([0, 0, STOP_IDX], [m, numTokens, 1]).squeeze([2])
            const stopCE = tf.neg(tf.log(tf.add(stopProbs, tf.scalar(1e-8))))
            const grammarMask = tf.tensor2d(grammarMaskData, [m, numTokens])
            grammarLoss = tf.div(tf.sum(tf.mul(stopCE, grammarMask)), tf.scalar(grammarCount)) as tf.Scalar
          }

          return { loss, entropy: ent, kl, grammarLoss }
        }

        // Plan PPO loss (forward + endgame)
        const klCoeff = batch.klCoeff ?? 0
        const getRefFwdLogits = klCoeff > 0 ? (i: number) => batch.refPlanForwardLogits?.[i] : undefined
        const getRefEgLogits = klCoeff > 0 ? (i: number) => batch.refPlanEndgameLogits?.[i] : undefined

        const fwdResult = computePlanLoss(
          planForwardLogits, numFwd,
          i => batch.planForwardActions?.[i],
          i => batch.planForwardLogProbs?.[i],
          getRefFwdLogits,
        )
        totalPolicyLoss = tf.add(totalPolicyLoss, fwdResult.loss)
        totalEntropy = tf.add(totalEntropy, fwdResult.entropy)

        const egResult = computePlanLoss(
          planEndgameLogits, numEg,
          i => batch.planEndgameActions?.[i],
          i => batch.planEndgameLogProbs?.[i],
          getRefEgLogits,
        )
        totalPolicyLoss = tf.add(totalPolicyLoss, egResult.loss)
        totalEntropy = tf.add(totalEntropy, egResult.entropy)

        // Grammar auxiliary loss: 文法違反トークンに CE(STOP) ペナルティ
        const GRAMMAR_LOSS_COEFF = 0.1
        const grammarTotal = tf.add(fwdResult.grammarLoss, egResult.grammarLoss) as tf.Scalar
        totalPolicyLoss = tf.add(totalPolicyLoss, tf.mul(tf.scalar(GRAMMAR_LOSS_COEFF), grammarTotal))
        result.grammarLoss = grammarTotal.dataSync()[0]

        // KL penalty: β * (KL_fwd + KL_eg)
        if (klCoeff > 0) {
          const klTotal = tf.add(fwdResult.kl, egResult.kl) as tf.Scalar
          totalPolicyLoss = tf.add(totalPolicyLoss, tf.mul(tf.scalar(klCoeff), klTotal))
          result.klLoss = klTotal.dataSync()[0]
        }

        headGroups.delete('strategy')  // 通常ヘッドループでは処理しない
      } else if (strategyIndices && strategyIndices.length > 0) {
        // freezePlan: plan PPO はスキップするが、predict sigmoid PPO は残す
        // strategy indices を predict head として通常ループに回す
        if (sigmoidHeadNames.has('predict')) {
          const existing = headGroups.get('predict') ?? []
          headGroups.set('predict', [...existing, ...strategyIndices])
        }
        headGroups.delete('strategy')
      } else {
        headGroups.delete('strategy')
      }

      for (const [headName, indices] of headGroups) {
        const headLogitsTensor = allLogits.get(headName)!

        if (sigmoidHeadNames.has(headName)) {
          // Sigmoid head PPO
          const headLogits = tf.gather(headLogitsTensor, indices)
          const headProbs = tf.sigmoid(headLogits)

          const headSize = headLogitsTensor.shape[1]!
          const actionsData = new Float32Array(indices.length * headSize)
          for (let j = 0; j < indices.length; j++) {
            const sa = batch.sigmoidActions?.[indices[j]]
            if (sa) actionsData.set(sa, j * headSize)
          }
          const actionsTensor = tf.tensor2d(actionsData, [indices.length, headSize])

          const logP = tf.log(tf.add(headProbs, tf.scalar(1e-8)))
          const log1mP = tf.log(tf.add(tf.sub(tf.scalar(1), headProbs), tf.scalar(1e-8)))
          const perElementLogProb = tf.add(
            tf.mul(actionsTensor, logP),
            tf.mul(tf.sub(tf.scalar(1), actionsTensor), log1mP),
          )
          const newLogProbs = tf.sum(perElementLogProb, 1)

          const headOldLogProbs = indices.map(i => batch.oldLogProbs[i])
          const headAdvantages = indices.map(i => batch.advantages[i])
          const ratio = tf.exp(tf.sub(newLogProbs, tf.tensor1d(headOldLogProbs)))
          const advTensor = tf.tensor1d(headAdvantages)
          const surr1 = tf.mul(ratio, advTensor)
          const surr2 = tf.mul(
            tf.clipByValue(ratio, 1 - batch.clipEpsilon, 1 + batch.clipEpsilon),
            advTensor,
          )
          const pLoss = tf.neg(tf.mean(tf.minimum(surr1, surr2)))

          const ent = tf.neg(tf.mean(tf.add(
            tf.mul(headProbs, logP),
            tf.mul(tf.sub(tf.scalar(1), headProbs), log1mP),
          )))

          totalPolicyLoss = tf.add(totalPolicyLoss, pLoss)
          totalEntropy = tf.add(totalEntropy, ent)
        } else {
          // Softmax head PPO
          const headLogits = tf.gather(headLogitsTensor, indices)
          const headProbs = tf.softmax(headLogits)

          const headActions = indices.map(i => batch.actionIndices[i])
          const headAdvantages = indices.map(i => batch.advantages[i])
          const headOldLogProbs = indices.map(i => batch.oldLogProbs[i])

          const actionMask = tf.oneHot(headActions, headLogitsTensor.shape[1]!)
          const selectedProbs = tf.sum(tf.mul(headProbs, actionMask), 1)
          const newLogProbs = tf.log(tf.add(selectedProbs, tf.scalar(1e-8)))

          const ratio = tf.exp(tf.sub(newLogProbs, tf.tensor1d(headOldLogProbs)))
          const advTensor = tf.tensor1d(headAdvantages)
          const surr1 = tf.mul(ratio, advTensor)
          const surr2 = tf.mul(
            tf.clipByValue(ratio, 1 - batch.clipEpsilon, 1 + batch.clipEpsilon),
            advTensor,
          )
          const pLoss = tf.neg(tf.mean(tf.minimum(surr1, surr2)))

          const ent = tf.neg(tf.mean(
            tf.sum(tf.mul(headProbs, tf.log(tf.add(headProbs, tf.scalar(1e-8)))), 1),
          ))

          totalPolicyLoss = tf.add(totalPolicyLoss, pLoss)
          totalEntropy = tf.add(totalEntropy, ent)
        }
      }

      const entBonus = tf.mul(tf.scalar(-batch.entropyCoeff), totalEntropy)
      let totalLoss = tf.add(tf.add(totalPolicyLoss, vLoss), entBonus) as tf.Scalar

      // Predict auxiliary loss: BCE between predict sigmoid head and true roles
      let pLossVal = 0
      if (predictLossCoeff > 0 && allLogits.has('predict')) {
        const predictLogits = allLogits.get('predict')!  // [n, 154]
        const predictProbs = tf.sigmoid(predictLogits)

        const predictSize = predictLogits.shape[1]!
        const targetsData = new Float32Array(n * predictSize)
        let validCount = 0
        const validMask = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          const tr = batch.trueRoles?.[i]
          if (tr) {
            targetsData.set(tr, i * predictSize)
            validMask[i] = 1
            validCount++
          }
        }

        if (validCount > 0) {
          const targetsTensor = tf.tensor2d(targetsData, [n, predictSize])
          const maskTensor = tf.tensor1d(validMask).expandDims(1)

          const logP = tf.log(tf.add(predictProbs, tf.scalar(1e-8)))
          const log1mP = tf.log(tf.add(tf.sub(tf.scalar(1), predictProbs), tf.scalar(1e-8)))
          const bce = tf.neg(tf.add(
            tf.mul(targetsTensor, logP),
            tf.mul(tf.sub(tf.scalar(1), targetsTensor), log1mP),
          ))
          const maskedBce = tf.mul(bce, maskTensor)
          const predictLoss = tf.div(tf.sum(maskedBce), tf.scalar(validCount * predictSize))
          const scaledPredictLoss = tf.mul(tf.scalar(predictLossCoeff), predictLoss)
          totalLoss = tf.add(totalLoss, scaledPredictLoss) as tf.Scalar
          pLossVal = predictLoss.dataSync()[0]
        }
      }

      result.policyLoss = totalPolicyLoss.dataSync()[0]
      result.valueLoss = vLoss.dataSync()[0]
      result.entropy = totalEntropy.dataSync()[0]
      result.predictLoss = pLossVal

      return totalLoss
    }

    this.optimizer.minimize(lossFunc, false, this.allVariables)
    return result
  }

  /**
   * 教師あり学習: predict (BCE) + value (MSE) 同時学習
   * trunk + predict head + value head を更新 (plan head は凍結)
   */
  trainSupervisedMulti(batch: {
    observations: Float32Array[]
    predictLabels: Float32Array[]   // [n, SEATS * NUM_ROLES] soft one-hot
    valueLabels: number[]           // [n] scalar ±1.0
  }): { predictLoss: number, valueLoss: number } {
    const n = batch.observations.length
    if (n === 0) return { predictLoss: 0, valueLoss: 0 }

    const inputSize = this.config.inputSize
    const obsData = new Float32Array(n * inputSize)
    for (let i = 0; i < n; i++) obsData.set(batch.observations[i], i * inputSize)

    const predictEntry = this.perSeatSigmoidHeadWeights.get('predict')
    const predictSize = predictEntry ? predictEntry[0].shape[1]! * SEATS : 0

    const predictData = new Float32Array(n * predictSize)
    for (let i = 0; i < n; i++) {
      if (batch.predictLabels[i]) predictData.set(batch.predictLabels[i], i * predictSize)
    }

    const valueData = new Float32Array(n)
    for (let i = 0; i < n; i++) valueData[i] = batch.valueLabels[i]

    const result = { predictLoss: 0, valueLoss: 0 }

    const lossFunc = () => {
      const obsTensor = tf.tensor2d(obsData, [n, inputSize])
      const { clsOut, seatOutputs } = this.forwardTrunk(obsTensor)

      let totalLoss = tf.scalar(0) as tf.Scalar

      // === Predict head (BCE) ===
      if (predictEntry && predictSize > 0) {
        const [pw, pb] = predictEntry
        const predictLogits = this.perSeatSigmoidLogits(seatOutputs, pw, pb)  // [n, SEATS * perDim]
        const predictProbs = tf.sigmoid(predictLogits)
        const targetsTensor = tf.tensor2d(predictData, [n, predictSize])

        const logP = tf.log(tf.add(predictProbs, tf.scalar(1e-8)))
        const log1mP = tf.log(tf.add(tf.sub(tf.scalar(1), predictProbs), tf.scalar(1e-8)))
        const bce = tf.neg(tf.add(
          tf.mul(targetsTensor, logP),
          tf.mul(tf.sub(tf.scalar(1), targetsTensor), log1mP),
        ))
        const predictLoss = tf.mean(bce)
        totalLoss = tf.add(totalLoss, predictLoss) as tf.Scalar
        result.predictLoss = predictLoss.dataSync()[0]
      }

      // === Value head (MSE) ===
      const valueOut = tf.add(tf.matMul(clsOut, this.valueW), this.valueB).squeeze([1])  // [n]
      const valueTensor = tf.tensor1d(valueData)
      const valueLoss = tf.mean(tf.squaredDifference(valueOut, valueTensor))
      totalLoss = tf.add(totalLoss, valueLoss) as tf.Scalar
      result.valueLoss = valueLoss.dataSync()[0]

      return totalLoss
    }

    this.optimizer.minimize(lossFunc, false, this.allVariables)
    return result
  }

  /**
   * 教師あり学習（vote head用 cross-entropy）
   */
  trainSupervisedVote(batch: {
    observations: Float32Array[]
    labels: Float32Array[]
    masks: Float32Array[]
  }): { loss: number, accuracy: number } {
    const n = batch.observations.length
    if (n === 0) return { loss: 0, accuracy: 0 }

    const inputSize = this.config.inputSize
    const obsData = new Float32Array(n * inputSize)
    for (let i = 0; i < n; i++) {
      obsData.set(batch.observations[i], i * inputSize)
    }

    const voteHeadSize = this.config.heads.vote
    const labelData = new Float32Array(n * voteHeadSize)
    const maskData = new Float32Array(n * voteHeadSize)
    for (let i = 0; i < n; i++) {
      labelData.set(batch.labels[i], i * voteHeadSize)
      maskData.set(batch.masks[i], i * voteHeadSize)
    }

    const result = { loss: 0, accuracy: 0 }

    // vote head weights を特定
    const voteHeadEntry = this.perSeatHeadWeights.get('vote')
    if (!voteHeadEntry) throw new Error('vote head not found in perSeatHeadWeights')
    const [voteW, voteB] = voteHeadEntry

    // 学習対象: projections + transformer layers + vote head
    const trainableVars = this.allVariables

    const lossFunc = () => {
      const obsTensor = tf.tensor2d(obsData, [n, inputSize])
      const { seatOutputs } = this.forwardTrunk(obsTensor)  // other outputs unused here

      // vote logits: per-seat readout
      const logits = this.perSeatLogits(seatOutputs, voteW, voteB)  // [n, SEATS]

      // マスク適用
      const maskTensor = tf.tensor2d(maskData, [n, voteHeadSize])
      const maskedLogits = tf.add(logits, maskTensor)

      const probs = tf.softmax(maskedLogits)
      const labelTensor = tf.tensor2d(labelData, [n, voteHeadSize])

      const logProbs = tf.log(tf.add(probs, tf.scalar(1e-8)))
      const loss = tf.neg(tf.mean(tf.sum(tf.mul(labelTensor, logProbs), 1)))

      // accuracy
      const predIndices = tf.argMax(probs, 1).dataSync()
      const labelIndices = tf.argMax(labelTensor, 1).dataSync()
      let correct = 0
      for (let i = 0; i < n; i++) {
        if (predIndices[i] === labelIndices[i]) correct++
      }
      result.accuracy = correct / n
      result.loss = loss.dataSync()[0]

      return loss as tf.Scalar
    }

    this.optimizer.minimize(lossFunc, false, trainableVars)
    return result
  }

  /**
   * Plan token Pointer 教師あり学習
   * Forward plan tokensのPointer出力にcross-entropy損失を適用
   */
  trainSupervisedPlan(batch: {
    observations: Float32Array[]
    forwardLabels: number[][]      // [n, numTokens] vocab indices
    forwardMasks: boolean[][]      // [n, numTokens] which tokens to train on
    endgameLabels?: number[][]     // [n, numEgTokens] vocab indices
    endgameMasks?: boolean[][]     // [n, numEgTokens] which tokens to train on
    numTokens: number
    numEndgameTokens?: number
    vocabSize: number
  }): { loss: number, accuracy: number } {
    const n = batch.observations.length
    if (n === 0) return { loss: 0, accuracy: 0 }

    const inputSize = this.config.inputSize
    const obsData = new Float32Array(n * inputSize)
    for (let i = 0; i < n; i++) obsData.set(batch.observations[i], i * inputSize)

    const result = { loss: 0, accuracy: 0 }
    const numTokens = batch.numTokens

    const lossFunc = () => {
      const obsTensor = tf.tensor2d(obsData, [n, inputSize])
      const { planForwardLogits, planEndgameLogits } = this.forwardTrunk(obsTensor)

      let totalLoss = tf.scalar(0)
      let correct = 0
      let totalMasked = 0

      // Helper: compute CE loss for a plan logits tensor
      const computeCE = (
        logitsTensor: tf.Tensor2D, numToks: number,
        labels: number[][], masks: boolean[][],
      ) => {
        const vocabActual = logitsTensor.shape[1]! / numToks
        const logits3d = logitsTensor.reshape([n, numToks, vocabActual])

        for (let t = 0; t < numToks; t++) {
          const validIndices: number[] = []
          const validLabels: number[] = []
          for (let i = 0; i < n; i++) {
            if (masks[i][t]) {
              validIndices.push(i)
              validLabels.push(labels[i][t])
            }
          }
          if (validIndices.length === 0) continue
          totalMasked += validIndices.length

          const tokenLogits = logits3d.slice([0, t, 0], [n, 1, vocabActual]).squeeze([1])
          const validLogits = tf.gather(tokenLogits, validIndices)
          const probs = tf.softmax(validLogits)

          const oneHot = tf.oneHot(validLabels, vocabActual)
          const logProbs = tf.log(tf.add(probs, tf.scalar(1e-8)))
          const ce = tf.neg(tf.sum(tf.mul(oneHot, logProbs), 1))
          totalLoss = tf.add(totalLoss, tf.sum(ce))

          const predIdx = tf.argMax(probs, 1).dataSync()
          for (let j = 0; j < validIndices.length; j++) {
            if (predIdx[j] === validLabels[j]) correct++
          }
        }
      }

      // Forward plan
      computeCE(planForwardLogits, numTokens, batch.forwardLabels, batch.forwardMasks)

      // Endgame plan
      if (batch.endgameLabels && batch.endgameMasks && batch.numEndgameTokens) {
        computeCE(planEndgameLogits, batch.numEndgameTokens, batch.endgameLabels, batch.endgameMasks)
      }

      if (totalMasked > 0) {
        result.accuracy = correct / totalMasked
        const avgLoss = tf.div(totalLoss, tf.scalar(totalMasked))
        result.loss = avgLoss.dataSync()[0]
        return avgLoss as tf.Scalar
      }
      result.loss = 0
      result.accuracy = 0
      return tf.scalar(0) as tf.Scalar
    }

    this.optimizer.minimize(lossFunc, false, this.trunkAndPlanVariables)
    return result
  }

  /** 重みのクローン */
  cloneWeights(): Map<string, Float32Array> {
    const weights = new Map<string, Float32Array>()

    weights.set('proj_cls_w', this.projClsW.dataSync() as Float32Array)
    weights.set('proj_cls_b', this.projClsB.dataSync() as Float32Array)
    weights.set('proj_seat_w', this.projSeatW.dataSync() as Float32Array)
    weights.set('proj_seat_b', this.projSeatB.dataSync() as Float32Array)
    weights.set('proj_role_w', this.projRoleW.dataSync() as Float32Array)
    weights.set('proj_role_b', this.projRoleB.dataSync() as Float32Array)

    const cloneLayers = (layers: (typeof TfTransformerNetwork.LayerShape)[], prefix: string) => {
      for (let l = 0; l < layers.length; l++) {
        const ly = layers[l]
        weights.set(`${prefix}_${l}_ln1_scale`, ly.ln1Scale.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_ln1_bias`, ly.ln1Bias.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_attn_wq`, ly.wQ.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_attn_bq`, ly.bQ.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_attn_wk`, ly.wK.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_attn_bk`, ly.bK.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_attn_wv`, ly.wV.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_attn_bv`, ly.bV.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_attn_wo`, ly.wO.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_attn_bo`, ly.bO.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_ln2_scale`, ly.ln2Scale.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_ln2_bias`, ly.ln2Bias.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_ffn_w1`, ly.ffnW1.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_ffn_b1`, ly.ffnB1.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_ffn_w2`, ly.ffnW2.dataSync() as Float32Array)
        weights.set(`${prefix}_${l}_ffn_b2`, ly.ffnB2.dataSync() as Float32Array)
      }
    }
    cloneLayers(this.seatLayers, 'seat_layer')
    weights.set('seat_final_ln_scale', this.seatFinalLnScale.dataSync() as Float32Array)
    weights.set('seat_final_ln_bias', this.seatFinalLnBias.dataSync() as Float32Array)
    cloneLayers(this.stratLayers, 'strat_layer')
    weights.set('strat_final_ln_scale', this.stratFinalLnScale.dataSync() as Float32Array)
    weights.set('strat_final_ln_bias', this.stratFinalLnBias.dataSync() as Float32Array)

    weights.set('forward_embeddings', this.forwardEmbeddings.dataSync() as Float32Array)
    weights.set('endgame_embeddings', this.endgameEmbeddings.dataSync() as Float32Array)
    weights.set('pointer_query_w', this.pointerQueryW.dataSync() as Float32Array)
    weights.set('pointer_query_b', this.pointerQueryB.dataSync() as Float32Array)
    weights.set('pointer_key_w', this.pointerKeyW.dataSync() as Float32Array)
    weights.set('pointer_key_b', this.pointerKeyB.dataSync() as Float32Array)
    weights.set('special_keys', this.specialKeys.dataSync() as Float32Array)

    for (const [name, [w, b]] of this.perSeatHeadWeights) {
      weights.set(`head_${name}_w`, w.dataSync() as Float32Array)
      weights.set(`head_${name}_b`, b.dataSync() as Float32Array)
    }
    if (this.nightSeatW) {
      weights.set('head_night_seat_w', this.nightSeatW.dataSync() as Float32Array)
      weights.set('head_night_seat_b', this.nightSeatB!.dataSync() as Float32Array)
      weights.set('head_night_cls_w', this.nightClsW!.dataSync() as Float32Array)
      weights.set('head_night_cls_b', this.nightClsB!.dataSync() as Float32Array)
    }
    for (const [name, [w, b]] of this.perSeatSigmoidHeadWeights) {
      weights.set(`head_${name}_w`, w.dataSync() as Float32Array)
      weights.set(`head_${name}_b`, b.dataSync() as Float32Array)
    }
    for (const [name, [w, b]] of this.globalHeadWeights) {
      weights.set(`head_${name}_w`, w.dataSync() as Float32Array)
      weights.set(`head_${name}_b`, b.dataSync() as Float32Array)
    }
    for (const [name, [w, b]] of this.globalSigmoidHeadWeights) {
      weights.set(`head_${name}_w`, w.dataSync() as Float32Array)
      weights.set(`head_${name}_b`, b.dataSync() as Float32Array)
    }
    weights.set('value_w', this.valueW.dataSync() as Float32Array)
    weights.set('value_b', this.valueB.dataSync() as Float32Array)

    return weights
  }

  /** 重みをロード */
  loadWeights(weights: Map<string, Float32Array>): void {
    tf.tidy(() => {
      this.projClsW.assign(tf.tensor(weights.get('proj_cls_w')!, this.projClsW.shape))
      this.projClsB.assign(tf.tensor(weights.get('proj_cls_b')!, this.projClsB.shape))
      this.projSeatW.assign(tf.tensor(weights.get('proj_seat_w')!, this.projSeatW.shape))
      this.projSeatB.assign(tf.tensor(weights.get('proj_seat_b')!, this.projSeatB.shape))
      this.projRoleW.assign(tf.tensor(weights.get('proj_role_w')!, this.projRoleW.shape))
      this.projRoleB.assign(tf.tensor(weights.get('proj_role_b')!, this.projRoleB.shape))

      const loadLayers = (layers: (typeof TfTransformerNetwork.LayerShape)[], prefix: string) => {
        for (let l = 0; l < layers.length; l++) {
          const ly = layers[l]
          ly.ln1Scale.assign(tf.tensor(weights.get(`${prefix}_${l}_ln1_scale`)!, ly.ln1Scale.shape))
          ly.ln1Bias.assign(tf.tensor(weights.get(`${prefix}_${l}_ln1_bias`)!, ly.ln1Bias.shape))
          ly.wQ.assign(tf.tensor(weights.get(`${prefix}_${l}_attn_wq`)!, ly.wQ.shape))
          ly.bQ.assign(tf.tensor(weights.get(`${prefix}_${l}_attn_bq`)!, ly.bQ.shape))
          ly.wK.assign(tf.tensor(weights.get(`${prefix}_${l}_attn_wk`)!, ly.wK.shape))
          ly.bK.assign(tf.tensor(weights.get(`${prefix}_${l}_attn_bk`)!, ly.bK.shape))
          ly.wV.assign(tf.tensor(weights.get(`${prefix}_${l}_attn_wv`)!, ly.wV.shape))
          ly.bV.assign(tf.tensor(weights.get(`${prefix}_${l}_attn_bv`)!, ly.bV.shape))
          ly.wO.assign(tf.tensor(weights.get(`${prefix}_${l}_attn_wo`)!, ly.wO.shape))
          ly.bO.assign(tf.tensor(weights.get(`${prefix}_${l}_attn_bo`)!, ly.bO.shape))
          ly.ln2Scale.assign(tf.tensor(weights.get(`${prefix}_${l}_ln2_scale`)!, ly.ln2Scale.shape))
          ly.ln2Bias.assign(tf.tensor(weights.get(`${prefix}_${l}_ln2_bias`)!, ly.ln2Bias.shape))
          ly.ffnW1.assign(tf.tensor(weights.get(`${prefix}_${l}_ffn_w1`)!, ly.ffnW1.shape))
          ly.ffnB1.assign(tf.tensor(weights.get(`${prefix}_${l}_ffn_b1`)!, ly.ffnB1.shape))
          ly.ffnW2.assign(tf.tensor(weights.get(`${prefix}_${l}_ffn_w2`)!, ly.ffnW2.shape))
          ly.ffnB2.assign(tf.tensor(weights.get(`${prefix}_${l}_ffn_b2`)!, ly.ffnB2.shape))
        }
      }
      loadLayers(this.seatLayers, 'seat_layer')
      this.seatFinalLnScale.assign(tf.tensor(weights.get('seat_final_ln_scale')!, this.seatFinalLnScale.shape))
      this.seatFinalLnBias.assign(tf.tensor(weights.get('seat_final_ln_bias')!, this.seatFinalLnBias.shape))
      loadLayers(this.stratLayers, 'strat_layer')
      this.stratFinalLnScale.assign(tf.tensor(weights.get('strat_final_ln_scale')!, this.stratFinalLnScale.shape))
      this.stratFinalLnBias.assign(tf.tensor(weights.get('strat_final_ln_bias')!, this.stratFinalLnBias.shape))

      this.forwardEmbeddings.assign(tf.tensor(weights.get('forward_embeddings')!, this.forwardEmbeddings.shape))
      this.endgameEmbeddings.assign(tf.tensor(weights.get('endgame_embeddings')!, this.endgameEmbeddings.shape))
      this.pointerQueryW.assign(tf.tensor(weights.get('pointer_query_w')!, this.pointerQueryW.shape))
      this.pointerQueryB.assign(tf.tensor(weights.get('pointer_query_b')!, this.pointerQueryB.shape))
      this.pointerKeyW.assign(tf.tensor(weights.get('pointer_key_w')!, this.pointerKeyW.shape))
      this.pointerKeyB.assign(tf.tensor(weights.get('pointer_key_b')!, this.pointerKeyB.shape))
      this.specialKeys.assign(tf.tensor(weights.get('special_keys')!, this.specialKeys.shape))

      for (const [name, [wVar, bVar]] of this.perSeatHeadWeights) {
        wVar.assign(tf.tensor(weights.get(`head_${name}_w`)!, wVar.shape))
        bVar.assign(tf.tensor(weights.get(`head_${name}_b`)!, bVar.shape))
      }
      if (this.nightSeatW) {
        this.nightSeatW.assign(tf.tensor(weights.get('head_night_seat_w')!, this.nightSeatW.shape))
        this.nightSeatB!.assign(tf.tensor(weights.get('head_night_seat_b')!, this.nightSeatB!.shape))
        this.nightClsW!.assign(tf.tensor(weights.get('head_night_cls_w')!, this.nightClsW!.shape))
        this.nightClsB!.assign(tf.tensor(weights.get('head_night_cls_b')!, this.nightClsB!.shape))
      }
      for (const [name, [wVar, bVar]] of this.perSeatSigmoidHeadWeights) {
        wVar.assign(tf.tensor(weights.get(`head_${name}_w`)!, wVar.shape))
        bVar.assign(tf.tensor(weights.get(`head_${name}_b`)!, bVar.shape))
      }
      for (const [name, [wVar, bVar]] of this.globalHeadWeights) {
        wVar.assign(tf.tensor(weights.get(`head_${name}_w`)!, wVar.shape))
        bVar.assign(tf.tensor(weights.get(`head_${name}_b`)!, bVar.shape))
      }
      for (const [name, [wVar, bVar]] of this.globalSigmoidHeadWeights) {
        wVar.assign(tf.tensor(weights.get(`head_${name}_w`)!, wVar.shape))
        bVar.assign(tf.tensor(weights.get(`head_${name}_b`)!, bVar.shape))
      }
      this.valueW.assign(tf.tensor(weights.get('value_w')!, this.valueW.shape))
      this.valueB.assign(tf.tensor(weights.get('value_b')!, this.valueB.shape))
    })
  }

  /** 総パラメータ数 */
  get totalParams(): number {
    let total = 0
    for (const v of this.allVariables) total += v.size
    return total
  }

  /** リソース解放 */
  dispose(): void {
    for (const v of this.allVariables) v.dispose()
    this.clsGatherIndices.dispose()
    this.seatGatherIndices.dispose()
  }
}
