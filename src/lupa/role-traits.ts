/**
 * 役職 trait 参照ヘルパー
 *
 * lupa エンジンが「役職名」で switch するのを避け、能力 (trait) ベースで分岐するための小道具。
 * 全ての参照元は `systemRoles` (src/types/index.ts)。
 */

import { systemRoles } from '../types/index.ts'
import type { SystemRole, Faction, RoleTrait } from '../types/index.ts'

export function hasTrait(role: SystemRole, kind: RoleTrait['kind'], sub: string): boolean {
  const traits = systemRoles.get(role)?.traits ?? []
  return traits.some(t => t.kind === kind && t.sub === sub)
}

export function getFaction(role: SystemRole): Faction {
  return systemRoles.get(role)?.faction ?? 'village'
}

/** 妖狐: 狐陣営かつ占い呪殺 trait を持つ役職 (werehamster のみ) */
export function isHamster(role: SystemRole): boolean {
  return getFaction(role) === 'fox' && hasTrait(role, 'passive', 'die-when-divined')
}
