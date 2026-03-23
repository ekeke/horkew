import type { SystemRole, EnumSpecies } from '../types/index.ts'

export type LupaConfig = {
  roles: Map<SystemRole, number>
  seed?: number
  verify?: boolean
  useRandomNames?: boolean
  hasFirstGhost?: boolean
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
  result: 'villager_won' | 'werewolf_won' | 'werehamster_won' | null
  /** 処刑履歴: day → seat */
  executionHistory: Map<number, number>
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
  | { type: 'medium_claim', actor: number }
  | { type: 'medium_result', actor: number, result: EnumSpecies }
  | { type: 'bodyguard_claim', actor: number, targets: number[] }
  | { type: 'mason_claim', actor: number, partner: number }
  | { type: 'nekomata_claim', actor: number }
  | { type: 'forecast', actor: number, target: number }
  | { type: 'curse_kill', target: number }
  | { type: 'follow_kill', target: number }
  | { type: 'vote', voter: number, target: number }
  | { type: 'revote', targets: number[] }
  | { type: 'execution', target: number }
  | { type: 'comment', text: string }
  | { type: 'game_over', result: 'villager_won' | 'werewolf_won' | 'werehamster_won' }
  | { type: 'reveal', seat: number, role: SystemRole }
