import { systemRoles } from '../../types/index.ts'
import type { SystemRole } from '../../types/index.ts'

export type NameStatus = 'default' | 'village' | 'wolf' | 'fox' | 'not-village'

/**
 * 役職可能性集合の alignment から名前の状況色を決める。
 * 両ペイン (AnalysisTable / VerticalDensePane) で共通の規則。
 */
export function classifyPlayer(roles: SystemRole[]): NameStatus {
  if (roles.length === 0) return 'default'
  const alignments = new Set(roles.map(r => systemRoles.get(r)!.alignment))
  if (alignments.size === 1) {
    const a = [...alignments][0]
    if (a === 'villager') return 'village'
    if (a === 'werewolf') return 'wolf'
    if (a === 'werehamster') return 'fox'
  }
  if (!alignments.has('villager')) return 'not-village'
  return 'default'
}
