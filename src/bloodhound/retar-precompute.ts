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
 * Note: `analyzeFromEvents` currently lives under `src/fenrir/src/retar-bridge.ts`.
 * Bloodhound depends on it directly for MVP; a future cleanup may relocate
 * the bridge under `src/retar/`.
 */

import type { GameEvent, GameState, LupaConfig } from '../lupa/types.ts'
import type { SystemRole } from '../types/index.ts'
import {
  analyzeFromEvents,
  type RetarResult,
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

/**
 * Run retar from this viewer's perspective, asserting the viewer's own
 * role (plus any extra known roles) as assumptions.
 */
export function precomputeViewerRetar(input: ViewerPrecomputeInput): RetarResult {
  const assumptions = new Map<number, SystemRole>(input.extraAssumptions ?? [])
  assumptions.set(input.viewerSeat, input.viewerRole)
  return analyzeFromEvents(input.events, input.state, input.config, assumptions)
}
