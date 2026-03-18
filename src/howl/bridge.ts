import type {
  SystemRole,
  EnumSpecies,
  VillageStatus,
  SeatStatus,
  VillageResult,
  Role,
} from '../types/index.ts'
import type {
  Statement,
  JoinStatement,
  VoteStatement,
  MultiVoteStatement,
  AttackStatement,
  LynchStatement,
  OverStatement,
  AssertStatement,
} from './statement.ts'
import { FlexibleDictionary } from './flexibleDictionary.ts'

function createSeatStatus(): SeatStatus {
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
    assertions: new Map(),
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
}

const claimRoleToSystemRole: Record<string, SystemRole> = {
  seer: 'seer',
  medium: 'medium',
  bodyguard: 'bodyguard',
  mason: 'mason',
  nekomata: 'nekomata',
}

export type BridgeResult = {
  vs: VillageStatus
  setup: Map<SystemRole, number>
  players: Map<number, string>
}

export function buildVillageStatus(statements: Statement[], meta?: Record<string, any>): BridgeResult {
  const dict = new FlexibleDictionary()
  const statuses = new Map<number, SeatStatus>()
  const players = new Map<number, string>()
  const executions = new Map<number, number[]>()
  const kills = new Map<number, number[]>()
  const roles = new Map<number, Role | SystemRole>()
  const claims = new Map<number | SystemRole, number[]>()
  let day = 1
  let finished = false
  let result: VillageResult = undefined

  function resolveSeat(name: string): number {
    const results = dict.search(name)
    if (results.length === 0) throw new Error(`Player not found: ${name}`)
    return Number(results[0])
  }

  function nextDay() {
    day++
    for (const status of statuses.values()) {
      if (!status.surviving) status.survivedDays++
      status.voted = false
      status.votedCount = 0
      status.votedTarget = -1
    }
  }

  for (const stmt of statements) {
    switch (stmt.type) {
      case 'join': {
        const s = stmt as JoinStatement
        for (let i = 0; i < s.players.length; i++) {
          const seat = i + 1
          const name = s.players[i]
          dict.add(String(seat), [name])
          statuses.set(seat, createSeatStatus())
          players.set(seat, name)
        }
        break
      }

      case 'vote': {
        const s = stmt as VoteStatement
        const voterSeat = resolveSeat(s.voter)
        const targetSeat = resolveSeat(s.target)
        const voter = statuses.get(voterSeat)!
        const target = statuses.get(targetSeat)!
        voter.voted = true
        voter.votedTarget = targetSeat
        target.votedCount++
        break
      }

      case 'multiVote': {
        const s = stmt as MultiVoteStatement
        const targetSeat = resolveSeat(s.target)
        const target = statuses.get(targetSeat)!

        // Empty voters means "all surviving players who haven't voted yet"
        const voterSeats = s.voters.length > 0
          ? s.voters.map(resolveSeat)
          : [...statuses.entries()]
              .filter(([, st]) => st.surviving && !st.voted)
              .map(([seat]) => seat)

        for (const voterSeat of voterSeats) {
          const voter = statuses.get(voterSeat)!
          voter.voted = true
          voter.votedTarget = targetSeat
          target.votedCount++
        }
        break
      }

      case 'attack': {
        const s = stmt as AttackStatement
        nextDay()
        for (const targetName of s.target) {
          const targetSeat = resolveSeat(targetName)
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
        nextDay()
        break
      }

      case 'lynch': {
        const s = stmt as LynchStatement
        const targetSeat = resolveSeat(s.target)
        const status = statuses.get(targetSeat)!
        status.surviving = false
        status.causeOfDeath = 'execution'
        status.diedDay = day
        const currentExec = executions.get(day) || []
        currentExec.push(targetSeat)
        executions.set(day, currentExec)
        break
      }

      case 'revote': {
        for (const status of statuses.values()) {
          status.voted = false
          status.votedCount = 0
          status.votedTarget = -1
        }
        break
      }

      case 'assert': {
        const s = stmt as AssertStatement
        const actorSeat = resolveSeat(s.actor)
        const actorStatus = statuses.get(actorSeat)!

        for (const assertion of s.assertions) {
          if (assertion.roles && assertion.roles.length > 0) {
            const role = assertion.roles[0]
            const sysRole = claimRoleToSystemRole[role]
            if (sysRole) {
              actorStatus.claiming = true
              actorStatus.claimingRole = sysRole
              actorStatus.claimedAt = day
              actorStatus.actions = new Map()
              actorStatus.assertions = new Map()
            }
          }

          if (assertion.target) {
            const targetSeat = resolveSeat(assertion.target)
            if (assertion.result) {
              actorStatus.assertions.set(targetSeat, speciesMap[assertion.result]!)
            }
            if (assertion.action === 'guard') {
              actorStatus.actions.set(day, targetSeat)
            }
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

  return { vs, setup, players }
}
