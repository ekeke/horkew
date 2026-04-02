/**
 * テスト用最小 GameHandlers — lupa 内で完結、verify/fenrir に依存しない
 */

import type { SystemRole } from '../types/index.ts'
import type { GameState, PlayerState, NightAction, DayClaim } from './types.ts'
import type { GameHandlers } from './handlers.ts'
import { alivePlayers } from './roles.ts'
import { Rng } from './random.ts'
import { forceTrueRoleCO } from './engine-utils.ts'

const WOLF_ROLES: SystemRole[] = ['werewolf']
const NIGHT_ROLES: SystemRole[] = ['seer', 'bodyguard', 'werewolf']

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
        switch (player.role) {
          case 'seer': {
            const targets = aliveSeats.filter(s => s !== player.seat)
            if (targets.length > 0) {
              actions.set(player.seat, { type: 'divine', target: targets[Math.floor(rng.next() * targets.length)] })
            }
            break
          }
          case 'bodyguard': {
            const targets = aliveSeats.filter(s => s !== player.seat)
            if (targets.length > 0) {
              actions.set(player.seat, { type: 'guard', target: targets[Math.floor(rng.next() * targets.length)] })
            }
            break
          }
          case 'werewolf': {
            const targets = aliveSeats.filter(s => {
              const r = seatRoles.get(s)
              return r !== undefined && !WOLF_ROLES.includes(r)
            })
            if (targets.length > 0) {
              actions.set(player.seat, { type: 'attack', target: targets[Math.floor(rng.next() * targets.length)] })
            }
            break
          }
        }
      }
      return actions
    },

    onDayClaims(ctx) {
      const state = ctx.state as GameState
      const claims = new Map<number, DayClaim>()
      for (const player of alivePlayers(state)) {
        if (NIGHT_ROLES.includes(player.role) || player.role === 'medium' || player.role === 'mason' || player.role === 'nekomata') {
          claims.set(player.seat, forceTrueRoleCO(state, player, ctx.day, state.executionHistory.get(ctx.day - 1) ?? null))
        } else {
          claims.set(player.seat, { type: 'none' })
        }
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
