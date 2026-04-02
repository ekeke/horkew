/**
 * エンジン用ユーティリティ — heuristic.ts から抽出した汎用関数
 */

import type { GameState, PlayerState, DayClaim } from './types.ts'

export function forceTrueRoleCO(
  state: GameState, player: PlayerState, _day: number,
  _lastExecutedSeat: number | null,
): DayClaim {
  switch (player.role) {
    case 'seer': {
      const results = Array.from(player.divineHistory.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ target: v.target, result: v.result }))
      return { type: 'seer_co', results }
    }
    case 'medium':
      return { type: 'medium_co' }
    case 'bodyguard': {
      const targets = Array.from(player.guardHistory.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, seat]) => seat)
      return { type: 'bodyguard_co', targets }
    }
    case 'mason': {
      const partner = state.players.find(p => p.seat !== player.seat && p.role === 'mason')
      if (!partner) return { type: 'none' }
      return { type: 'mason_co', partner: partner.seat }
    }
    case 'nekomata':
      return { type: 'nekomata_co' }
    default:
      return { type: 'none' }
  }
}

export function resolveVotes(votes: Map<number, number>): { decided: number } | { tied: number[] } {
  const counts = new Map<number, number>()
  for (const target of votes.values()) {
    counts.set(target, (counts.get(target) ?? 0) + 1)
  }
  let maxCount = 0
  let maxTargets: number[] = []
  for (const [target, count] of counts) {
    if (count > maxCount) { maxCount = count; maxTargets = [target] }
    else if (count === maxCount) maxTargets.push(target)
  }
  if (maxTargets.length === 1) return { decided: maxTargets[0] }
  return { tied: maxTargets.sort((a, b) => a - b) }
}
