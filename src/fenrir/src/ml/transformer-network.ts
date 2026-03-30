/**
 * Transformer-based Strategy Neural Network (pure JS, 推論用)
 *
 * 2段エンコーダ: Seat Transformer + Strategy Layer
 *
 * Seat Transformer (N層):
 *   CLS(1) + Seat(14) + Role(5) = 20トークン
 *   → 席間関係の構造的理解
 *
 * Strategy Layer (M層):
 *   20トークン(↑の出力) + Forward(8) + Endgame(4) = 32トークン
 *   → 処刑プラン + 推理 + CO方針
 *
 * 出力:
 *   CLS → co_policy, fake_target_hint, fake_result_hint, value
 *   Seat[i] → predict(11), trust(1)  (per-seat softmax/scalar)
 *   Forward/Endgame[k] → Pointer(23)  (plan tokens)
 *   + 既存head (vote, night等) for backward compat
 */

import type { NetworkConfig, ForwardResult, TransformerNetworkConfig } from './nn.ts'
import { DenseLayer } from './nn.ts'
import { TransformerEncoder, type TransformerConfig, linearBatchedPublic } from './transformer.ts'
import { tokenize, SEATS, NUM_ROLE_TOKENS, type ObservationMode } from '../observation.ts'

export class TransformerNetwork {
  readonly config: NetworkConfig
  readonly tConfig: TransformerNetworkConfig

  // Input projections: raw features → d_model
  private projCls: DenseLayer
  private projSeat: DenseLayer
  private projPlan: DenseLayer | null
  private projRole: DenseLayer

  // 2-stage encoders
  private seatEncoder: TransformerEncoder   // N layers, 20 tokens
  private strategyEncoder: TransformerEncoder  // M layers, 32 tokens

  // Learnable embeddings for Forward/Endgame plan tokens
  private forwardEmbeddings: Float32Array    // [numForward * dModel]
  private endgameEmbeddings: Float32Array    // [numEndgame * dModel]

  // Pointer mechanism for plan tokens
  private pointerQueryProj: DenseLayer       // dModel → dModel (plan token → query)
  private pointerKeyProj: DenseLayer         // dModel → dModel (target token → key)
  private specialKeys: Float32Array          // [3 * dModel] learnable keys for grayran/next/stop

  // Head layers (same structure as before for backward compat)
  private perSeatHeads: Map<string, DenseLayer>     // dModel → 1
  private perSeatSigmoidHeads: Map<string, DenseLayer>
  private globalHeads: Map<string, DenseLayer>
  private globalSigmoidHeads: Map<string, DenseLayer>
  private valueHead: DenseLayer

  // Special: night head = per-seat + CLS
  private nightSeatHead: DenseLayer | null = null
  private nightClsHead: DenseLayer | null = null

  // Scratch buffers
  private _seatTokens: Float32Array    // [seatSeqLen * dModel] for seat encoder
  private _stratTokens: Float32Array   // [stratSeqLen * dModel] for strategy encoder
  private _seatMask: boolean[]
  private _stratMask: boolean[]
  private _seatProjected: Float32Array // [SEATS * dModel]
  private _roleProjected: Float32Array // [NUM_ROLE_TOKENS * dModel]

  readonly isTeam: boolean
  readonly observationMode: ObservationMode

  constructor(config: NetworkConfig, isTeam: boolean | ObservationMode = false) {
    if (!config.transformer) throw new Error('NetworkConfig.transformer is required')

    this.config = config
    this.tConfig = config.transformer
    // 後方互換: boolean → ObservationMode
    if (typeof isTeam === 'boolean') {
      this.observationMode = isTeam ? 'team' : 'individual'
      this.isTeam = isTeam
    } else {
      this.observationMode = isTeam
      this.isTeam = isTeam === 'team'
    }

    const tc = this.tConfig
    const dm = tc.dModel
    const numRoles = tc.numRoleTokens ?? NUM_ROLE_TOKENS
    const numForward = tc.numForwardTokens ?? 8
    const numEndgame = tc.numEndgameTokens ?? 4
    const seatSeqLen = 1 + SEATS + numRoles  // CLS + 14 seats + 5 roles = 20
    const stratSeqLen = seatSeqLen + numForward + numEndgame  // 20 + 8 + 4 = 32

    // Input projections
    this.projCls = new DenseLayer(tc.clsFeatures, dm)
    this.projSeat = new DenseLayer(tc.seatFeatures, dm)
    this.projPlan = tc.planFeatures > 0 ? new DenseLayer(tc.planFeatures, dm) : null
    this.projRole = new DenseLayer(tc.roleFeatures ?? 15, dm)

    // Seat Transformer (N layers)
    const seatLayers = tc.seatLayers ?? tc.numLayers ?? 3
    this.seatEncoder = new TransformerEncoder({
      dModel: dm,
      numLayers: seatLayers,
      numHeads: tc.numHeads,
      dFf: tc.dFf,
      maxSeqLen: seatSeqLen,
    })

    // Strategy Layer (M layers)
    const strategyLayers = tc.strategyLayers ?? 2
    this.strategyEncoder = new TransformerEncoder({
      dModel: dm,
      numLayers: strategyLayers,
      numHeads: tc.numHeads,
      dFf: tc.dFf,
      maxSeqLen: stratSeqLen,
    })

    // Learnable Forward/Endgame embeddings (random init)
    this.forwardEmbeddings = new Float32Array(numForward * dm)
    this.endgameEmbeddings = new Float32Array(numEndgame * dm)
    const scale = 0.02
    for (let i = 0; i < this.forwardEmbeddings.length; i++) {
      this.forwardEmbeddings[i] = (Math.random() - 0.5) * scale
    }
    for (let i = 0; i < this.endgameEmbeddings.length; i++) {
      this.endgameEmbeddings[i] = (Math.random() - 0.5) * scale
    }

    // Pointer mechanism
    this.pointerQueryProj = new DenseLayer(dm, dm)
    this.pointerKeyProj = new DenseLayer(dm, dm)
    // 3 special keys: grayran, next, stop
    this.specialKeys = new Float32Array(3 * dm)
    for (let i = 0; i < this.specialKeys.length; i++) {
      this.specialKeys[i] = (Math.random() - 0.5) * scale
    }

    // Head layers
    const perSeatSet = new Set(tc.perSeatHeads)
    const perSeatSigmoidSet = new Set(tc.perSeatSigmoidHeads ?? [])
    this.perSeatHeads = new Map()
    this.perSeatSigmoidHeads = new Map()
    this.globalHeads = new Map()
    this.globalSigmoidHeads = new Map()

    for (const [name, outputSize] of Object.entries(config.heads)) {
      if (name === 'night') {
        this.nightSeatHead = new DenseLayer(dm, 1)
        this.nightClsHead = new DenseLayer(dm, 1)
      } else if (perSeatSet.has(name)) {
        this.perSeatHeads.set(name, new DenseLayer(dm, 1))
      } else {
        this.globalHeads.set(name, new DenseLayer(dm, outputSize))
      }
    }

    for (const [name, outputSize] of Object.entries(config.sigmoidHeads ?? {})) {
      if (perSeatSigmoidSet.has(name)) {
        const perSeatDim = outputSize / SEATS
        this.perSeatSigmoidHeads.set(name, new DenseLayer(dm, perSeatDim))
      } else {
        this.globalSigmoidHeads.set(name, new DenseLayer(dm, outputSize))
      }
    }

    this.valueHead = new DenseLayer(dm, 1)

    // Scratch buffers
    this._seatTokens = new Float32Array(seatSeqLen * dm)
    this._stratTokens = new Float32Array(stratSeqLen * dm)
    this._seatMask = new Array(seatSeqLen).fill(true)
    this._stratMask = new Array(stratSeqLen).fill(true)
    this._seatProjected = new Float32Array(SEATS * dm)
    this._roleProjected = new Float32Array(numRoles * dm)
  }

  forward(input: Float32Array): ForwardResult {
    const tc = this.tConfig
    const dm = tc.dModel
    const numRoles = tc.numRoleTokens ?? NUM_ROLE_TOKENS
    const numForward = tc.numForwardTokens ?? 8
    const numEndgame = tc.numEndgameTokens ?? 4
    const seatSeqLen = 1 + SEATS + numRoles
    const stratSeqLen = seatSeqLen + numForward + numEndgame

    // Tokenize
    const tok = tokenize(input, this.observationMode)

    // ========== Stage 1: Seat Transformer ==========
    // Build token sequence: [CLS, Seat0..Seat13, Role0..Role4]
    this._seatTokens.fill(0)

    // Project CLS → token[0]
    const clsProj = this.projCls.forward(tok.cls)
    this._seatTokens.set(clsProj, 0)

    // Batch project seats → token[1..14]
    linearBatchedPublic(
      tok.seats, this.projSeat.weights, this.projSeat.biases,
      tc.seatFeatures, dm, SEATS, this._seatProjected,
    )
    this._seatTokens.set(this._seatProjected, dm)

    // Batch project role tokens → token[15..19]
    linearBatchedPublic(
      tok.roles, this.projRole.weights, this.projRole.biases,
      tc.roleFeatures ?? 15, dm, numRoles, this._roleProjected,
    )
    this._seatTokens.set(this._roleProjected, (1 + SEATS) * dm)

    // Run Seat Transformer
    this.seatEncoder.forward(this._seatTokens, seatSeqLen, this._seatMask)

    // ========== Stage 2: Strategy Layer ==========
    // Copy Seat Transformer output into Strategy input
    this._stratTokens.fill(0)
    this._stratTokens.set(
      this._seatTokens.subarray(0, seatSeqLen * dm),
      0,
    )

    // Append Forward embeddings at positions [seatSeqLen .. seatSeqLen+numForward)
    const fwdStart = seatSeqLen * dm
    this._stratTokens.set(this.forwardEmbeddings, fwdStart)

    // Append Endgame embeddings at positions [seatSeqLen+numForward .. stratSeqLen)
    const egStart = (seatSeqLen + numForward) * dm
    this._stratTokens.set(this.endgameEmbeddings, egStart)

    // Run Strategy Layer
    this.strategyEncoder.forward(this._stratTokens, stratSeqLen, this._stratMask)

    // ========== Head readout ==========
    const seatBase = dm  // offset of first seat token in _stratTokens
    const policies = new Map<string, Float32Array>()

    // Per-seat softmax heads
    for (const [name, head] of this.perSeatHeads) {
      const logits = new Float32Array(SEATS)
      const w = head.weights
      const b = head.biases[0]
      for (let s = 0; s < SEATS; s++) {
        const off = seatBase + s * dm
        let sum = b
        for (let i = 0; i < dm; i++) sum += this._stratTokens[off + i] * w[i]
        logits[s] = sum
      }
      policies.set(name, logits)
    }

    // Night head (per-seat + CLS)
    if (this.nightSeatHead && this.nightClsHead) {
      const logits = new Float32Array(SEATS + 1)
      const sw = this.nightSeatHead.weights
      const sb = this.nightSeatHead.biases[0]
      for (let s = 0; s < SEATS; s++) {
        const off = seatBase + s * dm
        let sum = sb
        for (let i = 0; i < dm; i++) sum += this._stratTokens[off + i] * sw[i]
        logits[s] = sum
      }
      const cw = this.nightClsHead.weights
      const cb = this.nightClsHead.biases[0]
      let clsSum = cb
      for (let i = 0; i < dm; i++) clsSum += this._stratTokens[i] * cw[i]
      logits[SEATS] = clsSum
      policies.set('night', logits)
    }

    // Per-seat sigmoid heads
    for (const [name, head] of this.perSeatSigmoidHeads) {
      const perSeatDim = head.outputSize
      const logits = new Float32Array(SEATS * perSeatDim)
      linearBatchedPublic(
        this._stratTokens.subarray(seatBase, seatBase + SEATS * dm),
        head.weights, head.biases,
        dm, perSeatDim, SEATS, logits,
      )
      policies.set(name, logits)
    }

    // Global heads from CLS token
    const clsOut = this._stratTokens.subarray(0, dm)
    for (const [name, head] of this.globalHeads) {
      policies.set(name, head.forward(clsOut))
    }
    for (const [name, head] of this.globalSigmoidHeads) {
      policies.set(name, head.forward(clsOut))
    }

    // ========== Pointer mechanism for plan tokens ==========
    // Keys: Seat(14) + Role(5) + special(3) = 22 targets = PLAN_VOCAB.SIZE
    const vocabSize = tc.planVocabSize ?? 22
    const numTargetTokens = SEATS + numRoles  // 14 + 5 = 19 tokens provide keys
    const numSpecial = 3  // grayran, next, stop
    const invSqrtD = 1 / Math.sqrt(dm)

    // Compute keys for seat + role tokens
    const keys = new Float32Array((numTargetTokens + numSpecial) * dm)
    for (let t = 0; t < numTargetTokens; t++) {
      // Seat tokens at offset dm*(1+t), role tokens follow seats
      const tokenOff = (1 + t) * dm  // skip CLS
      const keyOff = t * dm
      const raw = this._stratTokens.subarray(tokenOff, tokenOff + dm)
      const projected = this.pointerKeyProj.forward(raw)
      keys.set(projected, keyOff)
    }
    // Special keys (learnable, no projection needed — already in key space)
    keys.set(this.specialKeys, numTargetTokens * dm)

    // Compute pointer logits for each Forward and Endgame token
    const computePointerLogits = (tokenOffset: number, count: number): Float32Array => {
      const allLogits = new Float32Array(count * vocabSize)
      for (let k = 0; k < count; k++) {
        const tokOff = tokenOffset + k * dm
        const raw = this._stratTokens.subarray(tokOff, tokOff + dm)
        const query = this.pointerQueryProj.forward(raw)

        const logitOff = k * vocabSize
        for (let t = 0; t < numTargetTokens + numSpecial; t++) {
          let dot = 0
          const kOff = t * dm
          for (let i = 0; i < dm; i++) dot += query[i] * keys[kOff + i]
          allLogits[logitOff + t] = dot * invSqrtD
        }
      }
      return allLogits
    }

    const fwdTokenOffset = seatSeqLen * dm
    policies.set('plan_forward', computePointerLogits(fwdTokenOffset, numForward))
    const egTokenOffset = (seatSeqLen + numForward) * dm
    policies.set('plan_endgame', computePointerLogits(egTokenOffset, numEndgame))

    // Value head
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
    weights.set('proj_role_w', new Float32Array(this.projRole.weights))
    weights.set('proj_role_b', new Float32Array(this.projRole.biases))

    // Seat Transformer encoder
    for (const [name, w] of this.seatEncoder.collectWeights()) {
      weights.set(`seat_${name}`, new Float32Array(w))
    }

    // Strategy Layer encoder
    for (const [name, w] of this.strategyEncoder.collectWeights()) {
      weights.set(`strat_${name}`, new Float32Array(w))
    }

    // Forward/Endgame embeddings
    weights.set('forward_embeddings', new Float32Array(this.forwardEmbeddings))
    weights.set('endgame_embeddings', new Float32Array(this.endgameEmbeddings))

    // Pointer mechanism
    weights.set('pointer_query_w', new Float32Array(this.pointerQueryProj.weights))
    weights.set('pointer_query_b', new Float32Array(this.pointerQueryProj.biases))
    weights.set('pointer_key_w', new Float32Array(this.pointerKeyProj.weights))
    weights.set('pointer_key_b', new Float32Array(this.pointerKeyProj.biases))
    weights.set('special_keys', new Float32Array(this.specialKeys))

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
    this.projRole.weights.set(weights.get('proj_role_w')!)
    this.projRole.biases.set(weights.get('proj_role_b')!)

    // Seat Transformer encoder
    const seatWeights = new Map<string, Float32Array>()
    for (const [key, val] of weights) {
      if (key.startsWith('seat_')) seatWeights.set(key.slice(5), val)
    }
    this.seatEncoder.loadWeights(seatWeights)

    // Strategy Layer encoder
    const stratWeights = new Map<string, Float32Array>()
    for (const [key, val] of weights) {
      if (key.startsWith('strat_')) stratWeights.set(key.slice(6), val)
    }
    this.strategyEncoder.loadWeights(stratWeights)

    // Forward/Endgame embeddings
    const fwdEmb = weights.get('forward_embeddings')
    if (fwdEmb) this.forwardEmbeddings.set(fwdEmb)
    const egEmb = weights.get('endgame_embeddings')
    if (egEmb) this.endgameEmbeddings.set(egEmb)

    // Pointer mechanism
    this.pointerQueryProj.weights.set(weights.get('pointer_query_w')!)
    this.pointerQueryProj.biases.set(weights.get('pointer_query_b')!)
    this.pointerKeyProj.weights.set(weights.get('pointer_key_w')!)
    this.pointerKeyProj.biases.set(weights.get('pointer_key_b')!)
    const sk = weights.get('special_keys')
    if (sk) this.specialKeys.set(sk)

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
    total += this.projRole.paramCount
    total += this.seatEncoder.paramCount
    total += this.strategyEncoder.paramCount
    total += this.forwardEmbeddings.length + this.endgameEmbeddings.length
    total += this.pointerQueryProj.paramCount + this.pointerKeyProj.paramCount
    total += this.specialKeys.length
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
    params.push(this.projRole.weights, this.projRole.biases)

    // Seat encoder weights
    for (const block of this.seatEncoder.blocks) {
      params.push(block.ln1.scale, block.ln1.bias)
      params.push(block.attn.wQ, block.attn.bQ, block.attn.wK, block.attn.bK)
      params.push(block.attn.wV, block.attn.bV, block.attn.wO, block.attn.bO)
      params.push(block.ln2.scale, block.ln2.bias)
      params.push(block.ffn.w1, block.ffn.b1, block.ffn.w2, block.ffn.b2)
    }
    params.push(this.seatEncoder.finalLN.scale, this.seatEncoder.finalLN.bias)

    // Strategy encoder weights
    for (const block of this.strategyEncoder.blocks) {
      params.push(block.ln1.scale, block.ln1.bias)
      params.push(block.attn.wQ, block.attn.bQ, block.attn.wK, block.attn.bK)
      params.push(block.attn.wV, block.attn.bV, block.attn.wO, block.attn.bO)
      params.push(block.ln2.scale, block.ln2.bias)
      params.push(block.ffn.w1, block.ffn.b1, block.ffn.w2, block.ffn.b2)
    }
    params.push(this.strategyEncoder.finalLN.scale, this.strategyEncoder.finalLN.bias)

    // Forward/Endgame embeddings
    params.push(this.forwardEmbeddings, this.endgameEmbeddings)

    // Pointer mechanism
    params.push(this.pointerQueryProj.weights, this.pointerQueryProj.biases)
    params.push(this.pointerKeyProj.weights, this.pointerKeyProj.biases)
    params.push(this.specialKeys)

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
