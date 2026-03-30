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
  CLS_FEATURES, TEAM_CLS_FEATURES, SEAT_TOKEN_FEATURES, TEAM_SEAT_TOKEN_FEATURES,
  HISTORY_WINDOW, OBSERVATION_SIZE,
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
const PLAN_START = RETAR_START + RETAR_SIZE
const PLAN_INCLUDED_START = PLAN_START
const PLAN_POSITION_START = PLAN_START + SEATS
const PLAN_GLOBAL_START = PLAN_START + SEATS * 2

// Team offsets
const TEAM_SIZE_START = OBSERVATION_SIZE
const TEAM_IS_MY_TEAM_START = TEAM_SIZE_START + 1
const TEAM_IS_CURRENT_ACTOR_START = TEAM_IS_MY_TEAM_START + SEATS
const TEAM_FAKE_DIVINE_START = TEAM_IS_CURRENT_ACTOR_START + SEATS

/** CLSトークンのインデックス配列を構築 */
function buildClsIndices(isTeam: boolean): number[] {
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
  // team
  if (isTeam) indices.push(TEAM_SIZE_START)
  return indices
}

/** 全席トークンのインデックス配列を構築 [SEATS * seatFeatures] */
function buildSeatIndices(isTeam: boolean): number[] {
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
    // retar (11)
    const rOff = RETAR_START + s * NUM_ROLES
    for (let i = 0; i < NUM_ROLES; i++) indices.push(rOff + i)
    // plan (2)
    indices.push(PLAN_INCLUDED_START + s)
    indices.push(PLAN_POSITION_START + s)
    // team per-seat (3)
    if (isTeam) {
      indices.push(TEAM_IS_MY_TEAM_START + s)
      indices.push(TEAM_IS_CURRENT_ACTOR_START + s)
      indices.push(TEAM_FAKE_DIVINE_START + s)
    }
  }
  return indices
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

  // Transformer layer weights (per layer)
  private layers: {
    ln1Scale: tf.Variable, ln1Bias: tf.Variable
    wQ: tf.Variable, bQ: tf.Variable
    wK: tf.Variable, bK: tf.Variable
    wV: tf.Variable, bV: tf.Variable
    wO: tf.Variable, bO: tf.Variable
    ln2Scale: tf.Variable, ln2Bias: tf.Variable
    ffnW1: tf.Variable, ffnB1: tf.Variable
    ffnW2: tf.Variable, ffnB2: tf.Variable
  }[]
  private finalLnScale: tf.Variable
  private finalLnBias: tf.Variable

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
  private optimizer: tf.AdamOptimizer

  // Pre-computed index tensors for tokenization
  private clsGatherIndices: tf.Tensor1D
  private seatGatherIndices: tf.Tensor1D

  // Config
  private readonly isTeam: boolean
  private readonly dm: number
  private readonly numHeads: number
  private readonly dHead: number

  constructor(config: NetworkConfig, lr: number = 3e-4, isTeam: boolean = false) {
    if (!config.transformer) throw new Error('NetworkConfig.transformer required')

    const prefix = `tftr${_tfTransformerId++}_`
    this.config = config
    this.tConfig = config.transformer
    this.isTeam = isTeam
    this.allVariables = []

    const tc = this.tConfig
    this.dm = tc.dModel
    this.numHeads = tc.numHeads
    this.dHead = tc.dModel / tc.numHeads


    const dm = this.dm
    const cf = isTeam ? TEAM_CLS_FEATURES : CLS_FEATURES
    const sf = isTeam ? TEAM_SEAT_TOKEN_FEATURES : SEAT_TOKEN_FEATURES

    // Gather indices
    this.clsGatherIndices = tf.tensor1d(buildClsIndices(isTeam), 'int32')
    this.seatGatherIndices = tf.tensor1d(buildSeatIndices(isTeam), 'int32')

    // Input projections
    this.projClsW = this.makeVar([cf, dm], cf, `${prefix}proj_cls_w`)
    this.projClsB = this.makeZeroVar([dm], `${prefix}proj_cls_b`)
    this.projSeatW = this.makeVar([sf, dm], sf, `${prefix}proj_seat_w`)
    this.projSeatB = this.makeZeroVar([dm], `${prefix}proj_seat_b`)

    // Transformer layers
    this.layers = []
    const numLayers = tc.seatLayers ?? tc.numLayers ?? 2
    for (let l = 0; l < numLayers; l++) {
      const layer = {
        ln1Scale: tf.variable(tf.ones([dm]), true, `${prefix}l${l}_ln1_s`),
        ln1Bias: this.makeZeroVar([dm], `${prefix}l${l}_ln1_b`),
        wQ: this.makeVar([dm, dm], dm, `${prefix}l${l}_wq`),
        bQ: this.makeZeroVar([dm], `${prefix}l${l}_bq`),
        wK: this.makeVar([dm, dm], dm, `${prefix}l${l}_wk`),
        bK: this.makeZeroVar([dm], `${prefix}l${l}_bk`),
        wV: this.makeVar([dm, dm], dm, `${prefix}l${l}_wv`),
        bV: this.makeZeroVar([dm], `${prefix}l${l}_bv`),
        wO: this.makeVar([dm, dm], dm, `${prefix}l${l}_wo`),
        bO: this.makeZeroVar([dm], `${prefix}l${l}_bo`),
        ln2Scale: tf.variable(tf.ones([dm]), true, `${prefix}l${l}_ln2_s`),
        ln2Bias: this.makeZeroVar([dm], `${prefix}l${l}_ln2_b`),
        ffnW1: this.makeVar([dm, tc.dFf], dm, `${prefix}l${l}_ff1w`),
        ffnB1: this.makeZeroVar([tc.dFf], `${prefix}l${l}_ff1b`),
        ffnW2: this.makeVar([tc.dFf, dm], tc.dFf, `${prefix}l${l}_ff2w`),
        ffnB2: this.makeZeroVar([dm], `${prefix}l${l}_ff2b`),
      }
      this.allVariables.push(
        layer.ln1Scale, layer.ln1Bias,
        layer.wQ, layer.bQ, layer.wK, layer.bK, layer.wV, layer.bV, layer.wO, layer.bO,
        layer.ln2Scale, layer.ln2Bias,
        layer.ffnW1, layer.ffnB1, layer.ffnW2, layer.ffnB2,
      )
      this.layers.push(layer)
    }

    this.finalLnScale = tf.variable(tf.ones([dm]), true, `${prefix}fln_s`)
    this.finalLnBias = this.makeZeroVar([dm], `${prefix}fln_b`)
    this.allVariables.push(this.finalLnScale, this.finalLnBias)

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
   * バッチ観測テンソルからトークンシーケンスを構築
   * @param obsTensor [batch, obsSize]
   * @returns [batch, seqLen, dModel]
   */
  private tokenizeAndProject(obsTensor: tf.Tensor2D): tf.Tensor3D {
    const batch = obsTensor.shape[0]
    const sf = this.isTeam ? TEAM_SEAT_TOKEN_FEATURES : SEAT_TOKEN_FEATURES

    // CLS features: [batch, clsFeatures]
    const clsRaw = tf.gather(obsTensor, this.clsGatherIndices, 1)
    // Project: [batch, dModel]
    const clsProj = tf.add(tf.matMul(clsRaw, this.projClsW), this.projClsB)
    // Reshape to [batch, 1, dModel]
    const clsToken = clsProj.reshape([batch, 1, this.dm])

    // Seat features: [batch, SEATS * seatFeatures]
    const seatRaw = tf.gather(obsTensor, this.seatGatherIndices, 1)
    // Reshape to [batch * SEATS, seatFeatures]
    const seatRaw3d = seatRaw.reshape([batch * SEATS, sf])
    // Project: [batch * SEATS, dModel]
    const seatProj = tf.add(tf.matMul(seatRaw3d, this.projSeatW), this.projSeatB)
    // Reshape to [batch, SEATS, dModel]
    const seatTokens = seatProj.reshape([batch, SEATS, this.dm])

    // Concat: [CLS, seat1..seat14] → [batch, 15, dModel]
    return tf.concat([clsToken, seatTokens], 1) as tf.Tensor3D
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
   * Transformer encoder forward
   * tokens: [batch, seqLen, dModel]
   * Returns: [batch, seqLen, dModel]
   */
  private forwardTransformer(tokens: tf.Tensor3D): tf.Tensor3D {
    let x = tokens

    for (const layer of this.layers) {
      // Pre-LN attention
      const normed1 = this.layerNorm(x, layer.ln1Scale, layer.ln1Bias) as tf.Tensor3D
      const attnOut = this.multiHeadAttention(
        normed1,
        layer.wQ, layer.bQ, layer.wK, layer.bK, layer.wV, layer.bV, layer.wO, layer.bO,
      )
      x = tf.add(x, attnOut) as tf.Tensor3D

      // Pre-LN FFN
      const normed2 = this.layerNorm(x, layer.ln2Scale, layer.ln2Bias) as tf.Tensor3D
      const batch = x.shape[0]
      const seq = x.shape[1]
      const flat = normed2.reshape([batch * seq, this.dm])
      const hidden = tf.relu(tf.add(tf.matMul(flat, layer.ffnW1), layer.ffnB1))
      const ffnOut = tf.add(tf.matMul(hidden, layer.ffnW2), layer.ffnB2)
      x = tf.add(x, ffnOut.reshape([batch, seq, this.dm])) as tf.Tensor3D
    }

    // Final LN
    return this.layerNorm(x, this.finalLnScale, this.finalLnBias) as tf.Tensor3D
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
   * Trunk forward: obs → Transformer → (cls_out, seat_outputs)
   */
  private forwardTrunk(obsTensor: tf.Tensor2D): { clsOut: tf.Tensor2D, seatOutputs: tf.Tensor3D } {
    const tokens = this.tokenizeAndProject(obsTensor)
    const encoded = this.forwardTransformer(tokens)

    const batch = obsTensor.shape[0]
    // CLS: [batch, dModel]
    const clsOut = encoded.slice([0, 0, 0], [batch, 1, this.dm]).reshape([batch, this.dm]) as tf.Tensor2D
    // Seats: [batch, SEATS, dModel]
    const seatOutputs = encoded.slice([0, 1, 0], [batch, SEATS, this.dm]) as tf.Tensor3D

    return { clsOut, seatOutputs }
  }

  /**
   * All head logits from trunk outputs.
   * Returns Map<headName, [batch, headSize]>
   */
  private computeAllHeadLogits(
    clsOut: tf.Tensor2D, seatOutputs: tf.Tensor3D,
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
      const { clsOut, seatOutputs } = this.forwardTrunk(obsTensor)

      const allLogits = this.computeAllHeadLogits(clsOut, seatOutputs)
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
    predictLossCoeff?: number
    clipEpsilon: number
    valueLossCoeff: number
    entropyCoeff: number
  }): { policyLoss: number, valueLoss: number, entropy: number, predictLoss: number } {
    const n = batch.observations.length
    if (n === 0) return { policyLoss: 0, valueLoss: 0, entropy: 0, predictLoss: 0 }

    const inputSize = this.config.inputSize
    const sigmoidHeadNames = new Set(Object.keys(this.config.sigmoidHeads ?? {}))
    const predictLossCoeff = batch.predictLossCoeff ?? 0

    const obsData = new Float32Array(n * inputSize)
    for (let i = 0; i < n; i++) {
      obsData.set(batch.observations[i], i * inputSize)
    }

    const result = { policyLoss: 0, valueLoss: 0, entropy: 0, predictLoss: 0 }

    // ヘッド別グループ化
    const headGroups = new Map<string, number[]>()
    for (let i = 0; i < n; i++) {
      const head = batch.actionHeads[i]
      if (!headGroups.has(head)) headGroups.set(head, [])
      headGroups.get(head)!.push(i)
    }

    const lossFunc = () => {
      const obsTensor = tf.tensor2d(obsData, [n, inputSize])
      const { clsOut, seatOutputs } = this.forwardTrunk(obsTensor)

      // Value loss
      const rawValues = tf.add(tf.matMul(clsOut, this.valueW), this.valueB).squeeze([1])
      const values = tf.tanh(rawValues)
      const returnsTensor = tf.tensor1d(batch.returns)
      const vLoss = tf.mul(
        tf.scalar(batch.valueLossCoeff),
        tf.mean(tf.squaredDifference(values, returnsTensor)),
      )

      // Compute all head logits
      const allLogits = this.computeAllHeadLogits(clsOut, seatOutputs)

      let totalPolicyLoss = tf.scalar(0)
      let totalEntropy = tf.scalar(0)

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
      const { seatOutputs } = this.forwardTrunk(obsTensor)

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

  /** 重みのクローン */
  cloneWeights(): Map<string, Float32Array> {
    const weights = new Map<string, Float32Array>()

    weights.set('proj_cls_w', this.projClsW.dataSync() as Float32Array)
    weights.set('proj_cls_b', this.projClsB.dataSync() as Float32Array)
    weights.set('proj_seat_w', this.projSeatW.dataSync() as Float32Array)
    weights.set('proj_seat_b', this.projSeatB.dataSync() as Float32Array)

    for (let l = 0; l < this.layers.length; l++) {
      const ly = this.layers[l]
      weights.set(`layer_${l}_ln1_scale`, ly.ln1Scale.dataSync() as Float32Array)
      weights.set(`layer_${l}_ln1_bias`, ly.ln1Bias.dataSync() as Float32Array)
      weights.set(`layer_${l}_attn_wq`, ly.wQ.dataSync() as Float32Array)
      weights.set(`layer_${l}_attn_bq`, ly.bQ.dataSync() as Float32Array)
      weights.set(`layer_${l}_attn_wk`, ly.wK.dataSync() as Float32Array)
      weights.set(`layer_${l}_attn_bk`, ly.bK.dataSync() as Float32Array)
      weights.set(`layer_${l}_attn_wv`, ly.wV.dataSync() as Float32Array)
      weights.set(`layer_${l}_attn_bv`, ly.bV.dataSync() as Float32Array)
      weights.set(`layer_${l}_attn_wo`, ly.wO.dataSync() as Float32Array)
      weights.set(`layer_${l}_attn_bo`, ly.bO.dataSync() as Float32Array)
      weights.set(`layer_${l}_ln2_scale`, ly.ln2Scale.dataSync() as Float32Array)
      weights.set(`layer_${l}_ln2_bias`, ly.ln2Bias.dataSync() as Float32Array)
      weights.set(`layer_${l}_ffn_w1`, ly.ffnW1.dataSync() as Float32Array)
      weights.set(`layer_${l}_ffn_b1`, ly.ffnB1.dataSync() as Float32Array)
      weights.set(`layer_${l}_ffn_w2`, ly.ffnW2.dataSync() as Float32Array)
      weights.set(`layer_${l}_ffn_b2`, ly.ffnB2.dataSync() as Float32Array)
    }

    weights.set('final_ln_scale', this.finalLnScale.dataSync() as Float32Array)
    weights.set('final_ln_bias', this.finalLnBias.dataSync() as Float32Array)

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

      for (let l = 0; l < this.layers.length; l++) {
        const ly = this.layers[l]
        ly.ln1Scale.assign(tf.tensor(weights.get(`layer_${l}_ln1_scale`)!, ly.ln1Scale.shape))
        ly.ln1Bias.assign(tf.tensor(weights.get(`layer_${l}_ln1_bias`)!, ly.ln1Bias.shape))
        ly.wQ.assign(tf.tensor(weights.get(`layer_${l}_attn_wq`)!, ly.wQ.shape))
        ly.bQ.assign(tf.tensor(weights.get(`layer_${l}_attn_bq`)!, ly.bQ.shape))
        ly.wK.assign(tf.tensor(weights.get(`layer_${l}_attn_wk`)!, ly.wK.shape))
        ly.bK.assign(tf.tensor(weights.get(`layer_${l}_attn_bk`)!, ly.bK.shape))
        ly.wV.assign(tf.tensor(weights.get(`layer_${l}_attn_wv`)!, ly.wV.shape))
        ly.bV.assign(tf.tensor(weights.get(`layer_${l}_attn_bv`)!, ly.bV.shape))
        ly.wO.assign(tf.tensor(weights.get(`layer_${l}_attn_wo`)!, ly.wO.shape))
        ly.bO.assign(tf.tensor(weights.get(`layer_${l}_attn_bo`)!, ly.bO.shape))
        ly.ln2Scale.assign(tf.tensor(weights.get(`layer_${l}_ln2_scale`)!, ly.ln2Scale.shape))
        ly.ln2Bias.assign(tf.tensor(weights.get(`layer_${l}_ln2_bias`)!, ly.ln2Bias.shape))
        ly.ffnW1.assign(tf.tensor(weights.get(`layer_${l}_ffn_w1`)!, ly.ffnW1.shape))
        ly.ffnB1.assign(tf.tensor(weights.get(`layer_${l}_ffn_b1`)!, ly.ffnB1.shape))
        ly.ffnW2.assign(tf.tensor(weights.get(`layer_${l}_ffn_w2`)!, ly.ffnW2.shape))
        ly.ffnB2.assign(tf.tensor(weights.get(`layer_${l}_ffn_b2`)!, ly.ffnB2.shape))
      }

      this.finalLnScale.assign(tf.tensor(weights.get('final_ln_scale')!, this.finalLnScale.shape))
      this.finalLnBias.assign(tf.tensor(weights.get('final_ln_bias')!, this.finalLnBias.shape))

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
