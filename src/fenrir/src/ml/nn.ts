/** NN共有ユーティリティ（活性化関数・DenseLayer・型定義） */

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
// Network Config & Types
// ============================================================

export type NetworkConfig = {
  inputSize: number
  heads: Record<string, number>  // head_name → output_size (softmax heads)
  sigmoidHeads?: Record<string, number>  // head_name → output_size (sigmoid heads)
  transformer: TransformerNetworkConfig
  /**
   * 終局 outcome 分布 head のサイズ (opt-in)。設定されると forward の戻り値に
   * outcomeDist (softmax 済 Float32Array) が乗る。
   *
   * skoll-zero では 4 (village_win / wolf_win / hamster_win / draw) を指定し、
   * value を陣営非依存の確率予測として学習させる (Stage 4)。
   * 未指定 (undefined) なら従来通り scalar value のみ。
   */
  outcomeDistOutputs?: number
}

/** Transformerアーキテクチャ設定 */
export type TransformerNetworkConfig = {
  dModel: number            // e.g. 128
  numHeads: number          // e.g. 4
  dFf: number               // e.g. 256
  seatFeatures: number      // 生の1席あたり特徴量次元
  clsFeatures: number       // CLSトークンの生特徴量次元
  planFeatures: number      // プラントークンの生特徴量次元 (入力plan tokens、旧互換)
  maxPlanTokens: number     // プラントークンの最大数 (入力plan tokens、旧互換)
  roleFeatures: number      // Role tokenの生特徴量次元
  numRoleTokens: number     // Role token数 (5 = CO可能役職)

  /** Seat Transformer層数 */
  seatLayers: number        // e.g. 3
  /** Strategy Layer層数 */
  strategyLayers: number    // e.g. 2
  /** Plan token数 (unified: forward + endgame 統合) */
  numPlanTokens: number     // 12
  /** Pointer語彙サイズ (14席 + 5役職 + grayran + or + stop) */
  planVocabSize: number     // 22 = PLAN_VOCAB.SIZE

  // 旧互換
  numLayers?: number

  /** per-seatヘッドの名前リスト (seat token出力から読み出す) */
  perSeatHeads: string[]    // e.g. ['vote', 'target']
  /** per-seat sigmoid headの名前リスト (seat token出力から読み出す) */
  perSeatSigmoidHeads?: string[]  // e.g. ['predict']
}

export type ForwardResult = {
  policies: Map<string, Float32Array>  // head_name → logits (pre-softmax)
  value: number                         // scalar value estimate (legacy scalar head)
  /**
   * Outcome 分布 head の出力 (config.outcomeDistOutputs 指定時のみ存在)。
   * softmax 済の確率分布 Float32Array (size = config.outcomeDistOutputs)。
   * 順序は consumer が決める (skoll-zero は [village_win, wolf_win, hamster_win, draw])。
   */
  outcomeDist?: Float32Array
  // Autoregressive plan decoder outputs (unified, populated by TransformerNetwork)
  planActions?: number[]
  planLogProbs?: number[]
}

/** Plan decoder に渡す盤面文脈（死亡席・未CO役職の mask 用） */
export type PlanContext = {
  aliveSeats: boolean[]    // [14] seat 0-13 の生存フラグ
  claimedRoles: boolean[]  // [5] CO_ROLES の CO 有無
  confirmedVillageSeats?: boolean[]  // [14] 確定白席（Phase 2 で解禁可）
  mySeat?: number          // 0-indexed seat index（自席を処刑対象から除外）
  maskedRoles?: boolean[]  // [5] CO者が全員除外済み（確定白+自席）の role token を禁止
}

/** TransformerNetwork 共通インターフェース (推論用) */
export interface AnyNetwork {
  readonly config: NetworkConfig
  forward(input: Float32Array, explore?: boolean, planContext?: PlanContext): ForwardResult
  getParams(): Float32Array[]
  cloneWeights(): Map<string, Float32Array>
  loadWeights(weights: Map<string, Float32Array>): void
  get totalParams(): number
}

/** TfTransformerNetwork 共通インターフェース (学習用) */
export interface AnyTfNetwork {
  readonly config: NetworkConfig
  forward(input: Float32Array, explore?: boolean): ForwardResult
  trainBatch(batch: {
    observations: Float32Array[]
    actionHeads: string[]
    actionIndices: number[]
    oldLogProbs: number[]
    advantages: number[]
    returns: number[]
    sigmoidActions?: (Float32Array | undefined)[]
    trueRoles?: (Float32Array | undefined)[]
    planActions?: (number[] | undefined)[]
    planLogProbs?: (number[] | undefined)[]
    predictLossCoeff?: number
    clipEpsilon: number
    valueLossCoeff: number
    entropyCoeff: number
    freezePlan?: boolean
    /** Reference policy logits for unified plan tokens [numPlanTokens * vocabSize] per step */
    refPlanLogits?: (Float32Array | undefined)[]
    /** KL penalty coefficient (β). >0 で KL(π_new || π_ref) を loss に加算 */
    klCoeff?: number
  }): { policyLoss: number, valueLoss: number, entropy: number, predictLoss: number, klLoss: number, klPlanLoss: number }
  cloneWeights(): Map<string, Float32Array>
  loadWeights(weights: Map<string, Float32Array>): void
  get totalParams(): number
  dispose(): void
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
