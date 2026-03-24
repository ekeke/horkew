import type { Seat, SystemRole } from '../types/index.ts'
import type { World } from './types.ts'
import { RoleBitIndex, ROLE_COUNT, RoleSignatureBitsReverseMap, bitIndicesFromMask } from '../retar/possibilities.ts'
import type { Possibilities } from '../retar/possibilities.ts'

/**
 * Retarの可能性からすべての有効なワールド（役職配置）を列挙する。
 *
 * 各seatの可能性ビットマスクとsetup（役職数）を使い、
 * バックトラッキングで全有効配置を列挙する。
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
  const assignment = new Map<Seat, SystemRole>()

  function backtrack(idx: number): void {
    if (idx === seats.length) {
      // 全役職が使い切られているか確認
      for (let i = 0; i < ROLE_COUNT; i++) {
        if (roleCount[i] !== 0) return
      }
      worlds.push(createWorld(assignment))
      return
    }

    const seat = seats[idx]
    const mask = possibilities.possibilities[seat]
    const indices = bitIndicesFromMask(mask)

    for (const bitIdx of indices) {
      if (roleCount[bitIdx] <= 0) continue
      const role = RoleSignatureBitsReverseMap.get(1 << bitIdx)!
      roleCount[bitIdx]--
      assignment.set(seat, role)
      backtrack(idx + 1)
      roleCount[bitIdx]++
    }
    assignment.delete(seat)
  }

  backtrack(0)
  return worlds
}

function createWorld(assignment: Map<Seat, SystemRole>): World {
  const roles = new Map(assignment)
  const wolfSeats = new Set<Seat>()
  let hamsterSeat = -1
  let immoralistSeat = -1
  let seerSeat = -1
  let bodyguardSeat = -1
  let nekomataSeat = -1
  let mediumSeat = -1

  for (const [seat, role] of roles) {
    switch (role) {
      case 'werewolf': wolfSeats.add(seat); break
      case 'werehamster': hamsterSeat = seat; break
      case 'immoralist': immoralistSeat = seat; break
      case 'seer': seerSeat = seat; break
      case 'bodyguard': bodyguardSeat = seat; break
      case 'nekomata': nekomataSeat = seat; break
      case 'medium': mediumSeat = seat; break
    }
  }

  return { roles, wolfSeats, hamsterSeat, immoralistSeat, seerSeat, bodyguardSeat, nekomataSeat, mediumSeat }
}

/**
 * 生存者の役職配置が同一のワールドを等価クラスとしてまとめる。
 * 探索の枝刈りに使用。
 */
export function worldEquivalenceKey(world: World, alive: Set<Seat>): string {
  const parts: string[] = []
  const sorted = Array.from(alive).sort((a, b) => a - b)
  for (const seat of sorted) {
    parts.push(`${seat}:${world.roles.get(seat)}`)
  }
  return parts.join(',')
}
