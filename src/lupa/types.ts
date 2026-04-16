import type { SystemRole, EnumSpecies, ResolvedRules } from '../types/index.ts'
import type { Agent, TeamAgent, AgentBase, TeamDecisionContext } from '../fenrir/src/agents/agent.ts'

export type LupaConfig = {
  roles: Map<SystemRole, number>
  seed?: number
  verify?: boolean
  useRandomNames?: boolean
  hasFirstGhost?: boolean
  /** プレイヤーごとのエージェント（未指定はdefaultAgent、それも未指定ならRandomAgent） */
  agents?: Map<number, Agent>
  /** agentsに未登録のseatに使うエージェント */
  defaultAgent?: Agent
  /** 役職割り当て後のコールバック（seat→roleマップを受け取り、agentsを動的に設定できる） */
  onRolesAssigned?: (seatRoles: Map<number, SystemRole>) => void
  /** 狼チームエージェント */
  wolfTeamAgent?: TeamAgent
  /** 共有者チームエージェント */
  masonTeamAgent?: TeamAgent
  /** Retar論理推論（デフォルトON、falseで無効化） */
  enableRetar?: boolean
  /** カスタムRetar実行関数（並列版等を注入する場合） */
  retarFn?: (events: GameEvent[], state: GameState, config: LupaConfig) => Promise<Map<number, Set<SystemRole>>>
  /** 再投票設定 (未指定時はデフォルト: 候補者限定ランダム、3回、最小seat処刑) */
  revoteConfig?: RevoteConfig
  /** 投票確定後のCO許可 = 遺言 (デフォルト: false) */
  allowPostVoteCO?: boolean
  /** 非同期エージェント (runGameAsync専用、対話型CLI等) */
  asyncAgents?: Map<number, AgentBase>
  /** asyncAgentsに未登録のseatに使う非同期エージェント */
  defaultAsyncAgent?: AgentBase
  /** 非同期狼チームエージェント */
  asyncWolfTeamAgent?: AgentBase<TeamDecisionContext>
  /** 非同期共有者チームエージェント */
  asyncMasonTeamAgent?: AgentBase<TeamDecisionContext>
  /** オプションルール（未指定分はるる鯛14D猫デフォルト） */
  rules?: Partial<ResolvedRules>
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

export type GameState<Ext = unknown> = {
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
  /** Consumer定義の拡張データ。Lupaは中身に触らない。structuredCloneで自動複製される。 */
  ext: Ext
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

/** 中盤スナップショット（Seed Bank 用） */
export type GameSnapshot<E = never, Ext = unknown> = {
  state: GameState<Ext>
  events: (GameEvent | E)[]
  rngState: number
  config: import('./handlers.ts').GameConfig
  seatRoles: Map<number, SystemRole>
}
