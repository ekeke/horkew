import type { SystemRole, EnumSpecies } from '../types/index.ts'

export type LupaConfig = {
  roles: Map<SystemRole, number>
  seed?: number
  verify?: boolean
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
}

export type GameState = {
  players: PlayerState[]
  day: number
  phase: 'night' | 'day'
  finished: boolean
  result: 'villager_won' | 'werewolf_won' | 'werehamster_won' | null
}

export type GameEvent =
  | { type: 'night_kill', target: number }
  | { type: 'fox_kill', target: number }
  | { type: 'peace' }
  | { type: 'seer_claim', actor: number, results: Array<{ target: number, result: EnumSpecies }> }
  | { type: 'seer_result', actor: number, target: number, result: EnumSpecies }
  | { type: 'medium_claim', actor: number }
  | { type: 'medium_result', actor: number, result: EnumSpecies }
  | { type: 'vote', voter: number, target: number }
  | { type: 'execution', target: number }
  | { type: 'game_over', result: 'villager_won' | 'werewolf_won' | 'werehamster_won' }
  | { type: 'reveal', seat: number, role: SystemRole }
