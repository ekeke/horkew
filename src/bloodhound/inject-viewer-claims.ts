/**
 * For a viewer that hasn't publicly COed yet, append a synthetic CO event
 * (and any associated results) to the event list so retar treats the
 * viewer's private knowledge as if it were already on the public record.
 *
 * Why: retar's `assumptions` API only takes `seat → role` pairs, so it
 * cannot express "seat-X is NOT a wolf" (the meaning of a ○ divine).
 * But the howl pipeline DOES propagate that information through CO + result
 * events. Synthesising those events for the viewer's role gives retar full
 * access to the viewer's private divine / medium / bodyguard / mason /
 * nekomata knowledge without having to leak it to other seats.
 *
 * Scope: village team only (seer / medium / bodyguard / mason / nekomata).
 * Wolf-team and hamster-team private knowledge has no public CO equivalent
 * and continues to flow through `buildAssumptions` instead.
 */

import type {
  GameEvent, GameState, PlayerState,
} from '../lupa/types.ts'
import { buildPlayerView } from '../lupa/player-view.ts'

/**
 * Returns a fresh event array with a single CO event (and result entries)
 * appended for the viewer's role, if they have not already COed publicly.
 * If the viewer is non-village or has already emitted a same-role claim,
 * the events are returned unchanged.
 */
export function injectViewerClaims(
  events: readonly GameEvent[],
  player: PlayerState,
  state: GameState,
): GameEvent[] {
  const seat = player.seat

  // If this seat has already publicly COed (handlers' additionalClaims
  // route, or any other path that put a *_claim event in the log), we
  // must not duplicate the claim — retar would re-process and event
  // ordering could be disturbed.
  for (const e of events) {
    if (!('actor' in e) || e.actor !== seat) continue
    switch (e.type) {
      case 'seer_claim':
      case 'medium_claim':
      case 'bodyguard_claim':
      case 'mason_claim':
      case 'nekomata_claim':
        return [...events]
      default: break
    }
  }

  const out: GameEvent[] = [...events]
  switch (player.role) {
    case 'seer': {
      const results = [...player.divineHistory.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([day, r]) => ({ day, target: r.target, result: r.result }))
      out.push({ type: 'seer_claim', actor: seat, results })
      break
    }
    case 'medium': {
      const pastResults: ('human' | 'wolf')[] = []
      for (const [, executedSeat] of state.executionHistory) {
        const executed = state.players.find(p => p.seat === executedSeat)
        if (!executed) continue
        pastResults.push(executed.role === 'werewolf' ? 'wolf' : 'human')
      }
      out.push({ type: 'medium_claim', actor: seat, pastResults })
      break
    }
    case 'bodyguard': {
      const targets = [...player.guardHistory.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, target]) => target)
      out.push({ type: 'bodyguard_claim', actor: seat, targets })
      break
    }
    case 'mason': {
      const view = buildPlayerView(state, seat)
      if (view.masonPartner !== null) {
        out.push({ type: 'mason_claim', actor: seat, partner: view.masonPartner })
      }
      break
    }
    case 'nekomata': {
      out.push({ type: 'nekomata_claim', actor: seat })
      break
    }
    default: break
  }
  return out
}
