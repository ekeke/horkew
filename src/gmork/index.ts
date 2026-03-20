import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'

/**
 * 指定された席の役職が否定される理由を説明する
 */
export function explain(
  _village: VillageStatus,
  _setup: Map<SystemRole, number>,
  _seat: Seat,
  _role: SystemRole,
): string {
  return 'わかりません'
}
