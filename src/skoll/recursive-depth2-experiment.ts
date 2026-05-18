/**
 * 再帰 skoll depth=2 spot check + perf 計測
 *
 * bloodhound seed=904995 の Day N 朝の盤面を再現し、 depth=1 / depth=2 の
 * per-X 期待値と elapsed を比較する。
 *
 * 実行例:
 *   node --experimental-strip-types src/skoll/recursive-depth2-experiment.ts
 *   node --experimental-strip-types src/skoll/recursive-depth2-experiment.ts --day 4
 *   node --experimental-strip-types src/skoll/recursive-depth2-experiment.ts --day 5
 */

import { readFileSync } from 'node:fs'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { retarResultToPossibilities, DEFAULT_RETAR_OPTIONS } from '../fenrir/src/retar-bridge.ts'
import { recursiveSkoll } from './recursive.ts'

const LOG_PATH = 'logs/bloodhound/2026-05-17T07-17-55-720Z/game.howl'

// recursive-perf.ts と同じ cutoff line を使用
const CUTOFFS = new Map<number, number>([
  [2, 79],
  [3, 141],
  [4, 194],
  [5, 238],
])

function arg(name: string): string | null {
  const eq = `--${name}=`
  const found = process.argv.find(a => a.startsWith(eq))
  if (found) return found.slice(eq.length)
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1]
  return null
}

const DAY = parseInt(arg('day') ?? '5', 10)
const cutoffLine = CUTOFFS.get(DAY)
if (cutoffLine === undefined) throw new Error(`unknown day=${DAY}, supported: ${[...CUTOFFS.keys()].join(',')}`)

function loadState(line: number) {
  const fullText = readFileSync(LOG_PATH, 'utf-8')
  const lines = fullText.split('\n')
  const partial = lines.slice(0, line).join('\n') + '\n'

  const { meta, statements } = parse(partial)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) throw new Error(`parser unknown count = ${unknowns.length}`)

  const { vs, setup } = buildVillageStatus(statements, meta)
  if (!vs || !setup) throw new Error('buildVillageStatus failed')

  const options: AnalyzeOptions = DEFAULT_RETAR_OPTIONS
  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyzeSafe()
  if (result.error || !result.result) throw new Error(`retar failed: ${result.error}`)

  const possibilities = retarResultToPossibilities(
    { possibilities: result.result, maxSurvivingNV: result.maxSurvivingNV },
    setup,
  )
  return { vs, setup, possibilities }
}

const { vs, setup, possibilities } = loadState(cutoffLine)
const alive: number[] = []
for (const [seat, status] of vs.statuses) if (status.surviving) alive.push(seat)
alive.sort((a, b) => a - b)

console.log(`=== Day ${DAY} morning, seed=904995, alive=[${alive.join(',')}] ===\n`)

// depth=1
const t1 = Date.now()
const d1 = recursiveSkoll(possibilities, setup, vs, { maxDepth: 1 })
const t1Ms = Date.now() - t1
console.log(`depth=1: ${d1.totalWorlds} worlds, ${t1Ms}ms`)

// depth=2 (warning: cost で Day 2-3 は分オーダー)
console.log(`depth=2: ${d1.totalWorlds} worlds, running... (Day 2-3 は分オーダーになり得る)`)
const t2 = Date.now()
const d2 = recursiveSkoll(possibilities, setup, vs, { maxDepth: 2 })
const t2Ms = Date.now() - t2
console.log(`depth=2: ${d2.totalWorlds} worlds, ${t2Ms}ms (${(t2Ms / 1000).toFixed(2)}s)`)

console.log(`\nslowdown: depth=2 / depth=1 = ${(t2Ms / t1Ms).toFixed(1)}x\n`)

// per-X 比較
const allX = [...new Set([...d1.perX.map(r => r.executeToday), ...d2.perX.map(r => r.executeToday)])].sort((a, b) => a - b)
console.log('X         depth=1 winRate  depth=2 winRate   Δ        d1 best Y     d2 best Y')
console.log('────────  ───────────────  ───────────────   ──────   ─────────     ─────────')
for (const x of allX) {
  const r1 = d1.perX.find(r => r.executeToday === x)
  const r2 = d2.perX.find(r => r.executeToday === x)
  const w1 = r1?.expectedWinRate ?? 0
  const w2 = r2?.expectedWinRate ?? 0
  const delta = w2 - w1
  const sign = delta >= 0 ? '+' : ''
  const y1 = r1?.bestDivineTonight ?? '-'
  const y2 = r2?.bestDivineTonight ?? '-'
  console.log(
    `seat-${String(x).padEnd(3)}  ${w1.toFixed(4).padStart(15)}  ${w2.toFixed(4).padStart(15)}   ${(sign + delta.toFixed(4)).padStart(7)}  seat-${String(y1).padEnd(8)}  seat-${String(y2)}`
  )
}

// best X
const d1Sorted = [...d1.perX].sort((a, b) => b.expectedWinRate - a.expectedWinRate)
const d2Sorted = [...d2.perX].sort((a, b) => b.expectedWinRate - a.expectedWinRate)
const d1Best = d1Sorted[0]
const d2Best = d2Sorted[0]

console.log(`\n=== Best X comparison ===`)
console.log(`depth=1: seat-${d1Best.executeToday} (${d1Best.expectedWinRate.toFixed(4)}) bestY=seat-${d1Best.bestDivineTonight}`)
console.log(`depth=2: seat-${d2Best.executeToday} (${d2Best.expectedWinRate.toFixed(4)}) bestY=seat-${d2Best.bestDivineTonight}`)
const bestChanged = d1Best.executeToday !== d2Best.executeToday
console.log(`best changed: ${bestChanged ? 'YES (depth=2 が判断を変えた)' : 'NO (同 best X)'}`)
