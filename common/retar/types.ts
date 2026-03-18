/**
 * Self-contained type definitions for the retar module.
 * These types were extracted from external dependencies (Prisma, OpenAPI, village.ts)
 * to make retar independently portable.
 */

export type SystemRole = 'werewolf' | 'possessed' | 'fanatic' | 'werehamster' | 'immoralist' | 'villager' | 'seer' | 'medium' | 'bodyguard' | 'mason' | 'nekomata'

export type EnumSpecies = 'human' | 'wolf' | null

export type CauseOfDeath =
  | 'execution'
  | 'night_kill'
  | 'follow_executed_hamster'
  | 'follow_killed_hamster'
  | 'cursed_by_executed_nekomata'
  | 'cursed_by_killed_nekomata'

export type VillageResult = 'werewolf_won' | 'villager_won' | 'werehamster_won' | 'draw' | undefined

export type PlayerAction = Map<number, number>
export type Assertions = Map<number, EnumSpecies>

export type Role = {
  name: string
  shortName: string
  systemName?: string | null
  description: string
  alignment: 'villager' | 'werewolf' | 'werehamster'
  category: 'villager' | 'seer' | 'medium' | 'bodyguard' | 'mason' | 'werewolf' | 'possessed' | 'werehamster' | 'fanatic' | 'other'
  humanCount: number
  wolfCount: number
  seerResult: EnumSpecies
  mediumResult: EnumSpecies
}

export type SeatStatus = {
  surviving: boolean
  causeOfDeath: CauseOfDeath
  survivedDays: number
  diedDay?: number
  voted: boolean
  claiming: boolean
  claimedAt?: number
  claimingRole: string
  claimingRoleID?: number
  votedCount: number
  votedTarget: number
  actions: PlayerAction
  assertions: Assertions
}

export type VillageStatus = {
  statuses: Map<number, SeatStatus>
  executions: Map<number, number[]>
  kills: Map<number, number[]>
  roles: Map<number, Role | SystemRole>
  claims: Map<number | SystemRole, number[]>
  day: number
  finished: boolean
  result: VillageResult
}
