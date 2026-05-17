/**
 * Canonical world enumeration の同一性テスト。
 *
 * `analyzeExecutionsByWorld` (元) と `analyzeExecutionsByWorldCanonical` (orbit 集約) が
 * 数学的に等価であることを bloodhound 実ログ (Day 2-5) で検証する。
 */

import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { retarResultToPossibilities, DEFAULT_RETAR_OPTIONS } from '../fenrir/src/retar-bridge.ts'
import { analyzeExecutionsByWorld } from './world-analysis.ts'
import {
  enumerateCanonicalWorlds,
  analyzeExecutionsByWorldCanonical,
  computeEquivalenceClasses,
} from './canonical-worlds.ts'
import { enumerateWorlds } from '../hati/worlds.ts'

const LOG_PATH = 'logs/bloodhound/2026-05-17T07-17-55-720Z/game.howl'

// Day 2/3/4/5 朝の cutoff line (recursive-experiment.ts と同じ)
const CUTOFFS = [
  { day: 5, line: 238 },
  { day: 4, line: 194 },
  { day: 3, line: 141 },
  { day: 2, line: 79 },
]

function loadStateAtCutoff(cutoffLine: number) {
  const fullText = readFileSync(LOG_PATH, 'utf-8')
  const lines = fullText.split('\n')
  const partial = lines.slice(0, cutoffLine).join('\n') + '\n'

  const { meta, statements } = parse(partial)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) throw new Error(`${unknowns.length} unknown statements`)

  const { vs, setup } = buildVillageStatus(statements, meta)
  if (!vs || !setup) throw new Error(`buildVillageStatus failed at line ${cutoffLine}`)

  const options: AnalyzeOptions = DEFAULT_RETAR_OPTIONS
  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyzeSafe()
  if (result.error || !result.result) throw new Error(`Retar failed: ${result.error}`)

  const possibilities = retarResultToPossibilities(
    { possibilities: result.result, maxSurvivingNV: result.maxSurvivingNV },
    setup,
  )
  return { vs, setup, possibilities }
}

describe('canonical-worlds', () => {
  describe('equivalence classes', () => {
    it('groups seats with same possibility bitmask', () => {
      const { possibilities } = loadStateAtCutoff(238)  // Day 5
      const classes = computeEquivalenceClasses(possibilities)
      // Day 5: alive seats 4, 6, 7, 10, 12, 14 + dead seats
      // seat-10 と seat-14 は同 possibility (vil/BG/neko/WOLF/FANA/FOX/IMM)
      // → 同 class に属するはず
      const seat10Class = classes.find(c => c.seats.includes(10))
      const seat14Class = classes.find(c => c.seats.includes(14))
      assert.ok(seat10Class)
      assert.strictEqual(seat10Class, seat14Class, 'seat-10 と seat-14 は同 class')
      assert.deepStrictEqual(seat10Class!.seats, [10, 14])
    })
  })

  describe('enumerateCanonicalWorlds: weight sum = enumerateWorlds count', () => {
    for (const cutoff of CUTOFFS) {
      it(`Day ${cutoff.day}: sum of canonical weights = total enumerateWorlds`, () => {
        const { setup, possibilities } = loadStateAtCutoff(cutoff.line)

        // Original
        let originalCount = 0
        enumerateWorlds(possibilities, setup, () => { originalCount++ })

        // Canonical
        let canonicalCount = 0
        let canonicalWeightSum = 0
        enumerateCanonicalWorlds(possibilities, setup, (_, weight) => {
          canonicalCount++
          canonicalWeightSum += weight
        })

        assert.strictEqual(
          canonicalWeightSum, originalCount,
          `Day ${cutoff.day}: canonical weight sum ${canonicalWeightSum} != original count ${originalCount}`,
        )

        console.log(`  Day ${cutoff.day}: original=${originalCount} worlds, canonical=${canonicalCount} (compression ${(originalCount / canonicalCount).toFixed(2)}x)`)
      })
    }
  })

  describe('analyzeExecutionsByWorldCanonical: per-X scores match original', () => {
    for (const cutoff of CUTOFFS) {
      it(`Day ${cutoff.day}: per-X scores within 1e-9`, () => {
        const { vs, setup, possibilities } = loadStateAtCutoff(cutoff.line)

        const original = analyzeExecutionsByWorld(possibilities, setup, vs)
        const canonical = analyzeExecutionsByWorldCanonical(possibilities, setup, vs)

        assert.strictEqual(
          canonical.totalWorlds, original.totalWorlds,
          'totalWorlds (= weight sum) match',
        )
        assert.strictEqual(canonical.executions.length, original.executions.length)

        for (let i = 0; i < original.executions.length; i++) {
          const o = original.executions[i]
          const c = canonical.executions[i]
          assert.strictEqual(c.seat, o.seat, `seat order match at index ${i}`)
          const diff = Math.abs(c.winRate - o.winRate)
          assert.ok(
            diff < 1e-9,
            `Day ${cutoff.day} seat-${o.seat}: canonical=${c.winRate} vs original=${o.winRate} (diff=${diff})`,
          )
        }
      })
    }
  })
})
