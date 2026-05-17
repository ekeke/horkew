/**
 * Per-event Howl-flavored line formatter for live observation.
 *
 * Unlike `formatHowl` (which renders the whole game at once using the
 * engine's internal player names like `占1`), this formatter emits one
 * line per event using seat-N notation. It is meant to be piped to
 * stderr while a game is running so the operator can read the game
 * in real time and abort if it goes off the rails.
 *
 * Returns `null` for events that don't have a meaningful one-line
 * representation (e.g. internal markers).
 */

import type { GameEvent } from '../lupa/types.ts'
import type { EnumSpecies } from '../types/index.ts'
import type { BloodhoundEvent } from './types.ts'

const SPECIES_GLYPH: Record<Exclude<EnumSpecies, null>, string> = {
  human: '○',
  wolf: '●',
}

/**
 * Render a seat: prefer the character name from `names` if supplied,
 * fall back to "seat-N". Live-stream output reads more naturally when
 * persona names are used, so play.ts threads a name map through.
 */
function fmtSeat(seat: number, names?: ReadonlyMap<number, string>): string {
  return names?.get(seat) ?? `P${seat}`
}

function fmtResults(
  results: ReadonlyArray<{ day: number; target: number; result: EnumSpecies }>,
  names?: ReadonlyMap<number, string>,
): string {
  return results
    .map(r => `${r.day}D ${fmtSeat(r.target, names)}${r.result === null ? '?' : SPECIES_GLYPH[r.result]}`)
    .join(' ')
}

export function formatEventLine(
  event: GameEvent | BloodhoundEvent,
  names?: ReadonlyMap<number, string>,
): string | null {
  switch (event.type) {
    case 'speech':
      return `${fmtSeat(event.actor, names)} > ${event.text}`
    case 'night_kill':
      return `${fmtSeat(event.target, names)} 死亡`
    case 'fox_kill':
      return `${fmtSeat(event.target, names)} 死亡 (狐)`
    case 'curse_kill':
      return `${fmtSeat(event.target, names)} 道連れ`
    case 'follow_kill':
      return `${fmtSeat(event.target, names)} 後追い`
    case 'peace':
      return '平和'
    case 'seer_claim': {
      const tail = event.results.length > 0 ? ' ' + fmtResults(event.results, names) : ''
      return `${fmtSeat(event.actor, names)} 占いCO${tail}`
    }
    case 'seer_result':
      return `${fmtSeat(event.actor, names)} 占い結果: ${fmtSeat(event.target, names)}${event.result === null ? '?' : SPECIES_GLYPH[event.result]}`
    case 'medium_claim': {
      const tail = event.pastResults && event.pastResults.length > 0
        ? ' ' + event.pastResults.map(r => r === null ? '?' : SPECIES_GLYPH[r]).join(' ')
        : ''
      return `${fmtSeat(event.actor, names)} 霊媒CO${tail}`
    }
    case 'medium_result':
      return `${fmtSeat(event.actor, names)} 霊媒結果: ${event.result === null ? '?' : SPECIES_GLYPH[event.result]}`
    case 'bodyguard_claim': {
      const tail = event.targets.length > 0 ? ' 護衛 ' + event.targets.map(s => fmtSeat(s, names)).join(' ') : ''
      return `${fmtSeat(event.actor, names)} 狩人CO${tail}`
    }
    case 'mason_claim':
      return `${fmtSeat(event.actor, names)} 共有CO (相方: ${fmtSeat(event.partner, names)})`
    case 'nekomata_claim':
      return `${fmtSeat(event.actor, names)} 猫又CO`
    case 'forecast':
      return `${fmtSeat(event.actor, names)} 予告 ${fmtSeat(event.target, names)}`
    case 'vote':
      return `${fmtSeat(event.voter, names)} → ${fmtSeat(event.target, names)}`
    case 'revote':
      return `--- 再投票 (候補: ${event.targets.map(s => fmtSeat(s, names)).join(', ')}) ---`
    case 'grelan':
      return 'グレラン'
    case 'execution':
      return `${fmtSeat(event.target, names)} 処刑`
    case 'comment':
      return `# ${event.text}`
    case 'game_over':
      return `=== game over: ${event.result} ===`
    case 'reveal':
      return `(reveal) ${fmtSeat(event.seat, names)} = ${event.role}`
    default:
      return null
  }
}
