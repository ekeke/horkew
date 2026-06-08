/**
 * Retar 検証スクリプト共有ヘルパー
 *
 * verify/retar-verify.ts と hati/verify.ts で共有する純粋関数群。
 * - buildAssumptions: プレイヤーの真知識 → Retar assumptions Map
 * - retarResultToPossibilities: RetarResult → Possibilities 型変換
 * - DEFAULT_RETAR_OPTIONS: AnalyzeOptions default
 */

import type { SystemRole } from '../types/index.ts'
import type { GameState } from '../lupa/types.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { defaultAnalyzeRegulation } from '../retar/defaults.ts'
import { Possibilities, RoleBitIndex, possibilityFromRoles } from '../retar/possibilities.ts'

export const DEFAULT_RETAR_OPTIONS: AnalyzeOptions = {
  regulation: defaultAnalyzeRegulation,
  seerClaimingDueDate: 99,
  mediumClaimingDueDate: 99,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 99,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  assumptions: new Map(),
  wolfPairDenyals: [],
  hocusPocus: new Map(),
  id: 0,
  batches: 1,
  batch: 0,
}

export type RetarResult = {
  possibilities: Map<number, Set<SystemRole>>
  maxSurvivingNV: number
}

/** プレイヤーの初期知識から Retar assumptions を構築 */
export function buildAssumptions(
  state: GameState,
  player: GameState['players'][0],
  prior?: Map<number, Set<SystemRole>>,
): Map<number, SystemRole> {
  const assumptions = new Map<number, SystemRole>()

  const trySet = (seat: number, role: SystemRole) => {
    if (prior) {
      const possible = prior.get(seat)
      if (!possible || !possible.has(role)) return
    }
    assumptions.set(seat, role)
  }

  trySet(player.seat, player.role)

  switch (player.role) {
    case 'werewolf':
      for (const p of state.players) {
        if (p.role === 'werewolf' && p.seat !== player.seat) {
          trySet(p.seat, 'werewolf')
        }
      }
      break

    case 'fanatic':
      for (const p of state.players) {
        if (p.role === 'werewolf') {
          trySet(p.seat, 'werewolf')
        }
      }
      break

    case 'immoralist': {
      const hamster = state.players.find(p => p.role === 'werehamster')
      if (hamster) trySet(hamster.seat, 'werehamster')
      break
    }

    case 'mason': {
      const partner = state.players.find(p => p.role === 'mason' && p.seat !== player.seat)
      if (partner) trySet(partner.seat, 'mason')
      break
    }

    case 'seer':
      for (const [, result] of player.divineHistory) {
        if (result.result === 'wolf') {
          trySet(result.target, 'werewolf')
        }
      }
      break

    case 'medium':
      for (const [_day, executedSeat] of state.executionHistory) {
        const executed = state.players.find(p => p.seat === executedSeat)
        if (executed && executed.role === 'werewolf') {
          trySet(executedSeat, 'werewolf')
        }
      }
      break
  }

  return assumptions
}

/** RetarResult を Possibilities に変換 (verify 用) */
export function retarResultToPossibilities(
  result: RetarResult,
  setup: Map<SystemRole, number>,
): Possibilities {
  let maxSeat = 0
  for (const seat of result.possibilities.keys()) {
    if (seat > maxSeat) maxSeat = seat
  }
  const p = new Possibilities(maxSeat)
  for (const [role, count] of setup) {
    p.setup[RoleBitIndex[role]] = count
  }
  p.setupOriginal = new Uint8Array(p.setup)
  for (const [seat, roles] of result.possibilities) {
    p.possibilities[seat] = possibilityFromRoles(roles)
  }
  p.refix()
  return p
}
