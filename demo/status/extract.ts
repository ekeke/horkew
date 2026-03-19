import type { VillageStatus, SeatStatus, CauseOfDeath, EnumSpecies, PlayerAction, Assertions, SystemRole } from '../../src/types/index.ts'
import { systemRoles } from '../../src/types/index.ts'

// --- Types ---

export type SurvivorInfo = {
  alive: number
  total: number
  survivors: { seat: number, name: string }[]
}

export type DeathEntry = {
  seat: number
  name: string
  causeOfDeath: CauseOfDeath
}

export type DayDeaths = {
  day: number
  executions: DeathEntry[]
  nightKills: DeathEntry[]
}

export type ClaimRow = {
  seat: number
  name: string
  claimingRole: string
  claimedAt: number | undefined
  assertions: Assertions
  actions: PlayerAction
  surviving: boolean
}

export type ClaimGroup = {
  role: string
  roleShortName: string
  rows: ClaimRow[]
}

export type DayAssertion = {
  targetSeat: number
  targetName: string
  species: EnumSpecies
} | null

// --- Role ordering for CO table grouping ---

const roleOrder: string[] = ['seer', 'medium', 'bodyguard', 'mason', 'nekomata']

// --- Extraction Functions ---

export function extractSurvivorInfo(vs: VillageStatus, players: Map<number, string>): SurvivorInfo {
  const survivors: { seat: number, name: string }[] = []
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) {
      survivors.push({ seat, name: players.get(seat) ?? `#${seat}` })
    }
  }
  return {
    alive: survivors.length,
    total: vs.statuses.size,
    survivors,
  }
}

export function extractDeathHistory(vs: VillageStatus, players: Map<number, string>): DayDeaths[] {
  const dayMap = new Map<number, { executions: DeathEntry[], nightKills: DeathEntry[] }>()

  function ensure(day: number) {
    if (!dayMap.has(day)) dayMap.set(day, { executions: [], nightKills: [] })
    return dayMap.get(day)!
  }

  function toEntry(seat: number, fallback: CauseOfDeath): DeathEntry {
    return {
      seat,
      name: players.get(seat) ?? `#${seat}`,
      causeOfDeath: vs.statuses.get(seat)?.causeOfDeath ?? fallback,
    }
  }

  // Executions: display on execution day
  for (const [day, seats] of vs.executions) {
    const row = ensure(day)
    for (const seat of seats) row.executions.push(toEntry(seat, 'execution'))
  }

  // Kills: execution-related deaths go into executions row (same day),
  // night-related deaths go into nightKills row (shifted to discovery day)
  const executionCauses: CauseOfDeath[] = ['cursed_by_executed_nekomata', 'follow_executed_hamster']
  for (const [day, seats] of vs.kills) {
    for (const seat of seats) {
      const entry = toEntry(seat, 'night_kill')
      if (executionCauses.includes(entry.causeOfDeath)) {
        ensure(day).executions.push(entry)
      } else {
        ensure(day + 1).nightKills.push(entry)
      }
    }
  }

  return [...dayMap.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, { executions, nightKills }]) => executions.length > 0 || nightKills.length > 0)
    .map(([day, { executions, nightKills }]) => ({ day, executions, nightKills }))
}

export function extractClaimGroups(vs: VillageStatus, players: Map<number, string>): ClaimGroup[] {
  const grouped = new Map<string, ClaimRow[]>()

  for (const [seat, status] of vs.statuses) {
    if (!status.claiming) continue
    const role = status.claimingRole
    if (!grouped.has(role)) grouped.set(role, [])
    grouped.get(role)!.push({
      seat,
      name: players.get(seat) ?? `#${seat}`,
      claimingRole: role,
      claimedAt: status.claimedAt,
      assertions: status.assertions,
      actions: status.actions,
      surviving: status.surviving,
    })
  }

  // Sort groups by roleOrder, unknowns at end
  const result: ClaimGroup[] = []
  for (const role of roleOrder) {
    const rows = grouped.get(role)
    if (rows) {
      const roleInfo = systemRoles.get(role as SystemRole)
      result.push({
        role,
        roleShortName: roleInfo?.shortName ?? role,
        rows: rows.sort((a, b) => a.seat - b.seat),
      })
      grouped.delete(role)
    }
  }
  // Remaining roles not in roleOrder
  for (const [role, rows] of grouped) {
    const roleInfo = systemRoles.get(role as SystemRole)
    result.push({
      role,
      roleShortName: roleInfo?.shortName ?? role,
      rows: rows.sort((a, b) => a.seat - b.seat),
    })
  }

  return result
}

/**
 * Build per-day assertion timeline for a claiming player.
 * For seer/medium: uses Map iteration order (insertion order) to assign assertions to sequential nights.
 * For bodyguard: uses the actions map (night → target seat).
 */
export function buildAssertionTimeline(
  row: ClaimRow,
  maxDay: number,
  players: Map<number, string>,
): Map<number, DayAssertion> {
  const timeline = new Map<number, DayAssertion>()

  if (row.claimingRole === 'bodyguard') {
    // Bodyguard: actions map keys are actual night numbers (last = day-1)
    for (const [night, targetSeat] of row.actions) {
      timeline.set(night, {
        targetSeat,
        targetName: players.get(targetSeat) ?? `#${targetSeat}`,
        species: null,
      })
    }
  } else {
    // Seer/Medium: assertions are target → species, use insertion order
    let night = 1
    for (const [targetSeat, species] of row.assertions) {
      timeline.set(night, {
        targetSeat,
        targetName: players.get(targetSeat) ?? `#${targetSeat}`,
        species,
      })
      night++
    }
  }

  return timeline
}

/**
 * Map CauseOfDeath to a human-readable Japanese label.
 */
export function causeOfDeathLabel(cause: CauseOfDeath): string {
  switch (cause) {
    case 'execution': return '処刑'
    case 'night_kill': return '襲撃'
    case 'follow_executed_hamster': return '後追い'
    case 'follow_killed_hamster': return '後追い'
    case 'cursed_by_executed_nekomata': return '道連れ'
    case 'cursed_by_killed_nekomata': return '道連れ'
  }
}
