import type { VillageStatus, CauseOfDeath, EnumSpecies, PlayerAction, Assertions, SystemRole } from '../../types/index.ts'
import { systemRoles } from '../../types/index.ts'

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
  claimOrder: number | undefined
  assertions: Assertions
  actions: PlayerAction
  forecasts: Map<number, number>
  surviving: boolean
  causeOfDeath: CauseOfDeath
  diedDay: number | undefined
  previousAssertions?: Map<number, { target: number, species: EnumSpecies }[]>
  slidToRole?: string
  slidDay?: number
}

export type ClaimGroup = {
  role: string
  roleShortName: string
  rows: ClaimRow[]
}

export type PreviousAssertion = {
  targetSeat: number
  targetName: string
  species: EnumSpecies
}

export type DayAssertion = {
  targetSeat: number
  targetName: string
  species: EnumSpecies
  forecast?: boolean
  previousAssertions?: PreviousAssertion[]
} | null

// --- Vote status types ---

export type VoteRow = {
  seat: number
  name: string
  votedCount: number
  voters: { seat: number, name: string, votedOrder: number }[]
}

export type VoteStatus = {
  rows: VoteRow[]
  pending: { seat: number, name: string }[]
  remainingVotes: number
  totalVoters: number
  hasAnyVotes: boolean
  executionOccurred: boolean
  hasMultiVote: boolean
}

export type VoteVerdict =
  | 'execution_locked'
  | 'runoff_locked'
  | 'at_risk'
  | 'safe'

export type VoteVerdictInfo = {
  verdict: VoteVerdict
  savedBy?: string                    // for safe: name of voter who caused salvation
  runoffVoterName?: string            // name of voter whose vote triggered runoff lock
  runoffVoterOrder?: number           // their votedOrder (for highlighting if in voters column)
  executionVoterName?: string         // name of voter whose vote triggered execution lock
  executionVoterOrder?: number        // their votedOrder
}

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
    const name = players.get(seat) ?? `#${seat}`
    const role = status.claimingRole
    if (!grouped.has(role)) grouped.set(role, [])
    grouped.get(role)!.push({
      seat,
      name,
      claimingRole: role,
      claimedAt: status.claimedAt,
      claimOrder: status.claimOrder,
      assertions: status.assertions,
      actions: status.actions,
      forecasts: status.forecasts,
      surviving: status.surviving,
      causeOfDeath: status.causeOfDeath,
      diedDay: status.diedDay,
      previousAssertions: status.previousAssertions,
    })

    // Generate rows for previous claims (role slides)
    if (status.previousClaims) {
      for (const prev of status.previousClaims) {
        const prevRole = prev.role
        if (!grouped.has(prevRole)) grouped.set(prevRole, [])
        grouped.get(prevRole)!.push({
          seat,
          name,
          claimingRole: prevRole,
          claimedAt: prev.claimedAt,
          claimOrder: prev.claimOrder,
          assertions: prev.assertions,
          actions: prev.actions,
          forecasts: prev.forecasts,
          surviving: status.surviving,
          causeOfDeath: status.causeOfDeath,
          diedDay: status.diedDay,
          slidToRole: prev.slidToRole,
          slidDay: prev.slidDay,
        })
      }
    }
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
        rows: rows.sort((a, b) => (a.claimOrder ?? a.seat) - (b.claimOrder ?? b.seat)),
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
      rows: rows.sort((a, b) => (a.claimOrder ?? a.seat) - (b.claimOrder ?? b.seat)),
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
  _maxDay: number,
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
    // Assertions are now day-keyed by bridge (right-aligned)
    for (const [night, { target: targetSeat, species }] of row.assertions) {
      if (night < 0) continue
      const prevList = row.previousAssertions?.get(night)
      timeline.set(night, {
        targetSeat,
        targetName: players.get(targetSeat) ?? `#${targetSeat}`,
        species,
        ...(prevList ? {
          previousAssertions: prevList.map(p => ({
            targetSeat: p.target,
            targetName: players.get(p.target) ?? `#${p.target}`,
            species: p.species,
          })),
        } : {}),
      })
    }
    // Forecasts: show for nights without a reported result
    if (row.claimingRole === 'seer') {
      for (const [night, targetSeat] of row.forecasts) {
        if (!timeline.has(night)) {
          timeline.set(night, {
            targetSeat,
            targetName: players.get(targetSeat) ?? `#${targetSeat}`,
            species: null,
            forecast: true,
          })
        }
      }
    }
  }

  return timeline
}

// --- Vote extraction ---

export function extractVoteStatus(vs: VillageStatus, players: Map<number, string>): VoteStatus {
  const votersBySeat = new Map<number, { seat: number, name: string, votedOrder: number }[]>()
  const pending: { seat: number, name: string }[] = []
  let hasAnyVotes = false
  const excluded = vs.voteFinalRule !== 'revote' ? vs.revoteTargets : new Set<number>()

  for (const [seat, status] of vs.statuses) {
    if (!status.surviving) continue
    if (excluded.has(seat)) continue
    if (status.voted) {
      hasAnyVotes = true
      const target = status.votedTarget
      if (!votersBySeat.has(target)) votersBySeat.set(target, [])
      votersBySeat.get(target)!.push({ seat, name: players.get(seat) ?? `#${seat}`, votedOrder: status.votedOrder })
    } else {
      pending.push({ seat, name: players.get(seat) ?? `#${seat}` })
    }
  }

  // Sort each voter list by vote order
  for (const voters of votersBySeat.values()) {
    voters.sort((a, b) => a.votedOrder - b.votedOrder)
  }

  // Build rows only for players with at least 1 vote
  const rows: VoteRow[] = []
  for (const [seat, status] of vs.statuses) {
    if (!status.surviving) continue
    if (status.votedCount === 0) continue
    rows.push({
      seat,
      name: players.get(seat) ?? `#${seat}`,
      votedCount: status.votedCount,
      voters: votersBySeat.get(seat) ?? [],
    })
  }

  // Sort by votedCount descending, then seat ascending
  rows.sort((a, b) => b.votedCount - a.votedCount || a.seat - b.seat)

  const totalVoters = [...vs.statuses.values()].filter(s => s.surviving).length

  return {
    rows,
    pending,
    remainingVotes: pending.length,
    totalVoters,
    hasAnyVotes,
    executionOccurred: vs.executions.has(vs.day),
    hasMultiVote: vs.hasMultiVote,
  }
}

export function computeVerdicts(status: VoteStatus): Map<number, VoteVerdictInfo> {
  const { rows, remainingVotes, totalVoters } = status
  const verdicts = new Map<number, VoteVerdictInfo>()

  if (rows.length === 0 || status.hasMultiVote) return verdicts

  const maxVotes = Math.max(...rows.map(r => r.votedCount))

  // Compute final verdict for each row
  for (const row of rows) {
    const maxOther = rows.reduce((max, r) => r.seat !== row.seat ? Math.max(max, r.votedCount) : max, 0)

    if (maxOther + remainingVotes < row.votedCount) {
      // 処刑確定: no one can even tie with this candidate
      verdicts.set(row.seat, { verdict: 'execution_locked' })
    } else if (maxOther + remainingVotes <= row.votedCount) {
      // 決戦以上確定: someone can tie but no one can surpass
      verdicts.set(row.seat, { verdict: 'runoff_locked' })
    } else if (row.votedCount + remainingVotes < maxVotes) {
      // 安全域: can't reach current max even with all remaining votes
      verdicts.set(row.seat, { verdict: 'safe' })
    } else {
      verdicts.set(row.seat, { verdict: 'at_risk' })
    }
  }

  // Simulate votes in chronological order to find decisive voters
  const needsDecisive = rows.filter(r => verdicts.get(r.seat)?.verdict !== 'at_risk')
  if (needsDecisive.length > 0) {
    const allVotes: { voterSeat: number, voterName: string, targetSeat: number, votedOrder: number }[] = []
    for (const row of rows) {
      for (const voter of row.voters) {
        allVotes.push({ voterSeat: voter.seat, voterName: voter.name, targetSeat: row.seat, votedOrder: voter.votedOrder })
      }
    }
    allVotes.sort((a, b) => a.votedOrder - b.votedOrder)

    const counts = new Map<number, number>()
    const foundRunoff = new Set<number>()
    const foundExec = new Set<number>()
    const foundSafe = new Set<number>()

    for (let i = 0; i < allVotes.length; i++) {
      const vote = allVotes[i]
      counts.set(vote.targetSeat, (counts.get(vote.targetSeat) ?? 0) + 1)
      const remaining = totalVoters - (i + 1)

      for (const candidate of needsDecisive) {
        const info = verdicts.get(candidate.seat)!
        const cCount = counts.get(candidate.seat) ?? 0
        const maxOther = rows.reduce((max, r) =>
          r.seat !== candidate.seat ? Math.max(max, counts.get(r.seat) ?? 0) : max, 0)

        // Runoff threshold: maxOther + remaining <= cCount
        // The triggering voter is whoever cast this vote (not necessarily for the candidate)
        if (!foundRunoff.has(candidate.seat) && (info.verdict === 'execution_locked' || info.verdict === 'runoff_locked')) {
          if (maxOther + remaining <= cCount) {
            info.runoffVoterName = vote.voterName
            info.runoffVoterOrder = vote.votedOrder
            foundRunoff.add(candidate.seat)
          }
        }

        // Execution threshold: maxOther + remaining < cCount
        if (!foundExec.has(candidate.seat) && info.verdict === 'execution_locked') {
          if (maxOther + remaining < cCount) {
            info.executionVoterName = vote.voterName
            info.executionVoterOrder = vote.votedOrder
            foundExec.add(candidate.seat)
          }
        }

        // Safe threshold: cCount + remaining < currentMax
        if (!foundSafe.has(candidate.seat) && info.verdict === 'safe') {
          const currentMax = rows.reduce((max, r) => Math.max(max, counts.get(r.seat) ?? 0), 0)
          if (cCount + remaining < currentMax) {
            info.savedBy = vote.voterName
            foundSafe.add(candidate.seat)
          }
        }
      }
    }
  }

  return verdicts
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
    case 'sudden_death': return '突然死'
  }
}
