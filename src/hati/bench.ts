/**
 * Hati ベンチマーク: small-8p 100ゲーム + 14d-neko seed=0
 * verify.ts と同じロジックでゲーム→howl→パース→hati を実行
 */
import type { SystemRole } from '../types/index.ts'
import type { GameState } from '../lupa/types.ts'
import { runGame } from '../lupa/engine.ts'
import { strategyAdapter } from '../verify/strategy-adapter.ts'
import { RuleBasedAgent as HeuristicStrategy, WolfTeamRuleAgent as WolfTeamHeuristic, MasonTeamRuleAgent as MasonTeamHeuristic } from '../fenrir/src/agents/rule-based-agent.ts'
import { formatHowl } from '../lupa/format.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { searchTsumi, searchTsumiStrategy } from './index.ts'
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
  id: 0,
  batches: 1,
  batch: 0,
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

type Config = {
  name: string
  roles: Map<SystemRole, number>
  seeds: [number, number]
  hasFirstGhost?: boolean
}

async function benchConfig(cfg: Config) {
  resetEndgameStats()

  let totalMs = 0
  let maxMs = 0
  let count = 0
  const perDay: Map<number, { totalMs: number, count: number, maxMs: number, maxNodes: number, times: number[] }> = new Map()

  for (let seed = cfg.seeds[0]; seed < cfg.seeds[1]; seed++) {
    let events: any[], state: GameState
    try {
      const gameConfig = {
        roles: cfg.roles, seed,
        hasFirstGhost: cfg.hasFirstGhost,
        revoteConfig: { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const },
      }
      const handlers = strategyAdapter({
        defaultStrategy: new HeuristicStrategy(),
        wolfTeamStrategy: new WolfTeamHeuristic(),
        masonTeamStrategy: new MasonTeamHeuristic(),
        enableRetar: false,
        seed,
        roles: cfg.roles,
      })
      const result = await runGame(gameConfig, handlers)
      events = result.events; state = result.state
    } catch (e) { console.error('  game error:', e); continue }

    const howl = formatHowl(events, state, {
      roles: cfg.roles, seed,
      hasFirstGhost: cfg.hasFirstGhost,
    })
    const checkpoints = findExecutionCheckpoints(howl)

    for (const cp of checkpoints) {
      const truncated = howl.split('\n').slice(0, cp.line - 1).join('\n')
      try {
        const { meta, statements } = parse(truncated)
        const { vs, setup } = buildVillageStatus(statements, meta)
        const opts = cfg.hasFirstGhost ? { ...ANALYZE_OPTIONS, hasFirstGhost: true } : ANALYZE_OPTIONS
        const r = searchTsumi(vs, setup, opts)
        let searchElapsed = 0
        let nodesVisited = 0
        if (r.isTsumi) {
          const sr = searchTsumiStrategy(r)
          searchElapsed = sr.searchElapsed
          nodesVisited = sr.nodesVisited
        }
        totalMs += searchElapsed
        if (searchElapsed > maxMs) maxMs = searchElapsed
        count++

        const d = perDay.get(cp.day) ?? { totalMs: 0, count: 0, maxMs: 0, maxNodes: 0, times: [] }
        d.totalMs += searchElapsed
        d.count++
        d.times.push(searchElapsed)
        if (searchElapsed > d.maxMs) d.maxMs = searchElapsed
        if (nodesVisited > d.maxNodes) d.maxNodes = nodesVisited
        perDay.set(cp.day, d)
      } catch (e) { console.error('  parse error:', e); continue }
    }
  }

  const eg = getEndgameStats()
  console.log(`${cfg.name} (seeds ${cfg.seeds[0]}-${cfg.seeds[1]}):`)
  console.log(`  ${count} checkpoints, avg ${count > 0 ? (totalMs / count).toFixed(2) : 'N/A'}ms, max ${maxMs.toFixed(1)}ms`)

  for (const [day, d] of [...perDay.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`    Day${day}: avg ${(d.totalMs / d.count).toFixed(2)}ms, max ${d.maxMs.toFixed(1)}ms, maxNodes ${d.maxNodes}`)
    if (d.times.length > 0) {
      d.times.sort((a, b) => a - b)
      const p50 = d.times[Math.floor(d.times.length * 0.5)]
      const p90 = d.times[Math.floor(d.times.length * 0.9)]
      const p95 = d.times[Math.floor(d.times.length * 0.95)]
      const p99 = d.times[Math.floor(d.times.length * 0.99)]
      console.log(`           p50=${p50.toFixed(2)}ms p90=${p90.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms`)
    }
  }
  console.log(`  endgame: ${eg.size} entries, ${eg.hits} hits`)
}

console.log('=== Hati Benchmark ===\n')
const t0 = performance.now()

await benchConfig({
  name: 'small-8p',
  roles: new Map<SystemRole, number>([
    ['werewolf', 1], ['villager', 4], ['seer', 1], ['mason', 2],
  ]),
  seeds: [0, 100],
})

console.log('')

await benchConfig({
  name: '14d-neko',
  roles: new Map<SystemRole, number>([
    ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
    ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
  ]),
  seeds: [0, 1],
  hasFirstGhost: true,
})

console.log('')

await benchConfig({
  name: '14d-neko-10k',
  roles: new Map<SystemRole, number>([
    ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
    ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
  ]),
  seeds: [10000, 20000],
  hasFirstGhost: true,
})

console.log(`\nTotal wall: ${(performance.now() - t0).toFixed(0)}ms`)
