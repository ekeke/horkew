/**
 * Hati ミニベンチマーク: small-8p 100ゲーム + 14d-neko seed=0 の Day3-5 のみ
 */
import type { SystemRole } from '../types/index.ts'
import type { GameEvent, GameState } from '../lupa/types.ts'
import { runGame } from '../lupa/engine.ts'
import { formatHowl } from '../lupa/format.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { searchTsumi } from './index.ts'
import { resetEndgameStats, getEndgameStats } from './search.ts'
import type { AnalyzeOptions } from '../retar/index.ts'

const ANALYZE_OPTIONS: AnalyzeOptions = {
  seerClaimingDueDate: 2,
  mediumClaimingDueDate: 2,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  hasFirstGhost: false,
  assumptions: new Map(),
  wolfPairDenyals: [],
  hocusPocus: new Map(),
}

function findExecutionCheckpoints(howl: string): { line: number, day: number }[] {
  const lines = howl.split('\n')
  const result: { line: number, day: number }[] = []
  let day = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/処刑$/)) {
      day++
      result.push({ line: i + 1, day })
    }
  }
  return result
}

// --- small-8p ---
function benchSmall8p() {
  const roles = new Map<SystemRole, number>([
    ['werewolf', 1], ['villager', 4], ['seer', 1], ['mason', 2],
  ])
  resetEndgameStats()
  let totalMs = 0, maxMs = 0, count = 0
  const t0 = performance.now()

  for (let seed = 0; seed < 100; seed++) {
    let events: GameEvent[], state: GameState
    try {
      const r = runGame({ roles, seed, revoteConfig: { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const } })
      events = r.events; state = r.state
    } catch { continue }

    const howl = formatHowl(events, state, { roles, seed })
    for (const cp of findExecutionCheckpoints(howl)) {
      const truncated = howl.split('\n').slice(0, cp.line - 1).join('\n')
      try {
        const { meta, statements } = parse(truncated)
        const { vs, setup } = buildVillageStatus(statements, meta)
        const r = searchTsumi(vs, setup, ANALYZE_OPTIONS)
        totalMs += r.stats.searchElapsed
        if (r.stats.searchElapsed > maxMs) maxMs = r.stats.searchElapsed
        count++
      } catch { continue }
    }
  }

  const wallMs = performance.now() - t0
  const eg = getEndgameStats()
  console.log(`small-8p (100 games): ${count} cps, avg ${(totalMs/count).toFixed(2)}ms, max ${maxMs.toFixed(1)}ms, wall ${wallMs.toFixed(0)}ms`)
  console.log(`  endgame: ${eg.size} entries, ${eg.hits} hits`)
}

// --- 14d-neko seed=0, Day3-5 only ---
function bench14dNeko() {
  const roles = new Map<SystemRole, number>([
    ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
    ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
  ])
  resetEndgameStats()

  const r = runGame({
    roles, seed: 0, hasFirstGhost: true,
    revoteConfig: { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const },
  })
  const howl = formatHowl(r.events, r.state, { roles, seed: 0, hasFirstGhost: true })
  const allCps = findExecutionCheckpoints(howl)
  // Day2以降（Day1はタイムアウト）
  const cps = allCps.filter(cp => cp.day >= 2)

  console.log(`14d-neko seed=0 (Day2+, ${cps.length} cps):`)

  for (const cp of cps) {
    const truncated = howl.split('\n').slice(0, cp.line - 1).join('\n')
    try {
      const { meta, statements } = parse(truncated)
      const { vs, setup } = buildVillageStatus(statements, meta)
      const opts = { ...ANALYZE_OPTIONS, hasFirstGhost: true }
      const result = searchTsumi(vs, setup, opts)
      console.log(`  Day${cp.day}: ${result.stats.searchElapsed.toFixed(1)}ms (${result.stats.nodesVisited} nodes, ${result.stats.worldsTotal} worlds) ${result.isTsumi ? '詰み' : '-'}`)
    } catch (e) {
      console.log(`  Day${cp.day}: error`)
    }
  }
  const eg = getEndgameStats()
  console.log(`  endgame: ${eg.size} entries, ${eg.hits} hits`)
}

const t0 = performance.now()
console.log('=== Hati Benchmark ===')
benchSmall8p()
console.log('')
bench14dNeko()
console.log(`\nTotal wall: ${(performance.now() - t0).toFixed(0)}ms`)
