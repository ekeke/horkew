/**
 * Command Adapter 型定義
 *
 * 昼・夜・指揮・CCO の各フェーズを統一した discriminated union。
 * 設計: tasks/command-adapter-plan.md, tmp/new-command-game-design.txt
 */

import type { SystemRole, EnumSpecies } from '../../../../types/index.ts'
import type { DayClaim } from '../../../../lupa/types.ts'

/** Retar 結果のキャッシュ（skoll が参照する形式に揃える） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- vs は howl ブリッジの型に依存
export type RetarCache = {
  /** 公開情報のみから計算した可能性 (seat → 役職集合) */
  possibilities: Map<number, Set<SystemRole>>
  /** skoll が参照する artifacts (null = VillageStatus 構築失敗) */
  lastArtifacts: { vs: any, setup: Map<SystemRole, number> } | null
  /** 計算時のイベント数（キャッシュ無効化判定用） */
  computedAtEventCount: number
}

// ============================================================
// フェーズ種別
// ============================================================

/** Command Adapter 内部の進行状態 */
export type CommandPhase =
  | 'night'        // 夜行動
  | 'discussion'   // 昼議論（キュー順）
  | 'commander'    // 進行指示（commander のみ）
  | 'cco'          // 最後の CO 機会
  | 'vote'         // 投票

/** 進行役が要求できる CO カテゴリ */
export type CoRequestCategory =
  | 'seer'
  | 'medium'
  | 'bodyguard'
  | 'nekomata'
  | 'nekomata_bodyguard_grelan'  // 猫狩ギドラ

/** 人外自白で表明できる真役職 */
export type VillainTrueRole = 'werewolf' | 'fanatic' | 'werehamster' | 'immoralist'

// ============================================================
// コマンド union
// ============================================================

// 夜コマンド (onNight)
export type NightCommand =
  | { type: 'divine', target: number }
  | { type: 'guard', target: number }
  | { type: 'attack', target: number }
  | { type: 'no_action' }

// 昼議論コマンド
export type DiscussionCommand =
  | { type: 'role_co', claim: DayClaim }            // 初 CO 宣言
  | { type: 'role_result_report', claim: DayClaim } // 結果報告（占い結果等）
  | { type: 'skip' }

// 進行指示コマンド（commander のみ）
export type CommanderCommand =
  | { type: 'request_co', category: CoRequestCategory }
  | { type: 'designate_execution', target: number }
  | { type: 'designate_runoff', targets: number[] }

// CCO コマンド
export type CcoCommand =
  | { type: 'cco_full', claim: DayClaim }  // 未 CO 席の一気出し
  | { type: 'cco_villain_reveal', trueRole: VillainTrueRole }
  | { type: 'cco_skip' }

// 投票コマンド
export type VoteCommand =
  | { type: 'vote', target: number }

/** 全コマンド統一型 */
export type Command =
  | NightCommand
  | DiscussionCommand
  | CommanderCommand
  | CcoCommand
  | VoteCommand

// ============================================================
// アダプタ ext（GameState.ext に格納）
// ============================================================

export type CommandHistoryEntry = {
  day: number
  phase: CommandPhase
  seat: number
  cmd: Command
}

export type CommandAdapterExt = {
  /** 現在の内部フェーズ */
  currentPhase: CommandPhase
  /** 議論フェーズ: 未処理の手番キュー（先頭から処理） */
  discussionQueue: number[]
  /** 議論フェーズ: 連続 skip した席（全員 skip 判定用） */
  consecutiveSkips: Set<number>
  /** 現在の進行役（Retar 結果から自動選出、誰もいなければ null） */
  commander: number | null
  /** 吊り指定された席（非 null なら onVote で全員強制投票） */
  designatedTarget: number | null
  /** ラン指定された候補席リスト */
  runoffCandidates: number[] | null
  /** CCO フェーズ: 機会を与える席のキュー */
  ccoQueue: number[]
  /** CCO フェーズ: 誰か 1 人でも CO したフラグ（終了時 discussion へ戻る） */
  ccoAnyReveal: boolean
  /** 全コマンド履歴 */
  history: CommandHistoryEntry[]
  /** 当日の onPreVote micro-step 数（暴走検知用、日替わりでリセット） */
  preVoteStepCount: number
  /** 投票フェーズ: 投票可能な候補席（lupa VoteContext.candidates or designate 由来） */
  voteCandidates: number[] | null
  /** Retar 再計算結果のキャッシュ（skoll 連携で参照）。未計算 or Retar 無効時は null */
  retarCache: RetarCache | null
  /**
   * 当日すでに request_co されたカテゴリ集合。一日一回制限の実装用。
   * 初日犠牲者が真役職だった場合に進行役が無限ループで CO 要求し続けるのを防ぐ。
   * onNight（新日開始）でクリアされる。
   */
  requestedCategoriesThisDay: Set<CoRequestCategory>
  /**
   * 人外の騙り割当。初回 villain discussion turn で決定され、以降不変。
   * Map<seat, claim> の形式。'hide' は潜伏（何も CO しない）。
   * 割り当てられた役職を CO し、以後その役職として結果報告を続ける。
   */
  villainClaimPlan: Map<number, VillainClaimAssignment>
}

/** 人外の騙り戦略 */
export type VillainClaimAssignment = 'seer' | 'medium' | 'bodyguard' | 'nekomata' | 'hide'

export function createCommandAdapterExt(): CommandAdapterExt {
  return {
    currentPhase: 'night',
    discussionQueue: [],
    consecutiveSkips: new Set(),
    commander: null,
    designatedTarget: null,
    runoffCandidates: null,
    ccoQueue: [],
    ccoAnyReveal: false,
    history: [],
    preVoteStepCount: 0,
    voteCandidates: null,
    retarCache: null,
    requestedCategoriesThisDay: new Set(),
    villainClaimPlan: new Map(),
  }
}

// ============================================================
// ヘルパー型ガード
// ============================================================

export function isNightCommand(cmd: Command): cmd is NightCommand {
  return cmd.type === 'divine'
    || cmd.type === 'guard'
    || cmd.type === 'attack'
    || cmd.type === 'no_action'
}

export function isDiscussionCommand(cmd: Command): cmd is DiscussionCommand {
  return cmd.type === 'role_co'
    || cmd.type === 'role_result_report'
    || cmd.type === 'skip'
}

export function isCommanderCommand(cmd: Command): cmd is CommanderCommand {
  return cmd.type === 'request_co'
    || cmd.type === 'designate_execution'
    || cmd.type === 'designate_runoff'
}

export function isCcoCommand(cmd: Command): cmd is CcoCommand {
  return cmd.type === 'cco_full'
    || cmd.type === 'cco_villain_reveal'
    || cmd.type === 'cco_skip'
}

export function isVoteCommand(cmd: Command): cmd is VoteCommand {
  return cmd.type === 'vote'
}

// EnumSpecies は Command の claim 側で参照されるため明示 re-export
export type { DayClaim, EnumSpecies, SystemRole }
