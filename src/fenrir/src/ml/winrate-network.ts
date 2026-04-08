/**
 * Win-Rate Estimator (WRE) — Pure JS 推論モデル
 *
 * 既存の TransformerEncoder を再利用した縮小版。
 * tokenize(obs, 'individual') → proj → 2層 SeatEncoder → CLS → Linear(3) → softmax
 *
 * 出力: [village_win, wolf_win, fox_win] の確率分布 (3クラス softmax)
 */

import { tokenize, SEATS, CLS_FEATURES, SEAT_TOKEN_FEATURES, NUM_ROLE_TOKENS, ROLE_TOKEN_FEATURES } from '../observation.ts'
import { TransformerEncoder, type TransformerConfig, linearBatchedPublic } from './transformer.ts'
import { DenseLayer, softmax, gaussianRandom } from './nn.ts'

// ============================================================
// Config
// ============================================================

export type WinrateNetworkConfig = {
  dModel: number      // 32
  numLayers: number   // 2
  numHeads: number    // 2
  dFf: number         // 64
}

export const DEFAULT_WINRATE_CONFIG: WinrateNetworkConfig = {
  dModel: 32,
  numLayers: 2,
  numHeads: 2,
  dFf: 64,
}

/** 出力クラス数: village_win, wolf_win, fox_win */
export const NUM_CLASSES = 3

/** シーケンス長: CLS(1) + Seats(14) + Roles(5) = 20 */
const SEQ_LEN = 1 + SEATS + NUM_ROLE_TOKENS

// ============================================================
// WinrateNetwork
// ============================================================

export class WinrateNetwork {
  readonly config: WinrateNetworkConfig

  // 入力射影: raw features → dModel
  private projClsW: Float32Array
  private projClsB: Float32Array
  private projSeatW: Float32Array
  private projSeatB: Float32Array
  private projRoleW: Float32Array
  private projRoleB: Float32Array

  // Transformer encoder
  private encoder: TransformerEncoder

  // 出力ヘッド: CLS → 3クラス
  private outputHead: DenseLayer

  // スクラッチバッファ
  private tokenBuffer: Float32Array
  private mask: boolean[]

  constructor(config: WinrateNetworkConfig = DEFAULT_WINRATE_CONFIG) {
    this.config = config
    const dm = config.dModel

    // 入力射影 (Xavier init)
    const clsScale = Math.sqrt(2 / CLS_FEATURES)
    this.projClsW = initProjection(CLS_FEATURES, dm, clsScale)
    this.projClsB = new Float32Array(dm)

    const seatScale = Math.sqrt(2 / SEAT_TOKEN_FEATURES)
    this.projSeatW = initProjection(SEAT_TOKEN_FEATURES, dm, seatScale)
    this.projSeatB = new Float32Array(dm)

    const roleScale = Math.sqrt(2 / ROLE_TOKEN_FEATURES)
    this.projRoleW = initProjection(ROLE_TOKEN_FEATURES, dm, roleScale)
    this.projRoleB = new Float32Array(dm)

    // Transformer
    const encoderConfig: TransformerConfig = {
      dModel: dm,
      numLayers: config.numLayers,
      numHeads: config.numHeads,
      dFf: config.dFf,
      maxSeqLen: SEQ_LEN,
    }
    this.encoder = new TransformerEncoder(encoderConfig)

    // 出力ヘッド
    this.outputHead = new DenseLayer(dm, NUM_CLASSES)

    // スクラッチ
    this.tokenBuffer = new Float32Array(SEQ_LEN * dm)
    this.mask = new Array(SEQ_LEN).fill(true)
  }

  /**
   * 推論: observation → [village_win, wolf_win, fox_win]
   * @param obs packObservation() の出力 (1209次元 flat Float32Array)
   */
  forward(obs: Float32Array): Float32Array {
    const dm = this.config.dModel
    const tok = this.tokenBuffer
    tok.fill(0)

    // tokenize
    const { cls, seats, roles } = tokenize(obs, 'individual')

    // CLS射影 → tok[0..dm)
    linearBatchedPublic(cls, this.projClsW, this.projClsB, CLS_FEATURES, dm, 1, tok)

    // Seat射影 → tok[dm .. (1+SEATS)*dm)
    const seatOut = new Float32Array(tok.buffer, (1) * dm * 4, SEATS * dm)
    linearBatchedPublic(seats, this.projSeatW, this.projSeatB, SEAT_TOKEN_FEATURES, dm, SEATS, seatOut)

    // Role射影 → tok[(1+SEATS)*dm .. SEQ_LEN*dm)
    const roleOut = new Float32Array(tok.buffer, (1 + SEATS) * dm * 4, NUM_ROLE_TOKENS * dm)
    linearBatchedPublic(roles, this.projRoleW, this.projRoleB, ROLE_TOKEN_FEATURES, dm, NUM_ROLE_TOKENS, roleOut)

    // Transformer encoder (in-place)
    this.encoder.forward(tok, SEQ_LEN, this.mask)

    // CLS token → output head → softmax
    const clsOut = new Float32Array(dm)
    for (let i = 0; i < dm; i++) clsOut[i] = tok[i]
    const logits = this.outputHead.forward(clsOut)
    return softmax(logits)
  }

  // ============================================================
  // 重み管理
  // ============================================================

  cloneWeights(): Map<string, Float32Array> {
    const weights = new Map<string, Float32Array>()

    // 射影層
    weights.set('proj_cls_w', new Float32Array(this.projClsW))
    weights.set('proj_cls_b', new Float32Array(this.projClsB))
    weights.set('proj_seat_w', new Float32Array(this.projSeatW))
    weights.set('proj_seat_b', new Float32Array(this.projSeatB))
    weights.set('proj_role_w', new Float32Array(this.projRoleW))
    weights.set('proj_role_b', new Float32Array(this.projRoleB))

    // Encoder
    for (const [key, val] of this.encoder.collectWeights()) {
      weights.set(`enc_${key}`, new Float32Array(val))
    }

    // 出力ヘッド
    weights.set('output_w', new Float32Array(this.outputHead.weights))
    weights.set('output_b', new Float32Array(this.outputHead.biases))

    return weights
  }

  loadWeights(weights: Map<string, Float32Array>): void {
    this.projClsW.set(weights.get('proj_cls_w')!)
    this.projClsB.set(weights.get('proj_cls_b')!)
    this.projSeatW.set(weights.get('proj_seat_w')!)
    this.projSeatB.set(weights.get('proj_seat_b')!)
    this.projRoleW.set(weights.get('proj_role_w')!)
    this.projRoleB.set(weights.get('proj_role_b')!)

    // Encoder
    const encoderWeights = new Map<string, Float32Array>()
    for (const [key, val] of weights) {
      if (key.startsWith('enc_')) {
        encoderWeights.set(key.slice(4), val)
      }
    }
    this.encoder.loadWeights(encoderWeights)

    this.outputHead.weights.set(weights.get('output_w')!)
    this.outputHead.biases.set(weights.get('output_b')!)
  }

  get totalParams(): number {
    const projParams = (CLS_FEATURES * this.config.dModel + this.config.dModel)
      + (SEAT_TOKEN_FEATURES * this.config.dModel + this.config.dModel)
      + (ROLE_TOKEN_FEATURES * this.config.dModel + this.config.dModel)
    return projParams + this.encoder.paramCount + this.outputHead.paramCount
  }
}

// ============================================================
// ユーティリティ
// ============================================================

function initProjection(inDim: number, outDim: number, scale: number): Float32Array {
  const w = new Float32Array(inDim * outDim)
  for (let i = 0; i < w.length; i++) {
    w[i] = gaussianRandom() * scale
  }
  return w
}
