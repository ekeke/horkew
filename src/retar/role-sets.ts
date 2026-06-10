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

import { systemRoles, type SystemRole, type RoleTrait, type EnumSpecies } from '../types/index.ts'

/**
 * 指定 role が trait (kind + sub) を持つかチェック.
 * 役職追加で systemRoles の traits が増えれば自動追従する.
 */
export function hasTrait(role: SystemRole, kind: RoleTrait['kind'], sub: RoleTrait['sub']): boolean {
  return systemRoles.get(role)!.traits.some(t => t.kind === kind && t.sub === sub)
}

/** setup に含まれる「trait predicate を満たす役職」のリスト. */
export function rolesWithTraitIn(
  setup: Map<SystemRole, number>,
  kind: RoleTrait['kind'],
  sub: RoleTrait['sub'],
): SystemRole[] {
  return allRolesIn(setup).filter(role => hasTrait(role, kind, sub))
}

/** setup に含まれる「seerResult が指定種別の役職」のリスト. */
export function rolesBySeerResultIn(
  setup: Map<SystemRole, number>,
  result: EnumSpecies,
): SystemRole[] {
  return allRolesIn(setup).filter(role => systemRoles.get(role)!.seerResult === result)
}

/**
 * trait predicate を満たす役職を systemRoles から全て返す (setup 非依存).
 * rolesWithTraitIn の setup フィルタ無し版. fixedPositions の確定先など、
 * setup に存在しなくても systemRoles レベルで意味のある役職を取り出す場面で使う.
 */
export function rolesByTrait(kind: RoleTrait['kind'], sub: RoleTrait['sub']): SystemRole[] {
  return allKnownRoles().filter(r => hasTrait(r, kind, sub))
}

/**
 * trait predicate を満たす役職を systemRoles から 1 つだけ返す (setup 非依存).
 * 0 件 or 複数件で throw (= 設計上 1 件しか無い前提のロジック箇所で使う).
 * 例: passive:die-when-divined → werehamster.
 */
export function singleRoleByTrait(kind: RoleTrait['kind'], sub: RoleTrait['sub']): SystemRole {
  const matched = allKnownRoles().filter(r => hasTrait(r, kind, sub))
  if (matched.length !== 1) {
    throw new Error(`singleRoleByTrait(${kind}:${sub}) expected exactly 1 role, got ${matched.length}: ${matched.join(',')}`)
  }
  return matched[0]
}

/**
 * seerResult が指定種別の役職を systemRoles から全て返す (setup 非依存).
 * rolesBySeerResultIn の setup フィルタ無し版.
 */
export function rolesBySeerResult(result: EnumSpecies): SystemRole[] {
  return allKnownRoles().filter(r => systemRoles.get(r)!.seerResult === result)
}

/**
 * seerResult が指定種別の役職を systemRoles から 1 つだけ返す (setup 非依存).
 * 0 件 or 複数件で throw.
 * 例: seerResult='wolf' → werewolf.
 */
export function singleRoleBySeerResult(result: EnumSpecies): SystemRole {
  const matched = allKnownRoles().filter(r => systemRoles.get(r)!.seerResult === result)
  if (matched.length !== 1) {
    throw new Error(`singleRoleBySeerResult(${result}) expected exactly 1 role, got ${matched.length}: ${matched.join(',')}`)
  }
  return matched[0]
}

/** setup に含まれる「trait を持つ役職」の count 合計. */
export function countByTraitIn(
  setup: Map<SystemRole, number>,
  kind: RoleTrait['kind'],
  sub: RoleTrait['sub'],
): number {
  return rolesWithTraitIn(setup, kind, sub).reduce((sum, role) => sum + (setup.get(role) ?? 0), 0)
}

/** setup に含まれる「seerResult が指定種別の役職」の count 合計. */
export function countBySeerResultIn(
  setup: Map<SystemRole, number>,
  result: EnumSpecies,
): number {
  return rolesBySeerResultIn(setup, result).reduce((sum, role) => sum + (setup.get(role) ?? 0), 0)
}

/**
 * predicate を満たす役職を systemRoles から 1 つだけ返す (setup 非依存).
 * 0 件 or 複数件で throw. trait + faction 等の複合条件で 1 役職を取り出すケースに.
 */
export function singleRoleByPredicate(predicate: (role: SystemRole) => boolean): SystemRole {
  const matched = allKnownRoles().filter(predicate)
  if (matched.length !== 1) {
    throw new Error(`singleRoleByPredicate expected exactly 1 role, got ${matched.length}: ${matched.join(',')}`)
  }
  return matched[0]
}

/** systemRoles に登録されている全役職 (setup 非依存). 宣言順を保つ. */
export function allKnownRoles(): SystemRole[] {
  return Array.from(systemRoles.keys())
}

/** systemRoles に登録されている全 村陣営役職 (setup 非依存). 配役生成等で使う. */
export function allVillageRoles(): SystemRole[] {
  return allKnownRoles().filter(r => systemRoles.get(r)!.faction === 'village')
}

/** systemRoles に登録されている全 人外陣営役職 (= faction !== 'village'、 setup 非依存). */
export function allLiarRoles(): SystemRole[] {
  return allKnownRoles().filter(r => systemRoles.get(r)!.faction !== 'village')
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

/**
 * setup に含まれる「能力を持つ村陣営役職」(faction=village かつ traits を持つ).
 * 旧 planBuilder.ts の `rolesInTestPlanning` を setup フィルタ + systemRoles 派生にしたもの.
 * 例: seer / medium / bodyguard / mason / nekomata. villager (traits=[]) は除外.
 */
export function poweredVillageRolesIn(setup: Map<SystemRole, number>): SystemRole[] {
  return allRolesIn(setup).filter(role => {
    const r = systemRoles.get(role)!
    return r.faction === 'village' && r.traits.length > 0
  })
}
