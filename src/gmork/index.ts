import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { DenialReason, ConfirmationReason } from './reasons.ts'
import { runAnalysis, getConfirmedRoles, analyzeSeer, analyzeMedium } from './analysis.ts'
import { allCheckers } from './checkers.ts'
import { allConfirmationCheckers } from './confirmers.ts'
import { formatReason, formatConfirmationReason } from './format.ts'

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

  const input = { village, setup, seat, role, status, analysis, players, possibilities }
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

/**
 * 指定された席の役職確定理由を構造化データで返す
 * 対象自身にはretarを使わないが、消去法で他プレイヤーの否定にはpossibilitiesを使える
 */
export function findConfirmationReason(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  seat: Seat,
  role: SystemRole,
  players?: Map<number, string>,
  possibilities?: Map<Seat, Set<SystemRole>>,
): ConfirmationReason | null {
  const status = village.statuses.get(seat)
  if (!status) return null

  const confirmed = possibilities
    ? getConfirmedRoles(possibilities)
    : new Map<Seat, SystemRole>()
  const seer = analyzeSeer(village, setup, confirmed, players)
  const medium = analyzeMedium(village, setup, confirmed, players)
  const analysis = { confirmed, seer, medium }

  const input = { village, setup, seat, role, status, analysis, players, possibilities }
  for (const checker of allConfirmationCheckers) {
    const reason = checker(input)
    if (reason) return reason
  }
  return null
}

/**
 * 指定された席の役職が確定した理由を説明する
 */
export function explainConfirmation(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  seat: Seat,
  role: SystemRole,
  players?: Map<number, string>,
  possibilities?: Map<Seat, Set<SystemRole>>,
): string {
  const reason = findConfirmationReason(village, setup, seat, role, players, possibilities)
  if (reason) return formatConfirmationReason(reason, role)
  return 'わかりません'
}
