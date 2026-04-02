/**
 * Lupa Next Engine — ハンドラー型定義
 *
 * エンジンは最小限のルール実行のみ行い、
 * 全ての意思決定をハンドラーコールバック経由で外部に委譲する。
 */

import type { SystemRole, ResolvedRules } from '../types/index.ts'
import type { GameState, GameEvent, GameSnapshot, NightAction, DayClaim, RevoteConfig } from './types.ts'

// ============================================================
// MaybePromise: sync/async 両対応
// ============================================================

export type MaybePromise<T> = T | Promise<T>

// ============================================================
// エンジン設定
// ============================================================

export type GameConfig = {
  roles: Map<SystemRole, number>
  seed?: number
  hasFirstGhost?: boolean
  revoteConfig?: RevoteConfig
  rules?: Partial<ResolvedRules>
  /** スナップショットを取得する Day 一覧（Seed Bank 用） */
  captureSnapshotDays?: number[]
  /** プレイヤー名の形式 (default: 'role') */
  nameStyle?: 'role' | 'seat'
}

// ============================================================
// フェーズコンテキスト（エンジンからハンドラーへ渡す情報）
// ============================================================

/** 基本フェーズコンテキスト */
export type PhaseContext<E = never> = {
  day: number
  state: Readonly<GameState>
  events: readonly (GameEvent | E)[]
  alivePlayers: number[]
  rules: ResolvedRules
}

/** 投票フェーズコンテキスト */
export type VoteContext<E = never> = PhaseContext<E> & {
  /** 再投票ラウンド (0=初回) */
  revoteRound: number
  /** 再投票候補 (null=全員が対象) */
  candidates: number[] | null
}

// ============================================================
// ハンドラーの戻り値
// ============================================================

/** onPreVote の戻り値: 議論フェーズの結果 */
export type PreVoteResult<E = never> = {
  /** 議論中に追加されたCO */
  additionalClaims?: Map<number, DayClaim>
  /** 議論フェーズで発生したイベント（エンジンが記録） */
  events?: (GameEvent | E)[]
}

// ============================================================
// ゲームハンドラー（外部から注入するコールバック）
// ============================================================

export type GameHandlers<E = never> = {
  /** 役職割当後、ゲーム開始前に呼ばれる */
  onSetup?(roles: Map<number, SystemRole>): MaybePromise<void>

  /** 夜フェーズ: 夜行動を持つプレイヤーのアクションを返す */
  onNight(ctx: PhaseContext<E>): MaybePromise<Map<number, NightAction>>

  /** 昼COフェーズ: 各プレイヤーのCO/結果報告を返す */
  onDayClaims(ctx: PhaseContext<E>): MaybePromise<Map<number, DayClaim>>

  /**
   * 投票前フェーズ（オプション）: 議論、指揮者選出、予告等
   * 未提供の場合、エンジンはCOの直後に投票に進む
   */
  onPreVote?(ctx: PhaseContext<E>): MaybePromise<PreVoteResult<E>>

  /** 遺言フェーズ（オプション）: 処刑対象者が最後にCOする機会 */
  onLastWill?(ctx: PhaseContext<E>, executedSeat: number): MaybePromise<DayClaim>

  /** 投票フェーズ: 各プレイヤーの投票先を返す（再投票時にも呼ばれる） */
  onVote(ctx: VoteContext<E>): MaybePromise<Map<number, number>>

  /** イベント通知（観測用、任意） */
  onEvent?(event: GameEvent | E): void

  /** ゲーム終了後に計測値を取得（任意） */
  getTiming?(): GameTiming
}

// ============================================================
// ゲーム結果
// ============================================================

export type GameResult<E = never> = {
  events: (GameEvent | E)[]
  state: GameState
  config: GameConfig
  /** ハンドラーが報告した計測値 */
  timing?: GameTiming
  /** captureSnapshotDays で取得されたスナップショット */
  snapshots?: Map<number, GameSnapshot<E>>
}

/** ハンドラーからエンジンに報告する計測値 */
export type GameTiming = {
  retarMs?: number
  [key: string]: number | undefined
}

// ============================================================
// プレイヤービュー（秘密知識）
// ============================================================

export type PlayerView = {
  /** 人狼 → 他の人狼のseat一覧 (人狼以外はnull) */
  wolfTeammates: number[] | null
  /** 狂信者 → 人狼のseat一覧 (狂信者以外はnull) */
  knownWolves: number[] | null
  /** 背徳者 → 妖狐のseat (背徳者以外はnull) */
  knownHamster: number | null
  /** 共有者 → 相方のseat (共有者以外はnull) */
  masonPartner: number | null
}
