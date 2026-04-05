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
 *   20トークン(↑の出力) + 8 forward plan + 4 endgame plan = 32トークン
 *   → 盤面理解 + plan token の文脈理解
 *
 * GRU Decoder:
 *   CLS出力 → 初期hidden → 自己回帰でplan token列を生成
 *   forward plan (8 steps) + endgame plan (4 steps)
 *
 * 出力:
 *   CLS → co_policy, fake_target_hint, fake_result_hint, value
 *   Seat[i] → predict(11), trust(1)  (per-seat softmax/scalar)
 *   GRU → plan_forward(8×22), plan_endgame(4×22)  (autoregressive)
 *   + 既存head (vote, night等) for backward compat
 */

import type { NetworkConfig, ForwardResult, TransformerNetworkConfig, PlanContext } from './nn.ts'
import { DenseLayer, gaussianRandom } from './nn.ts'
import { TransformerEncoder, linearBatchedPublic } from './transformer.ts'
import { tokenize, SEATS, NUM_ROLE_TOKENS, NUM_PLAN_FORWARD, NUM_PLAN_ENDGAME, type ObservationMode } from '../observation.ts'
import { PLAN_VOCAB } from '../plan/plan-vocab.ts'

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

  // GRU autoregressive decoder for plan tokens
  private gruWz: Float32Array    // [dModel * dModel]
  private gruWr: Float32Array
  private gruWh: Float32Array
  private gruUz: Float32Array    // [dModel * dModel]
  private gruUr: Float32Array
  private gruUh: Float32Array
  private gruBz: Float32Array    // [dModel]
  private gruBr: Float32Array
  private gruBh: Float32Array
  private planTokenEmbed: Float32Array   // [(vocabSize+1) * dModel] — 22 vocab + START
  private planInitFwd: DenseLayer        // CLS → forward initial hidden
  private planInitEg: DenseLayer         // CLS → endgame initial hidden

  // Plan observation embeddings (Strategy Encoder input)
  private planVocabEmbed: Float32Array       // [22 * dModel] vocab index → embedding
  private forwardPosEmbed: Float32Array      // [8 * dModel] position embeddings for forward plan
  private endgamePosEmbed: Float32Array      // [4 * dModel] position embeddings for endgame plan

  // Pointer mechanism for plan tokens
  private pointerQueryProj: DenseLayer       // dModel → dModel (GRU hidden → query)
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
  private _stratTokens: Float32Array   // [stratSeqLen * dModel] for strategy encoder (32 tokens)
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
    const seatSeqLen = 1 + SEATS + numRoles  // CLS + 14 seats + 5 roles = 20

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

    // Strategy Layer (M layers) — 20 seat tokens + 8 forward plan + 4 endgame plan = 32 tokens
    const numPlanTokens = NUM_PLAN_FORWARD + NUM_PLAN_ENDGAME  // 12
    const stratSeqLen = seatSeqLen + numPlanTokens  // 32
    const strategyLayers = tc.strategyLayers ?? 2
    this.strategyEncoder = new TransformerEncoder({
      dModel: dm,
      numLayers: strategyLayers,
      numHeads: tc.numHeads,
      dFf: tc.dFf,
      maxSeqLen: stratSeqLen,
    })

    // GRU autoregressive decoder for plan tokens
    const vocabSize = tc.planVocabSize ?? 22
    const embedSize = vocabSize + 1  // +1 for START token
    const scale = 0.02
    const gruScale = Math.sqrt(2 / dm)

    // GRU gate weights (Xavier init)
    this.gruWz = new Float32Array(dm * dm)
    this.gruWr = new Float32Array(dm * dm)
    this.gruWh = new Float32Array(dm * dm)
    this.gruUz = new Float32Array(dm * dm)
    this.gruUr = new Float32Array(dm * dm)
    this.gruUh = new Float32Array(dm * dm)
    for (const w of [this.gruWz, this.gruWr, this.gruWh, this.gruUz, this.gruUr, this.gruUh]) {
      for (let i = 0; i < w.length; i++) w[i] = gaussianRandom() * gruScale
    }
    this.gruBz = new Float32Array(dm)
    this.gruBr = new Float32Array(dm)
    this.gruBh = new Float32Array(dm)

    // Plan token embeddings: vocabSize + START
    this.planTokenEmbed = new Float32Array(embedSize * dm)
    for (let i = 0; i < this.planTokenEmbed.length; i++) {
      this.planTokenEmbed[i] = (Math.random() - 0.5) * scale
    }

    // Init projections: CLS → initial hidden state
    this.planInitFwd = new DenseLayer(dm, dm)
    this.planInitEg = new DenseLayer(dm, dm)

    // Plan observation embeddings (vocab + position → Strategy Encoder)
    const vocabEmbedSize = (tc.planVocabSize ?? 22) * dm
    this.planVocabEmbed = new Float32Array(vocabEmbedSize)
    for (let i = 0; i < vocabEmbedSize; i++) this.planVocabEmbed[i] = (Math.random() - 0.5) * scale
    this.forwardPosEmbed = new Float32Array(NUM_PLAN_FORWARD * dm)
    for (let i = 0; i < this.forwardPosEmbed.length; i++) this.forwardPosEmbed[i] = (Math.random() - 0.5) * scale
    this.endgamePosEmbed = new Float32Array(NUM_PLAN_ENDGAME * dm)
    for (let i = 0; i < this.endgamePosEmbed.length; i++) this.endgamePosEmbed[i] = (Math.random() - 0.5) * scale

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
    this._stratTokens = new Float32Array(stratSeqLen * dm)  // 32 tokens (20 seat + 12 plan)
    this._seatMask = new Array(seatSeqLen).fill(true)
    this._stratMask = new Array(stratSeqLen).fill(true)
    this._seatProjected = new Float32Array(SEATS * dm)
    this._roleProjected = new Float32Array(numRoles * dm)
  }

  /** GRU cell: z/r/h gates */
  private gruCell(input: Float32Array, hidden: Float32Array, dm: number): Float32Array {
    const newHidden = new Float32Array(dm)
    const z = new Float32Array(dm)
    const r = new Float32Array(dm)
    const hCandidate = new Float32Array(dm)

    // z = sigmoid(input @ Wz + hidden @ Uz + bz)
    for (let j = 0; j < dm; j++) {
      let sumZ = this.gruBz[j]
      let sumR = this.gruBr[j]
      for (let i = 0; i < dm; i++) {
        const idx = i * dm + j
        sumZ += input[i] * this.gruWz[idx] + hidden[i] * this.gruUz[idx]
        sumR += input[i] * this.gruWr[idx] + hidden[i] * this.gruUr[idx]
      }
      z[j] = 1 / (1 + Math.exp(-sumZ))
      r[j] = 1 / (1 + Math.exp(-sumR))
    }

    // h_candidate = tanh(input @ Wh + (r * hidden) @ Uh + bh)
    for (let j = 0; j < dm; j++) {
      let sum = this.gruBh[j]
      for (let i = 0; i < dm; i++) {
        sum += input[i] * this.gruWh[i * dm + j] + (r[i] * hidden[i]) * this.gruUh[i * dm + j]
      }
      hCandidate[j] = Math.tanh(sum)
    }

    // newHidden = (1 - z) * hidden + z * h_candidate
    for (let j = 0; j < dm; j++) {
      newHidden[j] = (1 - z[j]) * hidden[j] + z[j] * hCandidate[j]
    }
    return newHidden
  }

  /** Autoregressive plan token decoding with grammar masking */
  private decodePlan(
    numSteps: number, vocabSize: number, dm: number,
    keys: Float32Array, invSqrtD: number,
    clsOut: Float32Array, initLayer: DenseLayer,
    explore: boolean,
    planContext?: PlanContext,
  ): { logits: Float32Array, actions: number[], logProbs: number[] } {
    const START_IDX = vocabSize  // START token is at index vocabSize (=22)
    const NEXT_IDX = PLAN_VOCAB.NEXT
    const STOP_IDX = PLAN_VOCAB.STOP
    const totalKeys = vocabSize  // 22 keys (14 seat + 5 role + 3 special)

    const allLogits = new Float32Array(numSteps * vocabSize)
    const actions: number[] = []
    const logProbs: number[] = []

    // Initial hidden state: tanh(initLayer(clsOut))
    const initRaw = initLayer.forward(clsOut)
    let hidden = new Float32Array(dm)
    for (let i = 0; i < dm; i++) hidden[i] = Math.tanh(initRaw[i])

    let seenStop = false
    let prevAction = START_IDX
    const groupUsed = new Set<number>()

    for (let step = 0; step < numSteps; step++) {
      // Input: embedding of previous token
      const embedOff = prevAction * dm
      const input = this.planTokenEmbed.slice(embedOff, embedOff + dm)

      // GRU step
      hidden = this.gruCell(input, hidden, dm) as Float32Array<ArrayBuffer>

      // Pointer: query from hidden state
      const query = this.pointerQueryProj.forward(hidden)
      const stepLogits = new Float32Array(vocabSize)
      for (let t = 0; t < totalKeys; t++) {
        let dot = 0
        const kOff = t * dm
        for (let i = 0; i < dm; i++) dot += query[i] * keys[kOff + i]
        stepLogits[t] = dot * invSqrtD
      }

      // Store raw logits (before grammar mask) for KL reference computation
      allLogits.set(stepLogits, step * vocabSize)

      // Grammar mask (applied to local copy for sampling only)
      //
      // | prev        | allowed next                      |
      // |-------------|-----------------------------------|
      // | START       | seat, role, grayran, STOP         |
      // | seat        | seat (no dup), NEXT, STOP         |
      // | role/grayran| NEXT, STOP                        |
      // | NEXT        | seat, role, grayran               |
      // | STOP        | STOP                              |
      {
        const GRAYRAN_IDX = PLAN_VOCAB.GRAYRAN
        const ROLE_START = PLAN_VOCAB.ROLE_START
        const ROLE_END = PLAN_VOCAB.ROLE_END
        const isRoleOrGrayran = (t: number) => (t >= ROLE_START && t < ROLE_END) || t === GRAYRAN_IDX

        if (seenStop) {
          // After STOP: only STOP
          for (let t = 0; t < vocabSize; t++) {
            if (t !== STOP_IDX) stepLogits[t] = -Infinity
          }
        } else if (step === 0 || prevAction === NEXT_IDX) {
          // START or after NEXT: seat, role, grayran only
          stepLogits[NEXT_IDX] = -Infinity
          stepLogits[STOP_IDX] = step === 0 ? stepLogits[STOP_IDX] : -Infinity  // START allows STOP, NEXT does not
        } else if (prevAction >= 0 && prevAction < PLAN_VOCAB.SEAT_END) {
          // After seat: seat (no dup), NEXT, STOP
          for (let t = ROLE_START; t < ROLE_END; t++) stepLogits[t] = -Infinity
          stepLogits[GRAYRAN_IDX] = -Infinity
          for (const used of groupUsed) stepLogits[used] = -Infinity
        } else if (isRoleOrGrayran(prevAction)) {
          // After role or grayran: NEXT, STOP only (single-token group)
          for (let t = 0; t < vocabSize; t++) {
            if (t === NEXT_IDX || t === STOP_IDX) continue
            stepLogits[t] = -Infinity
          }
        }
      }

      // Context mask: 死亡席・未CO役職・確定白席・自席を禁止
      if (planContext) {
        for (let t = 0; t < PLAN_VOCAB.SEAT_END; t++) {
          if (!planContext.aliveSeats[t]) stepLogits[t] = -Infinity
        }
        for (let r = 0; r < planContext.claimedRoles.length; r++) {
          if (!planContext.claimedRoles[r]) stepLogits[PLAN_VOCAB.ROLE_START + r] = -Infinity
        }
        if (planContext.confirmedVillageSeats) {
          for (let t = 0; t < PLAN_VOCAB.SEAT_END; t++) {
            if (planContext.confirmedVillageSeats[t]) stepLogits[t] = -Infinity
          }
        }
        if (planContext.mySeat != null) {
          stepLogits[planContext.mySeat] = -Infinity
        }
      }

      // Sample or argmax (from masked logits)
      let maxVal = -Infinity
      for (let v = 0; v < vocabSize; v++) {
        if (stepLogits[v] > maxVal) maxVal = stepLogits[v]
      }
      const expVals = new Float32Array(vocabSize)
      let sumExp = 0
      for (let v = 0; v < vocabSize; v++) {
        expVals[v] = stepLogits[v] === -Infinity ? 0 : Math.exp(stepLogits[v] - maxVal)
        sumExp += expVals[v]
      }

      let chosenIdx: number
      if (explore) {
        const r = Math.random() * sumExp
        let cumulative = 0
        chosenIdx = vocabSize - 1
        for (let v = 0; v < vocabSize; v++) {
          cumulative += expVals[v]
          if (cumulative >= r) { chosenIdx = v; break }
        }
      } else {
        chosenIdx = 0
        for (let v = 1; v < vocabSize; v++) {
          if (expVals[v] > expVals[chosenIdx]) chosenIdx = v
        }
      }

      const prob = expVals[chosenIdx] / sumExp
      actions.push(chosenIdx)
      logProbs.push(seenStop ? 0 : Math.log(prob + 1e-8))  // STOP-forced steps have 0 logProb

      // Update state for next step
      if (chosenIdx === STOP_IDX) {
        seenStop = true
      } else if (chosenIdx === NEXT_IDX) {
        groupUsed.clear()
      } else {
        groupUsed.add(chosenIdx)
      }
      prevAction = chosenIdx
    }

    return { logits: allLogits, actions, logProbs }
  }

  forward(input: Float32Array, explore?: boolean, planContext?: PlanContext): ForwardResult {
    const tc = this.tConfig
    const dm = tc.dModel
    const numRoles = tc.numRoleTokens ?? NUM_ROLE_TOKENS
    const numForward = tc.numForwardTokens ?? 8
    const numEndgame = tc.numEndgameTokens ?? 4
    const seatSeqLen = 1 + SEATS + numRoles

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

    // ========== Stage 2: Strategy Layer (32 tokens: 20 seat + 8 fwd plan + 4 eg plan) ==========
    const numPlanTokens = NUM_PLAN_FORWARD + NUM_PLAN_ENDGAME
    const stratSeqLen = seatSeqLen + numPlanTokens

    // Copy seat encoder output → first 20 tokens
    this._stratTokens.fill(0)
    this._stratTokens.set(this._seatTokens.subarray(0, seatSeqLen * dm), 0)

    // Append forward plan tokens: posEmbed + vocabEmbed[index]
    let planOff = seatSeqLen * dm
    for (let i = 0; i < NUM_PLAN_FORWARD; i++) {
      const vocabIdx = Math.min(Math.max(0, Math.round(tok.planForward[i])), (tc.planVocabSize ?? 22) - 1)
      const posBase = i * dm
      const vocabBase = vocabIdx * dm
      for (let d = 0; d < dm; d++) {
        this._stratTokens[planOff + d] = this.forwardPosEmbed[posBase + d] + this.planVocabEmbed[vocabBase + d]
      }
      planOff += dm
    }
    // Append endgame plan tokens
    for (let i = 0; i < NUM_PLAN_ENDGAME; i++) {
      const vocabIdx = Math.min(Math.max(0, Math.round(tok.planEndgame[i])), (tc.planVocabSize ?? 22) - 1)
      const posBase = i * dm
      const vocabBase = vocabIdx * dm
      for (let d = 0; d < dm; d++) {
        this._stratTokens[planOff + d] = this.endgamePosEmbed[posBase + d] + this.planVocabEmbed[vocabBase + d]
      }
      planOff += dm
    }

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

    // ========== GRU autoregressive decoder for plan tokens ==========
    const vocabSize = tc.planVocabSize ?? 22
    const numTargetTokens = SEATS + numRoles  // 14 + 5 = 19 tokens provide keys
    const numSpecial = 3  // grayran, next, stop
    const invSqrtD = 1 / Math.sqrt(dm)

    // Compute pointer keys from seat + role tokens
    const keys = new Float32Array((numTargetTokens + numSpecial) * dm)
    for (let t = 0; t < numTargetTokens; t++) {
      const tokenOff = (1 + t) * dm  // skip CLS
      const raw = this._stratTokens.subarray(tokenOff, tokenOff + dm)
      const projected = this.pointerKeyProj.forward(raw)
      keys.set(projected, t * dm)
    }
    keys.set(this.specialKeys, numTargetTokens * dm)

    // Decode forward and endgame plans autoregressively
    const doExplore = explore ?? true
    const fwd = this.decodePlan(numForward, vocabSize, dm, keys, invSqrtD, clsOut, this.planInitFwd, doExplore, planContext)
    const eg = this.decodePlan(numEndgame, vocabSize, dm, keys, invSqrtD, clsOut, this.planInitEg, doExplore, planContext)
    policies.set('plan_forward', fwd.logits)
    policies.set('plan_endgame', eg.logits)

    // Value head
    const rawValue = this.valueHead.forward(clsOut)
    const value = Math.tanh(rawValue[0])

    return {
      policies, value,
      planForwardActions: fwd.actions,
      planForwardLogProbs: fwd.logProbs,
      planEndgameActions: eg.actions,
      planEndgameLogProbs: eg.logProbs,
    }
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

    // GRU decoder weights
    weights.set('gru_wz', new Float32Array(this.gruWz))
    weights.set('gru_wr', new Float32Array(this.gruWr))
    weights.set('gru_wh', new Float32Array(this.gruWh))
    weights.set('gru_uz', new Float32Array(this.gruUz))
    weights.set('gru_ur', new Float32Array(this.gruUr))
    weights.set('gru_uh', new Float32Array(this.gruUh))
    weights.set('gru_bz', new Float32Array(this.gruBz))
    weights.set('gru_br', new Float32Array(this.gruBr))
    weights.set('gru_bh', new Float32Array(this.gruBh))
    weights.set('plan_token_embed', new Float32Array(this.planTokenEmbed))
    weights.set('plan_init_fwd_w', new Float32Array(this.planInitFwd.weights))
    weights.set('plan_init_fwd_b', new Float32Array(this.planInitFwd.biases))
    weights.set('plan_init_eg_w', new Float32Array(this.planInitEg.weights))
    weights.set('plan_init_eg_b', new Float32Array(this.planInitEg.biases))

    // Plan observation embeddings
    weights.set('plan_vocab_embed', new Float32Array(this.planVocabEmbed))
    weights.set('forward_pos_embed', new Float32Array(this.forwardPosEmbed))
    weights.set('endgame_pos_embed', new Float32Array(this.endgamePosEmbed))

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

    // GRU decoder weights (optional for backward compat)
    const gruKeys: [string, Float32Array][] = [
      ['gru_wz', this.gruWz], ['gru_wr', this.gruWr], ['gru_wh', this.gruWh],
      ['gru_uz', this.gruUz], ['gru_ur', this.gruUr], ['gru_uh', this.gruUh],
      ['gru_bz', this.gruBz], ['gru_br', this.gruBr], ['gru_bh', this.gruBh],
      ['plan_token_embed', this.planTokenEmbed],
    ]
    for (const [key, target] of gruKeys) {
      const w = weights.get(key)
      if (w) target.set(w)
    }
    const pifW = weights.get('plan_init_fwd_w')
    if (pifW) { this.planInitFwd.weights.set(pifW); this.planInitFwd.biases.set(weights.get('plan_init_fwd_b')!) }
    const pieW = weights.get('plan_init_eg_w')
    if (pieW) { this.planInitEg.weights.set(pieW); this.planInitEg.biases.set(weights.get('plan_init_eg_b')!) }

    // Plan observation embeddings
    const pve = weights.get('plan_vocab_embed')
    if (pve) this.planVocabEmbed.set(pve)
    const fpe = weights.get('forward_pos_embed')
    if (fpe) this.forwardPosEmbed.set(fpe)
    const epe = weights.get('endgame_pos_embed')
    if (epe) this.endgamePosEmbed.set(epe)

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
    total += this.gruWz.length * 6 + this.gruBz.length * 3  // GRU gates
    total += this.planTokenEmbed.length  // token embeddings
    total += this.planInitFwd.paramCount + this.planInitEg.paramCount  // init projections
    total += this.planVocabEmbed.length + this.forwardPosEmbed.length + this.endgamePosEmbed.length  // plan obs embeddings
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

    // GRU decoder weights
    params.push(this.gruWz, this.gruWr, this.gruWh)
    params.push(this.gruUz, this.gruUr, this.gruUh)
    params.push(this.gruBz, this.gruBr, this.gruBh)
    params.push(this.planTokenEmbed)
    params.push(this.planInitFwd.weights, this.planInitFwd.biases)
    params.push(this.planInitEg.weights, this.planInitEg.biases)

    // Plan observation embeddings
    params.push(this.planVocabEmbed, this.forwardPosEmbed, this.endgamePosEmbed)

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
