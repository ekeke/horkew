/**
 * Pure JS Transformer (forward + backward).
 * Self-contained — no dependency on fenrir/ml.
 *
 * 構成:
 *   Linear (重み付き全結合, バッチ対応)
 *   LayerNorm (per-token)
 *   MultiHeadAttention
 *   FeedForward
 *   TransformerBlock (Pre-LN)
 *   TransformerEncoder
 *
 * 各層は forward() で中間値を返し、backward() がそれを受けて勾配を計算・蓄積。
 * applyStep() で SGD 更新と grad zero をまとめて行う。
 */

// ============================================================
// Helpers
// ============================================================

export function gaussian(): number {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export function relu(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) out[i] = x[i] > 0 ? x[i] : 0
  return out
}

// ============================================================
// Linear layer (with batched forward/backward)
// ============================================================

export class Linear {
  readonly inDim: number
  readonly outDim: number
  weights: Float32Array     // [inDim * outDim] row-major: w[i, j] = weights[i * outDim + j]
  biases: Float32Array      // [outDim]
  weightGrads: Float32Array
  biasGrads: Float32Array
  // Adam optimizer state (lazy-initialized on first adamLinear call)
  weightM?: Float32Array
  weightV?: Float32Array
  biasM?: Float32Array
  biasV?: Float32Array
  adamT = 0

  constructor(inDim: number, outDim: number, scale?: number) {
    this.inDim = inDim
    this.outDim = outDim
    const s = scale ?? Math.sqrt(2 / inDim)  // He init
    this.weights = new Float32Array(inDim * outDim)
    for (let i = 0; i < this.weights.length; i++) this.weights[i] = gaussian() * s
    this.biases = new Float32Array(outDim)
    this.weightGrads = new Float32Array(inDim * outDim)
    this.biasGrads = new Float32Array(outDim)
  }

  ensureAdamState(): void {
    if (!this.weightM) {
      this.weightM = new Float32Array(this.weights.length)
      this.weightV = new Float32Array(this.weights.length)
      this.biasM = new Float32Array(this.biases.length)
      this.biasV = new Float32Array(this.biases.length)
    }
  }

  /** x: [inDim] → [outDim] */
  forward(x: Float32Array): Float32Array {
    const out = new Float32Array(this.outDim)
    for (let j = 0; j < this.outDim; j++) {
      let s = this.biases[j]
      for (let i = 0; i < this.inDim; i++) s += x[i] * this.weights[i * this.outDim + j]
      out[j] = s
    }
    return out
  }

  /** x: [batch * inDim] → [batch * outDim] */
  forwardBatched(x: Float32Array, batch: number): Float32Array {
    const out = new Float32Array(batch * this.outDim)
    for (let b = 0; b < batch; b++) {
      const xOff = b * this.inDim
      const yOff = b * this.outDim
      for (let j = 0; j < this.outDim; j++) {
        let s = this.biases[j]
        for (let i = 0; i < this.inDim; i++) s += x[xOff + i] * this.weights[i * this.outDim + j]
        out[yOff + j] = s
      }
    }
    return out
  }

  /** Returns dx [inDim], accumulates weight/bias grads */
  backward(x: Float32Array, dy: Float32Array): Float32Array {
    const dx = new Float32Array(this.inDim)
    for (let j = 0; j < this.outDim; j++) {
      const dyJ = dy[j]
      this.biasGrads[j] += dyJ
      for (let i = 0; i < this.inDim; i++) {
        this.weightGrads[i * this.outDim + j] += x[i] * dyJ
        dx[i] += this.weights[i * this.outDim + j] * dyJ
      }
    }
    return dx
  }

  backwardBatched(x: Float32Array, dy: Float32Array, batch: number): Float32Array {
    const dx = new Float32Array(batch * this.inDim)
    for (let b = 0; b < batch; b++) {
      const xOff = b * this.inDim
      const yOff = b * this.outDim
      const dxOff = b * this.inDim
      for (let j = 0; j < this.outDim; j++) {
        const dyJ = dy[yOff + j]
        this.biasGrads[j] += dyJ
        for (let i = 0; i < this.inDim; i++) {
          this.weightGrads[i * this.outDim + j] += x[xOff + i] * dyJ
          dx[dxOff + i] += this.weights[i * this.outDim + j] * dyJ
        }
      }
    }
    return dx
  }

  zeroGrad(): void {
    this.weightGrads.fill(0)
    this.biasGrads.fill(0)
  }
}

// ============================================================
// LayerNorm (per-token)
// ============================================================

export class LayerNorm {
  readonly dim: number
  readonly eps: number
  scale: Float32Array
  bias: Float32Array
  scaleGrads: Float32Array
  biasGrads: Float32Array
  // Adam optimizer state
  scaleM?: Float32Array
  scaleV?: Float32Array
  biasM?: Float32Array
  biasV?: Float32Array
  adamT = 0

  constructor(dim: number, eps = 1e-5) {
    this.dim = dim
    this.eps = eps
    this.scale = new Float32Array(dim).fill(1)
    this.bias = new Float32Array(dim)
    this.scaleGrads = new Float32Array(dim)
    this.biasGrads = new Float32Array(dim)
  }

  ensureAdamState(): void {
    if (!this.scaleM) {
      this.scaleM = new Float32Array(this.scale.length)
      this.scaleV = new Float32Array(this.scale.length)
      this.biasM = new Float32Array(this.bias.length)
      this.biasV = new Float32Array(this.bias.length)
    }
  }

  /** x: [batch * dim] */
  forwardBatched(x: Float32Array, batch: number): {
    output: Float32Array
    means: Float32Array
    invStds: Float32Array
  } {
    const out = new Float32Array(x.length)
    const means = new Float32Array(batch)
    const invStds = new Float32Array(batch)
    const N = this.dim
    for (let b = 0; b < batch; b++) {
      const off = b * N
      let mean = 0
      for (let i = 0; i < N; i++) mean += x[off + i]
      mean /= N
      let varSum = 0
      for (let i = 0; i < N; i++) {
        const d = x[off + i] - mean
        varSum += d * d
      }
      const variance = varSum / N
      const invStd = 1 / Math.sqrt(variance + this.eps)
      means[b] = mean
      invStds[b] = invStd
      for (let i = 0; i < N; i++) {
        const xhat = (x[off + i] - mean) * invStd
        out[off + i] = xhat * this.scale[i] + this.bias[i]
      }
    }
    return { output: out, means, invStds }
  }

  backwardBatched(
    x: Float32Array,
    dy: Float32Array,
    means: Float32Array,
    invStds: Float32Array,
    batch: number,
  ): Float32Array {
    const dx = new Float32Array(x.length)
    const N = this.dim
    for (let b = 0; b < batch; b++) {
      const off = b * N
      const mean = means[b]
      const invStd = invStds[b]
      const dxhat = new Float32Array(N)
      let sumDxhat = 0
      let sumDxhatXhat = 0
      for (let i = 0; i < N; i++) {
        const xhatI = (x[off + i] - mean) * invStd
        const dyI = dy[off + i]
        this.scaleGrads[i] += dyI * xhatI
        this.biasGrads[i] += dyI
        dxhat[i] = dyI * this.scale[i]
        sumDxhat += dxhat[i]
        sumDxhatXhat += dxhat[i] * xhatI
      }
      const factor = invStd / N
      for (let i = 0; i < N; i++) {
        const xhatI = (x[off + i] - mean) * invStd
        dx[off + i] = factor * (N * dxhat[i] - sumDxhat - xhatI * sumDxhatXhat)
      }
    }
    return dx
  }

  zeroGrad(): void {
    this.scaleGrads.fill(0)
    this.biasGrads.fill(0)
  }
}

// ============================================================
// MultiHeadAttention
// ============================================================

export type MhaCache = {
  Q: Float32Array
  K: Float32Array
  V: Float32Array
  attnWeights: Float32Array  // [numHeads * seqLen * seqLen]
  context: Float32Array
}

export class MultiHeadAttention {
  readonly dModel: number
  readonly numHeads: number
  readonly dHead: number
  wq: Linear
  wk: Linear
  wv: Linear
  wo: Linear

  constructor(dModel: number, numHeads: number) {
    if (dModel % numHeads !== 0) throw new Error(`dModel (${dModel}) must be divisible by numHeads (${numHeads})`)
    this.dModel = dModel
    this.numHeads = numHeads
    this.dHead = dModel / numHeads
    this.wq = new Linear(dModel, dModel)
    this.wk = new Linear(dModel, dModel)
    this.wv = new Linear(dModel, dModel)
    this.wo = new Linear(dModel, dModel)
  }

  /** x: [seqLen * dModel], mask[seqLen]. mask[j]=false → 他トークンから j への注意は無効 */
  forward(x: Float32Array, seqLen: number, mask: boolean[]): {
    output: Float32Array
    cache: MhaCache
  } {
    const Q = this.wq.forwardBatched(x, seqLen)
    const K = this.wk.forwardBatched(x, seqLen)
    const V = this.wv.forwardBatched(x, seqLen)
    const dHead = this.dHead
    const H = this.numHeads
    const dM = this.dModel
    const scale = 1 / Math.sqrt(dHead)
    const attnWeights = new Float32Array(H * seqLen * seqLen)
    const context = new Float32Array(seqLen * dM)

    for (let h = 0; h < H; h++) {
      const headOff = h * dHead
      const wOff = h * seqLen * seqLen
      // Scores
      const scores = new Float32Array(seqLen * seqLen)
      for (let i = 0; i < seqLen; i++) {
        for (let j = 0; j < seqLen; j++) {
          let s = 0
          for (let k = 0; k < dHead; k++) {
            s += Q[i * dM + headOff + k] * K[j * dM + headOff + k]
          }
          scores[i * seqLen + j] = s * scale
        }
      }
      // Mask: invalid keys → -inf
      for (let i = 0; i < seqLen; i++) {
        for (let j = 0; j < seqLen; j++) {
          if (!mask[j]) scores[i * seqLen + j] = -1e9
        }
      }
      // Softmax per row (only for valid query rows)
      for (let i = 0; i < seqLen; i++) {
        if (!mask[i]) {
          for (let j = 0; j < seqLen; j++) attnWeights[wOff + i * seqLen + j] = 0
          continue
        }
        let maxS = -Infinity
        for (let j = 0; j < seqLen; j++) if (scores[i * seqLen + j] > maxS) maxS = scores[i * seqLen + j]
        let sumE = 0
        for (let j = 0; j < seqLen; j++) {
          const e = Math.exp(scores[i * seqLen + j] - maxS)
          attnWeights[wOff + i * seqLen + j] = e
          sumE += e
        }
        for (let j = 0; j < seqLen; j++) {
          attnWeights[wOff + i * seqLen + j] /= sumE
        }
      }
      // Context = attnWeights @ V
      for (let i = 0; i < seqLen; i++) {
        for (let k = 0; k < dHead; k++) {
          let s = 0
          for (let j = 0; j < seqLen; j++) {
            s += attnWeights[wOff + i * seqLen + j] * V[j * dM + headOff + k]
          }
          context[i * dM + headOff + k] = s
        }
      }
    }

    const output = this.wo.forwardBatched(context, seqLen)
    return { output, cache: { Q, K, V, attnWeights, context } }
  }

  backward(
    x: Float32Array,
    cache: MhaCache,
    dy: Float32Array,
    seqLen: number,
    mask: boolean[],
  ): Float32Array {
    const dHead = this.dHead
    const H = this.numHeads
    const dM = this.dModel
    const scale = 1 / Math.sqrt(dHead)

    const dContext = this.wo.backwardBatched(cache.context, dy, seqLen)

    const dQ = new Float32Array(seqLen * dM)
    const dK = new Float32Array(seqLen * dM)
    const dV = new Float32Array(seqLen * dM)

    for (let h = 0; h < H; h++) {
      const headOff = h * dHead
      const wOff = h * seqLen * seqLen

      // dAttn[i, j] = sum_k dContext[i, headOff+k] * V[j, headOff+k]
      const dAttn = new Float32Array(seqLen * seqLen)
      for (let i = 0; i < seqLen; i++) {
        if (!mask[i]) continue
        for (let j = 0; j < seqLen; j++) {
          let s = 0
          for (let k = 0; k < dHead; k++) {
            s += dContext[i * dM + headOff + k] * cache.V[j * dM + headOff + k]
          }
          dAttn[i * seqLen + j] = s
        }
      }

      // dV[j, headOff+k] += sum_i attnWeights[i,j] * dContext[i, headOff+k]
      for (let j = 0; j < seqLen; j++) {
        for (let k = 0; k < dHead; k++) {
          let s = 0
          for (let i = 0; i < seqLen; i++) {
            if (!mask[i]) continue
            s += cache.attnWeights[wOff + i * seqLen + j] * dContext[i * dM + headOff + k]
          }
          dV[j * dM + headOff + k] += s
        }
      }

      // Softmax backward per row
      // dscores[i, j] = attn[i, j] * (dAttn[i, j] - sum_l attn[i, l] * dAttn[i, l])
      const dScores = new Float32Array(seqLen * seqLen)
      for (let i = 0; i < seqLen; i++) {
        if (!mask[i]) continue
        let dot = 0
        for (let j = 0; j < seqLen; j++) {
          dot += cache.attnWeights[wOff + i * seqLen + j] * dAttn[i * seqLen + j]
        }
        for (let j = 0; j < seqLen; j++) {
          dScores[i * seqLen + j] = cache.attnWeights[wOff + i * seqLen + j] * (dAttn[i * seqLen + j] - dot)
        }
      }

      // dQ[i, headOff+k] += scale * sum_j dScores[i, j] * K[j, headOff+k]
      // dK[j, headOff+k] += scale * sum_i dScores[i, j] * Q[i, headOff+k]
      for (let i = 0; i < seqLen; i++) {
        if (!mask[i]) continue
        for (let k = 0; k < dHead; k++) {
          let s = 0
          for (let j = 0; j < seqLen; j++) {
            s += dScores[i * seqLen + j] * cache.K[j * dM + headOff + k]
          }
          dQ[i * dM + headOff + k] += s * scale
        }
      }
      for (let j = 0; j < seqLen; j++) {
        for (let k = 0; k < dHead; k++) {
          let s = 0
          for (let i = 0; i < seqLen; i++) {
            if (!mask[i]) continue
            s += dScores[i * seqLen + j] * cache.Q[i * dM + headOff + k]
          }
          dK[j * dM + headOff + k] += s * scale
        }
      }
    }

    const dxQ = this.wq.backwardBatched(x, dQ, seqLen)
    const dxK = this.wk.backwardBatched(x, dK, seqLen)
    const dxV = this.wv.backwardBatched(x, dV, seqLen)
    const dx = new Float32Array(seqLen * dM)
    for (let i = 0; i < dx.length; i++) dx[i] = dxQ[i] + dxK[i] + dxV[i]
    return dx
  }

  zeroGrad(): void {
    this.wq.zeroGrad(); this.wk.zeroGrad(); this.wv.zeroGrad(); this.wo.zeroGrad()
  }
}

// ============================================================
// FeedForward
// ============================================================

export type FfnCache = {
  h1Pre: Float32Array
  h1Post: Float32Array
}

export class FeedForward {
  fc1: Linear
  fc2: Linear

  constructor(dModel: number, dFf: number) {
    this.fc1 = new Linear(dModel, dFf)
    this.fc2 = new Linear(dFf, dModel)
  }

  forward(x: Float32Array, seqLen: number): {
    output: Float32Array
    cache: FfnCache
  } {
    const h1Pre = this.fc1.forwardBatched(x, seqLen)
    const h1Post = relu(h1Pre)
    const output = this.fc2.forwardBatched(h1Post, seqLen)
    return { output, cache: { h1Pre, h1Post } }
  }

  backward(x: Float32Array, cache: FfnCache, dy: Float32Array, seqLen: number): Float32Array {
    const dh1Post = this.fc2.backwardBatched(cache.h1Post, dy, seqLen)
    const dh1Pre = new Float32Array(dh1Post.length)
    for (let i = 0; i < dh1Pre.length; i++) {
      dh1Pre[i] = cache.h1Pre[i] > 0 ? dh1Post[i] : 0
    }
    return this.fc1.backwardBatched(x, dh1Pre, seqLen)
  }

  zeroGrad(): void {
    this.fc1.zeroGrad(); this.fc2.zeroGrad()
  }
}

// ============================================================
// TransformerBlock (Pre-LN)
// ============================================================

export type BlockCache = {
  ln1Out: { output: Float32Array; means: Float32Array; invStds: Float32Array }
  attnCache: MhaCache
  attnOut: Float32Array
  afterAttn: Float32Array
  ln2Out: { output: Float32Array; means: Float32Array; invStds: Float32Array }
  ffnCache: FfnCache
  ffnOut: Float32Array
}

export class TransformerBlock {
  ln1: LayerNorm
  attn: MultiHeadAttention
  ln2: LayerNorm
  ffn: FeedForward

  constructor(dModel: number, numHeads: number, dFf: number) {
    this.ln1 = new LayerNorm(dModel)
    this.attn = new MultiHeadAttention(dModel, numHeads)
    this.ln2 = new LayerNorm(dModel)
    this.ffn = new FeedForward(dModel, dFf)
  }

  /** y = x + attn(LN(x)); out = y + ffn(LN(y)) */
  forward(x: Float32Array, seqLen: number, mask: boolean[]): {
    output: Float32Array
    cache: BlockCache
  } {
    const ln1Out = this.ln1.forwardBatched(x, seqLen)
    const { output: attnOut, cache: attnCache } = this.attn.forward(ln1Out.output, seqLen, mask)
    const afterAttn = new Float32Array(x.length)
    for (let i = 0; i < x.length; i++) afterAttn[i] = x[i] + attnOut[i]
    const ln2Out = this.ln2.forwardBatched(afterAttn, seqLen)
    const { output: ffnOut, cache: ffnCache } = this.ffn.forward(ln2Out.output, seqLen)
    const output = new Float32Array(x.length)
    for (let i = 0; i < x.length; i++) output[i] = afterAttn[i] + ffnOut[i]
    return { output, cache: { ln1Out, attnCache, attnOut, afterAttn, ln2Out, ffnCache, ffnOut } }
  }

  backward(x: Float32Array, cache: BlockCache, dy: Float32Array, seqLen: number, mask: boolean[]): Float32Array {
    // out = afterAttn + ffn(ln2(afterAttn))
    // dafterAttn = dy + d(ffn(ln2(afterAttn)))
    const dffnOut = dy
    const dln2OutVal = this.ffn.backward(cache.ln2Out.output, cache.ffnCache, dffnOut, seqLen)
    const dafterAttnFromFfn = this.ln2.backwardBatched(
      cache.afterAttn, dln2OutVal, cache.ln2Out.means, cache.ln2Out.invStds, seqLen,
    )
    const dafterAttn = new Float32Array(x.length)
    for (let i = 0; i < x.length; i++) dafterAttn[i] = dy[i] + dafterAttnFromFfn[i]

    // afterAttn = x + attn(ln1(x))
    const dattnOut = dafterAttn
    const dln1OutVal = this.attn.backward(cache.ln1Out.output, cache.attnCache, dattnOut, seqLen, mask)
    const dxFromAttn = this.ln1.backwardBatched(
      x, dln1OutVal, cache.ln1Out.means, cache.ln1Out.invStds, seqLen,
    )
    const dx = new Float32Array(x.length)
    for (let i = 0; i < x.length; i++) dx[i] = dafterAttn[i] + dxFromAttn[i]
    return dx
  }

  zeroGrad(): void {
    this.ln1.zeroGrad(); this.attn.zeroGrad(); this.ln2.zeroGrad(); this.ffn.zeroGrad()
  }
}

// ============================================================
// TransformerEncoder
// ============================================================

export type EncoderCache = {
  blockInputs: Float32Array[]
  blockCaches: BlockCache[]
  preFinalLN: Float32Array
  finalLNOut: { output: Float32Array; means: Float32Array; invStds: Float32Array }
}

export class TransformerEncoder {
  readonly dModel: number
  readonly numLayers: number
  blocks: TransformerBlock[]
  finalLN: LayerNorm

  constructor(dModel: number, numLayers: number, numHeads: number, dFf: number) {
    this.dModel = dModel
    this.numLayers = numLayers
    this.blocks = []
    for (let i = 0; i < numLayers; i++) {
      this.blocks.push(new TransformerBlock(dModel, numHeads, dFf))
    }
    this.finalLN = new LayerNorm(dModel)
  }

  forward(x: Float32Array, seqLen: number, mask: boolean[]): {
    output: Float32Array
    cache: EncoderCache
  } {
    const blockInputs: Float32Array[] = []
    const blockCaches: BlockCache[] = []
    let cur = x
    for (const block of this.blocks) {
      blockInputs.push(cur)
      const { output, cache } = block.forward(cur, seqLen, mask)
      blockCaches.push(cache)
      cur = output
    }
    const preFinalLN = cur
    const finalLNOut = this.finalLN.forwardBatched(cur, seqLen)
    return {
      output: finalLNOut.output,
      cache: { blockInputs, blockCaches, preFinalLN, finalLNOut },
    }
  }

  backward(cache: EncoderCache, dy: Float32Array, seqLen: number, mask: boolean[]): Float32Array {
    let dCur = this.finalLN.backwardBatched(
      cache.preFinalLN, dy, cache.finalLNOut.means, cache.finalLNOut.invStds, seqLen,
    )
    for (let l = this.blocks.length - 1; l >= 0; l--) {
      dCur = this.blocks[l].backward(cache.blockInputs[l], cache.blockCaches[l], dCur, seqLen, mask)
    }
    return dCur
  }

  zeroGrad(): void {
    for (const block of this.blocks) block.zeroGrad()
    this.finalLN.zeroGrad()
  }

  /** SGD step + zero grad. divisor は累積回数 (REINFORCE バッチサイズ等) */
  applyStep(lr: number, divisor: number): void {
    for (const block of this.blocks) {
      sgdLinear(block.attn.wq, lr, divisor)
      sgdLinear(block.attn.wk, lr, divisor)
      sgdLinear(block.attn.wv, lr, divisor)
      sgdLinear(block.attn.wo, lr, divisor)
      sgdLinear(block.ffn.fc1, lr, divisor)
      sgdLinear(block.ffn.fc2, lr, divisor)
      sgdLayerNorm(block.ln1, lr, divisor)
      sgdLayerNorm(block.ln2, lr, divisor)
    }
    sgdLayerNorm(this.finalLN, lr, divisor)
  }

  /** Adam step + zero grad */
  applyStepAdam(lr: number, divisor: number, opts?: AdamOpts): void {
    for (const block of this.blocks) {
      adamLinear(block.attn.wq, lr, divisor, opts)
      adamLinear(block.attn.wk, lr, divisor, opts)
      adamLinear(block.attn.wv, lr, divisor, opts)
      adamLinear(block.attn.wo, lr, divisor, opts)
      adamLinear(block.ffn.fc1, lr, divisor, opts)
      adamLinear(block.ffn.fc2, lr, divisor, opts)
      adamLayerNorm(block.ln1, lr, divisor, opts)
      adamLayerNorm(block.ln2, lr, divisor, opts)
    }
    adamLayerNorm(this.finalLN, lr, divisor, opts)
  }
}

export function sgdLinear(layer: Linear, lr: number, divisor: number): void {
  for (let i = 0; i < layer.weights.length; i++) {
    layer.weights[i] -= lr * (layer.weightGrads[i] / divisor)
    layer.weightGrads[i] = 0
  }
  for (let i = 0; i < layer.biases.length; i++) {
    layer.biases[i] -= lr * (layer.biasGrads[i] / divisor)
    layer.biasGrads[i] = 0
  }
}

export function sgdLayerNorm(ln: LayerNorm, lr: number, divisor: number): void {
  for (let i = 0; i < ln.scale.length; i++) {
    ln.scale[i] -= lr * (ln.scaleGrads[i] / divisor)
    ln.scaleGrads[i] = 0
  }
  for (let i = 0; i < ln.bias.length; i++) {
    ln.bias[i] -= lr * (ln.biasGrads[i] / divisor)
    ln.biasGrads[i] = 0
  }
}

// ============================================================
// Adam optimizer
// ============================================================

export type AdamOpts = {
  beta1?: number  // default 0.9
  beta2?: number  // default 0.999
  eps?: number    // default 1e-8
}

export function adamLinear(layer: Linear, lr: number, divisor: number, opts?: AdamOpts): void {
  const beta1 = opts?.beta1 ?? 0.9
  const beta2 = opts?.beta2 ?? 0.999
  const eps = opts?.eps ?? 1e-8
  layer.ensureAdamState()
  layer.adamT++
  const t = layer.adamT
  const b1Corr = 1 - Math.pow(beta1, t)
  const b2Corr = 1 - Math.pow(beta2, t)
  const wM = layer.weightM!, wV = layer.weightV!
  for (let i = 0; i < layer.weights.length; i++) {
    const g = layer.weightGrads[i] / divisor
    wM[i] = beta1 * wM[i] + (1 - beta1) * g
    wV[i] = beta2 * wV[i] + (1 - beta2) * g * g
    const mHat = wM[i] / b1Corr
    const vHat = wV[i] / b2Corr
    layer.weights[i] -= lr * mHat / (Math.sqrt(vHat) + eps)
    layer.weightGrads[i] = 0
  }
  const bM = layer.biasM!, bV = layer.biasV!
  for (let i = 0; i < layer.biases.length; i++) {
    const g = layer.biasGrads[i] / divisor
    bM[i] = beta1 * bM[i] + (1 - beta1) * g
    bV[i] = beta2 * bV[i] + (1 - beta2) * g * g
    const mHat = bM[i] / b1Corr
    const vHat = bV[i] / b2Corr
    layer.biases[i] -= lr * mHat / (Math.sqrt(vHat) + eps)
    layer.biasGrads[i] = 0
  }
}

export function adamLayerNorm(ln: LayerNorm, lr: number, divisor: number, opts?: AdamOpts): void {
  const beta1 = opts?.beta1 ?? 0.9
  const beta2 = opts?.beta2 ?? 0.999
  const eps = opts?.eps ?? 1e-8
  ln.ensureAdamState()
  ln.adamT++
  const t = ln.adamT
  const b1Corr = 1 - Math.pow(beta1, t)
  const b2Corr = 1 - Math.pow(beta2, t)
  const sM = ln.scaleM!, sV = ln.scaleV!
  for (let i = 0; i < ln.scale.length; i++) {
    const g = ln.scaleGrads[i] / divisor
    sM[i] = beta1 * sM[i] + (1 - beta1) * g
    sV[i] = beta2 * sV[i] + (1 - beta2) * g * g
    const mHat = sM[i] / b1Corr
    const vHat = sV[i] / b2Corr
    ln.scale[i] -= lr * mHat / (Math.sqrt(vHat) + eps)
    ln.scaleGrads[i] = 0
  }
  const bM = ln.biasM!, bV = ln.biasV!
  for (let i = 0; i < ln.bias.length; i++) {
    const g = ln.biasGrads[i] / divisor
    bM[i] = beta1 * bM[i] + (1 - beta1) * g
    bV[i] = beta2 * bV[i] + (1 - beta2) * g * g
    const mHat = bM[i] / b1Corr
    const vHat = bV[i] / b2Corr
    ln.bias[i] -= lr * mHat / (Math.sqrt(vHat) + eps)
    ln.biasGrads[i] = 0
  }
}
