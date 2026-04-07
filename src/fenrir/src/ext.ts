/**
 * FenrirExt — GameState.ext に格納される fenrir 固有の永続データ
 *
 * Adapter のクロージャ変数を排し、全永続データを GameState.ext 経由で管理する。
 * structuredClone で自動複製され、snapshot / resumeGame で保存・復元される。
 */

import type { SystemRole } from '../../types/index.ts'
import type { ExecutionPlan } from './agents/agent.ts'
import type { PlanState } from './plan/plan-helpers.ts'
import type { SignalRecord } from './communication.ts'
import type { Proposal } from './leadership.ts'
import type { RetarResult } from './retar-bridge.ts'
import { PLAN_VOCAB } from './plan/plan-vocab.ts'
import { NUM_PLAN_TOKENS } from './observation.ts'

// PlanState は plan/plan-helpers.ts で定義済み、ここでは re-export のみ
export type { PlanState } from './plan/plan-helpers.ts'
export { NUM_PLAN_TOKENS } from './observation.ts'

/** Retar 解析結果のキャッシュ */
export type RetarCache = {
  /** per-seat 可能役職集合 */
  possibilities: Map<number, Set<SystemRole>>
  /** 最大生存人外数 */
  maxSurvivingNV: number | null
  /** グローバル Retar: 公開情報のみから計算した可能性 */
  globalPossibilities: Map<number, Set<SystemRole>> | null
  /** per-player Retar 結果 */
  perPlayer: Map<number, RetarResult> | null
  /** Hati 詰み探索用の生データ */
  lastArtifacts: {
    vs: any
    setup: Map<SystemRole, number>
    options: any
  } | null
}

/** full adapter の議論フェーズ状態 */
export type DiscussionState = {
  /** 全シグナル履歴 */
  signals: SignalRecord[]
  /** 今日のシグナル */
  daySignals: SignalRecord[]
  /** 今日の提案 */
  dayProposals: Proposal[]
  /** シグナルID カウンター */
  signalIdCounter: number
}

/** fenrir 固有の GameState 拡張 */
export type FenrirExt = {
  /** 処刑プランの進行状態 */
  planState: PlanState
  /** 村全体に公開された処刑プラン */
  executionPlans: ExecutionPlan[]
  /** NN が出力した raw plan token indices (unified 12 tokens, vocab 0-21) */
  planIndices: number[]
  /** Retar 解析結果のキャッシュ */
  retarCache: RetarCache | null
  /** 詰み判定キャッシュ: day → isTsumi */
  tsumiCache: Map<number, boolean>
  /** 詰み対象 seat */
  tsumiTarget: number | null
  /** full adapter の議論状態（strategy-only では不使用） */
  discussionState: DiscussionState | null
}

/** FenrirExt の初期値を生成 */
export function createFenrirExt(): FenrirExt {
  return {
    planState: {
      slots: [],
      endgameSlots: [],
      initialNooseCount: 0,
      mlMasonSeat: null,
      masonTakeoverDone: false,
    },
    executionPlans: [],
    planIndices: new Array(NUM_PLAN_TOKENS).fill(PLAN_VOCAB.STOP),
    retarCache: null,
    tsumiCache: new Map(),
    tsumiTarget: null,
    discussionState: null,
  }
}
