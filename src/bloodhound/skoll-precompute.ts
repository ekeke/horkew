/**
 * Skoll pre-computation for Bloodhound user prompts and aux-tool calls.
 *
 * Skoll enumerates every world consistent with the public log and, for
 * each surviving seat, averages the village-win rate of executing that
 * seat today. The result is the most reliable lynch-target signal we can
 * give the LLM short of running a full game-tree search.
 *
 * `bestExecution` from `analyzeExecutionsByWorld` is a single seat picked
 * by raw float comparison, so it flips between equally-good candidates on
 * ULP-level noise. We post-process to group seats by win rate within a
 * tolerance and expose the entire tied group as `bestSeats`.
 */

import type { SystemRole } from '../types/index.ts'
import type { VillageStatus } from '../types/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import {
  analyzeExecutionsByWorld,
  type WorldExecutionAnalysis,
} from '../skoll/world-analysis.ts'

/** ULP tolerance for grouping seats with effectively-equal win rates. */
export const SKOLL_TIE_TOLERANCE = 1e-9

export type SkollPrecomputeInput = {
  possibilities: Possibilities
  // VillageStatus is referenced via the howl-bridge return type; we keep
  // the parameter loosely typed (`unknown`-ish via the howl bridge alias)
  // to avoid pulling in a wider dependency surface.
  vs: VillageStatus
  setup: Map<SystemRole, number>
  maxWorlds?: number
}

export type SkollResult = WorldExecutionAnalysis & {
  /** All seats whose winRate is within SKOLL_TIE_TOLERANCE of the maximum. Sorted ascending. */
  bestSeats: number[]
}

export function precomputeSkoll(input: SkollPrecomputeInput): SkollResult {
  const raw = analyzeExecutionsByWorld(input.possibilities, input.setup, input.vs, input.maxWorlds)
  const best = computeBestSeats(raw.executions)
  return { ...raw, bestSeats: best }
}

/** Group seats with winRate within SKOLL_TIE_TOLERANCE of the maximum. */
export function computeBestSeats(
  executions: ReadonlyArray<{ seat: number; winRate: number }>,
): number[] {
  if (executions.length === 0) return []
  let max = -Infinity
  for (const e of executions) if (e.winRate > max) max = e.winRate
  const ties: number[] = []
  for (const e of executions) {
    if (Math.abs(e.winRate - max) <= SKOLL_TIE_TOLERANCE) ties.push(e.seat)
  }
  return ties.sort((a, b) => a - b)
}
