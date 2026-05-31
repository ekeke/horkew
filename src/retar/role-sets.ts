/**
 * 役職集合 helper. systemRoles を ground truth に派生。
 *
 * 役職追加時は src/types/index.ts の systemRoles に entry を埋めるだけで
 * これらの helper は自動追従する (paparazzi 追加で Liar 欠落バグを踏んだ反省)。
 *
 * - `*In(setup)`: setup に含まれる役職 (count > 0) だけにフィルタ。
 *   探索木に登場しない役職を枝刈りでき、 LiarRoles 等の用途に。
 * - `allKnownRoles()`: systemRoles に登録されている全役職 (setup-free)。
 *   配役生成や bit 配置など、 全候補が必要なケースに。
 */

import { systemRoles, type SystemRole } from '../types/index.ts'

/** systemRoles に登録されている全役職 (setup 非依存). 宣言順を保つ. */
export function allKnownRoles(): SystemRole[] {
  return Array.from(systemRoles.keys())
}

/** setup に含まれる役職 (count > 0). */
export function allRolesIn(setup: Map<SystemRole, number>): SystemRole[] {
  const out: SystemRole[] = []
  for (const [role, count] of setup) {
    if (count > 0) out.push(role)
  }
  return out
}

/** setup に含まれる村陣営 (faction === 'village') 役職. */
export function villageRolesIn(setup: Map<SystemRole, number>): SystemRole[] {
  return allRolesIn(setup).filter(role => systemRoles.get(role)!.faction === 'village')
}

/**
 * setup に含まれる嘘つき (faction !== 'village') 役職.
 * 旧 planBuilder.ts の `LiarRoles` を setup フィルタ + systemRoles 派生にしたもの.
 */
export function liarRolesIn(setup: Map<SystemRole, number>): SystemRole[] {
  return allRolesIn(setup).filter(role => systemRoles.get(role)!.faction !== 'village')
}

/**
 * setup に含まれる人間種別 (seerResult === 'human') 役職.
 * 旧 retar/index.ts の `HumanRoles` を setup フィルタ + systemRoles 派生にしたもの.
 */
export function humanRolesIn(setup: Map<SystemRole, number>): SystemRole[] {
  return allRolesIn(setup).filter(role => systemRoles.get(role)!.seerResult === 'human')
}
