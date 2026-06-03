export type Seat = number
export type Day = number

export type SystemRole = 'werewolf' | 'possessed' | 'fanatic' | 'werehamster' | 'immoralist' | 'villager' | 'seer' | 'medium' | 'bodyguard' | 'mason' | 'nekomata' | 'paparazzi' | 'kogitsune'

export type EnumSpecies = 'human' | 'wolf' | 'kogitsune' | null

export type Faction = 'village' | 'wolf' | 'fox'

/** 襲撃免疫: 人狼に噛まれても死なない (妖狐) */
export type AttackImmuneTrait = { kind: 'passive', sub: 'attack-immune' }

/** 呪殺: 占い師に占われると死ぬ (妖狐) */
export type DieWhenDivinedTrait = { kind: 'passive', sub: 'die-when-divined' }

/** 妖狐としての存在を仲間 (know-foxes 持ち) に認識される (妖狐のみ) */
export type VisibleAsFoxTrait = { kind: 'passive', sub: 'visible-as-fox' }

/** 狐陣営勝利カウント担当 (妖狐 + 子狐) */
export type FoxWinCounterTrait = { kind: 'passive', sub: 'fox-win-counter' }

/** 仲間の人狼を最初から知っている (人狼 / 狂信者) */
export type KnowWerewolvesTrait = { kind: 'knowledge', sub: 'know-werewolves' }

/** 仲間の妖狐を最初から知っている (背徳者) */
export type KnowFoxesTrait = { kind: 'knowledge', sub: 'know-foxes' }

/** 仲間の共有者を最初から知っている (共有者) */
export type KnowMasonsTrait = { kind: 'knowledge', sub: 'know-masons' }

/** 占い: 夜に一人を選んで人狼か否かを知る (占い師 / パパラッチ) */
export type DivineTrait = { kind: 'action', sub: 'divine' }

/** 不完全占い: 夜に一人を選び 50% 確率で結果を得る、 呪殺能力なし (子狐) */
export type DivineImperfectTrait = { kind: 'action', sub: 'divine-imperfect' }

/** 護衛: 夜に一人を選んで人狼の襲撃から守る (狩人) */
export type GuardTrait = { kind: 'action', sub: 'guard' }

/** 襲撃: 夜に一人を選んで噛む (人狼) */
export type AttackTrait = { kind: 'action', sub: 'attack' }

/** 処刑道連れ: 処刑されると生存者一人をランダムに道連れにする (猫又) */
export type CurseOnExecutedTrait = { kind: 'reactive', sub: 'curse-on-executed' }

/** 襲撃道連れ: 人狼に襲撃されると襲撃した人狼を道連れにする (猫又) */
export type CurseOnKilledTrait = { kind: 'reactive', sub: 'curse-on-killed' }

/** 妖狐後追い: 妖狐が全滅すると後追いで死亡する (背徳者) */
export type FollowFoxDeathTrait = { kind: 'reactive', sub: 'follow-fox-death' }

/** 霊媒: 処刑された人物が人狼かどうかを知る (霊能者) */
export type ExecutionSpeciesTrait = { kind: 'auto-info', sub: 'execution-species' }

/** 狼チャット: 夜に人狼同士で会話できる (人狼) */
export type WolfChatTrait = { kind: 'channel', sub: 'wolf-chat' }

export type RoleTrait =
  | AttackImmuneTrait
  | DieWhenDivinedTrait
  | VisibleAsFoxTrait
  | FoxWinCounterTrait
  | KnowWerewolvesTrait
  | KnowFoxesTrait
  | KnowMasonsTrait
  | DivineTrait
  | DivineImperfectTrait
  | GuardTrait
  | AttackTrait
  | CurseOnExecutedTrait
  | CurseOnKilledTrait
  | FollowFoxDeathTrait
  | ExecutionSpeciesTrait
  | WolfChatTrait

export type CauseOfDeath =
  | 'execution'
  | 'night_kill'
  | 'follow_executed_hamster'
  | 'follow_killed_hamster'
  | 'cursed_by_executed_nekomata'
  | 'cursed_by_killed_nekomata'
  | 'sudden_death'

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
  faction: Faction
  category: 'villager' | 'seer' | 'medium' | 'bodyguard' | 'mason' | 'werewolf' | 'possessed' | 'werehamster' | 'fanatic' | 'immoralist' | 'other'
  humanCount: number
  wolfCount: number
  seerResult: EnumSpecies
  mediumResult: EnumSpecies
  traits: RoleTrait[]
  /**
   * Howl パーサが入力中の役職トークンに match させる regex フラグメント。
   * anchor (^/$) は含めない (consumer 側で文脈に応じて付与)。
   * 必ず systemName を末尾選択肢として含める。
   * 例: seer = '(?:占い?師?|[預予]言?者?|seer)'
   *
   * prefix 衝突 (例: 狂人 vs 狂信者) は src/howl/vocabulary.ts の roleVocab()
   * 系 helper が name.length DESC ソートで解決する (長い名前を先に試す)。
   */
  howlPattern: string
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
  forecasts: Map<Day, Seat>
  noCoOpportunity?: boolean
  previousAssertions?: Map<Day, Assertion[]>
  previousClaims?: PreviousClaim[]
}

export type PreviousClaim = {
  role: string
  assertions: Assertions
  actions: PlayerAction
  forecasts: Map<Day, Seat>
  claimedAt?: number
  claimOrder?: number
  slidToRole: string
  slidDay: number
}

export type VoteRecord = { voter: Seat, target: Seat }

export type VillageStatus = {
  statuses: Map<number, SeatStatus>
  executions: Map<number, number[]>
  kills: Map<number, number[]>
  roles: Map<number, Role | SystemRole>
  claims: Map<number | SystemRole, number[]>
  voteHistory: Map<Day, VoteRecord[]>
  revoteTargets: Set<number>
  voteFinalRule: 'revote' | 'final'
  hasMultiVote: boolean
  multiVoteDays: Set<number>
  day: number
  finished: boolean
  result: VillageResult
}

export const systemRoles: Map<SystemRole, Role> = new Map([
  ["villager", {
    name: "村人", shortName: "村", systemName: "villager",
    alignment: "villager", faction: "village", category: "villager",
    description: "能力を持たない村人",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
    traits: [],
    howlPattern: "(?:村人?|villager)",
  }],
  ["seer", {
    name: "占い師", shortName: "占", systemName: "seer",
    alignment: "villager", faction: "village", category: "seer",
    description: "毎晩、生存者から一人を選び人狼かどうかを知ることができる",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
    traits: [{ kind: "action", sub: "divine" }],
    howlPattern: "(?:占い?師?|[預予]言?者?|seer)",
  }],
  ["medium", {
    name: "霊能者", shortName: "霊", systemName: "medium",
    alignment: "villager", faction: "village", category: "medium",
    description: "毎晩、前日に処刑された人物が人狼かどうかを知ることができる",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
    traits: [{ kind: "auto-info", sub: "execution-species" }],
    howlPattern: "(?:霊(?:媒師?|能者?|)|medium)",
  }],
  ["bodyguard", {
    name: "狩人", shortName: "狩", systemName: "bodyguard",
    alignment: "villager", faction: "village", category: "bodyguard",
    description: "毎晩、生存者から一人を選び人狼の襲撃から守ることができる",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
    traits: [{ kind: "action", sub: "guard" }],
    howlPattern: "(?:護(?:衛)?|狩(?:り|人)?|bodyguard)",
  }],
  ["mason", {
    name: "共有者", shortName: "共", systemName: "mason",
    alignment: "villager", faction: "village", category: "mason",
    description: "特別な能力はないが、最初から他の共有者を知っている",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
    traits: [{ kind: "knowledge", sub: "know-masons" }],
    howlPattern: "(?:共(?:有者?)?|mason)",
  }],
  ["nekomata", {
    name: "猫又", shortName: "猫", systemName: "nekomata",
    alignment: "villager", faction: "village", category: "other",
    description: "処刑されると、生存者の一人をランダムに道連れにする\n人狼に襲撃されると、人狼を道連れにする",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
    traits: [
      { kind: "reactive", sub: "curse-on-executed" },
      { kind: "reactive", sub: "curse-on-killed" },
    ],
    howlPattern: "(?:猫又?|nekomata)",
  }],
  ["werewolf", {
    name: "人狼", shortName: "狼", systemName: "werewolf",
    alignment: "werewolf", faction: "wolf", category: "werewolf",
    description: "夜に生存者から一人を選んで食べる\n人狼は他の人狼を知っている",
    humanCount: 0, wolfCount: 1, seerResult: "wolf", mediumResult: "wolf",
    traits: [
      { kind: "knowledge", sub: "know-werewolves" },
      { kind: "action", sub: "attack" },
      { kind: "channel", sub: "wolf-chat" },
    ],
    howlPattern: "(?:人?狼|werewolf)",
  }],
  ["possessed", {
    name: "狂人", shortName: "狂", systemName: "possessed",
    alignment: "werewolf", faction: "wolf", category: "possessed",
    description: "能力を持たない村人だが、人狼の味方をする",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
    traits: [],
    howlPattern: "(?:狂人?|possessed)",
  }],
  ["fanatic", {
    name: "狂信者", shortName: "信", systemName: "fanatic",
    alignment: "werewolf", faction: "wolf", category: "possessed",
    description: "能力を持たない村人だが、人狼の味方をする\n最初から人狼が誰かを知っている",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
    traits: [{ kind: "knowledge", sub: "know-werewolves" }],
    howlPattern: "(?:狂信者?|信|fanatic)",
  }],
  ["werehamster", {
    name: "妖狐", shortName: "狐", systemName: "werehamster",
    alignment: "werehamster", faction: "fox", category: "werehamster",
    description: "人狼と村人の戦いが終わったときに生存していると勝利する\n多数決の判定の際には無視される\n人狼に襲撃されても死なない\n占い師に占われると死亡する",
    humanCount: 0, wolfCount: 0, seerResult: "human", mediumResult: "human",
    traits: [
      { kind: "passive", sub: "attack-immune" },
      { kind: "passive", sub: "die-when-divined" },
      { kind: "passive", sub: "visible-as-fox" },
      { kind: "passive", sub: "fox-win-counter" },
    ],
    howlPattern: "(?:妖?狐|werehamster)",
  }],
  ["immoralist", {
    name: "背徳者", shortName: "背", systemName: "immoralist",
    alignment: "werehamster", faction: "fox", category: "immoralist",
    description: "特別な能力はない村人だが、妖狐の味方をする\n妖狐が全滅すると後追いで死亡する",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
    traits: [
      { kind: "knowledge", sub: "know-foxes" },
      { kind: "reactive", sub: "follow-fox-death" },
    ],
    howlPattern: "(?:背(?:徳者?)?|immoralist)",
  }],
  ["paparazzi", {
    name: "パパラッチ", shortName: "パ", systemName: "paparazzi",
    alignment: "werewolf", faction: "wolf", category: "possessed",
    description: "毎晩、生存者から一人を選び人狼かどうかを知ることができる\n人狼の味方をする",
    humanCount: 1, wolfCount: 0, seerResult: "human", mediumResult: "human",
    traits: [{ kind: "action", sub: "divine" }],
    howlPattern: "(?:パパラッチ|paparazzi)",
  }],
  ["kogitsune", {
    name: "子狐", shortName: "子狐", systemName: "kogitsune",
    alignment: "werehamster", faction: "fox", category: "other",
    description: "妖狐陣営。\n人狼に襲撃されると死亡する。占い師に占われても死亡しない。\n占い結果は『人間』、霊能結果は『子狐』。\n夜に一人を選んで占うことができるが、結果は50%の確率でしか得られない (呪殺能力なし)。\n最初から妖狐の正体を知っている。\n妖狐が退場しても後追いせず、自身の生存で勝利する。",
    humanCount: 0, wolfCount: 0, seerResult: "human", mediumResult: "kogitsune",
    traits: [
      { kind: "knowledge", sub: "know-foxes" },
      { kind: "passive", sub: "fox-win-counter" },
      { kind: "action", sub: "divine-imperfect" },
    ],
    howlPattern: "(?:子狐|kogitsune)",
  }],
])

export type Regulation = {
  'general.omitFirstDay': boolean
  'vote.style': 'free' | 'ordered' | 'concurrent'
  'vote.final': 'revote' | 'final'
  'vote.tiebreaker': 'random' | 'no-lynch' | 'draw'
  'general.first-victim': 'none' | 'random' | 'first-vote'
  'role.seer.first-seek': 'none' | 'no-wolf' | 'all'
  'role.bodyguard.allow-continuous-protection': boolean
  'role.nekomata.curse-target': 'all-survivors' | 'villager'
  'role.nekomata.curse-immediately': boolean
  'role.immoralist.follow-immediately': boolean
  'role.immoralist.reveal-following': boolean
  'phase.lastwill': boolean
}
