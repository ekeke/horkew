/**
 * テスト用最小 GameHandlers — lupa 内で完結、verify/fenrir に依存しない
 */

import type { SystemRole } from '../types/index.ts'
import type { GameState, NightAction, DayClaim } from './types.ts'
import type { GameHandlers } from './handlers.ts'
import { alivePlayers } from './roles.ts'
import { Rng } from './random.ts'
import { forceTrueRoleCO } from './engine-utils.ts'
import { hasTrait } from './role-traits.ts'

export function makeRandomHandlers(seed?: number): GameHandlers {
  const rng = new Rng(seed)
  let seatRoles = new Map<number, SystemRole>()

  return {
    onSetup(roles) {
      seatRoles = roles
    },

    onNight(ctx) {
      const state = ctx.state as GameState
      const actions = new Map<number, NightAction>()
      const alive = alivePlayers(state)
      const aliveSeats = alive.map(p => p.seat)

      for (const player of alive) {
        // 占い (action:divine) を持つ役職は divine action を発行 (seer / paparazzi)
        if (hasTrait(player.role, 'action', 'divine')) {
          const targets = aliveSeats.filter(s => s !== player.seat)
          if (targets.length > 0) {
            actions.set(player.seat, { type: 'divine', target: targets[Math.floor(rng.next() * targets.length)] })
          }
        } else if (hasTrait(player.role, 'action', 'guard')) {
          const targets = aliveSeats.filter(s => s !== player.seat)
          if (targets.length > 0) {
            actions.set(player.seat, { type: 'guard', target: targets[Math.floor(rng.next() * targets.length)] })
          }
        } else if (hasTrait(player.role, 'action', 'attack')) {
          // 襲撃: 同 seat の襲撃可能個体 (味方狼) は対象外
          const targets = aliveSeats.filter(s => {
            const r = seatRoles.get(s)
            return r !== undefined && !hasTrait(r, 'action', 'attack')
          })
          if (targets.length > 0) {
            actions.set(player.seat, { type: 'attack', target: targets[Math.floor(rng.next() * targets.length)] })
          }
        }
      }
      return actions
    },

    onDayClaims(ctx) {
      const state = ctx.state as GameState
      const claims = new Map<number, DayClaim>()
      // forceTrueRoleCO は対象外役職に対し { type: 'none' } を返すので、生存者全員に呼んで良い
      for (const player of alivePlayers(state)) {
        claims.set(player.seat, forceTrueRoleCO(state, player, ctx.day, state.executionHistory.get(ctx.day - 1) ?? null))
      }
      return claims
    },

    onVote(ctx) {
      const alive = ctx.alivePlayers
      const votes = new Map<number, number>()
      const candidates = ctx.candidates ?? alive
      for (const seat of alive) {
        const targets = candidates.filter(s => s !== seat)
        if (targets.length > 0) {
          votes.set(seat, targets[Math.floor(rng.next() * targets.length)])
        }
      }
      return votes
    },
  }
}
