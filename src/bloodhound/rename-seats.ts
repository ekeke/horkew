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
 *
 * Additionally, the Howl setup line ("配役 狼3 村2 占1 …") uses the same
 * role-abbreviation + count notation, which is visually indistinguishable
 * from seat names (e.g. "狼3" = "3 werewolves" vs "seat-3 is a werewolf").
 * `rewriteSetupLine` translates that line into an unambiguous English form
 * ("Setup: werewolf=3 villager=2 …").
 */

import type { PlayerState } from '../lupa/types.ts'

export function renameSeatNames(text: string, players: readonly PlayerState[]): string {
  const sorted = [...players].sort((a, b) => b.name.length - a.name.length)
  let result = text
  for (const p of sorted) {
    result = result.split(p.name).join(`P${p.seat}`)
  }
  return result
}

const ROLE_ABBREV_TO_ENGLISH: Record<string, string> = {
  '狼': 'werewolf',
  '村': 'villager',
  '占': 'seer',
  '霊': 'medium',
  '狩': 'bodyguard',
  '共': 'mason',
  '猫': 'nekomata',
  '信': 'fanatic',
  '狐': 'werehamster',
  '背': 'immoralist',
  '狂': 'possessed',
}

/**
 * Strip Howl comment lines (`# …`) from the text before handing it to the LLM.
 *
 * Lupa's `resolveNight` emits `comment` events with the truth — "占い: A → B ●",
 * "護衛: A → B", "襲撃: A → B" — and `formatHowl` renders them as `# …` lines.
 * That bypasses the information firewall entirely: every player would see every
 * night action. We must remove all `#` lines before any LLM reads the Howl.
 *
 * (Seed comment "# seed: N" is also stripped. The seed is a deterministic
 * fingerprint, not gameplay info, but there is no reason to expose it.)
 */
export function stripPrivateComments(text: string): string {
  return text
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n')
}

/** Replace the "配役 …" setup line with an unambiguous "Setup: role=count …" form. */
export function rewriteSetupLine(text: string): string {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^配役\s+(.+)$/)
    if (!m) continue
    const parts = m[1].trim().split(/\s+/).map(token => {
      const tm = token.match(/^(.+?)([0-9]+)$/)
      if (!tm) return token
      const [, abbrev, count] = tm
      const eng = ROLE_ABBREV_TO_ENGLISH[abbrev] ?? abbrev
      return `${eng}=${count}`
    })
    lines[i] = `Setup: ${parts.join(' ')}`
    break
  }
  return lines.join('\n')
}
