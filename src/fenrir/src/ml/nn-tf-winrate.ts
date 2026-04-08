/**
 * TF.js GPU ベースの Win-Rate Estimator 学習モデル
 *
 * Seat Transformer (2層) + 3クラス softmax 出力。
 * 教師あり学習: focal cross-entropy loss。
 */

// @ts-ignore — tf.js-node-gpu は CJS だが ESM から import 可能
import * as tf from '@tensorflow/tfjs-node-gpu'
import {
  SEATS, NUM_ROLES, HISTORY_WINDOW,
  OBSERVATION_SIZE,
  ROLE_TOKEN_FEATURES, NUM_ROLE_TOKENS, ROLE_INDEX, CO_ROLES,
} from '../observation.ts'
import { type WinrateNetworkConfig, DEFAULT_WINRATE_CONFIG, NUM_CLASSES } from './winrate-network.ts'

// ============================================================
// Observation offset 定数 (observation.ts の非exportを再計算)
// ============================================================

const GLOBAL_SIZE = 19
const PER_SEAT_SIZE = 25
const PER_SEAT_START = GLOBAL_SIZE
const PRIVATE_START = PER_SEAT_START + SEATS * PER_SEAT_SIZE
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
const RETAR_START = HISTORY_START + HISTORY_WINDOW * HISTORY_DAY_SIZE
const RETAR_SIZE = SEATS * NUM_ROLES
const GLOBAL_RETAR_START = RETAR_START + RETAR_SIZE
const PLAN_APPROVED_START = GLOBAL_RETAR_START + SEATS * NUM_ROLES
const NEW_SIGNALS_PER_SEAT = 4
const NEW_SIGNALS_START = PLAN_APPROVED_START + SEATS
const NEW_SIGNALS_SIZE = SEATS * NEW_SIGNALS_PER_SEAT
const RAW_PLAN_SIZE = 12
const TSUMI_START = NEW_SIGNALS_START + NEW_SIGNALS_SIZE + RAW_PLAN_SIZE

// CLS features = 23 (individual mode)
const CLS_FEATURES = 23
// Seat features = 71 (individual mode)
const SEAT_TOKEN_FEATURES = 71
// Sequence length: CLS + 14 Seats + 5 Roles = 20
// Sequence: CLS + 14 Seats + 5 Roles = 20 (used for documentation, not at runtime)

let _wreId = 0

// ============================================================
// Index builders (replicating nn-tf-transformer.ts pattern)
// ============================================================

function buildClsIndices(): number[] {
  const indices: number[] = []
  for (let i = 0; i < GLOBAL_SIZE; i++) indices.push(i)
  indices.push(MASON_PARTNER_START)
  indices.push(KNOWN_HAMSTER_START)
  indices.push(REVOTE_ROUND_START)
  indices.push(TSUMI_START)
  return indices
}

function buildSeatIndices(): number[] {
  const indices: number[] = []
  for (let s = 0; s < SEATS; s++) {
    const psOff = PER_SEAT_START + s * PER_SEAT_SIZE
    for (let i = 0; i < PER_SEAT_SIZE; i++) indices.push(psOff + i)
    indices.push(DIVINE_START + s)
    indices.push(WOLF_TEAM_START + s)
    indices.push(GUARD_HISTORY_START + s)
    indices.push(REVOTE_CANDIDATES_START + s)
    for (let w = 0; w < HISTORY_WINDOW; w++) {
      const hOff = HISTORY_START + w * HISTORY_DAY_SIZE + s * 5
      for (let i = 0; i < 5; i++) indices.push(hOff + i)
    }
    const rOff = RETAR_START + s * NUM_ROLES
    for (let i = 0; i < NUM_ROLES; i++) indices.push(rOff + i)
    const grOff = GLOBAL_RETAR_START + s * NUM_ROLES
    for (let i = 0; i < NUM_ROLES; i++) indices.push(grOff + i)
    indices.push(PLAN_APPROVED_START + s)
    const nsOff = NEW_SIGNALS_START + s * NEW_SIGNALS_PER_SEAT
    for (let i = 0; i < NEW_SIGNALS_PER_SEAT; i++) indices.push(nsOff + i)
  }
  return indices
}

function buildRoleTokenSeatClaimIndices(): { roleIdx: number, seatClaimOffsets: number[] }[] {
  return CO_ROLES.map(role => {
    const roleIdx = ROLE_INDEX.get(role)!
    const seatClaimOffsets: number[] = []
    for (let s = 0; s < SEATS; s++) {
      seatClaimOffsets.push(PER_SEAT_START + s * PER_SEAT_SIZE + 1 + roleIdx)
    }
    return { roleIdx, seatClaimOffsets }
  })
}

// ============================================================
// TfWinrateNetwork
// ============================================================

export class TfWinrateNetwork {
  readonly config: WinrateNetworkConfig

  // Input projections
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
  private layers: (typeof TfWinrateNetwork.LayerShape)[]
  private finalLnScale: tf.Variable
  private finalLnBias: tf.Variable

  // Output head: CLS → 3 classes
  private outputW: tf.Variable
  private outputB: tf.Variable

  private allVariables: tf.Variable[]
  private optimizer: tf.AdamOptimizer

  // Pre-computed gather indices
  private clsGatherIndices: tf.Tensor1D
  private seatGatherIndices: tf.Tensor1D

  private readonly dm: number
  private readonly numHeads: number
  private readonly dHead: number

  constructor(config: WinrateNetworkConfig = DEFAULT_WINRATE_CONFIG, lr: number = 3e-4) {
    const prefix = `wre${_wreId++}_`
    this.config = config
    this.allVariables = []

    this.dm = config.dModel
    this.numHeads = config.numHeads
    this.dHead = config.dModel / config.numHeads

    const dm = this.dm

    // Gather indices
    this.clsGatherIndices = tf.tensor1d(buildClsIndices(), 'int32')
    this.seatGatherIndices = tf.tensor1d(buildSeatIndices(), 'int32')

    // Input projections
    this.projClsW = this.makeVar([CLS_FEATURES, dm], CLS_FEATURES, `${prefix}proj_cls_w`)
    this.projClsB = this.makeZeroVar([dm], `${prefix}proj_cls_b`)
    this.projSeatW = this.makeVar([SEAT_TOKEN_FEATURES, dm], SEAT_TOKEN_FEATURES, `${prefix}proj_seat_w`)
    this.projSeatB = this.makeZeroVar([dm], `${prefix}proj_seat_b`)
    this.projRoleW = this.makeVar([ROLE_TOKEN_FEATURES, dm], ROLE_TOKEN_FEATURES, `${prefix}proj_role_w`)
    this.projRoleB = this.makeZeroVar([dm], `${prefix}proj_role_b`)

    // Transformer layers
    this.layers = []
    for (let l = 0; l < config.numLayers; l++) {
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
        ffnW1: this.makeVar([dm, config.dFf], dm, `${prefix}l${l}_ff1w`),
        ffnB1: this.makeZeroVar([config.dFf], `${prefix}l${l}_ff1b`),
        ffnW2: this.makeVar([config.dFf, dm], config.dFf, `${prefix}l${l}_ff2w`),
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

    // Output head
    this.outputW = this.makeVar([dm, NUM_CLASSES], dm, `${prefix}out_w`)
    this.outputB = this.makeZeroVar([NUM_CLASSES], `${prefix}out_b`)

    this.optimizer = tf.train.adam(lr)
  }

  // ============================================================
  // Variable helpers
  // ============================================================

  private makeVar(shape: number[], fanIn: number, name: string): tf.Variable {
    return tf.variable(tf.randomNormal(shape, 0, Math.sqrt(2 / fanIn)), true, name)
  }

  private makeZeroVar(shape: number[], name: string): tf.Variable {
    return tf.variable(tf.zeros(shape), true, name)
  }

  // ============================================================
  // Tokenize + Project
  // ============================================================

  private tokenizeAndProject(obsTensor: tf.Tensor2D): tf.Tensor3D {
    const batch = obsTensor.shape[0]
    const dm = this.dm

    // CLS: [batch, CLS_FEATURES] → [batch, 1, dm]
    const clsRaw = tf.gather(obsTensor, this.clsGatherIndices, 1)
    const clsProj = tf.add(tf.matMul(clsRaw, this.projClsW), this.projClsB)
    const clsToken = clsProj.reshape([batch, 1, dm])

    // Seats: [batch, SEATS*SEAT_TOKEN_FEATURES] → [batch, SEATS, dm]
    const seatRaw = tf.gather(obsTensor, this.seatGatherIndices, 1)
    const seatProj = tf.add(
      tf.matMul(seatRaw.reshape([batch * SEATS, SEAT_TOKEN_FEATURES]), this.projSeatW),
      this.projSeatB,
    )
    const seatTokens = seatProj.reshape([batch, SEATS, dm])

    // Role tokens from claimed_role
    const roleInfo = buildRoleTokenSeatClaimIndices()
    const roleFeatureArrays: tf.Tensor[] = []
    for (const { seatClaimOffsets } of roleInfo) {
      const claimFlags = tf.gather(obsTensor, tf.tensor1d(seatClaimOffsets, 'int32'), 1)
      const coCount = tf.sum(claimFlags, 1, true).div(tf.scalar(SEATS))
      roleFeatureArrays.push(tf.concat([coCount, claimFlags], 1))
    }
    const roleRaw = tf.stack(roleFeatureArrays, 1)
    const roleProj = tf.add(
      tf.matMul(roleRaw.reshape([batch * NUM_ROLE_TOKENS, ROLE_TOKEN_FEATURES]), this.projRoleW),
      this.projRoleB,
    )
    const roleTokens = roleProj.reshape([batch, NUM_ROLE_TOKENS, dm])

    return tf.concat([clsToken, seatTokens, roleTokens], 1) as tf.Tensor3D
  }

  // ============================================================
  // Transformer forward
  // ============================================================

  private layerNorm(x: tf.Tensor, scale: tf.Variable, bias: tf.Variable): tf.Tensor {
    const mean = tf.mean(x, -1, true)
    const variance = tf.mean(tf.square(tf.sub(x, mean)), -1, true)
    const normalized = tf.div(tf.sub(x, mean), tf.sqrt(tf.add(variance, tf.scalar(1e-5))))
    return tf.add(tf.mul(normalized, scale), bias)
  }

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

    const flat = tokens.reshape([batch * seq, this.dm])
    const qFlat = tf.add(tf.matMul(flat, wQ), bQ)
    const kFlat = tf.add(tf.matMul(flat, wK), bK)
    const vFlat = tf.add(tf.matMul(flat, wV), bV)

    const q = qFlat.reshape([batch, seq, nh, dh]).transpose([0, 2, 1, 3])
    const k = kFlat.reshape([batch, seq, nh, dh]).transpose([0, 2, 1, 3])
    const v = vFlat.reshape([batch, seq, nh, dh]).transpose([0, 2, 1, 3])

    const scores = tf.mul(tf.matMul(q, k, false, true), tf.scalar(1 / Math.sqrt(dh)))
    const attnWeights = tf.softmax(scores, -1)
    const context = tf.matMul(attnWeights, v)

    const contextFlat = context.transpose([0, 2, 1, 3]).reshape([batch * seq, this.dm])
    const output = tf.add(tf.matMul(contextFlat, wO), bO)
    return output.reshape([batch, seq, this.dm]) as tf.Tensor3D
  }

  private forwardEncoder(tokens: tf.Tensor3D): tf.Tensor3D {
    let x = tokens
    for (const layer of this.layers) {
      const normed1 = this.layerNorm(x, layer.ln1Scale, layer.ln1Bias) as tf.Tensor3D
      const attnOut = this.multiHeadAttention(
        normed1,
        layer.wQ, layer.bQ, layer.wK, layer.bK, layer.wV, layer.bV, layer.wO, layer.bO,
      )
      x = tf.add(x, attnOut) as tf.Tensor3D

      const normed2 = this.layerNorm(x, layer.ln2Scale, layer.ln2Bias) as tf.Tensor3D
      const batch = x.shape[0]
      const seq = x.shape[1]
      const flat2 = normed2.reshape([batch * seq, this.dm])
      const hidden = tf.relu(tf.add(tf.matMul(flat2, layer.ffnW1), layer.ffnB1))
      const ffnOut = tf.add(tf.matMul(hidden, layer.ffnW2), layer.ffnB2)
      x = tf.add(x, ffnOut.reshape([batch, seq, this.dm])) as tf.Tensor3D
    }
    return this.layerNorm(x, this.finalLnScale, this.finalLnBias) as tf.Tensor3D
  }

  // ============================================================
  // Forward (inference)
  // ============================================================

  /** バッチ推論: observations → [batch, 3] win probabilities */
  forwardBatch(observations: Float32Array[]): Float32Array[] {
    const n = observations.length
    const inputSize = OBSERVATION_SIZE
    const data = new Float32Array(n * inputSize)
    for (let i = 0; i < n; i++) data.set(observations[i], i * inputSize)

    const result: Float32Array[] = tf.tidy(() => {
      const obsTensor = tf.tensor2d(data, [n, inputSize])
      const tokens = this.tokenizeAndProject(obsTensor)
      const encoded = this.forwardEncoder(tokens)
      const clsOut = encoded.slice([0, 0, 0], [n, 1, this.dm]).reshape([n, this.dm])
      const logits = tf.add(tf.matMul(clsOut, this.outputW), this.outputB)
      const probs = tf.softmax(logits, -1)
      const arr = probs.arraySync() as number[][]
      return arr.map((row: number[]) => new Float32Array(row))
    })

    return result
  }

  // ============================================================
  // Training
  // ============================================================

  /**
   * Focal cross-entropy 学習
   * @param observations [n] flat observation arrays
   * @param labels [n] one-hot labels [village_win, wolf_win, fox_win]
   * @param focalGamma focal loss gamma (0 = standard CE)
   */
  trainBatch(
    observations: Float32Array[],
    labels: Float32Array[],
    focalGamma: number = 2.0,
  ): { loss: number, brierScore: number } {
    const n = observations.length
    if (n === 0) return { loss: 0, brierScore: 0 }

    const inputSize = OBSERVATION_SIZE
    const obsData = new Float32Array(n * inputSize)
    for (let i = 0; i < n; i++) obsData.set(observations[i], i * inputSize)

    const labelData = new Float32Array(n * NUM_CLASSES)
    for (let i = 0; i < n; i++) labelData.set(labels[i], i * NUM_CLASSES)

    let lossVal = 0
    let brierVal = 0

    const lossFunc = () => {
      const obsTensor = tf.tensor2d(obsData, [n, inputSize])
      const tokens = this.tokenizeAndProject(obsTensor)
      const encoded = this.forwardEncoder(tokens)
      const clsOut = encoded.slice([0, 0, 0], [n, 1, this.dm]).reshape([n, this.dm])
      const logits = tf.add(tf.matMul(clsOut, this.outputW), this.outputB)
      const probs = tf.softmax(logits, -1)

      const labelTensor = tf.tensor2d(labelData, [n, NUM_CLASSES])

      // Focal cross-entropy: -α * (1 - p_t)^γ * log(p_t)
      const probsClamped = tf.clipByValue(probs, 1e-7, 1 - 1e-7)
      const logProbs = tf.log(probsClamped)
      const pCorrect = tf.sum(tf.mul(probs, labelTensor), -1)  // [n]

      let loss: tf.Scalar
      if (focalGamma > 0) {
        const focalWeight = tf.pow(tf.sub(tf.scalar(1), pCorrect), tf.scalar(focalGamma))  // [n]
        const cePerSample = tf.neg(tf.sum(tf.mul(labelTensor, logProbs), -1))  // [n]
        loss = tf.mean(tf.mul(focalWeight, cePerSample)) as tf.Scalar
      } else {
        loss = tf.mean(tf.neg(tf.sum(tf.mul(labelTensor, logProbs), -1))) as tf.Scalar
      }

      // Brier score: mean(sum((p - y)^2))
      const brierPerSample = tf.sum(tf.squaredDifference(probs, labelTensor), -1)
      const brier = tf.mean(brierPerSample) as tf.Scalar

      lossVal = loss.dataSync()[0]
      brierVal = brier.dataSync()[0]

      return loss
    }

    this.optimizer.minimize(lossFunc, false, this.allVariables)

    return { loss: lossVal, brierScore: brierVal }
  }

  // ============================================================
  // Weight management
  // ============================================================

  cloneWeights(): Map<string, Float32Array> {
    const weights = new Map<string, Float32Array>()

    weights.set('proj_cls_w', this.projClsW.dataSync() as Float32Array)
    weights.set('proj_cls_b', this.projClsB.dataSync() as Float32Array)
    weights.set('proj_seat_w', this.projSeatW.dataSync() as Float32Array)
    weights.set('proj_seat_b', this.projSeatB.dataSync() as Float32Array)
    weights.set('proj_role_w', this.projRoleW.dataSync() as Float32Array)
    weights.set('proj_role_b', this.projRoleB.dataSync() as Float32Array)

    for (let l = 0; l < this.layers.length; l++) {
      const ly = this.layers[l]
      weights.set(`enc_layer_${l}_ln1_scale`, ly.ln1Scale.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_ln1_bias`, ly.ln1Bias.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_attn_wq`, ly.wQ.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_attn_bq`, ly.bQ.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_attn_wk`, ly.wK.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_attn_bk`, ly.bK.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_attn_wv`, ly.wV.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_attn_bv`, ly.bV.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_attn_wo`, ly.wO.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_attn_bo`, ly.bO.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_ln2_scale`, ly.ln2Scale.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_ln2_bias`, ly.ln2Bias.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_ffn_w1`, ly.ffnW1.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_ffn_b1`, ly.ffnB1.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_ffn_w2`, ly.ffnW2.dataSync() as Float32Array)
      weights.set(`enc_layer_${l}_ffn_b2`, ly.ffnB2.dataSync() as Float32Array)
    }
    weights.set('enc_final_ln_scale', this.finalLnScale.dataSync() as Float32Array)
    weights.set('enc_final_ln_bias', this.finalLnBias.dataSync() as Float32Array)

    weights.set('output_w', this.outputW.dataSync() as Float32Array)
    weights.set('output_b', this.outputB.dataSync() as Float32Array)

    return weights
  }

  loadWeights(weights: Map<string, Float32Array>): void {
    this.projClsW.assign(tf.tensor(weights.get('proj_cls_w')!, this.projClsW.shape))
    this.projClsB.assign(tf.tensor(weights.get('proj_cls_b')!, this.projClsB.shape))
    this.projSeatW.assign(tf.tensor(weights.get('proj_seat_w')!, this.projSeatW.shape))
    this.projSeatB.assign(tf.tensor(weights.get('proj_seat_b')!, this.projSeatB.shape))
    this.projRoleW.assign(tf.tensor(weights.get('proj_role_w')!, this.projRoleW.shape))
    this.projRoleB.assign(tf.tensor(weights.get('proj_role_b')!, this.projRoleB.shape))

    for (let l = 0; l < this.layers.length; l++) {
      const ly = this.layers[l]
      ly.ln1Scale.assign(tf.tensor(weights.get(`enc_layer_${l}_ln1_scale`)!, ly.ln1Scale.shape))
      ly.ln1Bias.assign(tf.tensor(weights.get(`enc_layer_${l}_ln1_bias`)!, ly.ln1Bias.shape))
      ly.wQ.assign(tf.tensor(weights.get(`enc_layer_${l}_attn_wq`)!, ly.wQ.shape))
      ly.bQ.assign(tf.tensor(weights.get(`enc_layer_${l}_attn_bq`)!, ly.bQ.shape))
      ly.wK.assign(tf.tensor(weights.get(`enc_layer_${l}_attn_wk`)!, ly.wK.shape))
      ly.bK.assign(tf.tensor(weights.get(`enc_layer_${l}_attn_bk`)!, ly.bK.shape))
      ly.wV.assign(tf.tensor(weights.get(`enc_layer_${l}_attn_wv`)!, ly.wV.shape))
      ly.bV.assign(tf.tensor(weights.get(`enc_layer_${l}_attn_bv`)!, ly.bV.shape))
      ly.wO.assign(tf.tensor(weights.get(`enc_layer_${l}_attn_wo`)!, ly.wO.shape))
      ly.bO.assign(tf.tensor(weights.get(`enc_layer_${l}_attn_bo`)!, ly.bO.shape))
      ly.ln2Scale.assign(tf.tensor(weights.get(`enc_layer_${l}_ln2_scale`)!, ly.ln2Scale.shape))
      ly.ln2Bias.assign(tf.tensor(weights.get(`enc_layer_${l}_ln2_bias`)!, ly.ln2Bias.shape))
      ly.ffnW1.assign(tf.tensor(weights.get(`enc_layer_${l}_ffn_w1`)!, ly.ffnW1.shape))
      ly.ffnB1.assign(tf.tensor(weights.get(`enc_layer_${l}_ffn_b1`)!, ly.ffnB1.shape))
      ly.ffnW2.assign(tf.tensor(weights.get(`enc_layer_${l}_ffn_w2`)!, ly.ffnW2.shape))
      ly.ffnB2.assign(tf.tensor(weights.get(`enc_layer_${l}_ffn_b2`)!, ly.ffnB2.shape))
    }
    this.finalLnScale.assign(tf.tensor(weights.get('enc_final_ln_scale')!, this.finalLnScale.shape))
    this.finalLnBias.assign(tf.tensor(weights.get('enc_final_ln_bias')!, this.finalLnBias.shape))

    this.outputW.assign(tf.tensor(weights.get('output_w')!, this.outputW.shape))
    this.outputB.assign(tf.tensor(weights.get('output_b')!, this.outputB.shape))
  }

  /** TF.js テンソルを解放 */
  dispose(): void {
    for (const v of this.allVariables) v.dispose()
    this.clsGatherIndices.dispose()
    this.seatGatherIndices.dispose()
  }

  get totalParams(): number {
    let total = 0
    for (const v of this.allVariables) total += v.size
    return total
  }
}
