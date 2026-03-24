import type { SystemRole } from '../types/index.ts'
import type { GameState, PlayerState, NightAction, DayClaim, GameEvent } from './types.ts'
import type { Signal, SignalRecord } from './communication.ts'
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
  /** 人外向け: 占いCOした場合のRetar分析結果（enableRetar時、未CO人外にのみ注入） */
  retarWhatIfPossibilities: Map<number, Set<SystemRole>> | null
}

/** プラガブルな戦略インターフェース */
export type Strategy = {
  decideNightAction(ctx: DecisionContext): NightAction
  decideDayClaim(ctx: DecisionContext): DayClaim
  decideForecast(ctx: DecisionContext): DayClaim
  decideVote(ctx: DecisionContext): number
  decideCommunication(ctx: DecisionContext): Signal
  decideProposal(ctx: DecisionContext): Proposal | null
  decideLeadershipResponse(ctx: DecisionContext, proposal: Proposal): LeadershipResponse
}
