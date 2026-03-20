import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { DenialReason } from './reasons.ts'
import { runAnalysis } from './analysis.ts'
import { allCheckers } from './checkers.ts'
import { formatReason } from './format.ts'

/**
 * 指定された席の役職否定理由を構造化データで返す
 */
export function findReason(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  seat: Seat,
  role: SystemRole,
  possibilities?: Map<Seat, Set<SystemRole>>,
  players?: Map<number, string>,
): DenialReason | null {
  const status = village.statuses.get(seat)
  if (!status) return null

  const analysis = possibilities
    ? runAnalysis(village, setup, possibilities, players)
    : null

  const input = { village, setup, seat, role, status, analysis }
  for (const checker of allCheckers) {
    const reason = checker(input)
    if (reason) return reason
  }
  return null
}

/**
 * 指定された席の役職が否定される理由を説明する
 */
export function explain(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  seat: Seat,
  role: SystemRole,
  possibilities?: Map<Seat, Set<SystemRole>>,
  players?: Map<number, string>,
): string {
  const reason = findReason(village, setup, seat, role, possibilities, players)
  if (reason) return formatReason(reason, role)
  return 'わかりません'
}
