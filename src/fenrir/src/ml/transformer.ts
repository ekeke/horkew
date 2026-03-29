/**
 * Pure JS Transformer Encoder
 *
 * 推論用の軽量実装。バッチなし、単一サンプル向け。
 * トークン列: [CLS, Seat1..Seat14, Plan0..PlanN]
 * 各トークンは d_model 次元のベクトル。
 *
 * メモリ: ホットパスでのアロケーションを最小化。
 * スクラッチバッファをコンストラクタで確保し再利用する。
 */

import { gaussianRandom } from './nn.ts'

// ============================================================
// Transformer Config
// ============================================================

export type TransformerConfig = {
  dModel: number       // e.g. 128
  numLayers: number    // e.g. 3
  numHeads: number     // e.g. 4
  dFf: number          // e.g. 256
  maxSeqLen: number    // e.g. 23
}

// ============================================================
// LayerNorm
// ============================================================

export class LayerNorm {
  readonly size: number
  scale: Float32Array
  bias: Float32Array

  constructor(size: number) {
    this.size = size
    this.scale = new Float32Array(size).fill(1)
    this.bias = new Float32Array(size)
  }

  /** Pre-allocated output buffer版 */
  forwardInto(input: Float32Array, inputOffset: number, out: Float32Array, outOffset: number): void {
    const n = this.size
    let mean = 0
    for (let i = 0; i < n; i++) mean += input[inputOffset + i]
    mean /= n

    let variance = 0
    for (let i = 0; i < n; i++) {
      const d = input[inputOffset + i] - mean
      variance += d * d
    }
    variance /= n
    const invStd = 1 / Math.sqrt(variance + 1e-5)

    for (let i = 0; i < n; i++) {
      out[outOffset + i] = (input[inputOffset + i] - mean) * invStd * this.scale[i] + this.bias[i]
    }
  }

  get paramCount(): number {
    return this.size * 2
  }
}

// ============================================================
// MultiHeadAttention
// ============================================================

export class MultiHeadAttention {
  readonly dModel: number
  readonly numHeads: number
  readonly dHead: number

  // Weights: [dModel, dModel] for Q, K, V, O
  wQ: Float32Array
  bQ: Float32Array
  wK: Float32Array
  bK: Float32Array
  wV: Float32Array
  bV: Float32Array
  wO: Float32Array
  bO: Float32Array

  // Scratch buffers (pre-allocated for maxSeqLen)
  private _q: Float32Array
  private _k: Float32Array
  private _v: Float32Array
  private _attnScores: Float32Array  // [maxSeq * maxSeq] per head, reused
  private _attnOut: Float32Array     // [maxSeq * dModel]

  constructor(dModel: number, numHeads: number, maxSeqLen: number) {
    this.dModel = dModel
    this.numHeads = numHeads
    this.dHead = dModel / numHeads

    const scale = Math.sqrt(2 / dModel)
    this.wQ = initWeight(dModel, dModel, scale)
    this.bQ = new Float32Array(dModel)
    this.wK = initWeight(dModel, dModel, scale)
    this.bK = new Float32Array(dModel)
    this.wV = initWeight(dModel, dModel, scale)
    this.bV = new Float32Array(dModel)
    this.wO = initWeight(dModel, dModel, scale)
    this.bO = new Float32Array(dModel)

    this._q = new Float32Array(maxSeqLen * dModel)
    this._k = new Float32Array(maxSeqLen * dModel)
    this._v = new Float32Array(maxSeqLen * dModel)
    this._attnScores = new Float32Array(maxSeqLen * maxSeqLen)
    this._attnOut = new Float32Array(maxSeqLen * dModel)
  }

  /**
   * Self-attention forward.
   * tokens: flat [seqLen * dModel]
   * mask: boolean[seqLen] — true = present, false = padding
   * output written into `out` [seqLen * dModel]
   */
  forward(tokens: Float32Array, seqLen: number, mask: boolean[], out: Float32Array): void {
    const dm = this.dModel
    const dh = this.dHead
    const nh = this.numHeads
    const invSqrtDh = 1 / Math.sqrt(dh)

    // Compute Q, K, V for all tokens: linear projection
    linearBatched(tokens, this.wQ, this.bQ, dm, dm, seqLen, this._q)
    linearBatched(tokens, this.wK, this.bK, dm, dm, seqLen, this._k)
    linearBatched(tokens, this.wV, this.bV, dm, dm, seqLen, this._v)

    // Per-head attention
    this._attnOut.fill(0)

    for (let h = 0; h < nh; h++) {
      const hOff = h * dh

      // Compute attention scores for this head
      for (let i = 0; i < seqLen; i++) {
        if (!mask[i]) continue
        for (let j = 0; j < seqLen; j++) {
          if (!mask[j]) {
            this._attnScores[i * seqLen + j] = -Infinity
            continue
          }
          // dot(Q_i, K_j) for this head
          let dot = 0
          for (let d = 0; d < dh; d++) {
            dot += this._q[i * dm + hOff + d] * this._k[j * dm + hOff + d]
          }
          this._attnScores[i * seqLen + j] = dot * invSqrtDh
        }
      }

      // Softmax per row + weighted sum of V
      for (let i = 0; i < seqLen; i++) {
        if (!mask[i]) continue

        // Softmax
        let maxScore = -Infinity
        for (let j = 0; j < seqLen; j++) {
          const s = this._attnScores[i * seqLen + j]
          if (s > maxScore) maxScore = s
        }

        let sumExp = 0
        for (let j = 0; j < seqLen; j++) {
          const s = this._attnScores[i * seqLen + j]
          const e = s === -Infinity ? 0 : Math.exp(s - maxScore)
          this._attnScores[i * seqLen + j] = e
          sumExp += e
        }

        const invSum = sumExp > 0 ? 1 / sumExp : 0
        for (let j = 0; j < seqLen; j++) {
          this._attnScores[i * seqLen + j] *= invSum
        }

        // Weighted sum of V for this head
        for (let d = 0; d < dh; d++) {
          let val = 0
          for (let j = 0; j < seqLen; j++) {
            val += this._attnScores[i * seqLen + j] * this._v[j * dm + hOff + d]
          }
          this._attnOut[i * dm + hOff + d] = val
        }
      }
    }

    // Output projection: attnOut @ wO + bO
    linearBatched(this._attnOut, this.wO, this.bO, dm, dm, seqLen, out)
  }

  get paramCount(): number {
    return 4 * (this.dModel * this.dModel + this.dModel)
  }
}

// ============================================================
// FeedForward Network
// ============================================================

export class FeedForward {
  readonly dModel: number
  readonly dFf: number

  w1: Float32Array    // [dModel, dFf]
  b1: Float32Array    // [dFf]
  w2: Float32Array    // [dFf, dModel]
  b2: Float32Array    // [dModel]

  private _hidden: Float32Array  // [maxSeq * dFf]

  constructor(dModel: number, dFf: number, maxSeqLen: number) {
    this.dModel = dModel
    this.dFf = dFf

    const scale1 = Math.sqrt(2 / dModel)
    const scale2 = Math.sqrt(2 / dFf)
    this.w1 = initWeight(dModel, dFf, scale1)
    this.b1 = new Float32Array(dFf)
    this.w2 = initWeight(dFf, dModel, scale2)
    this.b2 = new Float32Array(dModel)

    this._hidden = new Float32Array(maxSeqLen * dFf)
  }

  /** Forward: GELU(x @ W1 + b1) @ W2 + b2 */
  forward(input: Float32Array, seqLen: number, out: Float32Array): void {
    const dm = this.dModel
    const df = this.dFf

    // x @ W1 + b1 → ReLU
    linearBatched(input, this.w1, this.b1, dm, df, seqLen, this._hidden)
    // ReLU in place
    for (let i = 0; i < seqLen * df; i++) {
      if (this._hidden[i] < 0) this._hidden[i] = 0
    }

    // hidden @ W2 + b2
    linearBatched(this._hidden, this.w2, this.b2, df, dm, seqLen, out)
  }

  get paramCount(): number {
    return this.dModel * this.dFf + this.dFf + this.dFf * this.dModel + this.dModel
  }
}

// ============================================================
// Transformer Block (Pre-LN)
// ============================================================

export class TransformerBlock {
  ln1: LayerNorm
  attn: MultiHeadAttention
  ln2: LayerNorm
  ffn: FeedForward

  // Scratch
  private _normed: Float32Array   // [maxSeq * dModel]
  private _sublayer: Float32Array // [maxSeq * dModel]

  constructor(dModel: number, numHeads: number, dFf: number, maxSeqLen: number) {
    this.ln1 = new LayerNorm(dModel)
    this.attn = new MultiHeadAttention(dModel, numHeads, maxSeqLen)
    this.ln2 = new LayerNorm(dModel)
    this.ffn = new FeedForward(dModel, dFf, maxSeqLen)

    this._normed = new Float32Array(maxSeqLen * dModel)
    this._sublayer = new Float32Array(maxSeqLen * dModel)
  }

  /**
   * Pre-LN Transformer block:
   *   x = x + Attn(LN1(x))
   *   x = x + FFN(LN2(x))
   * tokens is [seqLen * dModel], modified in-place.
   */
  forward(tokens: Float32Array, seqLen: number, mask: boolean[]): void {
    const dm = this.ln1.size

    // Sub-layer 1: x + Attn(LN1(x))
    for (let i = 0; i < seqLen; i++) {
      this.ln1.forwardInto(tokens, i * dm, this._normed, i * dm)
    }
    this.attn.forward(this._normed, seqLen, mask, this._sublayer)
    for (let i = 0; i < seqLen * dm; i++) {
      tokens[i] += this._sublayer[i]
    }

    // Sub-layer 2: x + FFN(LN2(x))
    for (let i = 0; i < seqLen; i++) {
      this.ln2.forwardInto(tokens, i * dm, this._normed, i * dm)
    }
    this.ffn.forward(this._normed, seqLen, this._sublayer)
    for (let i = 0; i < seqLen * dm; i++) {
      tokens[i] += this._sublayer[i]
    }
  }

  get paramCount(): number {
    return this.ln1.paramCount + this.attn.paramCount + this.ln2.paramCount + this.ffn.paramCount
  }
}

// ============================================================
// Transformer Encoder
// ============================================================

export class TransformerEncoder {
  readonly config: TransformerConfig
  readonly blocks: TransformerBlock[]
  readonly finalLN: LayerNorm

  constructor(config: TransformerConfig) {
    this.config = config
    this.blocks = []
    for (let i = 0; i < config.numLayers; i++) {
      this.blocks.push(new TransformerBlock(
        config.dModel, config.numHeads, config.dFf, config.maxSeqLen,
      ))
    }
    this.finalLN = new LayerNorm(config.dModel)
  }

  /**
   * Forward pass.
   * tokens: [seqLen * dModel] — modified in-place.
   * mask: boolean[seqLen]
   * Returns tokens (same buffer, modified).
   */
  forward(tokens: Float32Array, seqLen: number, mask: boolean[]): Float32Array {
    for (const block of this.blocks) {
      block.forward(tokens, seqLen, mask)
    }
    // Final LayerNorm
    const dm = this.config.dModel
    for (let i = 0; i < seqLen; i++) {
      this.finalLN.forwardInto(tokens, i * dm, tokens, i * dm)
    }
    return tokens
  }

  get paramCount(): number {
    let total = this.finalLN.paramCount
    for (const block of this.blocks) total += block.paramCount
    return total
  }

  /** 全パラメータを名前付きで収集 */
  collectWeights(): Map<string, Float32Array> {
    const weights = new Map<string, Float32Array>()
    for (let l = 0; l < this.blocks.length; l++) {
      const b = this.blocks[l]
      weights.set(`layer_${l}_ln1_scale`, b.ln1.scale)
      weights.set(`layer_${l}_ln1_bias`, b.ln1.bias)
      weights.set(`layer_${l}_attn_wq`, b.attn.wQ)
      weights.set(`layer_${l}_attn_bq`, b.attn.bQ)
      weights.set(`layer_${l}_attn_wk`, b.attn.wK)
      weights.set(`layer_${l}_attn_bk`, b.attn.bK)
      weights.set(`layer_${l}_attn_wv`, b.attn.wV)
      weights.set(`layer_${l}_attn_bv`, b.attn.bV)
      weights.set(`layer_${l}_attn_wo`, b.attn.wO)
      weights.set(`layer_${l}_attn_bo`, b.attn.bO)
      weights.set(`layer_${l}_ln2_scale`, b.ln2.scale)
      weights.set(`layer_${l}_ln2_bias`, b.ln2.bias)
      weights.set(`layer_${l}_ffn_w1`, b.ffn.w1)
      weights.set(`layer_${l}_ffn_b1`, b.ffn.b1)
      weights.set(`layer_${l}_ffn_w2`, b.ffn.w2)
      weights.set(`layer_${l}_ffn_b2`, b.ffn.b2)
    }
    weights.set('final_ln_scale', this.finalLN.scale)
    weights.set('final_ln_bias', this.finalLN.bias)
    return weights
  }

  /** 名前付き重みをロード */
  loadWeights(weights: Map<string, Float32Array>): void {
    for (let l = 0; l < this.blocks.length; l++) {
      const b = this.blocks[l]
      b.ln1.scale.set(weights.get(`layer_${l}_ln1_scale`)!)
      b.ln1.bias.set(weights.get(`layer_${l}_ln1_bias`)!)
      b.attn.wQ.set(weights.get(`layer_${l}_attn_wq`)!)
      b.attn.bQ.set(weights.get(`layer_${l}_attn_bq`)!)
      b.attn.wK.set(weights.get(`layer_${l}_attn_wk`)!)
      b.attn.bK.set(weights.get(`layer_${l}_attn_bk`)!)
      b.attn.wV.set(weights.get(`layer_${l}_attn_wv`)!)
      b.attn.bV.set(weights.get(`layer_${l}_attn_bv`)!)
      b.attn.wO.set(weights.get(`layer_${l}_attn_wo`)!)
      b.attn.bO.set(weights.get(`layer_${l}_attn_bo`)!)
      b.ln2.scale.set(weights.get(`layer_${l}_ln2_scale`)!)
      b.ln2.bias.set(weights.get(`layer_${l}_ln2_bias`)!)
      b.ffn.w1.set(weights.get(`layer_${l}_ffn_w1`)!)
      b.ffn.b1.set(weights.get(`layer_${l}_ffn_b1`)!)
      b.ffn.w2.set(weights.get(`layer_${l}_ffn_w2`)!)
      b.ffn.b2.set(weights.get(`layer_${l}_ffn_b2`)!)
    }
    this.finalLN.scale.set(weights.get('final_ln_scale')!)
    this.finalLN.bias.set(weights.get('final_ln_bias')!)
  }
}

// ============================================================
// ユーティリティ
// ============================================================

/** Xavier初期化 [inDim, outDim] row-major */
function initWeight(inDim: number, outDim: number, scale: number): Float32Array {
  const w = new Float32Array(inDim * outDim)
  for (let i = 0; i < w.length; i++) {
    w[i] = gaussianRandom() * scale
  }
  return w
}

/**
 * Batched linear: out[t] = input[t] @ W + b for t in [0, count).
 * input: [count * inDim], W: [inDim * outDim] row-major, b: [outDim]
 * out: [count * outDim]
 *
 * ループ順序を最適化: wのアクセスがシーケンシャルになるよう
 * i(入力次元)を外側、j(出力次元)を内側に配置。
 */
export { linearBatched as linearBatchedPublic }
function linearBatched(
  input: Float32Array, w: Float32Array, b: Float32Array,
  inDim: number, outDim: number, count: number,
  out: Float32Array,
): void {
  for (let t = 0; t < count; t++) {
    const inOff = t * inDim
    const outOff = t * outDim
    // biasで初期化
    for (let j = 0; j < outDim; j++) out[outOff + j] = b[j]
    // 重み累積: w[i*outDim .. i*outDim+outDim-1] をシーケンシャルに読む
    for (let i = 0; i < inDim; i++) {
      const val = input[inOff + i]
      if (val === 0) continue  // sparse optimization
      const wOff = i * outDim
      for (let j = 0; j < outDim; j++) {
        out[outOff + j] += val * w[wOff + j]
      }
    }
  }
}
