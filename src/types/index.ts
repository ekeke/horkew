export type Seat = number
export type Day = number

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
export type Assertion = { target: Seat, species: EnumSpecies }
export type Assertions = Map<Day, Assertion>

export type Role = {
  name: string
  shortName: string
  systemName: string
  description: string
  alignment: 'villager' | 'werewolf' | 'werehamster'
  category: 'villager' | 'seer' | 'medium' | 'bodyguard' | 'mason' | 'werewolf' | 'possessed' | 'werehamster' | 'fanatic' | 'immoralist' | 'other'
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
  claimOrder?: number
  claimingRole: string
  deniedRoles: SystemRole[]
  votedCount: number
  votedTarget: number
  votedOrder: number
  actions: PlayerAction
  assertions: Assertions
}

export type VoteRecord = { voter: Seat, target: Seat }

export type VillageStatus = {
  statuses: Map<number, SeatStatus>
  executions: Map<number, number[]>
  kills: Map<number, number[]>
  roles: Map<number, Role | SystemRole>
  claims: Map<number | SystemRole, number[]>
  voteHistory: Map<Day, VoteRecord[]>
  day: number
  finished: boolean
  result: VillageResult
}

export const systemRoles: Map<SystemRole, Role> = new Map([
  ["villager", {
    name: "村人", shortName: "村", systemName: "villager",
    alignment: "villager", category: "villager",
    description: "能力を持たない村人",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
  }],
  ["seer", {
    name: "占い師", shortName: "占", systemName: "seer",
    alignment: "villager", category: "seer",
    description: "毎晩、生存者から一人を選び人狼かどうかを知ることができる",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
  }],
  ["medium", {
    name: "霊能者", shortName: "霊", systemName: "medium",
    alignment: "villager", category: "medium",
    description: "毎晩、前日に処刑された人物が人狼かどうかを知ることができる",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
  }],
  ["bodyguard", {
    name: "狩人", shortName: "狩", systemName: "bodyguard",
    alignment: "villager", category: "bodyguard",
    description: "毎晩、生存者から一人を選び人狼の襲撃から守ることができる",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
  }],
  ["mason", {
    name: "共有者", shortName: "共", systemName: "mason",
    alignment: "villager", category: "mason",
    description: "特別な能力はないが、最初から他の共有者を知っている",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
  }],
  ["nekomata", {
    name: "猫又", shortName: "猫", systemName: "nekomata",
    alignment: "villager", category: "other",
    description: "処刑されると、生存者の一人をランダムに道連れにする\n人狼に襲撃されると、人狼を道連れにする",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
  }],
  ["werewolf", {
    name: "人狼", shortName: "狼", systemName: "werewolf",
    alignment: "werewolf", category: "werewolf",
    description: "夜に生存者から一人を選んで食べる\n人狼は他の人狼を知っている",
    humanCount: 0, wolfCount: 1, seerResult: "wolf", mediumResult: "wolf",
  }],
  ["possessed", {
    name: "狂人", shortName: "狂", systemName: "possessed",
    alignment: "werewolf", category: "possessed",
    description: "能力を持たない村人だが、人狼の味方をする",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
  }],
  ["fanatic", {
    name: "狂信者", shortName: "信", systemName: "fanatic",
    alignment: "werewolf", category: "possessed",
    description: "能力を持たない村人だが、人狼の味方をする\n最初から人狼が誰かを知っている",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
  }],
  ["werehamster", {
    name: "妖狐", shortName: "狐", systemName: "werehamster",
    alignment: "werehamster", category: "werehamster",
    description: "人狼と村人の戦いが終わったときに生存していると勝利する\n多数決の判定の際には無視される\n人狼に襲撃されても死なない\n占い師に占われると死亡する",
    humanCount: 0, wolfCount: 0, seerResult: "human", mediumResult: "human",
  }],
  ["immoralist", {
    name: "背徳者", shortName: "背", systemName: "immoralist",
    alignment: "werehamster", category: "immoralist",
    description: "特別な能力はない村人だが、妖狐の味方をする",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
  }],
])
