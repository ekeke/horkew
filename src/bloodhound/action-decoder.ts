/**
 * Decode the LLM's final tool calls into structured Bloodhound actions
 * suitable for handing to lupa's GameHandlers.
 *
 * The LLM may emit multiple tool calls in one response. The decoder:
 *   1. Splits out retar tool calls (handled by the tool-use loop, not actions).
 *   2. For the current phase, picks the action-shaped tool calls and merges
 *      them into a single discriminated action (e.g. say + seer_co + report
 *      collapse into a discussion action with a `claim` field).
 *
 * Invalid combinations are surfaced via `invalid: string`, so the caller
 * (anthropic-client retry loop) can decide whether to ask the LLM again.
 */

import type { DayClaim, NightAction } from '../lupa/types.ts'
import type { EnumSpecies, SystemRole } from '../types/index.ts'
import type { BloodhoundPhase, ToolCall } from './types.ts'

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type RetarQuery = {
  callId: string
  assumptions: Map<number, SystemRole>
}

export type DiscussionAction = {
  kind: 'discussion'
  speech?: string         // present iff `say` was called
  pass: boolean           // true iff `pass` was called
  claim?: DayClaim        // composed from `*_co` + `report_*` tool calls
}

export type VoteAction = {
  kind: 'vote'
  target: number
}

export type NightActionDecoded = {
  kind: 'night'
  action: NightAction
}

export type FinalAction = DiscussionAction | VoteAction | NightActionDecoded

export type DecodeResult = {
  retarQueries: RetarQuery[]
  finalAction: FinalAction | null
  invalid: string[]         // accumulated complaints; empty = clean
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function decodeToolCalls(toolCalls: readonly ToolCall[], phase: BloodhoundPhase): DecodeResult {
  const retarQueries: RetarQuery[] = []
  const others: ToolCall[] = []
  const invalid: string[] = []

  for (const tc of toolCalls) {
    if (tc.name === 'retar') {
      const q = decodeRetarQuery(tc, invalid)
      if (q) retarQueries.push(q)
    } else {
      others.push(tc)
    }
  }

  let finalAction: FinalAction | null = null
  switch (phase) {
    case 'discussion':
    case 'last_will':
      finalAction = decodeDiscussion(others, invalid, phase === 'last_will')
      break
    case 'vote':
    case 'revote':
      finalAction = decodeVote(others, invalid)
      break
    case 'night_seer':
      finalAction = decodeSingleNight(others, 'divine', invalid)
      break
    case 'night_bodyguard':
      finalAction = decodeSingleNight(others, 'guard', invalid)
      break
    case 'night_wolf':
      finalAction = decodeSingleNight(others, 'attack', invalid)
      break
  }

  return { retarQueries, finalAction, invalid }
}

// ---------------------------------------------------------------------------
// Per-phase decoders
// ---------------------------------------------------------------------------

function decodeRetarQuery(tc: ToolCall, invalid: string[]): RetarQuery | null {
  const raw = (tc.input as { assumptions?: unknown }).assumptions
  if (!Array.isArray(raw)) {
    invalid.push(`retar call ${tc.id}: assumptions must be an array`)
    return null
  }
  const assumptions = new Map<number, SystemRole>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const seat = (item as { seat?: unknown }).seat
    const role = (item as { role?: unknown }).role
    if (typeof seat !== 'number' || typeof role !== 'string') continue
    assumptions.set(seat, role as SystemRole)
  }
  return { callId: tc.id, assumptions }
}

function decodeDiscussion(toolCalls: ToolCall[], invalid: string[], lastWill: boolean): DiscussionAction {
  let saySpeech: string | undefined
  let pass = false
  // Collect raw CO/report fragments first; compose into a single DayClaim at the end.
  let coKind: 'seer' | 'medium' | 'bodyguard' | 'mason' | 'nekomata' | null = null
  let masonPartner: number | undefined
  const seerResults: Array<{ day: number; target: number; result: EnumSpecies }> = []
  const mediumResults: EnumSpecies[] = []
  // CO/report tools each carry a `text` argument. All such texts are
  // concatenated (in order) into the final speech so the LLM cannot announce
  // a CO without also voicing it to other players.
  const claimTexts: string[] = []

  function takeText(tc: ToolCall): string | undefined {
    const t = (tc.input as { text?: unknown }).text
    if (typeof t !== 'string' || t.length === 0) {
      invalid.push(`${tc.name} call ${tc.id}: text is required and must be non-empty`)
      return undefined
    }
    return t
  }

  for (const tc of toolCalls) {
    switch (tc.name) {
      case 'say': {
        const text = (tc.input as { text?: unknown }).text
        if (typeof text !== 'string' || text.length === 0) {
          invalid.push(`say call ${tc.id}: text must be a non-empty string`)
          break
        }
        if (lastWill) {
          invalid.push(`say is not available in last_will phase (call ${tc.id} ignored)`)
          break
        }
        if (saySpeech !== undefined) invalid.push(`multiple say calls; last one wins`)
        saySpeech = text
        break
      }
      case 'pass': {
        if (lastWill) {
          invalid.push(`pass is not available in last_will phase (call ${tc.id} ignored)`)
          break
        }
        pass = true
        break
      }
      case 'seer_co': {
        coKind = 'seer'
        const t = takeText(tc); if (t) claimTexts.push(t)
        break
      }
      case 'medium_co': {
        coKind = 'medium'
        const t = takeText(tc); if (t) claimTexts.push(t)
        break
      }
      case 'bodyguard_co': {
        coKind = 'bodyguard'
        const t = takeText(tc); if (t) claimTexts.push(t)
        break
      }
      case 'mason_co': {
        coKind = 'mason'
        const partner = (tc.input as { partner_seat?: unknown }).partner_seat
        if (typeof partner !== 'number') {
          invalid.push(`mason_co call ${tc.id}: partner_seat missing or non-numeric`)
        } else {
          masonPartner = partner
        }
        const t = takeText(tc); if (t) claimTexts.push(t)
        break
      }
      case 'nekomata_co': {
        coKind = 'nekomata'
        const t = takeText(tc); if (t) claimTexts.push(t)
        break
      }
      case 'report_divination': {
        const target = (tc.input as { target_seat?: unknown }).target_seat
        const species = (tc.input as { species?: unknown }).species
        const day = (tc.input as { day?: unknown }).day
        if (typeof target !== 'number' || (species !== 'human' && species !== 'wolf') || typeof day !== 'number') {
          invalid.push(`report_divination call ${tc.id}: bad arguments`)
          break
        }
        seerResults.push({ day, target, result: species })
        const t = takeText(tc); if (t) claimTexts.push(t)
        break
      }
      case 'report_medium': {
        const target = (tc.input as { target_seat?: unknown }).target_seat
        const species = (tc.input as { species?: unknown }).species
        if ((species !== 'human' && species !== 'wolf') || typeof target !== 'number') {
          invalid.push(`report_medium call ${tc.id}: bad arguments`)
          break
        }
        mediumResults.push(species)
        const t = takeText(tc); if (t) claimTexts.push(t)
        break
      }
      default:
        invalid.push(`tool ${tc.name} not allowed in discussion phase`)
    }
  }

  // Merge say text + all CO/report texts into one speech event so the
  // utterance order is preserved (say first if present, then claim texts).
  let speech: string | undefined
  const allTexts: string[] = []
  if (saySpeech) allTexts.push(saySpeech)
  allTexts.push(...claimTexts)
  if (allTexts.length > 0) speech = allTexts.join('\n')

  // Compose the final claim. We always emit *_co shaped claims (with results
  // arrays / pastResults) even for "result-only" turns — this lets the
  // handler merge across rounds (seer_co.results gets appended each round).
  let claim: DayClaim | undefined
  if (coKind === 'seer') {
    claim = { type: 'seer_co', results: [...seerResults] }
  } else if (coKind === 'medium') {
    claim = { type: 'medium_co', pastResults: mediumResults.length > 0 ? [...mediumResults] : undefined }
  } else if (coKind === 'bodyguard') {
    claim = { type: 'bodyguard_co', targets: [] }
  } else if (coKind === 'mason') {
    if (masonPartner === undefined) {
      invalid.push(`mason_co: partner_seat is required`)
    } else {
      claim = { type: 'mason_co', partner: masonPartner }
    }
  } else if (coKind === 'nekomata') {
    claim = { type: 'nekomata_co' }
  } else if (seerResults.length > 0) {
    // No CO this turn but seer results were reported — emit as seer_co
    // with the reported results. The handler will merge into prior seer_co.
    claim = { type: 'seer_co', results: [...seerResults] }
  } else if (mediumResults.length > 0) {
    // Same idea for medium results.
    claim = { type: 'medium_co', pastResults: [...mediumResults] }
  }

  // In normal discussion phase, exactly one of speech/pass should be present
  if (!lastWill && speech === undefined && !pass && claim === undefined) {
    invalid.push(`discussion phase: at least one of say/pass/<co>/<report> must be called`)
  }
  if (!lastWill && speech !== undefined && pass) {
    invalid.push(`discussion phase: say and pass are mutually exclusive`)
  }

  return { kind: 'discussion', speech, pass, claim }
}

function decodeVote(toolCalls: ToolCall[], invalid: string[]): VoteAction | null {
  const voteCalls = toolCalls.filter(tc => tc.name === 'vote')
  if (voteCalls.length === 0) {
    invalid.push('vote phase: no vote tool call found')
    return null
  }
  if (voteCalls.length > 1) invalid.push(`vote phase: multiple vote calls; last wins`)
  const last = voteCalls[voteCalls.length - 1]
  const target = (last.input as { target_seat?: unknown }).target_seat
  if (typeof target !== 'number') {
    invalid.push(`vote call ${last.id}: target_seat must be a number`)
    return null
  }
  for (const tc of toolCalls) {
    if (tc.name !== 'vote') invalid.push(`tool ${tc.name} not allowed in vote phase`)
  }
  return { kind: 'vote', target }
}

function decodeSingleNight(
  toolCalls: ToolCall[],
  expectName: 'divine' | 'guard' | 'attack',
  invalid: string[],
): NightActionDecoded | null {
  const matches = toolCalls.filter(tc => tc.name === expectName)
  if (matches.length === 0) {
    invalid.push(`night phase: no ${expectName} tool call found`)
    return null
  }
  if (matches.length > 1) invalid.push(`night phase: multiple ${expectName} calls; last wins`)
  const last = matches[matches.length - 1]
  const target = (last.input as { target_seat?: unknown }).target_seat
  if (typeof target !== 'number') {
    invalid.push(`${expectName} call ${last.id}: target_seat must be a number`)
    return null
  }
  for (const tc of toolCalls) {
    if (tc.name !== expectName) invalid.push(`tool ${tc.name} not allowed in this night phase`)
  }
  return { kind: 'night', action: { type: expectName, target } }
}
