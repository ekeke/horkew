import type { Seat, SystemRole } from '../types/index.ts'
import type { World } from './types.ts'
import { RoleBitIndex, ROLE_COUNT, RoleSignatureBitsReverseMap, bitIndicesFromMask } from '../retar/possibilities.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import { ATTR, RoleAttributeBits } from './role-attributes.ts'

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
    wolfFactionMask: 0,
    foxFactionMask: 0,
    attackCapableMask: 0,
    divineCapableMask: 0,
    guardCapableMask: 0,
    attackImmuneMask: 0,
    dieWhenDivinedMask: 0,
    curseOnExecutedMask: 0,
    curseOnKilledMask: 0,
    followFoxDeathMask: 0,
    mediumshipMask: 0,
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

      // 増分適用: 属性マスクに OR 込み
      const attr = RoleAttributeBits[bitIdx]
      if (attr & ATTR.WOLF_FACTION)                world.wolfFactionMask |= bit
      if (attr & ATTR.FOX_FACTION)                 world.foxFactionMask |= bit
      if (attr & ATTR.ACTION_ATTACK)               world.attackCapableMask |= bit
      if (attr & ATTR.ACTION_DIVINE)               world.divineCapableMask |= bit
      if (attr & ATTR.ACTION_GUARD)                world.guardCapableMask |= bit
      if (attr & ATTR.PASSIVE_ATTACK_IMMUNE)       world.attackImmuneMask |= bit
      if (attr & ATTR.PASSIVE_DIE_WHEN_DIVINED)    world.dieWhenDivinedMask |= bit
      if (attr & ATTR.REACTIVE_CURSE_ON_EXECUTED)  world.curseOnExecutedMask |= bit
      if (attr & ATTR.REACTIVE_CURSE_ON_KILLED)    world.curseOnKilledMask |= bit
      if (attr & ATTR.REACTIVE_FOLLOW_FOX_DEATH)   world.followFoxDeathMask |= bit
      if (attr & ATTR.AUTO_INFO_EXECUTION_SPECIES) world.mediumshipMask |= bit

      backtrack(idx + 1)

      // 取り消し: 各マスクから bit を外す
      if (attr & ATTR.WOLF_FACTION)                world.wolfFactionMask &= ~bit
      if (attr & ATTR.FOX_FACTION)                 world.foxFactionMask &= ~bit
      if (attr & ATTR.ACTION_ATTACK)               world.attackCapableMask &= ~bit
      if (attr & ATTR.ACTION_DIVINE)               world.divineCapableMask &= ~bit
      if (attr & ATTR.ACTION_GUARD)                world.guardCapableMask &= ~bit
      if (attr & ATTR.PASSIVE_ATTACK_IMMUNE)       world.attackImmuneMask &= ~bit
      if (attr & ATTR.PASSIVE_DIE_WHEN_DIVINED)    world.dieWhenDivinedMask &= ~bit
      if (attr & ATTR.REACTIVE_CURSE_ON_EXECUTED)  world.curseOnExecutedMask &= ~bit
      if (attr & ATTR.REACTIVE_CURSE_ON_KILLED)    world.curseOnKilledMask &= ~bit
      if (attr & ATTR.REACTIVE_FOLLOW_FOX_DEATH)   world.followFoxDeathMask &= ~bit
      if (attr & ATTR.AUTO_INFO_EXECUTION_SPECIES) world.mediumshipMask &= ~bit

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
    wolfFactionMask: world.wolfFactionMask,
    foxFactionMask: world.foxFactionMask,
    attackCapableMask: world.attackCapableMask,
    divineCapableMask: world.divineCapableMask,
    guardCapableMask: world.guardCapableMask,
    attackImmuneMask: world.attackImmuneMask,
    dieWhenDivinedMask: world.dieWhenDivinedMask,
    curseOnExecutedMask: world.curseOnExecutedMask,
    curseOnKilledMask: world.curseOnKilledMask,
    followFoxDeathMask: world.followFoxDeathMask,
    mediumshipMask: world.mediumshipMask,
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
