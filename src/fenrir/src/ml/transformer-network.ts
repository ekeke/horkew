/**
 * Transformer-based Neural Network (pure JS, 推論用)
 *
 * NeuralNetwork と同じ ForwardResult インターフェースを持つ。
 * フラットobservationを受け取り、内部でトークン化してTransformerに通す。
 *
 * ヘッド読み出し:
 *   per-seat heads: 各席トークン出力から読み出し (vote, target, propose, predict, night)
 *   global heads: CLSトークン出力から読み出し (comm, claim, leader)
 *   value: CLSトークン出力から読み出し
 */

import type { NetworkConfig, ForwardResult, TransformerNetworkConfig } from './nn.ts'
import { DenseLayer } from './nn.ts'
import { TransformerEncoder, type TransformerConfig, linearBatchedPublic } from './transformer.ts'
import { tokenize, SEATS } from '../observation.ts'

export class TransformerNetwork {
  readonly config: NetworkConfig
  readonly tConfig: TransformerNetworkConfig

  // Input projections: raw features → d_model
  private projCls: DenseLayer
  private projSeat: DenseLayer
  private projPlan: DenseLayer | null

  // Transformer encoder
  private encoder: TransformerEncoder

  // Head layers
  //   per-seat softmax: [dModel, 1] per head → applied to each seat token → SEATS logits
  //   per-seat sigmoid: [dModel, perSeatOutputSize] per head → applied to each seat token
  //   global softmax: [dModel, outputSize] per head → applied to CLS
  //   value: [dModel, 1] → tanh
  private perSeatHeads: Map<string, DenseLayer>     // dModel → 1
  private perSeatSigmoidHeads: Map<string, DenseLayer>  // dModel → outputSize/SEATS
  private globalHeads: Map<string, DenseLayer>      // dModel → outputSize
  private globalSigmoidHeads: Map<string, DenseLayer>
  private valueHead: DenseLayer

  // Special: night head needs CLS (for "none" action) + per-seat
  private nightSeatHead: DenseLayer | null = null  // dModel → 1 (per seat)
  private nightClsHead: DenseLayer | null = null   // dModel → 1 (none action)

  // Scratch buffers
  private _tokens: Float32Array    // [maxSeqLen * dModel]
  private _mask: boolean[]
  private _seatProjected: Float32Array  // [SEATS * dModel] — batch projection scratch

  /** isTeam: チームネットワークかどうか (token featureサイズが変わる) */
  readonly isTeam: boolean

  constructor(config: NetworkConfig, isTeam: boolean = false) {
    if (!config.transformer) throw new Error('NetworkConfig.transformer is required')

    this.config = config
    this.tConfig = config.transformer
    this.isTeam = isTeam

    const tc = this.tConfig
    const dm = tc.dModel
    const maxSeq = 1 + SEATS + tc.maxPlanTokens  // CLS + seats + plans

    // Input projections
    this.projCls = new DenseLayer(tc.clsFeatures, dm)
    this.projSeat = new DenseLayer(tc.seatFeatures, dm)
    this.projPlan = tc.planFeatures > 0 ? new DenseLayer(tc.planFeatures, dm) : null

    // Transformer
    const encoderConfig: TransformerConfig = {
      dModel: dm,
      numLayers: tc.numLayers,
      numHeads: tc.numHeads,
      dFf: tc.dFf,
      maxSeqLen: maxSeq,
    }
    this.encoder = new TransformerEncoder(encoderConfig)

    // Per-seat heads (softmax): each produces 1 logit per seat
    const perSeatSet = new Set(tc.perSeatHeads)
    const perSeatSigmoidSet = new Set(tc.perSeatSigmoidHeads ?? [])

    this.perSeatHeads = new Map()
    this.perSeatSigmoidHeads = new Map()
    this.globalHeads = new Map()
    this.globalSigmoidHeads = new Map()

    // Classify heads
    for (const [name, outputSize] of Object.entries(config.heads)) {
      if (name === 'night') {
        // Special handling: SEATS logits from seat tokens + 1 from CLS = SEATS+1
        this.nightSeatHead = new DenseLayer(dm, 1)
        this.nightClsHead = new DenseLayer(dm, 1)
      } else if (perSeatSet.has(name)) {
        // Per-seat softmax: dModel → 1, applied SEATS times → SEATS logits
        this.perSeatHeads.set(name, new DenseLayer(dm, 1))
      } else {
        // Global softmax: dModel → outputSize
        this.globalHeads.set(name, new DenseLayer(dm, outputSize))
      }
    }

    for (const [name, outputSize] of Object.entries(config.sigmoidHeads ?? {})) {
      if (perSeatSigmoidSet.has(name)) {
        // Per-seat sigmoid: dModel → outputSize/SEATS per seat
        const perSeatDim = outputSize / SEATS
        this.perSeatSigmoidHeads.set(name, new DenseLayer(dm, perSeatDim))
      } else {
        // Global sigmoid
        this.globalSigmoidHeads.set(name, new DenseLayer(dm, outputSize))
      }
    }

    // Value head
    this.valueHead = new DenseLayer(dm, 1)

    // Scratch
    this._tokens = new Float32Array(maxSeq * dm)
    this._mask = new Array(maxSeq).fill(false)
    this._seatProjected = new Float32Array(SEATS * dm)
  }

  forward(input: Float32Array): ForwardResult {
    const tc = this.tConfig
    const dm = tc.dModel
    const sf = tc.seatFeatures

    // Tokenize
    const tok = tokenize(input, this.isTeam)

    // Build token sequence: [CLS, Seat0..Seat13, Plan0..PlanN]
    const seqLen = 1 + SEATS + tok.planCount
    this._tokens.fill(0)
    for (let i = 0; i < seqLen; i++) this._mask[i] = true
    for (let i = seqLen; i < this._mask.length; i++) this._mask[i] = false

    // Project CLS → token[0]
    const clsProj = this.projCls.forward(tok.cls)
    this._tokens.set(clsProj, 0)

    // Batch project all seats using linearBatched: seats[SEATS * sf] → _seatProjected[SEATS * dm]
    linearBatchedPublic(
      tok.seats, this.projSeat.weights, this.projSeat.biases,
      sf, dm, SEATS, this._seatProjected,
    )
    // Copy into token sequence at positions [1..14]
    this._tokens.set(this._seatProjected, dm)

    // Project plan tokens → token[15..]
    if (this.projPlan && tok.planCount > 0) {
      for (let p = 0; p < tok.planCount; p++) {
        const planRaw = tok.plans.subarray(p * tc.planFeatures, (p + 1) * tc.planFeatures)
        const planProj = this.projPlan.forward(planRaw)
        this._tokens.set(planProj, (1 + SEATS + p) * dm)
      }
    }

    // Transformer forward
    this.encoder.forward(this._tokens, seqLen, this._mask)

    // Seat token outputs start at offset dm (after CLS)
    const seatOutputs = this._tokens  // tokens[1*dm .. (1+SEATS)*dm]
    const seatBase = dm  // offset of first seat token

    const policies = new Map<string, Float32Array>()

    // === Per-seat softmax heads: direct dot product ===
    for (const [name, head] of this.perSeatHeads) {
      const logits = new Float32Array(SEATS)
      const w = head.weights  // [dm, 1] = dm elements
      const b = head.biases[0]
      for (let s = 0; s < SEATS; s++) {
        const off = seatBase + s * dm
        let sum = b
        for (let i = 0; i < dm; i++) sum += seatOutputs[off + i] * w[i]
        logits[s] = sum
      }
      policies.set(name, logits)
    }

    // === Night head: per-seat dot product + CLS dot product ===
    if (this.nightSeatHead && this.nightClsHead) {
      const logits = new Float32Array(SEATS + 1)
      const sw = this.nightSeatHead.weights
      const sb = this.nightSeatHead.biases[0]
      for (let s = 0; s < SEATS; s++) {
        const off = seatBase + s * dm
        let sum = sb
        for (let i = 0; i < dm; i++) sum += seatOutputs[off + i] * sw[i]
        logits[s] = sum
      }
      const cw = this.nightClsHead.weights
      const cb = this.nightClsHead.biases[0]
      let clsSum = cb
      for (let i = 0; i < dm; i++) clsSum += this._tokens[i] * cw[i]
      logits[SEATS] = clsSum
      policies.set('night', logits)
    }

    // === Per-seat sigmoid heads: batch linearBatched ===
    for (const [name, head] of this.perSeatSigmoidHeads) {
      const perSeatDim = head.outputSize
      const logits = new Float32Array(SEATS * perSeatDim)
      // Use seat outputs directly from _tokens at seatBase
      linearBatchedPublic(
        this._tokens.subarray(seatBase, seatBase + SEATS * dm),
        head.weights, head.biases,
        dm, perSeatDim, SEATS, logits,
      )
      policies.set(name, logits)
    }

    // === Global heads: from CLS token (offset 0) ===
    const clsOut = this._tokens.subarray(0, dm)
    for (const [name, head] of this.globalHeads) {
      policies.set(name, head.forward(clsOut))
    }
    for (const [name, head] of this.globalSigmoidHeads) {
      policies.set(name, head.forward(clsOut))
    }

    // === Value head ===
    const rawValue = this.valueHead.forward(clsOut)
    const value = Math.tanh(rawValue[0])

    return { policies, value }
  }

  /** 重みのクローン（チェックポイント用） */
  cloneWeights(): Map<string, Float32Array> {
    const weights = new Map<string, Float32Array>()

    // Input projections
    weights.set('proj_cls_w', new Float32Array(this.projCls.weights))
    weights.set('proj_cls_b', new Float32Array(this.projCls.biases))
    weights.set('proj_seat_w', new Float32Array(this.projSeat.weights))
    weights.set('proj_seat_b', new Float32Array(this.projSeat.biases))
    if (this.projPlan) {
      weights.set('proj_plan_w', new Float32Array(this.projPlan.weights))
      weights.set('proj_plan_b', new Float32Array(this.projPlan.biases))
    }

    // Transformer encoder
    const encoderWeights = this.encoder.collectWeights()
    for (const [name, w] of encoderWeights) {
      weights.set(name, new Float32Array(w))
    }

    // Heads
    for (const [name, head] of this.perSeatHeads) {
      weights.set(`head_${name}_w`, new Float32Array(head.weights))
      weights.set(`head_${name}_b`, new Float32Array(head.biases))
    }
    if (this.nightSeatHead) {
      weights.set('head_night_seat_w', new Float32Array(this.nightSeatHead.weights))
      weights.set('head_night_seat_b', new Float32Array(this.nightSeatHead.biases))
      weights.set('head_night_cls_w', new Float32Array(this.nightClsHead!.weights))
      weights.set('head_night_cls_b', new Float32Array(this.nightClsHead!.biases))
    }
    for (const [name, head] of this.perSeatSigmoidHeads) {
      weights.set(`head_${name}_w`, new Float32Array(head.weights))
      weights.set(`head_${name}_b`, new Float32Array(head.biases))
    }
    for (const [name, head] of this.globalHeads) {
      weights.set(`head_${name}_w`, new Float32Array(head.weights))
      weights.set(`head_${name}_b`, new Float32Array(head.biases))
    }
    for (const [name, head] of this.globalSigmoidHeads) {
      weights.set(`head_${name}_w`, new Float32Array(head.weights))
      weights.set(`head_${name}_b`, new Float32Array(head.biases))
    }
    weights.set('value_w', new Float32Array(this.valueHead.weights))
    weights.set('value_b', new Float32Array(this.valueHead.biases))

    return weights
  }

  /** 重みをロード */
  loadWeights(weights: Map<string, Float32Array>): void {
    // Input projections
    this.projCls.weights.set(weights.get('proj_cls_w')!)
    this.projCls.biases.set(weights.get('proj_cls_b')!)
    this.projSeat.weights.set(weights.get('proj_seat_w')!)
    this.projSeat.biases.set(weights.get('proj_seat_b')!)
    if (this.projPlan) {
      const pw = weights.get('proj_plan_w')
      if (pw) {
        this.projPlan.weights.set(pw)
        this.projPlan.biases.set(weights.get('proj_plan_b')!)
      }
    }

    // Transformer encoder
    this.encoder.loadWeights(weights)

    // Heads
    for (const [name, head] of this.perSeatHeads) {
      head.weights.set(weights.get(`head_${name}_w`)!)
      head.biases.set(weights.get(`head_${name}_b`)!)
    }
    if (this.nightSeatHead) {
      this.nightSeatHead.weights.set(weights.get('head_night_seat_w')!)
      this.nightSeatHead.biases.set(weights.get('head_night_seat_b')!)
      this.nightClsHead!.weights.set(weights.get('head_night_cls_w')!)
      this.nightClsHead!.biases.set(weights.get('head_night_cls_b')!)
    }
    for (const [name, head] of this.perSeatSigmoidHeads) {
      head.weights.set(weights.get(`head_${name}_w`)!)
      head.biases.set(weights.get(`head_${name}_b`)!)
    }
    for (const [name, head] of this.globalHeads) {
      head.weights.set(weights.get(`head_${name}_w`)!)
      head.biases.set(weights.get(`head_${name}_b`)!)
    }
    for (const [name, head] of this.globalSigmoidHeads) {
      head.weights.set(weights.get(`head_${name}_w`)!)
      head.biases.set(weights.get(`head_${name}_b`)!)
    }
    this.valueHead.weights.set(weights.get('value_w')!)
    this.valueHead.biases.set(weights.get('value_b')!)
  }

  /** 総パラメータ数 */
  get totalParams(): number {
    let total = 0
    total += this.projCls.paramCount
    total += this.projSeat.paramCount
    if (this.projPlan) total += this.projPlan.paramCount
    total += this.encoder.paramCount
    for (const head of this.perSeatHeads.values()) total += head.paramCount
    if (this.nightSeatHead) total += this.nightSeatHead.paramCount + this.nightClsHead!.paramCount
    for (const head of this.perSeatSigmoidHeads.values()) total += head.paramCount
    for (const head of this.globalHeads.values()) total += head.paramCount
    for (const head of this.globalSigmoidHeads.values()) total += head.paramCount
    total += this.valueHead.paramCount
    return total
  }

  /** 全パラメータをフラットに取得 (SharedWeights互換) */
  getParams(): Float32Array[] {
    const params: Float32Array[] = []
    params.push(this.projCls.weights, this.projCls.biases)
    params.push(this.projSeat.weights, this.projSeat.biases)
    if (this.projPlan) params.push(this.projPlan.weights, this.projPlan.biases)

    // Encoder weights in deterministic order
    for (const block of this.encoder.blocks) {
      params.push(block.ln1.scale, block.ln1.bias)
      params.push(block.attn.wQ, block.attn.bQ, block.attn.wK, block.attn.bK)
      params.push(block.attn.wV, block.attn.bV, block.attn.wO, block.attn.bO)
      params.push(block.ln2.scale, block.ln2.bias)
      params.push(block.ffn.w1, block.ffn.b1, block.ffn.w2, block.ffn.b2)
    }
    params.push(this.encoder.finalLN.scale, this.encoder.finalLN.bias)

    // Heads
    for (const head of this.perSeatHeads.values()) params.push(head.weights, head.biases)
    if (this.nightSeatHead) {
      params.push(this.nightSeatHead.weights, this.nightSeatHead.biases)
      params.push(this.nightClsHead!.weights, this.nightClsHead!.biases)
    }
    for (const head of this.perSeatSigmoidHeads.values()) params.push(head.weights, head.biases)
    for (const head of this.globalHeads.values()) params.push(head.weights, head.biases)
    for (const head of this.globalSigmoidHeads.values()) params.push(head.weights, head.biases)
    params.push(this.valueHead.weights, this.valueHead.biases)
    return params
  }
}
