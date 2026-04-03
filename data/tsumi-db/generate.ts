/**
 * 詰み盤面 DB 生成
 *
 * ランダム戦略でゲームを実行 → 各処刑チェックポイントで Hati 判定 →
 * 詰みが見つかったゲームを howl で保存 + manifest に記録。
 *
 * Usage:
 *   node --experimental-strip-types data/tsumi-db/generate.ts [--games N] [--seed N]
 */

import type { SystemRole } from '../../src/types/index.ts'
import type { GameEvent, GameState } from '../../src/lupa/types.ts'
import { runGame } from '../../src/lupa/engine.ts'
import { strategyAdapter } from '../../src/verify/strategy-adapter.ts'
import { RandomStrategy, WolfTeamRandom, MasonTeamRandom } from '../../src/verify/random-strategy.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from '../../src/fenrir/src/heuristic.ts'
import { formatHowl } from '../../src/lupa/format.ts'
import { parse } from '../../src/howl/parser.ts'
import { buildVillageStatus } from '../../src/howl/bridge.ts'
import { searchTsumi, searchTsumiStrategy } from '../../src/hati/index.ts'
import type { AnalyzeOptions } from '../../src/retar/index.ts'
import { resolveRules } from '../../src/howl/ruleset.ts'
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    games: { type: 'string', default: '5000' },
    seed: { type: 'string', default: '0' },
    heuristic: { type: 'boolean', default: false },
  },
})

const NUM_GAMES = parseInt(args.games!)
const BASE_SEED = parseInt(args.seed!)
const USE_HEURISTIC = args.heuristic!

const ANALYZE_OPTIONS: AnalyzeOptions = {
  seerClaimingDueDate: 2,
  mediumClaimingDueDate: 2,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  hasFirstGhost: true,
  assumptions: new Map(),
  wolfPairDenyals: [],
  hocusPocus: new Map(),
}

// 14人村
const ROLES_14: Map<SystemRole, number> = new Map([
  ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['werewolf', 3], ['fanatic', 1],
  ['werehamster', 1], ['immoralist', 1],
])

const TOTAL_PLAYERS = [...ROLES_14.values()].reduce((a, b) => a + b, 0)

type ManifestEntry = {
  seed: number
  players: number
  file: string
  tsumi: Array<{
    day: number
    target: number
    alive: number
    strategyDepth: number
  }>
  result: string
}

function findExecutionCheckpoints(howl: string): { lineIndex: number, day: number }[] {
  const lines = howl.split('\n')
  const result: { lineIndex: number, day: number }[] = []
  let day = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/処刑$/)) {
      day++
      result.push({ lineIndex: i + 1, day })
    }
  }
  return result
}

/** strategy tree の最大深さを計算 */
function strategyDepth(node: import('../../src/hati/types.ts').StrategyNode): number {
  if (node.type === 'win') return 0
  const branches = Object.values(node.branches)
  if (branches.length === 0) return 1
  return 1 + Math.max(...branches.map(strategyDepth))
}

async function main() {
  const dir = `data/tsumi-db/${TOTAL_PLAYERS}p`
  mkdirSync(dir, { recursive: true })

  const manifestPath = `${dir}/manifest.ndjson`
  // 既存の seed を読み込み（重複回避）
  const existingSeeds = new Set<number>()
  if (existsSync(manifestPath)) {
    const text = readFileSync(manifestPath, 'utf-8')
    for (const line of text.split('\n').filter(Boolean)) {
      const entry = JSON.parse(line)
      existingSeeds.add(entry.seed)
    }
  }

  console.log(`=== 詰み盤面 DB 生成 ===`)
  console.log(`  strategy: ${USE_HEURISTIC ? 'heuristic' : 'random'}`)
  console.log(`  players: ${TOTAL_PLAYERS}`)
  console.log(`  games: ${NUM_GAMES}`)
  console.log(`  seed range: ${BASE_SEED}..${BASE_SEED + NUM_GAMES - 1}`)
  console.log(`  output: ${dir}/`)
  console.log(`  existing: ${existingSeeds.size} games`)
  console.log()

  let gamesWithTsumi = 0
  let totalTsumiDays = 0
  let totalCheckpoints = 0
  let maxDepth = 0

  for (let i = 0; i < NUM_GAMES; i++) {
    const seed = BASE_SEED + i
    if (existingSeeds.has(seed)) continue

    let events: GameEvent[], state: GameState
    try {
      const handlers = strategyAdapter({
        defaultStrategy: USE_HEURISTIC ? new HeuristicStrategy() : new RandomStrategy(),
        wolfTeamStrategy: USE_HEURISTIC ? new WolfTeamHeuristic() : new WolfTeamRandom(),
        masonTeamStrategy: USE_HEURISTIC ? new MasonTeamHeuristic() : new MasonTeamRandom(),
        enableRetar: false,
        seed,
        roles: ROLES_14,
      })
      const result = await runGame({
        roles: ROLES_14, seed,
        hasFirstGhost: true,
        revoteConfig: { maxRounds: 1 },
        rules: resolveRules(),
      }, handlers)
      events = result.events
      state = result.state
    } catch { continue }

    const howl = formatHowl(events, state, {
      roles: ROLES_14, seed,
      hasFirstGhost: true,
    })

    const checkpoints = findExecutionCheckpoints(howl)
    const tsumiDays: ManifestEntry['tsumi'] = []

    for (const cp of checkpoints) {
      totalCheckpoints++
      // 処刑直前の状態で判定
      const truncated = howl.split('\n').slice(0, cp.lineIndex - 1).join('\n')
      try {
        const { meta, statements } = parse(truncated)
        const { vs, setup } = buildVillageStatus(statements, meta)
        const r = searchTsumi(vs, setup, ANALYZE_OPTIONS)
        if (r.isTsumi) {
          const sr = searchTsumiStrategy(r, { maxDepth: 6 })
          if (sr.strategy?.type === 'action') {
            const depth = strategyDepth(sr.strategy)
            if (depth > maxDepth) maxDepth = depth
            tsumiDays.push({
              day: cp.day,
              target: sr.strategy.action.execute,
              alive: r.judgment.alive,
              strategyDepth: depth,
            })
          }
        }
      } catch { /* parse/retar error, skip */ }
    }

    if (tsumiDays.length > 0) {
      gamesWithTsumi++
      totalTsumiDays += tsumiDays.length

      // howl ファイル保存
      const fileName = `seed_${seed}.howl`
      writeFileSync(`${dir}/${fileName}`, howl)

      // manifest に追記
      const gameResult = state.result ?? 'unknown'
      const entry: ManifestEntry = {
        seed,
        players: TOTAL_PLAYERS,
        file: fileName,
        tsumi: tsumiDays,
        result: gameResult,
      }
      appendFileSync(manifestPath, JSON.stringify(entry) + '\n')
    }

    if ((i + 1) % 500 === 0) {
      console.log(`  ${i + 1}/${NUM_GAMES} games | ${gamesWithTsumi} with tsumi (${totalTsumiDays} days) | maxDepth=${maxDepth}`)
    }
  }

  console.log()
  console.log(`=== 完了 ===`)
  console.log(`  Games processed: ${NUM_GAMES}`)
  console.log(`  Games with tsumi: ${gamesWithTsumi} (${(gamesWithTsumi / NUM_GAMES * 100).toFixed(1)}%)`)
  console.log(`  Total tsumi days: ${totalTsumiDays}`)
  console.log(`  Total checkpoints: ${totalCheckpoints}`)
  console.log(`  Tsumi rate: ${(totalTsumiDays / totalCheckpoints * 100).toFixed(2)}% of all checkpoints`)
  console.log(`  Max strategy depth: ${maxDepth}`)
}

main().catch(err => { console.error(err); process.exit(1) })
