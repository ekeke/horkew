import type { EnumCauseOfDeath, EnumSpecies, VillageEventWithID, Role as VillageRole, RoleCreateInput } from './village.d'
type CauseOfDeath = EnumCauseOfDeath
export type PlayerAction = Map<number, number>
export type Assertions = Map<number, EnumSpecies>
export type VillageEvent = VillageEventWithID
export type Role = VillageRole
export type SystemRole = 'werewolf' | 'possessed' | 'fanatic' | 'werehamster' | 'immoralist' | 'villager' | 'seer' | 'medium' | 'bodyguard' | 'mason' | 'nekomata'
export type VillageResult = 'werewolf_won' | 'villager_won' | 'werehamster_won' | 'draw' | undefined
export const systemRoles: Map<SystemRole, RoleCreateInput> = new Map([
  [
    "villager",
    {
      name: "村人",
      shortName: "村",
      systemName: "villager",
      alignment: "villager",
      category: "villager",
      description: `能力を持たない村人`,
      humanCount: 1,
      wolfCount: 0,
      seerResult: "human",
      mediumResult: "human",
    }
  ],
  [
    "seer",
    {
      name: "占い師",
      shortName: "占",
      systemName: "seer",
      alignment: "villager",
      category: "seer",
      description: `毎晩、生存者から一人を選び人狼かどうかを知ることができる`,
      humanCount: 1,
      wolfCount: 0,
      seerResult: "human",
      mediumResult: "human",
    }
  ],
  [
    "medium",
    {
      name: "霊能者",
      shortName: "霊",
      systemName: "medium",
      alignment: "villager",
      category: "medium",
      description: `毎晩、前日に処刑された人物が人狼かどうかを知ることができる`,
      humanCount: 1,
      wolfCount: 0,
      seerResult: "human",
      mediumResult: "human",
    }
  ],
  [
    "bodyguard",
    {
      name: "狩人",
      shortName: "狩",
      systemName: "bodyguard",
      alignment: "villager",
      category: "bodyguard",
      description: `毎晩、生存者から一人を選び人狼の襲撃から守ることができる`,
      humanCount: 1,
      wolfCount: 0,
      seerResult: "human",
      mediumResult: "human",
    }
  ],
  [
    "mason",
    {
      name: "共有者",
      shortName: "共",
      systemName: "mason",
      alignment: "villager",
      category: "mason",
      description: `特別な能力はないが、最初から他の共有者を知っている`,
      humanCount: 1,
      wolfCount: 0,
      seerResult: "human",
      mediumResult: "human",
    }
  ],
  [
    "nekomata",
    {
      name: "猫又",
      shortName: "猫",
      systemName: "nekomata",
      alignment: "villager",
      category: "other",
      description: `処刑されると、生存者の一人をランダムに道連れにする
人狼に襲撃されると、人狼を道連れにする`,
      humanCount: 1,
      wolfCount: 0,
      seerResult: "human",
      mediumResult: "human",
    }
  ],
  [
    "werewolf",
    {
      name: "人狼",
      shortName: "狼",
      systemName: "werewolf",
      alignment: "werewolf",
      category: "werewolf",
      description: `夜に生存者から一人を選んで食べる
人狼は他の人狼を知っている`,
      humanCount: 0,
      wolfCount: 1,
      seerResult: "wolf",
      mediumResult: "wolf",
    }
  ],
  [
    "possessed",
    {
      name: "狂人",
      shortName: "狂",
      systemName: "possessed",
      alignment: "werewolf",
      category: "possessed",
      description: `能力を持たない村人だが、人狼の味方をする`,
      humanCount: 1,
      wolfCount: 0,
      seerResult: "human",
      mediumResult: "human",
    }
  ],
  [
    "fanatic",
    {
      name: "狂信者",
      shortName: "信",
      systemName: "fanatic",
      alignment: "werewolf",
      category: "possessed",
      description: `能力を持たない村人だが、人狼の味方をする
最初から人狼が誰かを知っている`,
      humanCount: 1,
      wolfCount: 0,
      seerResult: "human",
      mediumResult: "human",
    }
  ],
  [
    "werehamster",
    {
      name: "妖狐",
      shortName: "狐",
      systemName: "werehamster",
      alignment: "werehamster",
      category: "werehamster",
      description: `人狼と村人の戦いが終わったときに生存していると勝利する
多数決の判定の際には無視される
人狼に襲撃されても死なない
占い師に占われると死亡する`,
      humanCount: 0,
      wolfCount: 0,
      seerResult: "human",
      mediumResult: "human",
    }
  ],
  [
    "immoralist",
    {
      name: "背徳者",
      shortName: "背",
      systemName: "immoralist",
      alignment: "werehamster",
      category: "immoralist",
      description: `特別な能力はない村人だが、妖狐の味方をする`,
      humanCount: 1,
      wolfCount: 0,
      seerResult: "human",
      mediumResult: "human",
    }
  ],
])

type Day = number
type Seat = number

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

function createStatus(): SeatStatus {
  return {
    surviving: true,
    causeOfDeath: 'execution',
    survivedDays: 0,
    diedDay: undefined,
    voted: false,
    claiming: false,
    claimingRole: 'none',
    votedCount: 0,
    votedTarget: -1,
    actions: new Map(),
    assertions: new Map()
  }
}

export type VillageStatus = {
  statuses: StatusMap,
  executions: Map<Day, number[]>,
  kills: Map<Day, number[]>,
  roles: Map<Seat, Role | SystemRole>,
  claims: Map<number | SystemRole , Seat[]>,
  day: Day,
  finished: boolean
  result: VillageResult
}


type StatusMap = Map<number, SeatStatus>

type Updaters = {
  [key in VillageEvent["type"]]: (event: VillageEvent, vs: VillageStatus) => void
}

const updaters: Updaters = {
  begin: (event, vs) => {
  },
  vote: (event, vs) => {
    if (!event.actor) throw new Error('actor is empty')
    const actor = vs.statuses.get(event.actor)
    if (!actor) throw new Error('actor is empty')
    actor.voted = true
    if ('number' !== typeof event.target) throw new Error("Invalid target")
    const target = vs.statuses.get(event.target || -1)
    if (!target) throw new Error('target is empty')
    target.votedCount++
    actor.votedTarget = event.target
  },
  runoff: (event, vs) => {
    for (const state of vs.statuses.values()) {
      state.voted = false
      state.votedCount = 0
      state.votedTarget = -1
    }
  },
  assert: (event, vs) => {
    if (!event.actor) throw new Error('actor is missing')
    const state = vs.statuses.get(event.actor)
    if (!state) throw new Error('No state found')
    if (!event.target || 'number' !== typeof event.target) throw new Error('Invalid target')
    if (!event.targetWas) throw new Error('Invalid targetWas')
    if (event.targetWas !== 'human' && event.targetWas !== 'wolf') throw new Error('Invalid targetWas')
    state.assertions.set(event.target, event.targetWas)

  },
  claim: (event, vs) => {
    if (!event.actor) throw new Error('actor is required')
    const state = vs.statuses.get(event.actor)
    if (!state) throw new Error('state is required')
    state.claiming = true
    const role = vs.roles.get(event.role || -1)
    if ( 'string' === typeof role ) {
      state.claimingRole = role
    }
    else {
      state.claimingRole = role ? role.systemName || role.shortName : 'unknown'
    }
    state.claimingRoleID = event.role
    state.claimedAt = vs.day
    state.actions = new Map()
    state.assertions = new Map()
  },
  surrender: (event, vs) => {
    if (!event.actor) throw new Error('actor is required')
    const state = vs.statuses.get(event.actor)
    if (!state) throw new Error('state is required')
    state.claiming = true
    state.claimingRole = 'surrender'
    state.claimingRoleID = -1
    state.claimedAt = vs.day
  },
  acted: (event, vs) => {
    if (!event.actor) throw new Error('actor is missing')
    const state = vs.statuses.get(event.actor)
    if (!state) throw new Error('No state found')
    if ('number' !== typeof event.day) throw new Error('Invalid day')
    if (!event.target || 'number' !== typeof event.target) throw new Error('Invalid target')
    state.actions.set(event.day, event.target)
  },
  killed: (event, vs) => {
    if (!event.target) throw new Error('target is required')
    const state = vs.statuses.get(event.target)
    if (!state) throw new Error('state is required')
    state.surviving = false
    const causeOfDeath = event.meta?.causeOfDeath
    if ( causeOfDeath === 'follow_killed_hamster' || causeOfDeath === 'cursed_by_killed_nekomata' ) {
      state.causeOfDeath = causeOfDeath
    }
    else {
      state.causeOfDeath = 'night_kill'
    }
    const currentKills = vs.kills.get(vs.day - 1) || []
    currentKills.push(event.target)
    state.diedDay = vs.day - 1 // 朝に報告されたので前日死亡とする
    vs.kills.set(vs.day - 1, currentKills)
  },
  executed: (event, vs) => {
    if (!event.target) throw new Error('target is required')
    const state = vs.statuses.get(event.target)
    if (!state) throw new Error(`state is missing`)
    state.surviving = false
    state.diedDay = vs.day
    const causeOfDeath = event.meta?.causeOfDeath
    if ( causeOfDeath === 'follow_executed_hamster' || causeOfDeath === 'cursed_by_executed_nekomata' ) {
      state.causeOfDeath = causeOfDeath
    }
    else {
      state.causeOfDeath = 'execution'
    }
    const currentExecution = vs.executions.get(vs.day) || []
    currentExecution.push(event.target)
    vs.executions.set(vs.day, currentExecution)
  },
  morning: (_event, vs) => {
    vs.day++
    for (const state of vs.statuses.values()) {
      if ( !state.surviving ) state.survivedDays++
      state.voted = false
      state.votedCount = 0
      state.votedTarget = -1
    }
  },
  end: (event, vs) => {
    vs.finished = true
  },
  werewolf_won: (event, vs) => {
    vs.result = 'werewolf_won'
    vs.finished = true
  },
  villager_won: (event, vs) => {
    vs.result = 'villager_won'
    vs.finished = true
  },
  werehamster_won: (event, vs) => {
    vs.result = 'werehamster_won'
    vs.finished = true
  },
  draw: (event, vs) => {
    vs.result = 'draw'
    vs.finished = true
  },
}

export type CreateVillageStatusOptions = {
  seats: number[],
  beginningDay: number,
  events: VillageEvent[],
  stop?: (event: VillageEvent) => boolean,
  each? (event: VillageEvent, vs: VillageStatus): void,
  roles: Map<number, Role | SystemRole>,
}

export function createVillageStatusFromEvents(options: CreateVillageStatusOptions) {
  const vs: VillageStatus = {
    statuses: new Map(options.seats.map(seat => [seat, createStatus()])),
    executions: new Map(),
    kills: new Map(),
    roles: options.roles,
    claims: new Map(),
    day: options.beginningDay,
    finished: false,
    result: undefined
  }
  for (const event of options.events) {
    updaters[event.type](event, vs)
    if (options.each) options.each(event, vs)
    if (options.stop && options.stop(event) ) break
  }
  const claims = new Map<number, Seat[]>()
  for (const [seat, status] of vs.statuses) {
    if (!status.claiming) continue
    const role = status.claimingRoleID
    if ( !claims.has(role) ) claims.set(role, [])
    claims.get(role).push(seat)
  }
  vs.claims = new Map(Array.from(claims.entries()).sort(([a], [b]) => a - b))
  console.log({vs})
  return vs
}
