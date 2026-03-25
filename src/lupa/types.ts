import type { SystemRole, EnumSpecies } from '../types/index.ts'
import type { Strategy, TeamStrategy } from './strategy.ts'
import type { Signal, RolePrediction } from './communication.ts'

export type LupaConfig = {
  roles: Map<SystemRole, number>
  seed?: number
  verify?: boolean
  useRandomNames?: boolean
  hasFirstGhost?: boolean
  /** プレイヤーごとの戦略（未指定はHeuristicStrategy） */
  strategies?: Map<number, Strategy>
  /** 狼チーム戦略 */
  wolfTeamStrategy?: TeamStrategy
  /** 共有者チーム戦略 */
  masonTeamStrategy?: TeamStrategy
  /** Retar論理推論を有効化（昼CO後に自動実行） */
  enableRetar?: boolean
  /** カスタムRetar実行関数（並列版等を注入する場合） */
  retarFn?: (events: GameEvent[], state: GameState, config: LupaConfig) => Promise<Map<number, Set<SystemRole>>>
  /** 再投票設定 (未指定時はデフォルト: 候補者限定ランダム、3回、最小seat処刑) */
  revoteConfig?: RevoteConfig
  /** 投票確定後のCO許可 (デフォルト: true) */
  allowPostVoteCO?: boolean
}

export type RevoteConfig = {
  /** 最大再投票回数 (デフォルト: 3) */
  maxRevotes: number
  /** 再投票方式: 'random_tied' = 候補者限定ランダム(現行), 'full_revote' = 全員で完全やり直し */
  style: 'random_tied' | 'full_revote'
  /** 決着つかない場合: 'lowest_seat' = 最小seat処刑(現行), 'draw' = 引き分け終了 */
  tiebreaker: 'lowest_seat' | 'draw'
}

export type PlayerState = {
  seat: number
  name: string
  role: SystemRole
  alive: boolean
  claimedRole: SystemRole | null
  claimedDay: number | null
  // 占い師: 実際の占い結果
  divineHistory: Map<number, { target: number, result: EnumSpecies }>
  // 狩人: 護衛先
  guardHistory: Map<number, number>
  // 狂人: 偽占い結果
  fakeDivineHistory: Map<number, { target: number, result: EnumSpecies }>
  // 予告先（次の夜に占う対象）
  forecastTarget: number | null
}

export type GameState = {
  players: PlayerState[]
  day: number
  phase: 'night' | 'day'
  finished: boolean
  result: 'villager_won' | 'werewolf_won' | 'werehamster_won' | 'draw' | null
  /** 処刑履歴: day → seat */
  executionHistory: Map<number, number>
  /** 現在の指揮者 (seat) */
  commander: number | null
  /** 共有CO時のpartner記録: seat → partnerSeat */
  masonPartners?: Map<number, number>
}

export type NightAction =
  | { type: 'divine', target: number }
  | { type: 'guard', target: number }
  | { type: 'attack', target: number }
  | { type: 'none' }

export type DayClaim =
  | { type: 'seer_co', results: Array<{ target: number, result: EnumSpecies }> }
  | { type: 'seer_result', target: number, result: EnumSpecies }
  | { type: 'medium_co', pastResults?: EnumSpecies[] }
  | { type: 'medium_result', result: EnumSpecies }
  | { type: 'bodyguard_co', targets: number[] }
  | { type: 'mason_co', partner: number }
  | { type: 'nekomata_co' }
  | { type: 'forecast', target: number }
  | { type: 'none' }

export type GameEvent =
  | { type: 'night_kill', target: number }
  | { type: 'fox_kill', target: number }
  | { type: 'peace' }
  | { type: 'seer_claim', actor: number, results: Array<{ target: number, result: EnumSpecies }> }
  | { type: 'seer_result', actor: number, target: number, result: EnumSpecies }
  | { type: 'medium_claim', actor: number, pastResults?: EnumSpecies[] }
  | { type: 'medium_result', actor: number, result: EnumSpecies }
  | { type: 'bodyguard_claim', actor: number, targets: number[] }
  | { type: 'mason_claim', actor: number, partner: number }
  | { type: 'nekomata_claim', actor: number }
  | { type: 'forecast', actor: number, target: number }
  | { type: 'curse_kill', target: number }
  | { type: 'follow_kill', target: number }
  | { type: 'vote', voter: number, target: number }
  | { type: 'revote', targets: number[] }
  | { type: 'grelan' }
  | { type: 'execution', target: number }
  | { type: 'comment', text: string }
  | { type: 'game_over', result: 'villager_won' | 'werewolf_won' | 'werehamster_won' | 'draw' }
  | { type: 'reveal', seat: number, role: SystemRole }
  | { type: 'signal', actor: number, signal: Signal }
  | { type: 'wolf_claim', actor: number, claimedRole: SystemRole }
  | { type: 'execute_proposals', actor: number, targets: number[] }
  | { type: 'prediction', actor: number, predictions: RolePrediction }
  | { type: 'commander_appointed', seat: number }
  | { type: 'proposal', actor: number, proposal: import('./leadership.ts').Proposal }
  | { type: 'leadership_response', actor: number, response: import('./leadership.ts').LeadershipResponse }
