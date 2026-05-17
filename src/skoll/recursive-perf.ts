/**
 * 単純再帰 skoll のパフォーマンス計測
 *
 * 同じ bloodhound seed=904995 log を Day 2/3/4/5 朝の各 cutoff で truncate し、
 * single-day skoll と recursive skoll の elapsed を計測する。
 *
 * 実行: node --experimental-strip-types src/skoll/recursive-perf.ts
 */

import { readFileSync } from 'node:fs'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { retarResultToPossibilities, DEFAULT_RETAR_OPTIONS } from '../fenrir/src/retar-bridge.ts'
import { precomputeSkoll } from '../bloodhound/skoll-precompute.ts'
import { recursiveSkoll } from './recursive.ts'

const LOG_PATH = 'logs/bloodhound/2026-05-17T07-17-55-720Z/game.howl'

const CUTOFFS = [
  { day: 2, line: 79 },
  { day: 3, line: 141 },
  { day: 4, line: 194 },
  { day: 5, line: 238 },
]

function loadStateAtCutoff(cutoffLine: number) {
  const fullText = readFileSync(LOG_PATH, 'utf-8')
  const lines = fullText.split('\n')
  const partial = lines.slice(0, cutoffLine).join('\n') + '\n'

  const { meta, statements } = parse(partial)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) {
    throw new Error(`Parser produced ${unknowns.length} unknown statements at line ${cutoffLine}`)
  }

  const { vs, setup } = buildVillageStatus(statements, meta)
  if (!vs || !setup) throw new Error(`buildVillageStatus failed at line ${cutoffLine}`)

  const options: AnalyzeOptions = DEFAULT_RETAR_OPTIONS
  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyzeSafe()
  if (result.error || !result.result) throw new Error(`Retar failed at line ${cutoffLine}: ${result.error}`)

  const possibilities = retarResultToPossibilities(
    { possibilities: result.result, maxSurvivingNV: result.maxSurvivingNV },
    setup,
  )

  return { vs, setup, possibilities }
}

function aliveCount(vs: { statuses: Map<number, { surviving: boolean }> }): number {
  let n = 0
  for (const [, status] of vs.statuses) if (status.surviving) n++
  return n
}

function main() {
  console.log('=== Recursive skoll perf (seed=904995) ===\n')
  console.log('Day | Alive | Worlds | Single ms | Recursive ms | Pairs | ms/pair')
  console.log('----|-------|--------|-----------|--------------|-------|--------')

  for (const cutoff of CUTOFFS) {
    const { vs, setup, possibilities } = loadStateAtCutoff(cutoff.line)
    const alive = aliveCount(vs)

    // Warm up (JIT)
    precomputeSkoll({ possibilities, vs, setup })

    const t0 = Date.now()
    const single = precomputeSkoll({ possibilities, vs, setup })
    const t1 = Date.now()
    const singleMs = t1 - t0

    const t2 = Date.now()
    recursiveSkoll(possibilities, setup, vs)
    const t3 = Date.now()
    const recMs = t3 - t2

    const pairs = alive * (alive - 1)  // X × Y (Y ≠ X)
    const msPerPair = recMs / pairs

    console.log(
      `  ${cutoff.day} |   ${alive.toString().padStart(2)}  | ${single.totalWorlds.toString().padStart(6)} |  ${singleMs.toString().padStart(7)} |  ${recMs.toString().padStart(10)} | ${pairs.toString().padStart(5)} | ${msPerPair.toFixed(2).padStart(6)}`
    )
  }
}

main()
