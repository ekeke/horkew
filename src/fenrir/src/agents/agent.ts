/**
 * Agent / TeamAgent インターフェース
 *
 * 旧 Strategy / TeamStrategy をリネーム。
 * 意思決定の型定義（DecisionContext, ExecutionPlan 等）もここに集約。
 */

import type { SystemRole, ResolvedRules } from '../../../types/index.ts'
import type { GameState, PlayerState, NightAction, DayClaim } from '../../../lupa/types.ts'
import type { SignalRecord, CommunicationAction } from '../communication.ts'
import type { Proposal, LeadershipResponse } from '../leadership.ts'
import type { Rng } from '../../../lupa/random.ts'

// ============================================================
// 意思決定コンテキスト
// ============================================================

/** エージェントに渡される意思決定コンテキスト */
export type DecisionContext = {
  mySeat: number
  myRole: SystemRole
  myPlayer: PlayerState
  day: number
  phase: 'night' | 'day'
  alivePlayers: number[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GameEvent | FenrirExtEvent
  publicEvents: readonly any[]
  signals: SignalRecord[]
  commander: number | null
  proposals: Proposal[]
  rng: Rng
  /** ヒューリスティック用: 完全なゲーム状態（MLは無視すべき） */
  gameState: GameState
  lastExecutedSeat: number | null
  /** Retarの分析結果（enableRetar時にアダプターが注入、それ以外はnull） */
  retarPossibilities: Map<number, Set<SystemRole>> | null
  /** Retarの最大生存人外数（縄余裕の計算に使用、Retar無効時は null） */
  maxSurvivingNV: number | null
  /** グローバルRetar: 公開情報のみから計算した可能性 (enableRetar時にアダプターが注入) */
  globalRetarPossibilities: Map<number, Set<SystemRole>> | null
  /** 人狼 → 他の人狼のseat一覧 (人狼以外はnull) */
  wolfTeammates: number[] | null
  /** 狂信者 → 人狼のseat一覧 (狂信者以外はnull) */
  knownWolves: number[] | null
  /** 背徳者 → 妖狐のseat (背徳者以外はnull) */
  knownHamster: number | null
  /** 共有者 → 相方のseat (共有者以外はnull) */
  masonPartner: number | null
  /** 再投票ラウンド (0=初回投票, 1=再投票1回目, ...; 投票フェーズ以外はnull) */
  revoteRound: number | null
  /** 再投票時の候補者seat一覧 (初回投票 or 投票フェーズ以外はnull) */
  revoteCandidates: number[] | null
  /** 処刑プラン (空配列 = プランなし) */
  executionPlans: ExecutionPlan[]
  /** NN が出力した raw plan token indices (unified 12 tokens) */
  planIndices: number[] | null
  /** 詰み探索: 今日処刑すべき席 (詰みなし or 探索失敗時は null) */
  tsumiTarget: number | null
  /** ゲームルール */
  rules: ResolvedRules
}

// ============================================================
// 処刑プラン
// ============================================================

/** 処刑プランの種別 */
export type PlanType = 'roller' | 'decision' | 'designated' | 'grayran' | 'endgame'

/** 処刑プラン（NNのobservationに注入） */
export type ExecutionPlan = {
  /** 処刑対象の席番号列 (1-indexed, 順序が処刑順)。endgameの場合は候補集合 */
  targets: number[]
  /** プラン種別 */
  type: PlanType
}

// ============================================================
// Agent（個人エージェント）
// ============================================================

/** プラガブルなエージェン��インターフェース (個人) */
export type Agent = {
  decideNightAction(ctx: DecisionContext): NightAction
  decideDayClaim(ctx: DecisionContext): DayClaim
  decideForecast(ctx: DecisionContext): DayClaim
  decideVote(ctx: DecisionContext): number
  decideCommunication(ctx: DecisionContext): CommunicationAction
  decideProposal(ctx: DecisionContext): Proposal | null
  decideLeadershipResponse(ctx: DecisionContext, proposal: Proposal): LeadershipResponse
  /** 提案後・投票前の防御CO（処刑提案されている場合に反応） */
  decideDefensiveClaim(ctx: DecisionContext): DayClaim
}

// ============================================================
// TeamAgent（チームエージェント）
// ============================================================

/** チーム意思決定コンテキスト */
export type TeamDecisionContext = DecisionContext & {
  /** チームメンバーのseat一覧 */
  teamSeats: number[]
  /** チームメンバーの状態 */
  teamPlayers: PlayerState[]
  /** 昼行動時、今誰の番か */
  currentActorSeat?: number
}

/** 狼チームの夜行動 */
export type WolfNightAction = {
  /** 襲撃先 */
  target: number
  /** 襲撃者 (猫又道連れリスク者) */
  attacker: number
}

/** チームエージェントインターフェース */
export type TeamAgent = {
  /** 狼チーム夜行動: 襲撃先 + 襲撃者を選択 */
  decideNightAction(ctx: TeamDecisionContext): WolfNightAction | NightAction
  /** 昼CO (currentActorSeat のプレイヤー分) */
  decideDayClaim(ctx: TeamDecisionContext): DayClaim
  /** 予告 (currentActorSeat のプレイヤー分) */
  decideForecast(ctx: TeamDecisionContext): DayClaim
  /** 投票 (currentActorSeat のプレイヤー分) */
  decideVote(ctx: TeamDecisionContext): number
  /** コミュニケーション (currentActorSeat のプレイヤー分) */
  decideCommunication(ctx: TeamDecisionContext): CommunicationAction
  /** 指揮者提案 */
  decideProposal(ctx: TeamDecisionContext): Proposal | null
  /** 指揮者への応答 */
  decideLeadershipResponse(ctx: TeamDecisionContext, proposal: Proposal): LeadershipResponse
  /** 提案後・投票前の防御CO */
  decideDefensiveClaim(ctx: TeamDecisionContext): DayClaim
}

// ============================================================
// 非同期エージェント（対話型CLI等）
// ============================================================

type MaybePromise<T> = T | Promise<T>

/** 非同期対応のエージェントインターフェース — Agent の上位互換 */
export type AsyncAgent = {
  decideNightAction(ctx: DecisionContext): MaybePromise<NightAction>
  decideDayClaim(ctx: DecisionContext): MaybePromise<DayClaim>
  decideForecast(ctx: DecisionContext): MaybePromise<DayClaim>
  decideVote(ctx: DecisionContext): MaybePromise<number>
  decideCommunication(ctx: DecisionContext): MaybePromise<CommunicationAction>
  decideProposal(ctx: DecisionContext): MaybePromise<Proposal | null>
  decideLeadershipResponse(ctx: DecisionContext, proposal: Proposal): MaybePromise<LeadershipResponse>
  decideDefensiveClaim(ctx: DecisionContext): MaybePromise<DayClaim>
}

/** 非同期対応のチームエージェントインターフェース */
export type AsyncTeamAgent = {
  decideNightAction(ctx: TeamDecisionContext): MaybePromise<WolfNightAction | NightAction>
  decideDayClaim(ctx: TeamDecisionContext): MaybePromise<DayClaim>
  decideForecast(ctx: TeamDecisionContext): MaybePromise<DayClaim>
  decideVote(ctx: TeamDecisionContext): MaybePromise<number>
  decideCommunication(ctx: TeamDecisionContext): MaybePromise<CommunicationAction>
  decideProposal(ctx: TeamDecisionContext): MaybePromise<Proposal | null>
  decideLeadershipResponse(ctx: TeamDecisionContext, proposal: Proposal): MaybePromise<LeadershipResponse>
  decideDefensiveClaim(ctx: TeamDecisionContext): MaybePromise<DayClaim>
}
