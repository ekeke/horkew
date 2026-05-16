/**
 * Rewrite lupa's internal seat names (e.g. "占1", "狼4") to "seat-N" form
 * before handing text to the LLM.
 *
 * Lupa's `nameStyle: 'seat'` actually generates "<role-abbrev><seat>" names,
 * which trivially leaks every player's true role through the player list at
 * the top of the Howl rendering. Bloodhound must strip this leakage out.
 *
 * Replacement is done longest-name-first to avoid the "狼1" → "seat-1"
 * substitution corrupting "狼12" by matching its prefix.
 */

import type { PlayerState } from '../lupa/types.ts'

export function renameSeatNames(text: string, players: readonly PlayerState[]): string {
  const sorted = [...players].sort((a, b) => b.name.length - a.name.length)
  let result = text
  for (const p of sorted) {
    result = result.split(p.name).join(`seat-${p.seat}`)
  }
  return result
}
