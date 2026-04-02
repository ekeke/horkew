import { readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parse } from '../parser.ts'
import { buildVillageStatus } from '../bridge.ts'
import type { VillageResult, SeatStatus, CauseOfDeath } from '../../types/index.ts'
import type { RevealStatement } from '../statement.ts'

// ── Types ──

export type GameSummary = {
  seed: string
  result: VillageResult
  day: number
  roles: Map<number, string>
  statuses: Map<number, SeatStatus>
}

export type RoleStats = {
  games: number
  survived: number
  totalDaysAlive: number
  minDaysAlive: number
  maxDaysAlive: number
  deathCauses: Record<string, number>
}

export type IterSummary = {
  name: string
  gameCount: number
  results: Record<string, number>
  avgDays: number
  roleStats: Map<string, RoleStats>
}

// ── Loading ──

export function loadGames(dirPath: string): GameSummary[] {
  const files = readdirSync(dirPath).filter(f => f.endsWith('.howl')).sort()
  return files.map(file => {
    const text = readFileSync(join(dirPath, file), 'utf-8')
    const { meta, statements } = parse(text)
    const { vs, players } = buildVillageStatus(statements, meta)

    const nameToSeat = new Map<string, number>()
    for (const [seat, name] of players) nameToSeat.set(name, seat)

    const roles = new Map<number, string>()
    for (const stmt of statements) {
      if (stmt.type !== 'reveal') continue
      const reveal = stmt as RevealStatement
      const seat = nameToSeat.get(reveal.player)
      if (seat != null) roles.set(seat, reveal.role)
    }

    return {
      seed: file.replace('.howl', ''),
      result: vs.result,
      day: vs.day,
      roles,
      statuses: vs.statuses,
    }
  })
}

// ── Aggregation ──

function emptyRoleStats(): RoleStats {
  return { games: 0, survived: 0, totalDaysAlive: 0, minDaysAlive: Infinity, maxDaysAlive: 0, deathCauses: {} }
}

export function summarizeIter(name: string, games: GameSummary[]): IterSummary {
  const results: Record<string, number> = {}
  let totalDays = 0
  const roleStats = new Map<string, RoleStats>()

  for (const game of games) {
    const key = game.result ?? 'unknown'
    results[key] = (results[key] ?? 0) + 1
    totalDays += game.day

    for (const [seat, role] of game.roles) {
      if (!roleStats.has(role)) roleStats.set(role, emptyRoleStats())
      const rs = roleStats.get(role)!
      rs.games++

      const status = game.statuses.get(seat)
      if (!status) continue

      const daysAlive = status.surviving ? game.day : (status.diedDay ?? 1)
      rs.totalDaysAlive += daysAlive
      if (daysAlive < rs.minDaysAlive) rs.minDaysAlive = daysAlive
      if (daysAlive > rs.maxDaysAlive) rs.maxDaysAlive = daysAlive

      if (status.surviving) {
        rs.survived++
      } else {
        const cause = status.causeOfDeath ?? 'unknown'
        rs.deathCauses[cause] = (rs.deathCauses[cause] ?? 0) + 1
      }
    }
  }

  return {
    name,
    gameCount: games.length,
    results,
    avgDays: games.length > 0 ? totalDays / games.length : 0,
    roleStats,
  }
}

// ── Formatting ──

const RESULT_ORDER: { key: string, label: string }[] = [
  { key: 'villager_won', label: 'Village' },
  { key: 'werewolf_won', label: 'Wolf' },
  { key: 'werehamster_won', label: 'Hamster' },
  { key: 'draw', label: 'Draw' },
]

const DEATH_CAUSES: CauseOfDeath[] = [
  'execution', 'night_kill',
  'cursed_by_executed_nekomata', 'cursed_by_killed_nekomata',
  'follow_executed_hamster', 'follow_killed_hamster',
]

const CAUSE_SHORT: Record<string, string> = {
  execution: 'exec',
  night_kill: 'kill',
  cursed_by_executed_nekomata: 'curse_e',
  cursed_by_killed_nekomata: 'curse_k',
  follow_executed_hamster: 'follow_e',
  follow_killed_hamster: 'follow_k',
}

function pct(n: number, total: number): string {
  if (total === 0) return '  -  '
  return (n / total * 100).toFixed(1).padStart(5) + '%'
}

function pad(s: string | number, w: number): string {
  return String(s).padStart(w)
}

function roleOrder(roleStats: Map<string, RoleStats>): string[] {
  return [...roleStats.keys()].sort((a, b) => (roleStats.get(b)!.games - roleStats.get(a)!.games))
}

function formatSingle(s: IterSummary): string {
  const lines: string[] = []
  lines.push(`=== ${s.name} (${s.gameCount} games) ===`)
  lines.push('')
  lines.push('Win Rates:')
  for (const { key, label } of RESULT_ORDER) {
    const n = s.results[key] ?? 0
    lines.push(`  ${label.padEnd(10)} ${pct(n, s.gameCount)}  (${pad(n, 3)})`)
  }
  lines.push('')
  lines.push(`Avg game length: ${s.avgDays.toFixed(1)} days`)
  lines.push('')

  const causeHeaders = DEATH_CAUSES.map(c => CAUSE_SHORT[c] ?? c)
  const hdr = '  ' + 'Role'.padEnd(14)
    + pad('Games', 6)
    + pad('Surv%', 7)
    + pad('AvgDay', 7)
    + pad('Min', 5)
    + pad('Max', 5)
    + causeHeaders.map(h => pad(h, 9)).join('')
  lines.push('Per-Role Stats:')
  lines.push(hdr)

  for (const role of roleOrder(s.roleStats)) {
    const rs = s.roleStats.get(role)!
    const avgDay = (rs.totalDaysAlive / rs.games).toFixed(1)
    const min = rs.minDaysAlive === Infinity ? '-' : String(rs.minDaysAlive)
    const max = String(rs.maxDaysAlive)
    const causeCols = DEATH_CAUSES.map(c => pad(rs.deathCauses[c] ?? 0, 9)).join('')
    lines.push('  ' + role.padEnd(14)
      + pad(rs.games, 6)
      + ' ' + pct(rs.survived, rs.games)
      + pad(avgDay, 7)
      + pad(min, 5)
      + pad(max, 5)
      + causeCols)
  }

  return lines.join('\n')
}

function formatComparison(summaries: IterSummary[]): string {
  const lines: string[] = []
  const colW = 12
  const labelW = 16

  lines.push('=== Comparison ===')
  lines.push('')
  lines.push(''.padEnd(labelW) + summaries.map(s => pad(s.name, colW)).join(''))
  lines.push('')
  lines.push('Games:'.padEnd(labelW) + summaries.map(s => pad(s.gameCount, colW)).join(''))

  for (const { key, label } of RESULT_ORDER) {
    lines.push((label + ':').padEnd(labelW) + summaries.map(s => {
      const n = s.results[key] ?? 0
      return pad(pct(n, s.gameCount), colW)
    }).join(''))
  }

  lines.push('Avg length:'.padEnd(labelW) + summaries.map(s => pad(s.avgDays.toFixed(1), colW)).join(''))

  // Per-role survival rate
  const allRoles = new Set<string>()
  for (const s of summaries) for (const r of s.roleStats.keys()) allRoles.add(r)
  const roles = [...allRoles].sort((a, b) => {
    const maxA = Math.max(...summaries.map(s => s.roleStats.get(a)?.games ?? 0))
    const maxB = Math.max(...summaries.map(s => s.roleStats.get(b)?.games ?? 0))
    return maxB - maxA
  })

  lines.push('')
  lines.push('Survival Rate:')
  lines.push(''.padEnd(labelW) + summaries.map(s => pad(s.name, colW)).join(''))
  for (const role of roles) {
    lines.push(('  ' + role).padEnd(labelW) + summaries.map(s => {
      const rs = s.roleStats.get(role)
      if (!rs || rs.games === 0) return pad('-', colW)
      return pad(pct(rs.survived, rs.games), colW)
    }).join(''))
  }

  return lines.join('\n')
}

export function formatSummary(summaries: IterSummary[]): string {
  if (summaries.length === 1) return formatSingle(summaries[0])
  const parts = summaries.map(formatSingle)
  parts.push('')
  parts.push(formatComparison(summaries))
  return parts.join('\n\n')
}

export function formatJson(summaries: IterSummary[]): string {
  return JSON.stringify(summaries.map(s => ({
    ...s,
    roleStats: Object.fromEntries(s.roleStats),
  })), null, 2)
}

// ── CLI ──

function main() {
  const args = process.argv.slice(2)
  const dirs: string[] = []
  let json = false

  for (const arg of args) {
    if (arg === '--json') { json = true; continue }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: eval-summary <dir> [dir...] [--json]')
      console.log('  Summarize eval howl files from one or more iter directories.')
      process.exit(0)
    }
    dirs.push(arg)
  }

  if (dirs.length === 0) {
    console.error('Error: no directories specified. Usage: eval-summary <dir> [dir...]')
    process.exit(1)
  }

  const summaries = dirs.map(dir => {
    const name = basename(dir) || dir
    const games = loadGames(dir)
    return summarizeIter(name, games)
  })

  console.log(json ? formatJson(summaries) : formatSummary(summaries))
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('howl/scripts/eval-summary.ts')
if (isDirectRun) main()
