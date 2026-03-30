/** 軽量ニューラルネットワーク実装（Dense + ReLU + Softmax + Tanh） */

// ============================================================
// 活性化関数
// ============================================================

export function relu(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) {
    out[i] = x[i] > 0 ? x[i] : 0
  }
  return out
}

export function reluBackward(x: Float32Array, gradOutput: Float32Array): Float32Array {
  const grad = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) {
    grad[i] = x[i] > 0 ? gradOutput[i] : 0
  }
  return grad
}

export function softmax(logits: Float32Array): Float32Array {
  const out = new Float32Array(logits.length)
  let max = -Infinity
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > max) max = logits[i]
  }
  let sum = 0
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - max)
    sum += out[i]
  }
  for (let i = 0; i < logits.length; i++) {
    out[i] /= sum
  }
  return out
}

export function sigmoid(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) {
    out[i] = 1 / (1 + Math.exp(-x[i]))
  }
  return out
}

export function tanh(x: number): number {
  return Math.tanh(x)
}

// ============================================================
// Dense Layer
// ============================================================

export class DenseLayer {
  readonly inputSize: number
  readonly outputSize: number
  weights: Float32Array   // [inputSize × outputSize], row-major
  biases: Float32Array    // [outputSize]

  // 勾配（学習時に使用）
  weightGrads: Float32Array
  biasGrads: Float32Array

  // Forward pass キャッシュ
  private _lastInput: Float32Array | null = null
  private _lastOutput: Float32Array | null = null

  constructor(inputSize: number, outputSize: number) {
    this.inputSize = inputSize
    this.outputSize = outputSize

    // He初期化
    const scale = Math.sqrt(2 / inputSize)
    this.weights = new Float32Array(inputSize * outputSize)
    for (let i = 0; i < this.weights.length; i++) {
      this.weights[i] = gaussianRandom() * scale
    }
    this.biases = new Float32Array(outputSize)

    this.weightGrads = new Float32Array(inputSize * outputSize)
    this.biasGrads = new Float32Array(outputSize)
  }

  forward(input: Float32Array): Float32Array {
    this._lastInput = input
    const out = new Float32Array(this.outputSize)
    for (let j = 0; j < this.outputSize; j++) {
      let sum = this.biases[j]
      for (let i = 0; i < this.inputSize; i++) {
        sum += input[i] * this.weights[i * this.outputSize + j]
      }
      out[j] = sum
    }
    this._lastOutput = out
    return out
  }

  /** 逆伝播: gradOutputを受け取り、gradInputを返す。weightGrads/biasGradsを蓄積 */
  backward(gradOutput: Float32Array): Float32Array {
    const input = this._lastInput!
    const gradInput = new Float32Array(this.inputSize)

    for (let j = 0; j < this.outputSize; j++) {
      this.biasGrads[j] += gradOutput[j]
      for (let i = 0; i < this.inputSize; i++) {
        this.weightGrads[i * this.outputSize + j] += input[i] * gradOutput[j]
        gradInput[i] += this.weights[i * this.outputSize + j] * gradOutput[j]
      }
    }

    return gradInput
  }

  zeroGrad(): void {
    this.weightGrads.fill(0)
    this.biasGrads.fill(0)
  }

  get lastOutput(): Float32Array | null {
    return this._lastOutput
  }

  /** パラメータ数 */
  get paramCount(): number {
    return this.weights.length + this.biases.length
  }
}

// ============================================================
// Multi-Head Neural Network
// ============================================================

export type NetworkConfig = {
  inputSize: number
  hiddenSizes: number[]       // e.g. [512, 256]
  heads: Record<string, number>  // head_name → output_size (softmax heads)
  sigmoidHeads?: Record<string, number>  // head_name → output_size (sigmoid heads)
  /** Transformer設定 (存在すればMLPの代わりにTransformerをtrunkとして使用) */
  transformer?: TransformerNetworkConfig
}

/** Transformerアーキテクチャ設定 */
export type TransformerNetworkConfig = {
  dModel: number            // e.g. 128
  numLayers: number         // e.g. 3
  numHeads: number          // e.g. 4
  dFf: number               // e.g. 256
  seatFeatures: number      // 生の1席あたり特徴量次元
  clsFeatures: number       // CLSトークンの生特徴量次元
  planFeatures: number      // プラントークンの生特徴量次元
  maxPlanTokens: number     // プラントークンの最大数
  /** per-seatヘッドの名前リスト (seat token出力から読み出す) */
  perSeatHeads: string[]    // e.g. ['vote', 'target', 'propose']
  /** per-seat sigmoid headの名前リスト (seat token出力から読み出す) */
  perSeatSigmoidHeads?: string[]  // e.g. ['predict']
}

export type ForwardResult = {
  policies: Map<string, Float32Array>  // head_name → logits (pre-softmax)
  value: number                         // scalar value estimate
}

/** NeuralNetwork / TransformerNetwork 共通インターフェース (推論用) */
export interface AnyNetwork {
  readonly config: NetworkConfig
  forward(input: Float32Array): ForwardResult
  getParams(): Float32Array[]
  cloneWeights(): Map<string, Float32Array>
  loadWeights(weights: Map<string, Float32Array>): void
  get totalParams(): number
}

/** TfNeuralNetwork / TfTransformerNetwork 共通インターフェース (学習用) */
export interface AnyTfNetwork {
  readonly config: NetworkConfig
  forward(input: Float32Array): ForwardResult
  trainBatch(batch: {
    observations: Float32Array[]
    actionHeads: string[]
    actionIndices: number[]
    oldLogProbs: number[]
    advantages: number[]
    returns: number[]
    sigmoidActions?: (Float32Array | undefined)[]
    clipEpsilon: number
    valueLossCoeff: number
    entropyCoeff: number
  }): { policyLoss: number, valueLoss: number, entropy: number }
  cloneWeights(): Map<string, Float32Array>
  loadWeights(weights: Map<string, Float32Array>): void
  get totalParams(): number
  dispose(): void
}

export class NeuralNetwork {
  readonly config: NetworkConfig
  readonly trunk: DenseLayer[]
  readonly heads: Map<string, DenseLayer>          // softmax heads
  readonly sigmoidHeads: Map<string, DenseLayer>    // sigmoid heads
  readonly valueHead: DenseLayer

  // ReLU入力キャッシュ（backward用）
  private _trunkPreActivations: Float32Array[] = []

  constructor(config: NetworkConfig) {
    this.config = config
    this.trunk = []
    this.heads = new Map()
    this.sigmoidHeads = new Map()

    // Trunk layers
    let prevSize = config.inputSize
    for (const hiddenSize of config.hiddenSizes) {
      this.trunk.push(new DenseLayer(prevSize, hiddenSize))
      prevSize = hiddenSize
    }

    // Softmax policy heads
    for (const [name, outputSize] of Object.entries(config.heads)) {
      this.heads.set(name, new DenseLayer(prevSize, outputSize))
    }

    // Sigmoid policy heads
    for (const [name, outputSize] of Object.entries(config.sigmoidHeads ?? {})) {
      this.sigmoidHeads.set(name, new DenseLayer(prevSize, outputSize))
    }

    // Value head (single output, tanh activation)
    this.valueHead = new DenseLayer(prevSize, 1)
  }

  forward(input: Float32Array): ForwardResult {
    this._trunkPreActivations = []

    // Trunk: Dense → ReLU → Dense → ReLU → ...
    let x = input
    for (const layer of this.trunk) {
      const preAct = layer.forward(x)
      this._trunkPreActivations.push(preAct)
      x = relu(preAct)
    }

    // Policy heads (output raw logits — softmax + sigmoid)
    const policies = new Map<string, Float32Array>()
    for (const [name, head] of this.heads) {
      policies.set(name, head.forward(x))
    }
    for (const [name, head] of this.sigmoidHeads) {
      policies.set(name, head.forward(x))
    }

    // Value head
    const rawValue = this.valueHead.forward(x)
    const value = tanh(rawValue[0])

    return { policies, value }
  }

  /** 全レイヤーの勾配をゼロに */
  zeroGrad(): void {
    for (const layer of this.trunk) layer.zeroGrad()
    for (const head of this.heads.values()) head.zeroGrad()
    for (const head of this.sigmoidHeads.values()) head.zeroGrad()
    this.valueHead.zeroGrad()
  }

  /**
   * 逆伝播
   * @param policyGrads head_name → gradients on logits
   * @param valueGrad gradient on tanh output
   */
  backward(policyGrads: Map<string, Float32Array>, valueGrad: number): void {
    const lastTrunkOutput = relu(this._trunkPreActivations[this._trunkPreActivations.length - 1])

    // Policy heads backward (softmax + sigmoid)
    let trunkGrad = new Float32Array(lastTrunkOutput.length)
    for (const [name, head] of this.heads) {
      const grad = policyGrads.get(name)
      if (!grad) continue
      const headGrad = head.backward(grad)
      for (let i = 0; i < trunkGrad.length; i++) {
        trunkGrad[i] += headGrad[i]
      }
    }
    for (const [name, head] of this.sigmoidHeads) {
      const grad = policyGrads.get(name)
      if (!grad) continue
      const headGrad = head.backward(grad)
      for (let i = 0; i < trunkGrad.length; i++) {
        trunkGrad[i] += headGrad[i]
      }
    }

    // Value head backward
    // d(tanh(x))/dx = 1 - tanh²(x)
    const rawValue = this.valueHead.lastOutput![0]
    const tanhVal = tanh(rawValue)
    const tanhGrad = (1 - tanhVal * tanhVal) * valueGrad
    const valueHeadGrad = this.valueHead.backward(new Float32Array([tanhGrad]))
    for (let i = 0; i < trunkGrad.length; i++) {
      trunkGrad[i] += valueHeadGrad[i]
    }

    // Trunk backward (reverse order)
    let grad: Float32Array = trunkGrad
    for (let l = this.trunk.length - 1; l >= 0; l--) {
      const preAct = this._trunkPreActivations[l]
      grad = reluBackward(preAct, grad) as Float32Array<ArrayBuffer>
      grad = this.trunk[l].backward(grad) as Float32Array<ArrayBuffer>
    }
  }

  /** 全パラメータをフラットに取得 */
  getParams(): Float32Array[] {
    const params: Float32Array[] = []
    for (const layer of this.trunk) {
      params.push(layer.weights, layer.biases)
    }
    for (const head of this.heads.values()) {
      params.push(head.weights, head.biases)
    }
    for (const head of this.sigmoidHeads.values()) {
      params.push(head.weights, head.biases)
    }
    params.push(this.valueHead.weights, this.valueHead.biases)
    return params
  }

  /** 全勾配をフラットに取得 */
  getGrads(): Float32Array[] {
    const grads: Float32Array[] = []
    for (const layer of this.trunk) {
      grads.push(layer.weightGrads, layer.biasGrads)
    }
    for (const head of this.heads.values()) {
      grads.push(head.weightGrads, head.biasGrads)
    }
    for (const head of this.sigmoidHeads.values()) {
      grads.push(head.weightGrads, head.biasGrads)
    }
    grads.push(this.valueHead.weightGrads, this.valueHead.biasGrads)
    return grads
  }

  /** 総パラメータ数 */
  get totalParams(): number {
    let total = 0
    for (const layer of this.trunk) total += layer.paramCount
    for (const head of this.heads.values()) total += head.paramCount
    for (const head of this.sigmoidHeads.values()) total += head.paramCount
    total += this.valueHead.paramCount
    return total
  }

  /** 重みのクローン（チェックポイント用） */
  cloneWeights(): Map<string, Float32Array> {
    const weights = new Map<string, Float32Array>()
    for (let i = 0; i < this.trunk.length; i++) {
      weights.set(`trunk_${i}_w`, new Float32Array(this.trunk[i].weights))
      weights.set(`trunk_${i}_b`, new Float32Array(this.trunk[i].biases))
    }
    for (const [name, head] of this.heads) {
      weights.set(`head_${name}_w`, new Float32Array(head.weights))
      weights.set(`head_${name}_b`, new Float32Array(head.biases))
    }
    for (const [name, head] of this.sigmoidHeads) {
      weights.set(`head_${name}_w`, new Float32Array(head.weights))
      weights.set(`head_${name}_b`, new Float32Array(head.biases))
    }
    weights.set('value_w', new Float32Array(this.valueHead.weights))
    weights.set('value_b', new Float32Array(this.valueHead.biases))
    return weights
  }

  /** 重みをロード */
  loadWeights(weights: Map<string, Float32Array>): void {
    for (let i = 0; i < this.trunk.length; i++) {
      this.trunk[i].weights.set(weights.get(`trunk_${i}_w`)!)
      this.trunk[i].biases.set(weights.get(`trunk_${i}_b`)!)
    }
    for (const [name, head] of this.heads) {
      head.weights.set(weights.get(`head_${name}_w`)!)
      head.biases.set(weights.get(`head_${name}_b`)!)
    }
    for (const [name, head] of this.sigmoidHeads) {
      head.weights.set(weights.get(`head_${name}_w`)!)
      head.biases.set(weights.get(`head_${name}_b`)!)
    }
    this.valueHead.weights.set(weights.get('value_w')!)
    this.valueHead.biases.set(weights.get('value_b')!)
  }
}

// ============================================================
// ユーティリティ
// ============================================================

/** Box-Muller法による正規分布乱数 */
let _hasSpare = false
let _spare = 0
export function gaussianRandom(): number {
  if (_hasSpare) {
    _hasSpare = false
    return _spare
  }
  let u: number, v: number, s: number
  do {
    u = Math.random() * 2 - 1
    v = Math.random() * 2 - 1
    s = u * u + v * v
  } while (s >= 1 || s === 0)
  s = Math.sqrt(-2 * Math.log(s) / s)
  _spare = v * s
  _hasSpare = true
  return u * s
}
