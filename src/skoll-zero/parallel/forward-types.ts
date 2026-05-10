/**
 * Stage 2: worker → main forward IPC のメッセージ型と SharedArrayBuffer レイアウト定数。
 *
 * 設計: worker thread の MasonZeroNN.forwardBatch が呼ばれたとき、
 *   1. requestSAB に obs / actorSeats / actorRoles / headName / module を encode
 *   2. signalSAB を REQUEST_PENDING にして、postMessage(forward_request) で main に通知
 *   3. Atomics.wait(signalSAB, 0, REQUEST_PENDING) で blocking
 *   4. main は forwardBatch (GPU) を実行し、responseSAB に encode、signalSAB を RESPONSE_READY に書き換え + Atomics.notify
 *   5. worker は wake、responseSAB から NNOutput[] を decode
 *
 * MasonZeroNN.forwardBatch は sync API (NNOutput[] を返す) なので、Atomics で sync 化する。
 */

import type { HeadName } from '../mcts/nn.ts'
import type { ForwardSlotName } from './types.ts'

// ============================================================
// signal の状態値
// ============================================================

export const SIGNAL_IDLE = 0
export const SIGNAL_REQUEST_PENDING = 1
export const SIGNAL_RESPONSE_READY = 2
export const SIGNAL_ERROR = 3

// ============================================================
// 容量上限
// ============================================================

/** 1 batch に詰められる leaf 数の上限。SKOLLZ_BATCH_INFER の最大想定値 */
export const MAX_BATCH = 64

/** 観測ベクトルの最大次元 (wolf_collective: 1212 dims が最大) */
export const MAX_OBS_DIMS = 1212

/**
 * 1 NNOutput の policy.entries 最大数。
 *
 * - per-seat head (vote/attack/divine/guard/target): 14 (alive seat 14 max)
 * - global head: 各 head の logits 長 (morning=28, claim_fake=15, predict=154 等)
 *
 * Phase 2 head (predict 154 等) も将来 MCTS で使う可能性に備えて 256 (キリの良い幅)。
 */
export const MAX_POLICY_ENTRIES = 256

/** outcomeDist 固定サイズ */
export const OUTCOME_DIST_DIMS = 4

// ============================================================
// HeadName / SlotName ↔ index 双方向マップ (SAB に整数で encode)
// ============================================================

export const HEAD_NAMES: ReadonlyArray<HeadName> = [
  'execute', 'attack', 'divine', 'guard', 'target',
  'claim_true', 'claim_fake', 'morning',
  'claim', 'comm', 'leader',
  'propose', 'predict',
]

export const HEAD_NAME_TO_INDEX: ReadonlyMap<HeadName, number> = new Map(
  HEAD_NAMES.map((h, i) => [h, i]),
)

export const SLOT_NAMES: ReadonlyArray<ForwardSlotName> = [
  'mason', 'village', 'wolf', 'fanatic', 'hamster', 'immoralist', 'frozenVillage',
]

export const SLOT_NAME_TO_INDEX: ReadonlyMap<ForwardSlotName, number> = new Map(
  SLOT_NAMES.map((s, i) => [s, i]),
)

// ============================================================
// SAB レイアウト
// ============================================================

/**
 * signalSAB: Int32Array(1) view を取って Atomics で操作。
 * バイト数 4。
 */
export const SIGNAL_SAB_BYTES = 4

/**
 * requestSAB のレイアウト (Float32Array view を取り、必要箇所のみ Int32Array view も使う):
 *
 * Int32 ヘッダ (5 words = 20 bytes):
 *   [0]: batch_size
 *   [1]: head_index (HEAD_NAMES の index)
 *   [2]: slot_index (SLOT_NAMES の index)
 *   [3]: obs_dims (slot ごとに変わる、wolf=1212 等)
 *   [4]: reserved (将来用)
 *
 * 続く配列 (Int32 view、batch_size 個ずつ):
 *   [5..5+MAX_BATCH-1]: actorSeats (Int32 × MAX_BATCH)
 *   [5+MAX_BATCH..5+2*MAX_BATCH-1]: alives (Int32 × MAX_BATCH、各 sample の SimState.alive bitmask)
 *
 * 続く obs データ (Float32 view):
 *   [obsOffsetWords + i*MAX_OBS_DIMS .. + obs_dims - 1]: i 番目の obs
 *
 * 全体サイズ計算:
 *   ヘッダ (5) + actorSeats (MAX_BATCH) + alives (MAX_BATCH) = 5 + 128 = 133 words = 532 bytes
 *   obs 領域 = MAX_BATCH × MAX_OBS_DIMS × 4 = 64 × 1212 × 4 = 310,272 bytes
 *   合計 = 310,804 bytes (~304 KB)
 *
 * 注: SimState 全体は worker thread でしか持てないが、TfMasonZeroNetwork.forwardBatch が
 * per-seat softmax で使うのは state.alive と actorSeat のみ (tf-mason-zero.ts:73 確認済み)。
 * よって main 側では仮 SimState ({ alive: bitmask } のみ) を作って forwardBatch に渡せる。
 */
export const REQUEST_HEADER_WORDS = 5
export const REQUEST_ACTOR_SEATS_OFFSET_WORDS = REQUEST_HEADER_WORDS
export const REQUEST_ALIVES_OFFSET_WORDS = REQUEST_HEADER_WORDS + MAX_BATCH
export const REQUEST_OBS_OFFSET_WORDS = REQUEST_HEADER_WORDS + 2 * MAX_BATCH
export const REQUEST_SAB_WORDS = REQUEST_OBS_OFFSET_WORDS + MAX_BATCH * MAX_OBS_DIMS
export const REQUEST_SAB_BYTES = REQUEST_SAB_WORDS * 4

/**
 * responseSAB のレイアウト (Int32Array view と Float32Array view を同じ SAB で取って使い分け):
 *
 * Int32 ヘッダ (1 word):
 *   [0]: batch_size (echo back、検証用)
 *
 * Int32 array (entry_counts、batch_size 個):
 *   [1..1+MAX_BATCH-1]: per-sample policy_entries 数
 *
 * Int32 array (policy_seats、各 sample MAX_POLICY_ENTRIES 個):
 *   [policySeatsOffsetWords + i*MAX_POLICY_ENTRIES + k]: i 番目 sample の k 番目の seat (1-based)
 *
 * Float32 array (policy_probs、同形):
 *   [policyProbsOffsetWords + i*MAX_POLICY_ENTRIES + k]: 上の seat に対応する probability
 *
 * Float32 array (outcomeDist):
 *   [outcomeOffsetWords + i*OUTCOME_DIST_DIMS + j]: i 番目 sample の outcomeDist[j]
 *
 * サイズ:
 *   ヘッダ (1) + entry_counts (MAX_BATCH) = 65 words = 260 bytes
 *   policy_seats = MAX_BATCH × MAX_POLICY_ENTRIES = 896 words = 3584 bytes
 *   policy_probs = 同 = 3584 bytes
 *   outcomeDist = MAX_BATCH × OUTCOME_DIST_DIMS = 256 words = 1024 bytes
 *   合計 = 8452 bytes (~8.3 KB)
 */
export const RESPONSE_HEADER_WORDS = 1
export const RESPONSE_ENTRY_COUNTS_OFFSET_WORDS = RESPONSE_HEADER_WORDS
export const RESPONSE_POLICY_SEATS_OFFSET_WORDS = RESPONSE_HEADER_WORDS + MAX_BATCH
export const RESPONSE_POLICY_PROBS_OFFSET_WORDS = RESPONSE_POLICY_SEATS_OFFSET_WORDS + MAX_BATCH * MAX_POLICY_ENTRIES
export const RESPONSE_OUTCOME_DIST_OFFSET_WORDS = RESPONSE_POLICY_PROBS_OFFSET_WORDS + MAX_BATCH * MAX_POLICY_ENTRIES
export const RESPONSE_SAB_WORDS = RESPONSE_OUTCOME_DIST_OFFSET_WORDS + MAX_BATCH * OUTCOME_DIST_DIMS
export const RESPONSE_SAB_BYTES = RESPONSE_SAB_WORDS * 4

// ============================================================
// IPC メッセージ型
// ============================================================

/** worker → main: SAB に encode 済みの forward リクエストを処理してくれ、という通知 */
export type ForwardRequestMessage = {
  type: 'forward_request'
  workerId: number
}

/** main → worker: response 完了通知 (実際の content は SAB 経由、これは error 通知用) */
export type ForwardErrorMessage = {
  type: 'forward_error'
  workerId: number
  message: string
}

export type WorkerForwardSABs = {
  signalSAB: SharedArrayBuffer
  requestSAB: SharedArrayBuffer
  responseSAB: SharedArrayBuffer
}

/** SystemRole の整数 encode 用 (codec が使う) */
export const SYSTEM_ROLE_NAMES = [
  'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
  'werewolf', 'fanatic', 'werehamster', 'immoralist', 'possessed',
] as const
export type SystemRoleEncoded = typeof SYSTEM_ROLE_NAMES[number]
export const SYSTEM_ROLE_TO_INDEX: ReadonlyMap<string, number> = new Map(
  SYSTEM_ROLE_NAMES.map((r, i) => [r, i]),
)
