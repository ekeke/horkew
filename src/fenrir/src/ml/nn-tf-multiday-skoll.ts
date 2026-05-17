/**
 * TF.js GPU ベースの skoll-multiday-NN 学習モデル。
 *
 * Pure JS 版 `MultidaySkollNetwork` (multiday-skoll-network.ts) と同じ
 * architecture を TF.js で構築:
 *   - 入力: CLS features (~18 dim) + Seat features (14 × 12 dim)
 *   - Transformer Encoder (3 層、 dModel=64、 heads=4、 dFf=128)
 *   - Per-seat 出力: dModel → 1 dim (winRate、 linear)
 *
 * 損失: per-seat MSE with alive mask (非 alive seat は loss 寄与なし)。
 * 重み命名は Pure JS 版と同期 (cloneWeights / loadWeights で相互変換可)。
 */

// @ts-ignore — tf.js-node-gpu は CJS だが ESM から import 可能
import * as tf from '@tensorflow/tfjs-node-gpu'
import {
  type MultidaySkollConfig,
  DEFAULT_MULTIDAY_SKOLL_CONFIG,
  CLS_FEATURES,
  SEAT_FEATURES,
  MAX_SEAT,
} from './multiday-skoll-network.ts'

let _instId = 0

// ============================================================
// TfMultidaySkollNetwork
// ============================================================

export class TfMultidaySkollNetwork {
  readonly config: MultidaySkollConfig

  // Input projections
  private projClsW: tf.Variable
  private projClsB: tf.Variable
  private projSeatW: tf.Variable
  private projSeatB: tf.Variable

  // Transformer layers
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
  private layers: (typeof TfMultidaySkollNetwork.LayerShape)[]
  private finalLnScale: tf.Variable
  private finalLnBias: tf.Variable

  // Output head: per-seat dm → 1 winRate
  private outputW: tf.Variable
  private outputB: tf.Variable

  private allVariables: tf.Variable[]
  private optimizer: tf.AdamOptimizer

  private readonly dm: number
  private readonly numHeads: number
  private readonly dHead: number

  constructor(
    config: MultidaySkollConfig = DEFAULT_MULTIDAY_SKOLL_CONFIG,
    lr: number = 3e-4,
    /** 出力 bias の初期値。 訓練 label の平均で初期化すると収束が早い。 */
    outputBiasInit: number = 0,
  ) {
    const prefix = `mds${_instId++}_`
    this.config = config
    this.allVariables = []

    this.dm = config.dModel
    this.numHeads = config.numHeads
    this.dHead = config.dModel / config.numHeads
    if (this.dm % this.numHeads !== 0) {
      throw new Error(`dModel (${this.dm}) must be divisible by numHeads (${this.numHeads})`)
    }

    const dm = this.dm

    // 射影層
    this.projClsW = this.makeVar([CLS_FEATURES, dm], CLS_FEATURES, `${prefix}proj_cls_w`)
    this.projClsB = this.makeZeroVar([dm], `${prefix}proj_cls_b`)
    this.projSeatW = this.makeVar([SEAT_FEATURES, dm], SEAT_FEATURES, `${prefix}proj_seat_w`)
    this.projSeatB = this.makeZeroVar([dm], `${prefix}proj_seat_b`)

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

    // 出力ヘッド
    this.outputW = this.makeVar([dm, 1], dm, `${prefix}out_w`)
    this.outputB = tf.variable(tf.fill([1], outputBiasInit), true, `${prefix}out_b`)

    // 射影層と出力層も allVariables に追加
    this.allVariables.unshift(this.projClsW, this.projClsB, this.projSeatW, this.projSeatB)
    this.allVariables.push(this.outputW, this.outputB)

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

  /**
   * 入力 tensor を encoder への token 列に変換。
   * @param clsBatch [batch, CLS_FEATURES]
   * @param seatBatch [batch, MAX_SEAT, SEAT_FEATURES]
   * @returns [batch, SEQ_LEN, dModel]
   */
  private tokenizeAndProject(
    clsBatch: tf.Tensor2D,
    seatBatch: tf.Tensor3D,
  ): tf.Tensor3D {
    const batch = clsBatch.shape[0]
    const dm = this.dm

    // CLS: [batch, CLS_FEATURES] → [batch, 1, dm]
    const clsProj = tf.add(tf.matMul(clsBatch, this.projClsW), this.projClsB)
    const clsToken = clsProj.reshape([batch, 1, dm])

    // Seat: [batch, MAX_SEAT, SEAT_FEATURES] → [batch * MAX_SEAT, SEAT_FEATURES]
    //   → [batch * MAX_SEAT, dm] → [batch, MAX_SEAT, dm]
    const seatFlat = seatBatch.reshape([batch * MAX_SEAT, SEAT_FEATURES])
    const seatProj = tf.add(tf.matMul(seatFlat, this.projSeatW), this.projSeatB)
    const seatTokens = seatProj.reshape([batch, MAX_SEAT, dm])

    return tf.concat([clsToken, seatTokens], 1) as tf.Tensor3D
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

    // [batch, seq, dm] → [batch, seq, nh, dh] → [batch, nh, seq, dh]
    const q = qFlat.reshape([batch, seq, nh, dh]).transpose([0, 2, 1, 3])
    const k = kFlat.reshape([batch, seq, nh, dh]).transpose([0, 2, 1, 3])
    const v = vFlat.reshape([batch, seq, nh, dh]).transpose([0, 2, 1, 3])

    // Scaled dot-product attention
    const scores = tf.mul(tf.matMul(q, k, false, true), tf.scalar(1 / Math.sqrt(dh)))
    const attnWeights = tf.softmax(scores, -1)
    const context = tf.matMul(attnWeights, v)

    // [batch, nh, seq, dh] → [batch, seq, nh, dh] → [batch, seq, dm]
    const contextT = context.transpose([0, 2, 1, 3]).reshape([batch * seq, this.dm])
    const outFlat = tf.add(tf.matMul(contextT, wO), bO)
    return outFlat.reshape([batch, seq, this.dm]) as tf.Tensor3D
  }

  private feedForward(
    tokens: tf.Tensor3D,
    ffnW1: tf.Variable, ffnB1: tf.Variable,
    ffnW2: tf.Variable, ffnB2: tf.Variable,
  ): tf.Tensor3D {
    const batch = tokens.shape[0]
    const seq = tokens.shape[1]
    const flat = tokens.reshape([batch * seq, this.dm])
    const hidden = tf.relu(tf.add(tf.matMul(flat, ffnW1), ffnB1))
    const out = tf.add(tf.matMul(hidden, ffnW2), ffnB2)
    return out.reshape([batch, seq, this.dm]) as tf.Tensor3D
  }

  /**
   * Full forward: tokens → encoder → per-seat output.
   * @returns [batch, MAX_SEAT] per-seat winRate (linear)
   */
  private forwardImpl(clsBatch: tf.Tensor2D, seatBatch: tf.Tensor3D): tf.Tensor2D {
    let tokens = this.tokenizeAndProject(clsBatch, seatBatch)

    for (const layer of this.layers) {
      // Pre-LN: LN → MHA → residual
      const lnNorm1 = this.layerNorm(tokens, layer.ln1Scale, layer.ln1Bias) as tf.Tensor3D
      const attnOut = this.multiHeadAttention(
        lnNorm1,
        layer.wQ, layer.bQ, layer.wK, layer.bK, layer.wV, layer.bV, layer.wO, layer.bO,
      )
      tokens = tf.add(tokens, attnOut) as tf.Tensor3D

      // LN → FFN → residual
      const lnNorm2 = this.layerNorm(tokens, layer.ln2Scale, layer.ln2Bias) as tf.Tensor3D
      const ffnOut = this.feedForward(lnNorm2, layer.ffnW1, layer.ffnB1, layer.ffnW2, layer.ffnB2)
      tokens = tf.add(tokens, ffnOut) as tf.Tensor3D
    }

    // Final LN
    const finalNorm = this.layerNorm(tokens, this.finalLnScale, this.finalLnBias) as tf.Tensor3D

    // Per-seat output: skip CLS, take seat tokens [batch, MAX_SEAT, dm]
    const seatTokens = tf.slice(finalNorm, [0, 1, 0], [-1, MAX_SEAT, -1])
    const batch = seatTokens.shape[0]
    const seatFlat = seatTokens.reshape([batch * MAX_SEAT, this.dm])
    const outFlat = tf.add(tf.matMul(seatFlat, this.outputW), this.outputB)
    return outFlat.reshape([batch, MAX_SEAT]) as tf.Tensor2D
  }

  // ============================================================
  // Public API
  // ============================================================

  /**
   * Forward 推論 (= eval/inference 用)。 gradients は計算しない。
   * @returns Float32Array [batch * MAX_SEAT]
   */
  predict(
    clsBatch: Float32Array | Float32Array[],
    seatBatch: Float32Array | Float32Array[],
    batchSize: number,
  ): Float32Array {
    return tf.tidy(() => {
      const clsArr = Array.isArray(clsBatch)
        ? Float32Array.from(clsBatch.flatMap(a => Array.from(a)))
        : clsBatch
      const seatArr = Array.isArray(seatBatch)
        ? Float32Array.from(seatBatch.flatMap(a => Array.from(a)))
        : seatBatch
      const clsTensor = tf.tensor2d(clsArr, [batchSize, CLS_FEATURES])
      const seatTensor = tf.tensor3d(seatArr, [batchSize, MAX_SEAT, SEAT_FEATURES])
      const out = this.forwardImpl(clsTensor, seatTensor)
      return out.dataSync() as Float32Array
    })
  }

  /**
   * 1 minibatch の SL 学習 (forward + backward + optimizer step)。
   * @param clsBatch [batch * CLS_FEATURES] flat
   * @param seatBatch [batch * MAX_SEAT * SEAT_FEATURES] flat
   * @param labels [batch * MAX_SEAT] flat (per-seat winRate label)
   * @param masks [batch * MAX_SEAT] flat (1 if alive, 0 if dead)
   * @returns scalar loss (mean masked MSE)
   */
  trainStep(
    clsBatch: Float32Array,
    seatBatch: Float32Array,
    labels: Float32Array,
    masks: Float32Array,
    batchSize: number,
  ): number {
    let lossVal = 0
    this.optimizer.minimize(() => {
      const clsTensor = tf.tensor2d(clsBatch, [batchSize, CLS_FEATURES])
      const seatTensor = tf.tensor3d(seatBatch, [batchSize, MAX_SEAT, SEAT_FEATURES])
      const labelTensor = tf.tensor2d(labels, [batchSize, MAX_SEAT])
      const maskTensor = tf.tensor2d(masks, [batchSize, MAX_SEAT])

      const pred = this.forwardImpl(clsTensor, seatTensor)
      const diff = tf.sub(pred, labelTensor)
      const sqErr = tf.square(diff)
      const maskedErr = tf.mul(sqErr, maskTensor)
      // mean over alive entries only
      const sumMask = tf.sum(maskTensor)
      const loss = tf.div(tf.sum(maskedErr), tf.maximum(sumMask, tf.scalar(1e-6))) as tf.Scalar
      lossVal = loss.dataSync()[0]
      return loss
    }, true, this.allVariables)
    return lossVal
  }

  /**
   * Eval (no gradients): batch MSE + per-seat MAE。
   */
  evalBatch(
    clsBatch: Float32Array,
    seatBatch: Float32Array,
    labels: Float32Array,
    masks: Float32Array,
    batchSize: number,
  ): { mse: number, mae: number, n: number } {
    return tf.tidy(() => {
      const clsTensor = tf.tensor2d(clsBatch, [batchSize, CLS_FEATURES])
      const seatTensor = tf.tensor3d(seatBatch, [batchSize, MAX_SEAT, SEAT_FEATURES])
      const labelTensor = tf.tensor2d(labels, [batchSize, MAX_SEAT])
      const maskTensor = tf.tensor2d(masks, [batchSize, MAX_SEAT])

      const pred = this.forwardImpl(clsTensor, seatTensor)
      const diff = tf.sub(pred, labelTensor)
      const sqErr = tf.mul(tf.square(diff), maskTensor)
      const absErr = tf.mul(tf.abs(diff), maskTensor)
      const sumMask = tf.sum(maskTensor)
      const n = sumMask.dataSync()[0]
      const mse = (n > 0) ? (tf.sum(sqErr).dataSync()[0] / n) : 0
      const mae = (n > 0) ? (tf.sum(absErr).dataSync()[0] / n) : 0
      return { mse, mae, n }
    })
  }

  // ============================================================
  // Weight transfer (Pure JS 版と互換)
  // ============================================================

  cloneWeights(): Map<string, Float32Array> {
    const weights = new Map<string, Float32Array>()
    weights.set('proj_cls_w', this.projClsW.dataSync() as Float32Array)
    weights.set('proj_cls_b', this.projClsB.dataSync() as Float32Array)
    weights.set('proj_seat_w', this.projSeatW.dataSync() as Float32Array)
    weights.set('proj_seat_b', this.projSeatB.dataSync() as Float32Array)

    // encoder: enc_layer_{i}_{key} (Pure JS TransformerEncoder の命名規約に合わせる)
    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li]
      const px = `enc_layer_${li}_`
      weights.set(px + 'ln1_scale', layer.ln1Scale.dataSync() as Float32Array)
      weights.set(px + 'ln1_bias', layer.ln1Bias.dataSync() as Float32Array)
      weights.set(px + 'attn_wq', layer.wQ.dataSync() as Float32Array)
      weights.set(px + 'attn_bq', layer.bQ.dataSync() as Float32Array)
      weights.set(px + 'attn_wk', layer.wK.dataSync() as Float32Array)
      weights.set(px + 'attn_bk', layer.bK.dataSync() as Float32Array)
      weights.set(px + 'attn_wv', layer.wV.dataSync() as Float32Array)
      weights.set(px + 'attn_bv', layer.bV.dataSync() as Float32Array)
      weights.set(px + 'attn_wo', layer.wO.dataSync() as Float32Array)
      weights.set(px + 'attn_bo', layer.bO.dataSync() as Float32Array)
      weights.set(px + 'ln2_scale', layer.ln2Scale.dataSync() as Float32Array)
      weights.set(px + 'ln2_bias', layer.ln2Bias.dataSync() as Float32Array)
      weights.set(px + 'ffn_w1', layer.ffnW1.dataSync() as Float32Array)
      weights.set(px + 'ffn_b1', layer.ffnB1.dataSync() as Float32Array)
      weights.set(px + 'ffn_w2', layer.ffnW2.dataSync() as Float32Array)
      weights.set(px + 'ffn_b2', layer.ffnB2.dataSync() as Float32Array)
    }
    weights.set('enc_final_ln_scale', this.finalLnScale.dataSync() as Float32Array)
    weights.set('enc_final_ln_bias', this.finalLnBias.dataSync() as Float32Array)

    weights.set('output_w', this.outputW.dataSync() as Float32Array)
    weights.set('output_b', this.outputB.dataSync() as Float32Array)
    return weights
  }
}
