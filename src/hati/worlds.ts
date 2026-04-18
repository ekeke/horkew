import type { Seat, SystemRole } from '../types/index.ts'
import type { World } from './types.ts'
import { RoleBitIndex, ROLE_COUNT, RoleSignatureBitsReverseMap, bitIndicesFromMask } from '../retar/possibilities.ts'
import type { Possibilities } from '../retar/possibilities.ts'

/**
 * Retarの可能性からすべての有効なワールド（役職配置）を逐次列挙する。
 * 各ワールドが見つかるたびに emit コールバックを呼ぶ。
 * emit が false を返すと列挙を中断する（早期打ち切り）。
 *
 * 重要: emit に渡される World は再利用されるバッファ。コールバック外で
 * 参照を保持する場合は cloneWorld で複製すること。
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

  // 各 seat の bit indices を事前計算
  const seatBitIndices: number[][] = new Array(seats.length)
  for (let i = 0; i < seats.length; i++) {
    seatBitIndices[i] = bitIndicesFromMask(possibilities.possibilities[seats[i]])
  }

  const size = seats.length > 0 ? seats[seats.length - 1] + 1 : 0

  // 共有ワールドバッファ — backtrack 中に増分更新し、emit に同じ参照を渡す
  const rolesArr: SystemRole[] = new Array(size)
  const roleIds = new Uint8Array(size)
  const world: World = {
    roles: rolesArr,
    roleIds,
    wolfMask: 0,
    hamsterMask: 0,
    immoralistMask: 0,
    seerMask: 0,
    mediumMask: 0,
    nekomataMask: 0,
    bodyguardSeat: -1,
  }

  let stopped = false

  function backtrack(idx: number): void {
    if (stopped) return
    if (idx === seats.length) {
      for (let i = 0; i < ROLE_COUNT; i++) {
        if (roleCount[i] !== 0) return
      }
      if (emit(world) === false) stopped = true
      return
    }

    const seat = seats[idx]
    const indices = seatBitIndices[idx]
    const bit = 1 << seat

    for (let j = 0; j < indices.length; j++) {
      if (stopped) return
      const bitIdx = indices[j]
      if (roleCount[bitIdx] <= 0) continue

      const role = RoleSignatureBitsReverseMap.get(1 << bitIdx)!
      roleCount[bitIdx]--
      rolesArr[seat] = role
      roleIds[seat] = bitIdx

      // 増分適用
      let prevBodyguard = -2
      switch (role) {
        case 'werewolf': world.wolfMask |= bit; break
        case 'werehamster': world.hamsterMask |= bit; break
        case 'immoralist': world.immoralistMask |= bit; break
        case 'seer': world.seerMask |= bit; break
        case 'medium': world.mediumMask |= bit; break
        case 'nekomata': world.nekomataMask |= bit; break
        case 'bodyguard':
          prevBodyguard = world.bodyguardSeat
          world.bodyguardSeat = seat
          break
      }

      backtrack(idx + 1)

      // 取り消し
      switch (role) {
        case 'werewolf': world.wolfMask &= ~bit; break
        case 'werehamster': world.hamsterMask &= ~bit; break
        case 'immoralist': world.immoralistMask &= ~bit; break
        case 'seer': world.seerMask &= ~bit; break
        case 'medium': world.mediumMask &= ~bit; break
        case 'nekomata': world.nekomataMask &= ~bit; break
        case 'bodyguard': world.bodyguardSeat = prevBodyguard; break
      }

      roleCount[bitIdx]++
    }
  }

  backtrack(0)
}

/**
 * World のディープコピーを返す。enumerateWorlds が emit する共有バッファを
 * 保持したい場合に使う。
 */
export function cloneWorld(world: World): World {
  return {
    roles: world.roles.slice(),
    roleIds: new Uint8Array(world.roleIds),
    wolfMask: world.wolfMask,
    hamsterMask: world.hamsterMask,
    immoralistMask: world.immoralistMask,
    seerMask: world.seerMask,
    mediumMask: world.mediumMask,
    nekomataMask: world.nekomataMask,
    bodyguardSeat: world.bodyguardSeat,
  }
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
    worlds.push(cloneWorld(w))
    if (worlds.length > maxCount) { overflow = true; return false }
  })
  return overflow ? null : worlds
}
