export type EnumSpecies = null | "human" | "wolf"

export type EnumCauseOfDeath =
  | null
  | "execution"
  | "night_kill"
  | "follow_executed_hamster"
  | "follow_killed_hamster"
  | "cursed_by_executed_nekomata"
  | "cursed_by_killed_nekomata"

export type EnumEventType =
  | "begin"
  | "vote"
  | "runoff"
  | "assert"
  | "claim"
  | "surrender"
  | "acted"
  | "killed"
  | "executed"
  | "morning"
  | "end"
  | "werewolf_won"
  | "villager_won"
  | "werehamster_won"
  | "draw"

export type EnumRoleAlignment = "villager" | "werewolf" | "werehamster"

export type EnumRoleCategory =
  | "villager"
  | "seer"
  | "medium"
  | "bodyguard"
  | "mason"
  | "werewolf"
  | "possessed"
  | "werehamster"
  | "fanatic"
  | "immoralist"
  | "other"

export type VillageEvent = {
  villageId: number
  prevId: number | null
  type: EnumEventType
  actor?: number | null
  day?: number | null
  role?: number | null
  target?: number | null
  targetWas?: EnumSpecies
  meta?: {
    [key: string]: string | undefined
  }
}

export type VillageEventWithID = VillageEvent & { id: number }

export type Role = {
  name: string
  shortName: string
  systemName: string
  description: string
  alignment: EnumRoleAlignment
  category: EnumRoleCategory
  humanCount: number
  wolfCount: number
  seerResult: EnumSpecies
  mediumResult: EnumSpecies
}

export type RoleCreateInput = Role
