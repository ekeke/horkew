import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { DenialReason, ConfirmationReason } from './reasons.ts'
import type { BustReason } from './analysis.ts'
import { runAnalysis, getConfirmedRoles, analyzeSeer, analyzeMedium } from './analysis.ts'
import { allCheckers } from './checkers.ts'
import { allConfirmationCheckers } from './confirmers.ts'
import { formatReason, formatConfirmationReason } from './format.ts'

// ── 依存先の説明可能性チェック ─────────────────────────────────────────

/**
 * 確認用のinputを構築するヘルパー
 */
function buildConfirmationInput(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  seat: Seat,
  role: SystemRole,
  players?: Map<number, string>,
  possibilities?: Map<Seat, Set<SystemRole>>,
) {
  const status = village.statuses.get(seat)
  if (!status) return null
  const confirmed = possibilities ? getConfirmedRoles(possibilities) : new Map()
  const seer = analyzeSeer(village, setup, confirmed, players)
  const medium = analyzeMedium(village, setup, confirmed, players)
  const analysis = { confirmed, seer, medium }
  return { village, setup, seat, role, status, analysis, players, possibilities }
}

/**
 * 確定理由がaxiomaticチェッカーのみで説明可能か（bust検証から呼ばれる）
 */
function hasAxiomaticConfirmation(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  seat: Seat,
  role: SystemRole,
  players?: Map<number, string>,
  possibilities?: Map<Seat, Set<SystemRole>>,
): boolean {
  const input = buildConfirmationInput(village, setup, seat, role, players, possibilities)
  if (!input) return false

  for (const { fn, category } of allConfirmationCheckers) {
    if (category !== 'axiomatic') continue
    if (fn(input)) return true
  }
  return false
}

/**
 * 確定理由が説明可能か（axiomatic + 依存チェック済みdependent）
 *
 * isDependencyExplainable → hasExplainableConfirmation → isConfirmationDependencyExplainable
 *   → areBustsExplainable → isBustExplainable → hasAxiomaticConfirmation（厳格版で終端）
 * 再帰はhasAxiomaticConfirmation（axiomatic限定）で止まるため無限ループしない。
 */
function hasExplainableConfirmation(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  seat: Seat,
  role: SystemRole,
  players?: Map<number, string>,
  possibilities?: Map<Seat, Set<SystemRole>>,
): boolean {
  const input = buildConfirmationInput(village, setup, seat, role, players, possibilities)
  if (!input) return false

  for (const { fn, category } of allConfirmationCheckers) {
    if (category === 'axiomatic') {
      if (fn(input)) return true
    } else if (category === 'dependent') {
      const reason = fn(input)
      if (reason && isConfirmationDependencyExplainable(reason, village, setup, players, possibilities)) {
        return true
      }
    }
  }
  return false
}

/**
 * bust理由がaxiomaticに説明可能か
 *
 * - perspective_liar_budget / white_evil_exceeded: 自己完結
 * - result_contradicts_confirmed: 確定対象がaxiomaticに説明可能なら OK
 * - confirmed_as_other_role: Retar依存のみ → 説明不能
 */
function isBustExplainable(
  bustReason: BustReason,
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  players?: Map<number, string>,
  possibilities?: Map<Seat, Set<SystemRole>>,
): boolean {
  switch (bustReason.type) {
    case 'perspective_liar_budget':
    case 'white_evil_exceeded':
      return true
    case 'result_contradicts_confirmed':
      return hasAxiomaticConfirmation(village, setup, bustReason.target, bustReason.confirmedRole, players, possibilities)
    case 'confirmed_as_other_role':
      return false
  }
}

/**
 * 指定ロールのbusted CO者のbust理由が全て説明可能かチェック
 */
function areBustsExplainable(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  role: 'seer' | 'medium' | 'both',
  players?: Map<number, string>,
  possibilities?: Map<Seat, Set<SystemRole>>,
): boolean {
  const analysis = possibilities
    ? runAnalysis(village, setup, possibilities, players)
    : null
  if (!analysis) return true

  if (role === 'seer' || role === 'both') {
    for (const [, bustReason] of analysis.seer.busted) {
      if (!isBustExplainable(bustReason, village, setup, players, possibilities)) return false
    }
  }
  if (role === 'medium' || role === 'both') {
    for (const [, bustReason] of analysis.medium.busted) {
      if (!isBustExplainable(bustReason, village, setup, players, possibilities)) return false
    }
  }
  return true
}

/**
 * dependentカテゴリの否定理由の依存先が説明可能か検証
 */
function isDependencyExplainable(
  reason: DenialReason,
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  _seat: Seat,
  players?: Map<number, string>,
  possibilities?: Map<Seat, Set<SystemRole>>,
): boolean {
  switch (reason.type) {
    case 'confirmed_seer_white':
    case 'confirmed_seer_black':
      return hasExplainableConfirmation(village, setup, reason.seerSeat, 'seer', players, possibilities)

    case 'confirmed_medium_white':
    case 'confirmed_medium_black':
      return hasExplainableConfirmation(village, setup, reason.mediumSeat, 'medium', players, possibilities)

    case 'confirmed_role_holder_exists':
      return hasExplainableConfirmation(village, setup, reason.confirmedSeat, reason.confirmedRole, players, possibilities)

    case 'seer_claim_contradicted':
      return isBustExplainable(reason.bustReason, village, setup, players, possibilities)
    case 'medium_claim_contradicted':
      return isBustExplainable(reason.bustReason, village, setup, players, possibilities)

    case 'seer_black':
    case 'seer_white':
    case 'seer_fox_kill':
      return areBustsExplainable(village, setup, 'seer', players, possibilities)

    case 'medium_black':
    case 'medium_white':
      return areBustsExplainable(village, setup, 'medium', players, possibilities)

    case 'co_contradiction_pair_slot':
    case 'co_contradiction_triple_slot':
      return areBustsExplainable(village, setup, 'both', players, possibilities)

    default:
      return true
  }
}

/**
 * dependentカテゴリの確定理由の依存先が説明可能か検証
 */
function isConfirmationDependencyExplainable(
  reason: ConfirmationReason,
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  players?: Map<number, string>,
  possibilities?: Map<Seat, Set<SystemRole>>,
): boolean {
  switch (reason.type) {
    case 'all_other_cos_busted':
      // bust対象のロールに応じてチェック
      return areBustsExplainable(village, setup,
        reason.role === 'seer' ? 'seer' : reason.role === 'medium' ? 'medium' : 'both',
        players, possibilities)

    case 'seer_consensus_black':
    case 'seer_fox_kill':
      return areBustsExplainable(village, setup, 'seer', players, possibilities)

    case 'medium_consensus_black':
    case 'medium_white_non_wolf':
      return areBustsExplainable(village, setup, 'medium', players, possibilities)

    case 'dead_werewolf_count':
      return true

    default:
      return true
  }
}

// ── Public API ─────────────────────────────────────────────────────────

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
  for (const { fn, category } of allCheckers) {
    const reason = fn(input)
    if (!reason) continue

    if (category === 'axiomatic') return reason

    if (category === 'dependent') {
      if (isDependencyExplainable(reason, village, setup, seat, players, possibilities)) {
        return reason
      }
      continue
    }

    // elimination
    return reason
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
  for (const { fn, category } of allConfirmationCheckers) {
    const reason = fn(input)
    if (!reason) continue

    if (category === 'axiomatic') return reason

    if (category === 'dependent') {
      if (isConfirmationDependencyExplainable(reason, village, setup, players, possibilities)) {
        return reason
      }
      continue
    }

    // elimination
    return reason
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
