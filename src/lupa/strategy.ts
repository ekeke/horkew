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
