import type { Seat, SystemRole } from '../types/index.ts'
import type { World } from './types.ts'
import { RoleBitIndex, ROLE_COUNT, RoleSignatureBitsReverseMap, bitIndicesFromMask } from '../retar/possibilities.ts'
import type { Possibilities } from '../retar/possibilities.ts'

/**
 * Retarの可能性からすべての有効なワールド（役職配置）を列挙する。
 */
export function enumerateWorlds(
  possibilities: Possibilities,
  setup: Map<SystemRole, number>,
): World[] {
  const seats: Seat[] = []
  for (let i = 1; i < possibilities.possibilities.length; i++) {
    if (possibilities.possibilities[i] !== 0) {
      seats.push(i)
    }
  }

  const roleCount = new Uint8Array(ROLE_COUNT)
  for (const [role, count] of setup) {
    roleCount[RoleBitIndex[role]] = count
  }

  const worlds: World[] = []
  const assignment: SystemRole[] = new Array(seats.length > 0 ? seats[seats.length - 1] + 1 : 0)

  function backtrack(idx: number): void {
    if (idx === seats.length) {
      for (let i = 0; i < ROLE_COUNT; i++) {
        if (roleCount[i] !== 0) return
      }
      worlds.push(createWorld(assignment, seats))
      return
    }

    const seat = seats[idx]
    const mask = possibilities.possibilities[seat]
    const indices = bitIndicesFromMask(mask)

    for (const bitIdx of indices) {
      if (roleCount[bitIdx] <= 0) continue
      const role = RoleSignatureBitsReverseMap.get(1 << bitIdx)!
      roleCount[bitIdx]--
      assignment[seat] = role
      backtrack(idx + 1)
      roleCount[bitIdx]++
    }
  }

  backtrack(0)
  return worlds
}

function createWorld(roles: SystemRole[], seats: Seat[]): World {
  const rolesArr: SystemRole[] = new Array(roles.length)
  const roleIds = new Uint8Array(roles.length)
  let wolfMask = 0
  let hamsterSeat = -1
  let immoralistSeat = -1
  let seerSeat = -1
  let bodyguardSeat = -1
  let nekomataSeat = -1
  let mediumSeat = -1

  for (const seat of seats) {
    const role = roles[seat]
    rolesArr[seat] = role
    roleIds[seat] = RoleBitIndex[role]
    switch (role) {
      case 'werewolf': wolfMask |= (1 << seat); break
      case 'werehamster': hamsterSeat = seat; break
      case 'immoralist': immoralistSeat = seat; break
      case 'seer': seerSeat = seat; break
      case 'bodyguard': bodyguardSeat = seat; break
      case 'nekomata': nekomataSeat = seat; break
      case 'medium': mediumSeat = seat; break
    }
  }

  return { roles: rolesArr, roleIds, wolfMask, hamsterSeat, immoralistSeat, seerSeat, bodyguardSeat, nekomataSeat, mediumSeat }
}
