import type { SystemRole } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'
import type { LupaConfig } from './types.ts'
import { runGame } from './engine.ts'
import { formatHowl } from './format.ts'
import { parse } from '../howl/index.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { searchTsumi } from '../hati/index.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from './heuristic.ts'
import { RandomStrategy } from './random-strategy.ts'
import { findScenario, scenarioToRoles, scenarios } from './scenarios.ts'
import type { AnalyzeOptions } from '../retar/index.ts'

type CliOptions = {
  config: LupaConfig
  tsumi: boolean
  stats: boolean
  games: number
}

function parseArgs(args: string[]): CliOptions {
  const roles = new Map<SystemRole, number>()
  let seed: number | undefined
  let verify = false
  let useRandomNames = false
  let tsumi = false
  let stats = false
  let heuristic = false
  let hasFirstGhost = false
  let games = 1
  let revoteConfig: import('./types.ts').RevoteConfig | undefined
  const randomRoles: SystemRole[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--test') { verify = true; continue }
    if (arg === '--use-random-names') { useRandomNames = true; continue }
    if (arg === '--tsumi') { tsumi = true; continue }
    if (arg === '--stats') { stats = true; continue }
    if (arg === '--heuristic') { heuristic = true; continue }
    if (arg === '--random-roles' && i + 1 < args.length) {
      const roleNames = args[++i].split(',')
      for (const rn of roleNames) {
        const role = rn.trim() as SystemRole
        if (!systemRoles.has(role)) {
          console.error(`不明な役職: ${role}`)
          console.error(`利用可能: ${Array.from(systemRoles.keys()).join(', ')}`)
          process.exit(1)
        }
        randomRoles.push(role)
      }
      continue
    }
    if (arg === '--first-ghost') { hasFirstGhost = true; continue }
    if (arg === '--revote-draw') { revoteConfig = { maxRevotes: 2, style: 'full_revote', tiebreaker: 'draw' }; continue }
    if (arg === '--scenario' && i + 1 < args.length) {
      const name = args[++i]
      const scenario = findScenario(name)
      if (!scenario) {
        console.error(`不明なシナリオ: ${name}`)
        console.error(`利用可能: ${scenarios.map(s => s.name).join(', ')}`)
        process.exit(1)
      }
      for (const [role, count] of Object.entries(scenario.roles)) {
        roles.set(role as SystemRole, count)
      }
      if (scenario.hasFirstGhost) hasFirstGhost = true
      if (scenario.revoteConfig) revoteConfig = scenario.revoteConfig
      continue
    }
    if (arg.startsWith('--seed=')) { seed = parseInt(arg.slice(7), 10); continue }
    if (arg === '--seed' && i + 1 < args.length) { seed = parseInt(args[++i], 10); continue }
    if (arg.startsWith('--games=')) { games = parseInt(arg.slice(8), 10); continue }
    if (arg === '--games' && i + 1 < args.length) { games = parseInt(args[++i], 10); continue }

    const match = arg.match(/^(\w+):(\d+)$/)
    if (match) {
      const role = match[1] as SystemRole
      if (!systemRoles.has(role)) {
        console.error(`不明な役職: ${role}`)
        console.error(`利用可能: ${Array.from(systemRoles.keys()).join(', ')}`)
        process.exit(1)
      }
      roles.set(role, parseInt(match[2], 10))
    }
  }

  if (roles.size === 0) {
    console.error('使用法: node --experimental-strip-types src/lupa/cli.ts <role:count>... [options]')
    console.error('例: node --experimental-strip-types src/lupa/cli.ts werewolf:1 villager:4 seer:1 mason:2 --tsumi --games 100')
    console.error('    node --experimental-strip-types src/lupa/cli.ts werewolf:3 villager:2 seer:1 medium:1 bodyguard:1 mason:2 nekomata:1 fanatic:1 werehamster:1 immoralist:1 --heuristic --stats --games 1000 --first-ghost --revote-draw')
    process.exit(1)
  }

  const totalPlayers = Array.from(roles.values()).reduce((a, b) => a + b, 0)
  const config: LupaConfig = { roles, seed, verify, useRandomNames, hasFirstGhost, revoteConfig }

  if (heuristic) {
    const h = new HeuristicStrategy()
    const strategies = new Map<number, import('./strategy.ts').Strategy>()
    for (let s = 1; s <= totalPlayers; s++) strategies.set(s, h)
    config.strategies = strategies
    config.wolfTeamStrategy = new WolfTeamHeuristic()
    config.masonTeamStrategy = new MasonTeamHeuristic()

    if (randomRoles.length > 0) {
      const randomRoleSet = new Set(randomRoles)
      const r = new RandomStrategy()
      config.onRolesAssigned = (seatRoles: Map<number, SystemRole>) => {
        for (const [seat, role] of seatRoles) {
          if (randomRoleSet.has(role)) {
            strategies.set(seat, r)
          }
        }
      }
    }
  }

  return { config, tsumi, stats, games }
}

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

function findExecutionLines(howl: string): number[] {
  const lines = howl.split('\n')
  const result: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/処刑$/)) {
      result.push(i + 1) // 1-indexed
    }
  }
  return result
}

function truncateHowl(howl: string, upToLine: number): string {
  return howl.split('\n').slice(0, upToLine - 1).join('\n')
}

function strategyOneLiner(node: import('../hati/types.ts').StrategyNode): string {
  if (node.type === 'win') return '村勝利'
  const parts: string[] = []
  if (node.action.execute !== -1) parts.push(`処刑 ${node.action.execute}`)
  const entries = Object.entries(node.branches)
  if (entries.length === 1 && entries[0][0] === 'win') {
    parts.push('→ 村勝利')
  }
  return parts.join(' ')
}

function runTsumiCheck(howl: string, execLine: number, _day: number): {
  found: boolean
  worlds: number
  elapsed: number
  summary: string
} {
  const truncated = truncateHowl(howl, execLine)
  try {
    const { meta, statements } = parse(truncated)
    const { vs, setup } = buildVillageStatus(statements, meta)
    const result = searchTsumi(vs, setup, ANALYZE_OPTIONS)
    const summary = result.isTsumi && result.strategy
      ? strategyOneLiner(result.strategy)
      : ''
    return {
      found: result.isTsumi,
      worlds: result.stats.worldsTotal,
      elapsed: result.stats.elapsed,
      summary,
    }
  } catch {
    return { found: false, worlds: 0, elapsed: 0, summary: '' }
  }
}

const { config, tsumi, stats, games } = parseArgs(process.argv.slice(2))

if (stats) {
  // 勝率統計モード
  const baseSeed = config.seed ?? Date.now()
  const counts: Record<string, number> = {}
  let totalLen = 0

  for (let g = 0; g < games; g++) {
    const seed = baseSeed + g
    try {
      const { state } = runGame({ ...config, seed })
      const result = state.result ?? 'unknown'
      counts[result] = (counts[result] ?? 0) + 1
      totalLen += state.day
    } catch (e) {
      console.error(`seed=${seed} エラー: ${e instanceof Error ? e.message : e}`)
    }
  }

  for (const [k, v] of Object.entries(counts)) {
    console.log(`${k}: ${v} (${(v / games * 100).toFixed(1)}%)`)
  }
  console.log(`avgLen: ${(totalLen / games).toFixed(1)}`)
} else if (!tsumi) {
  // 通常モード: howl出力のみ
  const { events, state } = runGame(config)
  console.log(formatHowl(events, state, config))
} else if (games === 1) {
  // 単発tsumi: howl出力 + 各日の詰みチェック
  const seed = config.seed ?? Date.now()
  const { events, state } = runGame({ ...config, seed })
  const howl = formatHowl(events, state, { ...config, seed })
  const execLines = findExecutionLines(howl)

  console.log(howl)
  console.log('')

  for (let i = 0; i < execLines.length; i++) {
    const day = i + 1
    const check = runTsumiCheck(howl, execLines[i], day)
    if (check.found) {
      console.log(`# [Hati] Day ${day}: 詰み → ${check.summary} (${check.worlds}世界, ${check.elapsed.toFixed(1)}ms)`)
    } else {
      console.log(`# [Hati] Day ${day}: 詰みなし (${check.worlds}世界, ${check.elapsed.toFixed(1)}ms)`)
    }
  }
} else {
  // 複数ゲーム: 統計モード
  let tsumiGames = 0
  const baseSeed = config.seed ?? Date.now()

  for (let g = 0; g < games; g++) {
    const seed = baseSeed + g
    try {
      const { events, state } = runGame({ ...config, seed })
      const howl = formatHowl(events, state, { ...config, seed })
      const execLines = findExecutionLines(howl)

      let found = false
      for (let i = 0; i < execLines.length; i++) {
        const day = i + 1
        const check = runTsumiCheck(howl, execLines[i], day)
        if (check.found) {
          console.log(`seed=${seed} Day${day} 詰み → ${check.summary} (${check.worlds}世界, ${check.elapsed.toFixed(1)}ms)`)
          found = true
          break // 最初の詰みのみ報告
        }
      }
      if (!found) {
        console.log(`seed=${seed} 詰みなし`)
      }
      if (found) tsumiGames++
    } catch (e) {
      console.log(`seed=${seed} エラー: ${e instanceof Error ? e.message : e}`)
    }
  }

  console.log(`\n=== ${games}ゲーム / 詰み発見: ${tsumiGames} (${(tsumiGames / games * 100).toFixed(1)}%) ===`)
}
