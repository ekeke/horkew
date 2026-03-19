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
  const days: DayDeaths[] = []

  // Collect all days that have any deaths
  const allDays = new Set<number>()
  for (const day of vs.executions.keys()) allDays.add(day)
  for (const day of vs.kills.keys()) allDays.add(day)

  const sortedDays = [...allDays].sort((a, b) => a - b)

  for (const day of sortedDays) {
    const execSeats = vs.executions.get(day) ?? []
    const killSeats = vs.kills.get(day) ?? []

    const executions: DeathEntry[] = execSeats.map(seat => ({
      seat,
      name: players.get(seat) ?? `#${seat}`,
      causeOfDeath: vs.statuses.get(seat)?.causeOfDeath ?? 'execution',
    }))

    const nightKills: DeathEntry[] = killSeats.map(seat => ({
      seat,
      name: players.get(seat) ?? `#${seat}`,
      causeOfDeath: vs.statuses.get(seat)?.causeOfDeath ?? 'night_kill',
    }))

    if (executions.length > 0 || nightKills.length > 0) {
      days.push({ day, executions, nightKills })
    }
  }

  return days
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
    // Bodyguard: actions map is night → target seat
    for (let night = 1; night < maxDay; night++) {
      const target = row.actions.get(night)
      if (target !== undefined) {
        timeline.set(night, {
          targetSeat: target,
          targetName: players.get(target) ?? `#${target}`,
          species: null,
        })
      }
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
