/**
 * skoll-zero worker 並列化の IPC メッセージ型定義。
 *
 * Stage 1: worker 内で Pure JS NN forward を実行する経路。
 *   - main が round 開始時に各 slot の weights を pack して送信
 *   - worker は受信した weights から MasonZeroNetwork を構築 → self-play 実行
 *   - finalize 済み TrainingRecord[] を main に返す
 *
 * Stage 2 以降で SkollZeroModule.forwardAt を main への IPC proxy 化する想定。
 */

import type { SystemRole } from '../../types/index.ts'
import type { SharedWeights } from '../../fenrir/src/parallel.ts'
import type { TrainingRecord } from '../selfplay/buffer.ts'
import type { SlotMap } from '../selfplay/multi-runner.ts'

/** SlotMap のキー集合 = 6 役職グループ */
export type SlotName = keyof SlotMap & string

/**
 * MCTSConfig は rng が関数で structured clone 不可のため、
 * worker に渡すときは seed に変換し、worker 側で再構築する。
 */
export type SerializableMCTSConfig = {
  cPuct: number
  nRollouts: number
  rngSeed: number
  rootDirichletAlpha?: number
  rootDirichletEps?: number
}

/** main → worker: 1 chunk 分の self-play job */
export type SelfPlayChunkRequest = {
  type: 'self_play_chunk'
  /** slot 名 → 重み (frozen / 未学習 slot は省略可、worker は heuristic fallback) */
  weights: Partial<Record<SlotName, SharedWeights>>
  /**
   * 役職分布 (Map → entries 配列でシリアライズ)。
   * undefined なら worker 内で DEFAULT_ROLES に fallback (逐次経路と挙動を揃える)。
   */
  rolesEntries?: Array<[SystemRole, number]>
  mctsConfig: SerializableMCTSConfig
  selectionMode: 'sample' | 'argmax'
  /** Stage 1 では未使用、Stage 2+ で main 集約用に使う */
  batchInferSize: number
  /** この chunk が担当する seed リスト */
  seeds: number[]
}

/** worker での self-play 結果サマリ (chunk 単位の outcomes 集計) */
export type SerializedOutcomes = {
  villagerWon: number
  werewolfWon: number
  werehamsterWon: number
  draw: number
}

/** worker → main: chunk 結果 */
export type SelfPlayChunkResult = {
  type: 'self_play_result'
  /** slot 名 → finalize 済み TrainingRecord 配列 (main で buffer に push) */
  records: Partial<Record<SlotName, TrainingRecord[]>>
  outcomes: SerializedOutcomes
}

/** worker → main: エラー報告 (例外時) */
export type SelfPlayChunkError = {
  type: 'self_play_error'
  message: string
  stack?: string
}

export type WorkerToMainMessage = SelfPlayChunkResult | SelfPlayChunkError
