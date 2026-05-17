/**
 * Flat retar pre-computation for Bloodhound user prompts.
 *
 * Every Bloodhound seat will, on every turn, want the per-seat role
 * possibilities so the LLM can reason about who can still be what.
 * Rather than have every seat re-run retar (14× work for the same answer),
 * we compute one flat result per turn and embed it into each user prompt.
 *
 * The viewer's own seat-role is always added as an assumption (per
 * memory: `feedback_viewer_role_assumption`).
 *
 * We return the underlying VillageStatus and setup alongside the retar
 * possibilities so that downstream tools (skoll, hati) can reuse them
 * without re-parsing the Howl log.
 *
 * Note: `analyzeFromEventsDetailed` currently lives under
 * `src/fenrir/src/retar-bridge.ts`. Bloodhound depends on it directly for
 * MVP; a future cleanup may relocate the bridge under `src/retar/`.
 */

import type { GameEvent, GameState, LupaConfig } from '../lupa/types.ts'
import type { SystemRole } from '../types/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import {
  analyzeFromEventsDetailed,
  retarResultToPossibilities,
  type RetarResult,
  type DetailedRetarResult,
} from '../fenrir/src/retar-bridge.ts'

export type ViewerPrecomputeInput = {
  events: GameEvent[]
  state: GameState
  config: LupaConfig
  viewerSeat: number
  viewerRole: SystemRole
  /** Optional extra assumptions (e.g., wolves know each other's roles). */
  extraAssumptions?: Map<number, SystemRole>
}

/** Bloodhound-side retar bundle: possibilities plus the vs/setup needed by skoll/hati. */
export type ViewerPrecomputeResult = RetarResult & {
  /** VillageStatus reconstructed from the Howl log; null if parsing failed. */
  vs: DetailedRetarResult['vs']
  /** Role setup map; null if parsing failed. */
  setup: Map<SystemRole, number> | null
  /** Cached Possibilities (with viewer-role assumptions applied). null when parsing failed. */
  possibilitiesBitmask: Possibilities | null
}

/** Public-retar bundle: possibilities plus vs/setup for CO-table rendering. */
export type PublicRetarResult = RetarResult & {
  vs: DetailedRetarResult['vs']
  setup: Map<SystemRole, number> | null
}

/**
 * Run retar over the public event stream alone, with no viewer-private
 * information injected. The result mirrors what every seat at the table
 * can derive from the public log — useful as the "objective baseline"
 * the viewer can compare their private deductions against.
 *
 * Also returns the VillageStatus so the CO table (which is purely public
 * information) can be rendered from the same parse.
 */
export function precomputePublicRetar(input: {
  events: readonly GameEvent[]
  state: GameState
  config: LupaConfig
}): PublicRetarResult {
  const d = analyzeFromEventsDetailed(input.events as GameEvent[], input.state, input.config)
  return {
    possibilities: d.possibilities,
    maxSurvivingNV: d.maxSurvivingNV,
    vs: d.vs,
    setup: d.setup,
  }
}

/**
 * Run retar from this viewer's perspective, asserting the viewer's own
 * role (plus any extra known roles) as assumptions. Returns both the
 * possibilities map and the underlying VillageStatus + setup so callers
 * can chain into skoll / hati without re-parsing the Howl.
 */
export function precomputeViewerRetar(input: ViewerPrecomputeInput): ViewerPrecomputeResult {
  const assumptions = new Map<number, SystemRole>(input.extraAssumptions ?? [])
  assumptions.set(input.viewerSeat, input.viewerRole)
  const detailed = analyzeFromEventsDetailed(input.events, input.state, input.config, assumptions)
  const possibilitiesBitmask = detailed.setup
    ? retarResultToPossibilities({ possibilities: detailed.possibilities, maxSurvivingNV: detailed.maxSurvivingNV }, detailed.setup)
    : null
  return {
    possibilities: detailed.possibilities,
    maxSurvivingNV: detailed.maxSurvivingNV,
    vs: detailed.vs,
    setup: detailed.setup,
    possibilitiesBitmask,
  }
}
