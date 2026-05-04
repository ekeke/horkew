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
  /** Day bonus 係数 (0 で無効、SKOLLZ_DAY_BONUS_COEF) */
  dayBonusCoef?: number
  /** Endgame bonus 係数 (0 で無効、SKOLLZ_ENDGAME_BONUS_COEF) */
  endgameBonusCoef?: number
  /** Night phase 並列化フラグ (SKOLLZ_NIGHT_PARALLEL) */
  nightParallel?: boolean
}

/** Stage 2: ProxiedMasonZeroNN が forward IPC で使う SAB のセット (1 worker あたり 1 セット) */
export type ForwardSABBundle = {
  signalSAB: SharedArrayBuffer
  requestSAB: SharedArrayBuffer
  responseSAB: SharedArrayBuffer
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
  selectionMode: 'sample' | 'argmax' | 'policy_argmax'
  /** Stage 1 では未使用、Stage 2+ で main 集約用に使う */
  batchInferSize: number
  /** この chunk が担当する seed リスト */
  seeds: number[]
  /**
   * Stage 2: 指定されれば worker は MasonZeroNetwork (Pure JS) を ProxiedMasonZeroNN で wrap し、
   * forwardBatch を SAB+Atomics 経由で main GPU に投げる。
   * 未指定なら Stage 1 経路 (worker 内 Pure JS forward)。
   */
  forwardSABs?: ForwardSABBundle
  /** forwardSABs と必ず同時指定。forward server が SAB を区別するための worker 識別 */
  workerId?: number
  /**
   * カリキュラム制御: この chunk で retar rollout (MCTS 中の retar 再実行) を有効化するか。
   * worker 内で process.env.SKOLLZ_ROLLOUT_RETAR を上書きする。
   * 未指定なら worker 起動時の env を維持 (= phase 起動時の env)。
   */
  rolloutRetar?: boolean
  /**
   * Per-slot Dirichlet ε override (auto-decay 用)。指定された slot は mctsConfig.rootDirichletEps
   * の代わりにこちらを使う。指定外は mctsConfig.rootDirichletEps を維持。
   */
  dirichletEpsBySlot?: Partial<Record<SlotName, number>>
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
  /**
   * slot 名 → root visit エントロピー比の集計 (chunk 内全 game 累計)。
   * Dirichlet ε auto-decay の判定に使う。
   */
  entropyStats: Partial<Record<SlotName, { sum: number, count: number }>>
}

/** worker → main: エラー報告 (例外時) */
export type SelfPlayChunkError = {
  type: 'self_play_error'
  message: string
  stack?: string
}

export type WorkerToMainMessage = SelfPlayChunkResult | SelfPlayChunkError
