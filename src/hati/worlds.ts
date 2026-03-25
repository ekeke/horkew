import type { Seat, SystemRole } from '../types/index.ts'
import type { World } from './types.ts'
import { RoleBitIndex, ROLE_COUNT, RoleSignatureBitsReverseMap, bitIndicesFromMask } from '../retar/possibilities.ts'
import type { Possibilities } from '../retar/possibilities.ts'

/**
 * Retarの可能性からすべての有効なワールド（役職配置）を逐次列挙する。
 * 各ワールドが見つかるたびに emit コールバックを呼ぶ。
 * emit が false を返すと列挙を中断する（早期打ち切り）。
 */
export function enumerateWorlds(
  possibilities: Possibilities,
  setup: Map<SystemRole, number>,
  emit: (world: World) => boolean | void,
): void {
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

  const assignment: SystemRole[] = new Array(seats.length > 0 ? seats[seats.length - 1] + 1 : 0)
  let stopped = false

  function backtrack(idx: number): void {
    if (stopped) return
    if (idx === seats.length) {
      for (let i = 0; i < ROLE_COUNT; i++) {
        if (roleCount[i] !== 0) return
      }
      if (emit(createWorld(assignment, seats)) === false) stopped = true
      return
    }

    const seat = seats[idx]
    const mask = possibilities.possibilities[seat]
    const indices = bitIndicesFromMask(mask)

    for (const bitIdx of indices) {
      if (stopped) return
      if (roleCount[bitIdx] <= 0) continue
      const role = RoleSignatureBitsReverseMap.get(1 << bitIdx)!
      roleCount[bitIdx]--
      assignment[seat] = role
      backtrack(idx + 1)
      roleCount[bitIdx]++
    }
  }

  backtrack(0)
}

/**
 * 全ワールドを配列に収集するヘルパー。
 * maxCount を超えたら null を返す（OOM防止）。
 */
export function collectWorlds(
  possibilities: Possibilities,
  setup: Map<SystemRole, number>,
  maxCount: number = Infinity,
): World[] | null {
  const worlds: World[] = []
  let overflow = false
  enumerateWorlds(possibilities, setup, w => {
    worlds.push(w)
    if (worlds.length > maxCount) { overflow = true; return false }
  })
  return overflow ? null : worlds
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
