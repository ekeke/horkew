import type { SystemRole } from '../types/index.ts'
import type { GameState, PlayerState, NightAction, DayClaim, GameEvent } from './types.ts'
import type { SignalRecord, CommunicationAction } from './communication.ts'
import type { Proposal, LeadershipResponse } from './leadership.ts'
import type { Rng } from './random.ts'

/** エージェントに渡される意思決定コンテキスト */
export type DecisionContext = {
  mySeat: number
  myRole: SystemRole
  myPlayer: PlayerState
  day: number
  phase: 'night' | 'day'
  alivePlayers: number[]
  publicEvents: GameEvent[]
  signals: SignalRecord[]
  commander: number | null
  proposals: Proposal[]
  rng: Rng
  /** ヒューリスティック用: 完全なゲーム状態（MLは無視すべき） */
  gameState: GameState
  lastExecutedSeat: number | null
  /** Retarの分析結果（enableRetar時にエンジンが注入、それ以外はnull） */
  retarPossibilities: Map<number, Set<SystemRole>> | null
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
}

/** プラガブルな戦略インターフェース (個人エージェント) */
export type Strategy = {
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
// チームエージェント (狼チーム / 共有者チーム)
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

/** チーム戦略インターフェース */
export type TeamStrategy = {
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
// 非同期戦略 (対話型CLI等、人間の入力を待つ場合)
// ============================================================

type MaybePromise<T> = T | Promise<T>

/** 非同期対応の戦略インターフェース — Strategy の上位互換 */
export type AsyncStrategy = {
  decideNightAction(ctx: DecisionContext): MaybePromise<NightAction>
  decideDayClaim(ctx: DecisionContext): MaybePromise<DayClaim>
  decideForecast(ctx: DecisionContext): MaybePromise<DayClaim>
  decideVote(ctx: DecisionContext): MaybePromise<number>
  decideCommunication(ctx: DecisionContext): MaybePromise<CommunicationAction>
  decideProposal(ctx: DecisionContext): MaybePromise<Proposal | null>
  decideLeadershipResponse(ctx: DecisionContext, proposal: Proposal): MaybePromise<LeadershipResponse>
  decideDefensiveClaim(ctx: DecisionContext): MaybePromise<DayClaim>
}

/** 非同期対応のチーム戦略インターフェース */
export type AsyncTeamStrategy = {
  decideNightAction(ctx: TeamDecisionContext): MaybePromise<WolfNightAction | NightAction>
  decideDayClaim(ctx: TeamDecisionContext): MaybePromise<DayClaim>
  decideForecast(ctx: TeamDecisionContext): MaybePromise<DayClaim>
  decideVote(ctx: TeamDecisionContext): MaybePromise<number>
  decideCommunication(ctx: TeamDecisionContext): MaybePromise<CommunicationAction>
  decideProposal(ctx: TeamDecisionContext): MaybePromise<Proposal | null>
  decideLeadershipResponse(ctx: TeamDecisionContext, proposal: Proposal): MaybePromise<LeadershipResponse>
  decideDefensiveClaim(ctx: TeamDecisionContext): MaybePromise<DayClaim>
}
