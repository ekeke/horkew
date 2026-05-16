/**
 * Bloodhound internal types.
 *
 * The Bloodhound agent plugs into the lupa engine via `GameHandlers`.
 * It extends the engine's event stream with a `SpeechEvent` (passed as
 * the `E` type parameter to `runGame`).
 */

import type { SystemRole } from '../types/index.ts'

// =====================================================
// Phase: Bloodhound's internal view, derived from lupa's phase + role
// =====================================================

export type BloodhoundPhase =
  | 'discussion'        // pre-vote round-robin
  | 'vote'              // first vote
  | 'revote'            // tied revote
  | 'night_seer'        // seer's divine
  | 'night_bodyguard'   // bodyguard's guard
  | 'night_wolf'        // werewolf's attack
  | 'last_will'         // executed player's final CO

// =====================================================
// Speech event (extension to lupa GameEvent via `E` parameter)
// =====================================================

export type SpeechEvent = {
  type: 'speech'
  actor: number     // seat number (1-indexed)
  text: string      // free-form Japanese utterance
}

export type BloodhoundEvent = SpeechEvent

// =====================================================
// Persona (fixed per seat, affects only `say` text style)
// =====================================================

export type Gender = 'male' | 'female'

export type Persona = {
  seat: number
  gender: Gender
  trait: string       // English short trait (e.g. "calm analyst", "cheerful")
  toneSample: string  // Japanese sample utterance to anchor LLM tone
}

// =====================================================
// Tool call result (decoded from Anthropic Tool Use response)
// =====================================================

export type ToolName =
  | 'say' | 'pass'
  | 'seer_co' | 'medium_co' | 'bodyguard_co' | 'mason_co' | 'nekomata_co'
  | 'report_divination' | 'report_medium'
  | 'vote' | 'divine' | 'guard' | 'attack'
  | 'retar' | 'craft_deception'

export type ToolCall = {
  id: string
  name: ToolName
  input: Record<string, unknown>
}

// =====================================================
// Per-seat agent context (held between handler invocations)
// =====================================================

export type SeatAgentContext = {
  seat: number
  role: SystemRole
  persona: Persona
}
