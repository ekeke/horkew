import type {
  SystemRole,
  EnumSpecies,
  VillageStatus,
  SeatStatus,
  VillageResult,
  Role,
  Regulation,
} from '../types/index.ts'
import { systemRoles } from '../types/index.ts'
import { resolveRegulation } from './ruleset.ts'
import type {
  Statement,
  JoinStatement,
  JoinMultiStatement,
  VoteStatement,
  MultiVoteStatement,
  AttackStatement,
  LynchStatement,
  SuddenDeathStatement,
  CorpseFoundStatement,
  AnnounceStatement,
  CurseStatement,
  FollowStatement,
  ForecastStatement,
  RevoteStatement,
  OverStatement,
  AssertStatement,
  MasonStatement,
  SpoilerStatement,
  DayMarkStatement,
} from './statement.ts'
import { FlexibleDictionary } from './flexibleDictionary.ts'
import * as V from './vocabulary.ts'

function createSeatStatus(): SeatStatus {
  return {
    surviving: true,
    causeOfDeath: 'execution',
    survivedDays: 0,
    diedDay: undefined,
    voted: false,
    claiming: false,
    claimingRole: 'none',
    deniedRoles: [],
    votedCount: 0,
    votedTarget: -1,
    votedOrder: 0,
    actions: new Map(),
    assertions: new Map(),
    forecasts: new Map(),
  }
}

const gameResultMap: Record<string, VillageResult> = {
  villageWin: 'villager_won',
  wolfWin: 'werewolf_won',
  hamsterWin: 'werehamster_won',
  draw: 'draw',
}

const speciesMap: Record<string, EnumSpecies> = {
  isHuman: 'human',
  isWolf: 'wolf',
  isKogitsune: 'kogitsune',
}

const claimRoleToSystemRole: Record<string, SystemRole> = {
  seer: 'seer',
  medium: 'medium',
  bodyguard: 'bodyguard',
  mason: 'mason',
  nekomata: 'nekomata',
}

// spoiler/reveal 等で使う、 日本語/英語の役職トークンを SystemRole に解決する。
// systemRoles.howlPattern (= vocabulary 由来) を完全一致で当てていく。
// villager のみ plainVillager (素村) も同じ SystemRole 'villager' に集約 (retar の
// SystemRole は素村を区別しない)。
// prefix 衝突を起こす役職対 (狂人 vs 狂信者) は name.length DESC ソートで長い名前を
// 先に試すことで disambiguate。
const spoilerRoleSpecs: { systemRole: SystemRole, pattern: RegExp }[] = (() => {
  const sorted = [...systemRoles.entries()].sort(
    ([, a], [, b]) => b.name.length - a.name.length,
  )
  return sorted.map(([role, meta]) => {
    const pattern = role === 'villager'
      ? new RegExp(`^(?:${V.plainVillager}|${meta.howlPattern})$`)
      : new RegExp(`^${meta.howlPattern}$`)
    return { systemRole: role, pattern }
  })
})()

function resolveSpoilerRole(raw: string): SystemRole | null {
  for (const spec of spoilerRoleSpecs) {
    if (spec.pattern.test(raw)) return spec.systemRole
  }
  return null
}

/**
 * spoiler 右辺の集合 alias (人外 / 狼陣営 / 狐陣営 / 村陣営) を解決する。
 * 単一役職 pin (resolveSpoilerRole) との曖昧を避けるため、 必ず陣営付きキー
 * (`...陣営`) または英語キーに match した場合のみ alias と判定する。
 * 戻り値は「許可する faction の集合」。 hostile = wolf + fox。
 */
type FactionAlias = 'village' | 'wolf' | 'fox' | 'hostile'
const factionAliasSpecs: { alias: FactionAlias, pattern: RegExp }[] = [
  { alias: 'village', pattern: new RegExp(`^${V.factionAliasVillage}$`) },
  { alias: 'wolf',    pattern: new RegExp(`^${V.factionAliasWolf}$`) },
  { alias: 'fox',     pattern: new RegExp(`^${V.factionAliasFox}$`) },
  { alias: 'hostile', pattern: new RegExp(`^${V.factionAliasHostile}$`) },
]

function resolveFactionAlias(raw: string): FactionAlias | null {
  for (const spec of factionAliasSpecs) {
    if (spec.pattern.test(raw)) return spec.alias
  }
  return null
}

/**
 * faction alias に対応する「許可する faction の集合」。
 * 補集合 (= deny される faction) は systemRoles から派生する。
 */
const ALIAS_ALLOWED_FACTIONS: Record<FactionAlias, Set<'village' | 'wolf' | 'fox'>> = {
  village: new Set(['village']),
  wolf:    new Set(['wolf']),
  fox:     new Set(['fox']),
  hostile: new Set(['wolf', 'fox']),
}

/**
 * faction alias から deny すべき SystemRole 集合を計算する。
 * systemRoles の各役職について「許可された faction に属さないもの」を deny する。
 */
function deniedRolesForAlias(alias: FactionAlias): SystemRole[] {
  const allowed = ALIAS_ALLOWED_FACTIONS[alias]
  const denied: SystemRole[] = []
  for (const [role, meta] of systemRoles) {
    if (!allowed.has(meta.faction)) denied.push(role)
  }
  return denied
}

export type SpoilerActionRecord = {
  day: number
  by: number
  action: 'divine' | 'guard' | 'attack'
  target: number
}

export type BridgeResult = {
  vs: VillageStatus
  setup: Map<SystemRole, number>
  players: Map<number, string>
  shortNames: Map<number, string>
  dict: FlexibleDictionary
  rules: Regulation
  /**
   * 役職 pin の集約。 announce (公式公開情報) + spoiler 行 (`!Alice=seer`) +
   * frontmatter `spoilers.roles` をひとまとめにした「実効 pin 一覧」。
   * 出所別の内訳は [announceAssumptions](#announceAssumptions) を参照。
   */
  assumptions: Map<number, SystemRole>
  /**
   * `assumptions` のうち announce 行 (`※ Alice 契約者` 等) 由来の subset。
   * spoiler 非表示トグルの影響を受けず常に有効、 という性質を持たせるため
   * lykaon 側で「公開 pin」 と 「秘匿 pin」 を切り分けるのに使う。
   */
  announceAssumptions: Map<number, SystemRole>
  spoilerActions: SpoilerActionRecord[]
  /**
   * spoiler faction alias (`!Alice=人外` 等) 由来で deny された SystemRole を席ごとに記録。
   * 同じ deny は seat.deniedRoles 経由でも retar に流れるが、 UI 上で
   * 「CO 由来 deny」と「spoiler 由来 deny」を区別表示するための副インデックス。
   */
  spoilerDeniedRoles: Map<number, Set<SystemRole>>
}

export function buildVillageStatus(statements: Statement[], meta?: Record<string, any>): BridgeResult {
  const dict = new FlexibleDictionary()
  const statuses = new Map<number, SeatStatus>()
  const players = new Map<number, string>()
  const shortNames = new Map<number, string>()
  const executions = new Map<number, number[]>()
  const kills = new Map<number, number[]>()
  const roles = new Map<number, Role | SystemRole>()
  const claims = new Map<number | SystemRole, number[]>()
  const voteHistory = new Map<number, import('../types/index.ts').VoteRecord[]>()
  let day = 1
  let finished = false
  let result: VillageResult = undefined
  let lastDeathEvent: 'execution' | 'night_kill' = 'execution'
  let claimCounter = 0
  let pendingGrelan = false
  let voteOrderCounter = 0
  const rules = resolveRegulation(meta?.rules)
  const voteFinalRule = rules['vote.final']
  let revoteTargets = new Set<number>()
  let hasMultiVote = false
  const multiVoteDays = new Set<number>()

  function resolveSeat(name: string): number | null {
    const results = dict.search(name)
    if (results.length === 0) return null
    return Number(results[0])
  }

  function syncDay(stmt: Statement) {
    if (stmt.day === undefined || stmt.day === day) return
    const newDay = stmt.day
    while (day < newDay) {
      day++
      for (const status of statuses.values()) {
        if (!status.surviving) status.survivedDays++
        status.voted = false
        status.votedCount = 0
        status.votedTarget = -1
        status.votedOrder = 0
      }
      voteOrderCounter = 0
      revoteTargets = new Set()
      hasMultiVote = false
    }
  }

  let nextSeat = 1

  for (const stmt of statements) {
    syncDay(stmt)
    switch (stmt.type) {
      case 'join': {
        const s = stmt as JoinStatement
        const seat = nextSeat++
        const seatStr = String(seat)
        const keywords = new Set<string>([s.name, ...s.aliases, seatStr])
        dict.add(seatStr, [...keywords])
        statuses.set(seat, createSeatStatus())
        players.set(seat, s.name)
        if (s.shortName) shortNames.set(seat, s.shortName)
        break
      }

      case 'joinMulti': {
        const s = stmt as JoinMultiStatement
        for (let i = 0; i < s.players.length; i++) {
          const seat = nextSeat++
          const name = s.players[i]
          const seatStr = String(seat)
          const keywords = new Set<string>([name, seatStr])
          dict.add(seatStr, [...keywords])
          statuses.set(seat, createSeatStatus())
          players.set(seat, name)
        }
        break
      }

      case 'vote': {
        const s = stmt as VoteStatement
        const voterSeat = resolveSeat(s.voter)
        const targetSeat = resolveSeat(s.target)
        if (voterSeat === null || targetSeat === null) break
        const voter = statuses.get(voterSeat)!
        const target = statuses.get(targetSeat)!
        voter.voted = true
        voter.votedTarget = targetSeat
        voter.votedOrder = ++voteOrderCounter
        target.votedCount++
        if (!voteHistory.has(day)) voteHistory.set(day, [])
        voteHistory.get(day)!.push({ voter: voterSeat, target: targetSeat })
        break
      }

      case 'multiVote': {
        hasMultiVote = true
        multiVoteDays.add(day)
        const s = stmt as MultiVoteStatement
        const targetSeat = resolveSeat(s.target)
        if (targetSeat === null) break
        const target = statuses.get(targetSeat)!

        const voterSeats = s.voters.map(resolveSeat).filter((s): s is number => s !== null)

        if (!voteHistory.has(day)) voteHistory.set(day, [])
        const dayVotes = voteHistory.get(day)!
        for (const voterSeat of voterSeats) {
          const voter = statuses.get(voterSeat)!
          voter.voted = true
          voter.votedTarget = targetSeat
          voter.votedOrder = ++voteOrderCounter
          target.votedCount++
          dayVotes.push({ voter: voterSeat, target: targetSeat })
        }
        break
      }

      case 'attack': {
        const s = stmt as AttackStatement
        lastDeathEvent = 'night_kill'
        for (const targetName of s.target) {
          const targetSeat = resolveSeat(targetName)
          if (targetSeat === null) continue
          const status = statuses.get(targetSeat)!
          status.surviving = false
          status.causeOfDeath = 'night_kill'
          status.diedDay = day - 1
          const currentKills = kills.get(day - 1) || []
          currentKills.push(targetSeat)
          kills.set(day - 1, currentKills)
        }
        break
      }

      case 'peace': {
        for (const status of statuses.values()) {
          status.voted = false
          status.votedCount = 0
          status.votedTarget = -1
          status.votedOrder = 0
        }
        voteOrderCounter = 0
        revoteTargets = new Set()
        hasMultiVote = false
        // peace night を kills に空配列で登録 (attack と同じ day-1 規約).
        // これにより retar 側で「Day N の actual=0 = peace night」 を正しく検出できる.
        const peaceDay = day - 1
        if (!kills.has(peaceDay)) kills.set(peaceDay, [])
        break
      }

      case 'dayMark': {
        // 同一 day への dayMark は no-op (assignDays が advanced=false で印).
        if (!(stmt as DayMarkStatement).advanced) break
        for (const status of statuses.values()) {
          status.voted = false
          status.votedCount = 0
          status.votedTarget = -1
          status.votedOrder = 0
        }
        voteOrderCounter = 0
        revoteTargets = new Set()
        hasMultiVote = false
        break
      }

      case 'grelan': {
        pendingGrelan = true
        break
      }

      case 'lynch': {
        const s = stmt as LynchStatement
        lastDeathEvent = 'execution'
        if (s.target !== null) {
          const targetSeat = resolveSeat(s.target)
          if (targetSeat === null) break
          const status = statuses.get(targetSeat)!
          status.surviving = false
          status.causeOfDeath = 'execution'
          status.diedDay = day
          if (pendingGrelan) {
            status.noCoOpportunity = true
          }
          const currentExec = executions.get(day) || []
          currentExec.push(targetSeat)
          executions.set(day, currentExec)
        }
        pendingGrelan = false
        for (const status of statuses.values()) {
          status.voted = false
          status.votedCount = 0
          status.votedTarget = -1
          status.votedOrder = 0
        }
        voteOrderCounter = 0
        revoteTargets = new Set()
        hasMultiVote = false
        break
      }

      case 'suddenDeath': {
        const s = stmt as SuddenDeathStatement
        const targetSeat = resolveSeat(s.target)
        if (targetSeat === null) break
        const status = statuses.get(targetSeat)!
        status.surviving = false
        status.causeOfDeath = 'sudden_death'
        if (lastDeathEvent === 'execution') {
          status.diedDay = day
          const currentExec = executions.get(day) || []
          currentExec.push(targetSeat)
          executions.set(day, currentExec)
        } else {
          status.diedDay = day - 1
          const deathDay = status.diedDay
          const currentKills = kills.get(deathDay) || []
          currentKills.push(targetSeat)
          kills.set(deathDay, currentKills)
        }
        break
      }

      case 'corpseFound': {
        // 契約者の宝刀「焔薙」による強制退場。 夜時間の出来事として kills に登録し、
        // retar へは sudden_death と同じ「制約無し離脱」として渡す
        // (護衛貫通・狐免疫貫通の能力なので、 単独夜死推論等から除外される必要がある)。
        const s = stmt as CorpseFoundStatement
        lastDeathEvent = 'night_kill'
        const targetSeat = resolveSeat(s.target)
        if (targetSeat === null) break
        const status = statuses.get(targetSeat)!
        status.surviving = false
        status.causeOfDeath = 'sudden_death'
        status.diedDay = day - 1
        const currentKills = kills.get(day - 1) || []
        currentKills.push(targetSeat)
        kills.set(day - 1, currentKills)
        break
      }

      case 'curse': {
        const s = stmt as CurseStatement
        const targetSeat = resolveSeat(s.target)
        if (targetSeat === null) break
        const status = statuses.get(targetSeat)!
        status.surviving = false
        status.causeOfDeath = lastDeathEvent === 'execution'
          ? 'cursed_by_executed_nekomata'
          : 'cursed_by_killed_nekomata'
        status.diedDay = lastDeathEvent === 'execution' ? day : day - 1
        const deathDay = status.diedDay
        const currentKills = kills.get(deathDay) || []
        currentKills.push(targetSeat)
        kills.set(deathDay, currentKills)
        break
      }

      case 'follow': {
        const s = stmt as FollowStatement
        const targetSeat = resolveSeat(s.target)
        if (targetSeat === null) break
        const status = statuses.get(targetSeat)!
        status.surviving = false
        status.causeOfDeath = lastDeathEvent === 'execution'
          ? 'follow_executed_hamster'
          : 'follow_killed_hamster'
        status.diedDay = lastDeathEvent === 'execution' ? day : day - 1
        const deathDay = status.diedDay
        const currentKills = kills.get(deathDay) || []
        currentKills.push(targetSeat)
        kills.set(deathDay, currentKills)
        break
      }

      case 'forecast': {
        const s = stmt as ForecastStatement
        const actorSeat = resolveSeat(s.actor)
        const targetSeat = resolveSeat(s.target)
        if (actorSeat === null || targetSeat === null) break
        const actorStatus = statuses.get(actorSeat)!
        if (!actorStatus.claiming || actorStatus.claimingRole !== 'seer') break
        actorStatus.forecasts.set(day, targetSeat)
        break
      }

      case 'revote': {
        const s = stmt as RevoteStatement
        if (s.targets.length > 0) {
          revoteTargets = new Set(s.targets.map(t => resolveSeat(t)).filter((s): s is number => s !== null))
        } else {
          // Derive targets from current vote state: top-tied candidates
          let maxVotes = 0
          for (const status of statuses.values()) {
            if (status.surviving && status.votedCount > maxVotes) maxVotes = status.votedCount
          }
          revoteTargets = new Set<number>()
          if (maxVotes > 0) {
            for (const [seat, status] of statuses) {
              if (status.surviving && status.votedCount === maxVotes) revoteTargets.add(seat)
            }
          }
        }
        for (const status of statuses.values()) {
          status.voted = false
          status.votedCount = 0
          status.votedTarget = -1
          status.votedOrder = 0
        }
        voteOrderCounter = 0
        hasMultiVote = false
        break
      }

      case 'mason': {
        const s = stmt as MasonStatement
        for (const playerName of s.players) {
          const seat = resolveSeat(playerName)
          if (seat === null) continue
          const status = statuses.get(seat)!
          const alreadyMason = status.claiming && status.claimingRole === 'mason'
          if (!alreadyMason) {
            status.claiming = true
            status.claimingRole = 'mason'
            status.claimedAt = day
            status.claimOrder = ++claimCounter
            status.actions = new Map()
            status.assertions = new Map()
          }
          let masonKey = -1
          while (status.assertions.has(masonKey)) masonKey--
          const existingPartners = new Set<number>()
          for (const { target } of status.assertions.values()) existingPartners.add(target)
          for (const otherName of s.players) {
            if (otherName === playerName) continue
            const otherSeat = resolveSeat(otherName)
            if (otherSeat === null) continue
            if (existingPartners.has(otherSeat)) continue
            status.assertions.set(masonKey--, { target: otherSeat, species: 'human' })
            existingPartners.add(otherSeat)
          }
        }
        break
      }

      case 'assert': {
        const s = stmt as AssertStatement
        const actorSeat = resolveSeat(s.actor)
        if (actorSeat === null) break
        const actorStatus = statuses.get(actorSeat)!
        const guardTargets: number[] = []
        const divinationResults: { target: number, species: EnumSpecies }[] = []

        const villageRoles: SystemRole[] = ['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata']

        for (const assertion of s.assertions) {
          if (assertion.roles && assertion.roles.length > 0) {
            const sysRoles = assertion.roles
              .map(r => claimRoleToSystemRole[r])
              .filter((r): r is SystemRole => r != null)

            if (assertion.roles.includes('nonVillage') && !assertion.negative) {
              // 人外CO / 人狼CO / 狂人CO / 妖狐CO / 狂信者CO / 背徳者CO: 村全 6 役職を否定
              actorStatus.deniedRoles.push(...villageRoles)
            } else if (assertion.negative || sysRoles.length > 1) {
              // 否定CO or 複数CO (ギドラ): claiming せず deniedRoles で処理
              const denied = assertion.negative
                ? sysRoles                                          // 非占いCO → deny seer
                : villageRoles.filter(r => !sysRoles.includes(r))   // 猫狩CO → deny seer,medium,mason
              actorStatus.deniedRoles.push(...denied)
            } else if (sysRoles.length === 1) {
              // 単独CO: 従来通り
              const sysRole = sysRoles[0]
              if (!actorStatus.claiming || actorStatus.claimingRole !== sysRole) {
                if (actorStatus.claiming) {
                  if (!actorStatus.previousClaims) actorStatus.previousClaims = []
                  actorStatus.previousClaims.push({
                    role: actorStatus.claimingRole,
                    assertions: actorStatus.assertions,
                    actions: actorStatus.actions,
                    forecasts: actorStatus.forecasts,
                    claimedAt: actorStatus.claimedAt,
                    claimOrder: actorStatus.claimOrder,
                    slidToRole: sysRole,
                    slidDay: day,
                  })
                }
                actorStatus.claiming = true
                actorStatus.claimingRole = sysRole
                actorStatus.claimedAt = day
                actorStatus.claimOrder = ++claimCounter
                actorStatus.actions = new Map()
                actorStatus.assertions = new Map()
                actorStatus.forecasts = new Map()
              }
            }
          }

          if (assertion.target) {
            const targetSeat = resolveSeat(assertion.target)
            if (targetSeat === null) continue
            if (assertion.result) {
              divinationResults.push({ target: targetSeat, species: speciesMap[assertion.result]! })
            }
            if (assertion.action === 'guard') {
              guardTargets.push(targetSeat)
            }
          }
        }

        // Right-align divination results: last result = previous night, counting backwards
        if (divinationResults.length > 0) {
          const lastNight = day - 1
          for (let i = 0; i < divinationResults.length; i++) {
            const night = lastNight - (divinationResults.length - 1 - i)
            const existing = actorStatus.assertions.get(night)
            const next = divinationResults[i]
            // Only treat as slide (push to previousAssertions) when the new result actually differs
            // from the existing one. Identical re-statements (same target + same species) are no-ops.
            if (existing && (existing.target !== next.target || existing.species !== next.species)) {
              if (!actorStatus.previousAssertions) actorStatus.previousAssertions = new Map()
              if (!actorStatus.previousAssertions.has(night)) actorStatus.previousAssertions.set(night, [])
              actorStatus.previousAssertions.get(night)!.push(existing)
            }
            actorStatus.assertions.set(night, next)
          }
        }

        // Assign guard actions: last guard = previous night (day-1), counting backwards
        if (guardTargets.length > 0) {
          const lastNight = day - 1
          for (let i = 0; i < guardTargets.length; i++) {
            const night = lastNight - (guardTargets.length - 1 - i)
            actorStatus.actions.set(night, guardTargets[i])
          }
        }
        break
      }

      case 'over': {
        const s = stmt as OverStatement
        finished = true
        result = gameResultMap[s.result]
        break
      }

      case 'reveal':
      case 'spoiler':
      case 'announce':
      case 'videoSource':
      case 'timestamp':
      case 'unknown':
        break
    }
  }

  // Build claims map from statuses
  for (const [seat, status] of statuses) {
    if (!status.claiming) continue
    const role = status.claimingRole as SystemRole
    if (!claims.has(role)) claims.set(role, [])
    claims.get(role)!.push(seat)
  }

  const vs: VillageStatus = {
    statuses,
    executions,
    kills,
    roles,
    claims,
    voteHistory,
    revoteTargets,
    voteFinalRule,
    hasMultiVote,
    multiVoteDays,
    day,
    finished,
    result,
  }

  // Derive setup from meta or default
  const setup = new Map<SystemRole, number>()
  if (meta?.setup) {
    for (const [role, count] of Object.entries(meta.setup)) {
      setup.set(role as SystemRole, count as number)
    }
  } else {
    // Default setup based on player count
    const n = statuses.size
    setup.set('villager', Math.max(1, n - 6))
    setup.set('werewolf', n >= 13 ? 3 : n >= 8 ? 2 : 1)
    setup.set('seer', 1)
    setup.set('medium', 1)
    setup.set('bodyguard', n >= 8 ? 1 : 0)
    setup.set('possessed', 1)
    if (n >= 13) {
      setup.set('mason', 2)
      setup.set('werehamster', 1)
    }
  }

  // Remove zero-count roles
  for (const [role, count] of setup) {
    if (count <= 0) setup.delete(role)
  }

  // 予告先がその夜までに死亡していたら予告を無効化（占い先は変更される）
  for (const [, status] of statuses) {
    for (const [night, targetSeat] of status.forecasts) {
      const targetStatus = statuses.get(targetSeat)!
      if (!targetStatus.surviving && targetStatus.diedDay != null && targetStatus.diedDay <= night) {
        status.forecasts.delete(night)
      }
    }
  }

  // spoiler 文を集約して assumptions / spoilerActions / spoilerDeniedRoles を構築する。
  // 役職 pin (role が SystemRole) → assumptions、 集合 alias (role が faction alias) →
  // spoilerDeniedRoles と seat.deniedRoles、 秘匿行動 (action あり) → spoilerActions に分離。
  // 同一プレイヤーに対して異なる役職の spoiler が存在する場合はエラー（同じ役職の重複は許容）。
  const assumptions = new Map<number, SystemRole>()
  const announceAssumptions = new Map<number, SystemRole>()
  const spoilerDeniedRoles = new Map<number, Set<SystemRole>>()
  const spoilerActions: SpoilerActionRecord[] = []

  function applyAliasDeny(seat: number, alias: FactionAlias, line: number): void {
    if (assumptions.has(seat)) {
      const name = players.get(seat) ?? `#${seat}`
      throw new Error(`spoiler: ${name} に対する矛盾する仮定 (${assumptions.get(seat)} vs ${alias} alias) (line ${line})`)
    }
    const denied = deniedRolesForAlias(alias)
    const seatStatus = statuses.get(seat)
    if (!seatStatus) return
    let set = spoilerDeniedRoles.get(seat)
    if (!set) {
      set = new Set<SystemRole>()
      spoilerDeniedRoles.set(seat, set)
    }
    for (const role of denied) {
      if (!set.has(role)) {
        set.add(role)
        seatStatus.deniedRoles.push(role)
      }
    }
  }

  function applyPinAssumption(seat: number, role: SystemRole, line: number): void {
    // alias 由来の denied set に新 role が**含まれる**場合のみ矛盾。
    // 例: `!Alice=人外` (hostile alias → village 役職を deny) の後に `!Alice=人狼` が来ても
    // werewolf は denied set に含まれないため refinement として許容。
    // 一方 `!Alice=人外` + `!Alice=seer` は seer ∈ denied(hostile) なので矛盾。
    const deniedSet = spoilerDeniedRoles.get(seat)
    if (deniedSet && deniedSet.has(role)) {
      const name = players.get(seat) ?? `#${seat}`
      throw new Error(`spoiler: ${name} に対する矛盾する仮定 (alias deny vs ${role}) (line ${line})`)
    }
    const existing = assumptions.get(seat)
    if (existing !== undefined && existing !== role) {
      const name = players.get(seat) ?? `#${seat}`
      throw new Error(`spoiler: ${name} に対する矛盾する仮定 (${existing} vs ${role}) (line ${line})`)
    }
    assumptions.set(seat, role)
  }

  for (const stmt of statements) {
    if (stmt.type !== 'spoiler') continue
    const s = stmt as SpoilerStatement
    const seat = resolveSeat(s.player)
    if (seat === null) {
      throw new Error(`spoiler: 未知のプレイヤー "${s.player}" (line ${s.line})`)
    }
    if (s.role !== undefined) {
      const alias = resolveFactionAlias(s.role)
      if (alias !== null) {
        applyAliasDeny(seat, alias, s.line)
        continue
      }
      const role = resolveSpoilerRole(s.role)
      if (role === null) {
        throw new Error(`spoiler: 役職名を解決できません "${s.role}" (line ${s.line})`)
      }
      applyPinAssumption(seat, role, s.line)
    } else if (s.action !== undefined && s.day !== undefined && s.target !== undefined) {
      const target = resolveSeat(s.target)
      if (target === null) {
        throw new Error(`spoiler action: 未知のターゲット "${s.target}" (line ${s.line})`)
      }
      spoilerActions.push({ day: s.day, by: seat, action: s.action, target })
    } else {
      throw new Error(`spoiler: 形式不正 (role も action も無い) (line ${s.line})`)
    }
  }

  // 公式アナウンス (`※ Alice、Bob 契約者` 等) を assumptions に集約する。
  // spoiler は「視点配信メモ = 観戦者向けの秘匿情報」 であるのに対し、 announce は
  // 「進行中に村全員が共有する公式情報」 という性質差がある。 retar への影響
  // (= 該当 seat の役職確定) は同じなので applyPinAssumption を再利用するが、
  // 出所を区別する副インデックス announceAssumptions にも記録しておき、
  // lykaon 側で spoiler 非表示トグル時に announce 由来分だけを残せるようにする。
  for (const stmt of statements) {
    if (stmt.type !== 'announce') continue
    const a = stmt as AnnounceStatement
    if (a.kind !== 'rolePin') continue
    const role = resolveSpoilerRole(a.role)
    if (role === null) {
      throw new Error(`announce: 役職名を解決できません "${a.role}" (line ${a.line})`)
    }
    for (const playerName of a.targets) {
      const seat = resolveSeat(playerName)
      if (seat === null) {
        throw new Error(`announce: 未知のプレイヤー "${playerName}" (line ${a.line})`)
      }
      applyPinAssumption(seat, role, a.line)
      announceAssumptions.set(seat, role)
    }
  }

  // frontmatter `spoilers.roles` も同じ assumptions に集約する。
  // ヘッダーで pin 役職を一覧できるためテストシナリオで読みやすい。
  // `!Player=Role` spoiler 文と同等の意味を持ち、両者が同一プレイヤーに別役職を
  // 指定した場合は矛盾エラー。
  const fmSpoilerRoles = meta?.spoilers?.roles
  if (fmSpoilerRoles !== undefined && fmSpoilerRoles !== null) {
    if (typeof fmSpoilerRoles !== 'object' || Array.isArray(fmSpoilerRoles)) {
      throw new Error('spoilers.roles: object 形式 ({ Player: role, ... }) で指定してください')
    }
    for (const [playerName, roleRaw] of Object.entries(fmSpoilerRoles)) {
      const seat = resolveSeat(playerName)
      if (seat === null) {
        throw new Error(`spoilers.roles: 未知のプレイヤー "${playerName}"`)
      }
      const raw = String(roleRaw)
      const alias = resolveFactionAlias(raw)
      if (alias !== null) {
        applyAliasDeny(seat, alias, 0)
        continue
      }
      const role = resolveSpoilerRole(raw)
      if (role === null) {
        throw new Error(`spoilers.roles: 役職名を解決できません "${roleRaw}" (player: ${playerName})`)
      }
      applyPinAssumption(seat, role, 0)
    }
  }

  return { vs, setup, players, shortNames, dict, rules, assumptions, announceAssumptions, spoilerActions, spoilerDeniedRoles }
}
