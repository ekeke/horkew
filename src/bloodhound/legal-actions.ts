/**
 * Pure mapping from (lupa phase + self role + state) to the set of tools
 * Bloodhound should expose to the LLM, with per-tool target candidate lists.
 *
 * This module owns the "what can I do right now" decision. It runs without
 * any LLM call so that the legality logic is unit-testable in isolation.
 */

import type { ToolName, BloodhoundPhase } from './types.ts'
import type { SystemRole } from '../types/index.ts'

export type LegalActionsInput = {
  phase: BloodhoundPhase
  role: SystemRole
  selfSeat: number
  alivePlayers: readonly number[]
  /** Vote phase: explicit revote candidate list. null/undefined = initial vote, all alive are candidates. */
  voteCandidates?: readonly number[] | null
  /** night_wolf: fellow alive wolves (excluded from attack candidates). */
  fellowWolves?: readonly number[]
  /** Universe of seat numbers (used for report_* tools whose targets may include dead). */
  allSeats: readonly number[]
}

export type LegalActions = {
  toolNames: ToolName[]
  targets: {
    vote?: number[]
    divine?: number[]
    guard?: number[]
    attack?: number[]
    report_divination?: number[]
    report_medium?: number[]
  }
}

const DISCUSSION_TOOLS: ToolName[] = [
  'say', 'pass',
  'seer_co', 'medium_co', 'bodyguard_co', 'mason_co', 'nekomata_co',
  'report_divination', 'report_medium',
  'retar',
]

const LAST_WILL_TOOLS: ToolName[] = [
  'seer_co', 'medium_co', 'bodyguard_co', 'mason_co', 'nekomata_co',
  'report_divination', 'report_medium',
  'retar',
]

export function legalActions(input: LegalActionsInput): LegalActions {
  const { phase, selfSeat, alivePlayers, voteCandidates, fellowWolves, allSeats } = input
  const aliveExceptSelf = alivePlayers.filter(s => s !== selfSeat)

  switch (phase) {
    case 'discussion':
      return {
        toolNames: [...DISCUSSION_TOOLS],
        targets: {
          report_divination: [...allSeats],
          report_medium: [...allSeats],
        },
      }

    case 'vote':
    case 'revote': {
      const base = voteCandidates && voteCandidates.length > 0
        ? voteCandidates
        : alivePlayers
      const candidates = base.filter(s => s !== selfSeat)
      return {
        toolNames: ['vote', 'retar'],
        targets: { vote: candidates },
      }
    }

    case 'night_seer':
      return {
        toolNames: ['divine', 'retar'],
        targets: { divine: aliveExceptSelf },
      }

    case 'night_bodyguard':
      return {
        toolNames: ['guard', 'retar'],
        targets: { guard: aliveExceptSelf },
      }

    case 'night_wolf': {
      const allies = new Set([selfSeat, ...(fellowWolves ?? [])])
      return {
        toolNames: ['attack', 'retar'],
        targets: { attack: alivePlayers.filter(s => !allies.has(s)) },
      }
    }

    case 'last_will':
      return {
        toolNames: [...LAST_WILL_TOOLS],
        targets: {
          report_divination: [...allSeats],
          report_medium: [...allSeats],
        },
      }
  }
}
