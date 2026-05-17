/**
 * skoll-multiday-NN — Pure JS 推論モデル
 *
 * `recursiveSkoll` (src/skoll/recursive.ts) の出力を教師とする per-X 期待値
 * 予測 NN。 fenrir 既存の TransformerEncoder を再利用。
 *
 * 入力 tokenization (skoll 専用):
 *   - CLS token: global features (day one-hot + setup counts + max_surviving_nv + alive_count)
 *   - Seat tokens (1..MAX_SEAT): per-seat features (possibility one-hot + alive)
 *
 * 出力:
 *   - Per-seat token → shared linear (dModel → 1) → linear (winRate, no activation)
 *   - 14 dim vector (alive mask は loss 側で適用)
 *
 * 重み命名:
 *   - proj_cls_*, proj_seat_*: 射影
 *   - enc_*: TransformerEncoder
 *   - output_*: per-seat head (shared linear)
 */

import { TransformerEncoder, linearBatchedPublic } from './transformer.ts'
import { DenseLayer, gaussianRandom } from './nn.ts'

// ============================================================
// Constants
// ============================================================

/** ROLE bit 数 (= 11) — possibility one-hot のサイズ */
export const ROLE_BITS = 11
/** 最大 seat 数 (14d-neko = 14) */
export const MAX_SEAT = 14
/** Day を 1-hot 化する際の最大 day (day 5+ は 1 つにまとめる) */
const MAX_DAY_BUCKET = 5

/** Per-seat features: ROLE_BITS (possibility) + 1 (alive) = 12 */
export const SEAT_FEATURES = ROLE_BITS + 1

/** Global (CLS) features:
 *  - day one-hot (MAX_DAY_BUCKET)
 *  - setup counts (ROLE_BITS, normalized)
 *  - max_surviving_nv (1, normalized)
 *  - alive_count (1, normalized)
 */
export const CLS_FEATURES = MAX_DAY_BUCKET + ROLE_BITS + 1 + 1

/** シーケンス長: CLS(1) + Seats(MAX_SEAT) */
const SEQ_LEN = 1 + MAX_SEAT

// ============================================================
// Config
// ============================================================

export type MultidaySkollConfig = {
  dModel: number
  numLayers: number
  numHeads: number
  dFf: number
}

export const DEFAULT_MULTIDAY_SKOLL_CONFIG: MultidaySkollConfig = {
  dModel: 64,
  numLayers: 3,
  numHeads: 4,
  dFf: 128,
}

// ============================================================
// Tokenization (skoll 専用)
// ============================================================

/**
 * Skoll 入力を CLS + Seat features に展開する。
 */
export function tokenizeSkollInput(input: {
  possibilities: ArrayLike<number>  // [0]=unused, [1..MAX_SEAT]=role bitmask
  aliveSeats: ReadonlyArray<number>
  setup: ReadonlyMap<string, number> | Record<string, number>
  day: number
  maxSurvivingNV: number
}): { cls: Float32Array, seats: Float32Array } {
  const cls = new Float32Array(CLS_FEATURES)
  const seats = new Float32Array(MAX_SEAT * SEAT_FEATURES)

  // Per-seat: possibility one-hot + alive
  const aliveSet = new Set(input.aliveSeats)
  for (let seat = 1; seat <= MAX_SEAT; seat++) {
    const seatIdx = seat - 1  // 0-indexed in seats array
    const mask = input.possibilities[seat] ?? 0
    const featOffset = seatIdx * SEAT_FEATURES
    for (let bit = 0; bit < ROLE_BITS; bit++) {
      seats[featOffset + bit] = (mask & (1 << bit)) !== 0 ? 1 : 0
    }
    seats[featOffset + ROLE_BITS] = aliveSet.has(seat) ? 1 : 0
  }

  // CLS: day one-hot
  const dayBucket = Math.min(Math.max(input.day, 1), MAX_DAY_BUCKET) - 1
  cls[dayBucket] = 1

  // CLS: setup counts (normalized by total players)
  let totalRoles = 0
  const setupEntries: [string, number][] = input.setup instanceof Map
    ? Array.from(input.setup.entries())
    : Object.entries(input.setup)
  for (const [_, count] of setupEntries) totalRoles += count
  const roleBitIndex: Record<string, number> = {
    villager: 0, seer: 1, medium: 2, bodyguard: 3, mason: 4,
    nekomata: 5, werewolf: 6, possessed: 7, fanatic: 8,
    werehamster: 9, immoralist: 10,
  }
  const setupOffset = MAX_DAY_BUCKET
  for (const [role, count] of setupEntries) {
    const idx = roleBitIndex[role]
    if (idx !== undefined) cls[setupOffset + idx] = totalRoles > 0 ? count / totalRoles : 0
  }

  // CLS: max_surviving_nv (normalized by totalRoles)
  cls[setupOffset + ROLE_BITS] = totalRoles > 0 ? input.maxSurvivingNV / totalRoles : 0

  // CLS: alive_count (normalized by totalRoles)
  cls[setupOffset + ROLE_BITS + 1] = totalRoles > 0 ? input.aliveSeats.length / totalRoles : 0

  return { cls, seats }
}

// ============================================================
// Network
// ============================================================

export class MultidaySkollNetwork {
  readonly config: MultidaySkollConfig

  // 入力射影
  private projClsW: Float32Array
  private projClsB: Float32Array
  private projSeatW: Float32Array
  private projSeatB: Float32Array

  // Transformer encoder
  private encoder: TransformerEncoder

  // 出力ヘッド: per-seat → shared linear → 1 dim (winRate)
  private outputHead: DenseLayer

  // スクラッチ
  private tokenBuffer: Float32Array
  private mask: boolean[]

  constructor(config: MultidaySkollConfig = DEFAULT_MULTIDAY_SKOLL_CONFIG) {
    this.config = config
    const dm = config.dModel

    // 射影 (He init)
    this.projClsW = initProjection(CLS_FEATURES, dm)
    this.projClsB = new Float32Array(dm)
    this.projSeatW = initProjection(SEAT_FEATURES, dm)
    this.projSeatB = new Float32Array(dm)

    // Transformer
    this.encoder = new TransformerEncoder({
      dModel: dm,
      numLayers: config.numLayers,
      numHeads: config.numHeads,
      dFf: config.dFf,
      maxSeqLen: SEQ_LEN,
    })

    // 出力ヘッド: per-seat (dm → 1 winRate)
    this.outputHead = new DenseLayer(dm, 1)

    // スクラッチ
    this.tokenBuffer = new Float32Array(SEQ_LEN * dm)
    this.mask = new Array(SEQ_LEN).fill(true)
  }

  /**
   * 推論: skoll input → per-seat winRate (length = MAX_SEAT)
   * 出力は線形 (clip なし)。 alive mask は呼び出し側で適用。
   */
  forward(input: Parameters<typeof tokenizeSkollInput>[0]): Float32Array {
    const dm = this.config.dModel
    const tok = this.tokenBuffer
    tok.fill(0)

    const { cls, seats } = tokenizeSkollInput(input)

    // CLS 射影 → tok[0..dm)
    linearBatchedPublic(cls, this.projClsW, this.projClsB, CLS_FEATURES, dm, 1, tok)

    // Seat 射影 → tok[dm .. SEQ_LEN*dm)
    const seatOut = new Float32Array(tok.buffer, dm * 4, MAX_SEAT * dm)
    linearBatchedPublic(seats, this.projSeatW, this.projSeatB, SEAT_FEATURES, dm, MAX_SEAT, seatOut)

    // Transformer encoder (in-place)
    this.encoder.forward(tok, SEQ_LEN, this.mask)

    // Per-seat head: 各 seat token → 1 dim winRate
    const out = new Float32Array(MAX_SEAT)
    const seatVec = new Float32Array(dm)
    for (let s = 0; s < MAX_SEAT; s++) {
      const offset = (1 + s) * dm  // CLS は skip
      for (let i = 0; i < dm; i++) seatVec[i] = tok[offset + i]
      const oneDim = this.outputHead.forward(seatVec)
      out[s] = oneDim[0]
    }
    return out
  }

  // ============================================================
  // 重み管理
  // ============================================================

  cloneWeights(): Map<string, Float32Array> {
    const weights = new Map<string, Float32Array>()
    weights.set('proj_cls_w', new Float32Array(this.projClsW))
    weights.set('proj_cls_b', new Float32Array(this.projClsB))
    weights.set('proj_seat_w', new Float32Array(this.projSeatW))
    weights.set('proj_seat_b', new Float32Array(this.projSeatB))
    for (const [key, val] of this.encoder.collectWeights()) {
      weights.set(`enc_${key}`, new Float32Array(val))
    }
    weights.set('output_w', new Float32Array(this.outputHead.weights))
    weights.set('output_b', new Float32Array(this.outputHead.biases))
    return weights
  }

  loadWeights(weights: Map<string, Float32Array>): void {
    this.projClsW.set(weights.get('proj_cls_w')!)
    this.projClsB.set(weights.get('proj_cls_b')!)
    this.projSeatW.set(weights.get('proj_seat_w')!)
    this.projSeatB.set(weights.get('proj_seat_b')!)
    const encoderWeights = new Map<string, Float32Array>()
    for (const [key, val] of weights) {
      if (key.startsWith('enc_')) encoderWeights.set(key.slice(4), val)
    }
    this.encoder.loadWeights(encoderWeights)
    this.outputHead.weights.set(weights.get('output_w')!)
    this.outputHead.biases.set(weights.get('output_b')!)
  }

  get totalParams(): number {
    const projParams = (CLS_FEATURES * this.config.dModel + this.config.dModel)
      + (SEAT_FEATURES * this.config.dModel + this.config.dModel)
    return projParams + this.encoder.paramCount + this.outputHead.paramCount
  }
}

// ============================================================
// Utility
// ============================================================

function initProjection(inDim: number, outDim: number): Float32Array {
  const scale = Math.sqrt(2 / inDim)
  const w = new Float32Array(inDim * outDim)
  for (let i = 0; i < w.length; i++) w[i] = gaussianRandom() * scale
  return w
}
