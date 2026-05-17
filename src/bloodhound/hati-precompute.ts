/**
 * Hati pre-computation for Bloodhound user prompts and aux-tool calls.
 *
 * Hati answers the binary question "does the village have a forced winning
 * strategy from here?". It also (optionally) returns the AND-OR strategy
 * tree showing which executions force the win in every consistent world.
 *
 * Bloodhound always wants both: the binary judgment for the prompt summary,
 * and — when tsumi exists — the strategy tree so the LLM can see the
 * execution plan rather than just being told "it is solved".
 */

import type { SystemRole } from '../types/index.ts'
import type { VillageStatus } from '../types/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { searchTsumi, searchTsumiStrategy } from '../hati/index.ts'
import { lupaRunRetar, DEFAULT_RETAR_OPTIONS } from '../fenrir/src/retar-bridge.ts'
import type { TsumiResult, StrategyNode } from '../hati/index.ts'

/** Default search depth for hati strategy construction. */
export const HATI_DEFAULT_MAX_DEPTH = 5

export type HatiPrecomputeInput = {
  possibilities: Possibilities
  vs: VillageStatus
  setup: Map<SystemRole, number>
  /** Retar analyze options; defaults to DEFAULT_RETAR_OPTIONS. */
  analyzeOptions?: AnalyzeOptions
  maxDepth?: number
}

export type HatiResult = TsumiResult & {
  /** Constructed only when isTsumi is true; otherwise null. */
  strategy: StrategyNode | null
}

/**
 * Run hati tsumi judgment and, on success, build the strategy tree.
 * If the underlying parse/state failed (no vs/setup), the caller should
 * not call this — there is no graceful empty result type to return here.
 */
export function precomputeHati(input: HatiPrecomputeInput): HatiResult {
  const opts = input.analyzeOptions ?? DEFAULT_RETAR_OPTIONS
  const maxDepth = input.maxDepth ?? HATI_DEFAULT_MAX_DEPTH
  const judgment = searchTsumi(input.vs, input.setup, opts, lupaRunRetar, input.possibilities)
  if (!judgment.isTsumi) {
    return { ...judgment, strategy: null }
  }
  const sr = searchTsumiStrategy(judgment, { maxDepth })
  return { ...judgment, strategy: sr.strategy }
}
