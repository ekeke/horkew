import type { Seat, SystemRole, VillageStatus, SeatStatus, Day } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'

// ── 確定役職の抽出 ─────────────────────────────────────────────────

export function getConfirmedRoles(
  possibilities: Map<Seat, Set<SystemRole>>
): Map<Seat, SystemRole> {
  const confirmed = new Map<Seat, SystemRole>()
  for (const [seat, roles] of possibilities) {
    if (roles.size === 1) {
      confirmed.set(seat, [...roles][0])
    }
  }
  return confirmed
}

// ── CO者の破綻判定（占い・霊媒共通） ────────────────────────────────

export type BustReason =
  | { type: 'result_contradicts_confirmed', target: Seat, confirmedRole: SystemRole, night: Day }
  | { type: 'confirmed_as_other_role', confirmedRole: SystemRole }
  | { type: 'rival_not_wolf_no_evil_slot', rival: Seat }
  | { type: 'perspective_liar_budget', needed: number, budget: number, breakdown: LiarBreakdownEntry[] }

export type LiarBreakdownEntry = {
  label: string   // e.g. "霊媒対抗", "藤澤黒判定"
  count: number
}

export type RoleAnalysis = {
  candidates: Seat[]
  busted: Map<Seat, BustReason>
  confirmed: Seat | null
}

/**
 * CO者の破綻判定を行う汎用関数
 *
 * 1. Retar確定役職がCO役職と不一致 → 破綻
 * 2. 結果が確定役職と矛盾 → 破綻
 *    - 黒判定の対象が確定非人狼（seerResult/mediumResult ≠ 'wolf'）→ 破綻
 *    - 白判定の対象が確定人狼 → 破綻
 */
function analyzeRole(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  confirmed: Map<Seat, SystemRole>,
  claimRole: SystemRole,
  resultField: 'seerResult' | 'mediumResult',
  players?: Map<number, string>,
): RoleAnalysis {
  const slots = setup.get(claimRole) || 0
  if (slots === 0) return { candidates: [], busted: new Map(), confirmed: null }

  const candidates = [...(village.claims.get(claimRole) || [])] as Seat[]
  const busted = new Map<Seat, BustReason>()

  for (const seat of candidates) {
    const status = village.statuses.get(seat)!

    // 破綻1: 視点人外数がセットアップを超過（完全自己完結）
    const perspBust = checkPerspectiveLiarBudget(seat, status, claimRole, village, setup, players)
    if (perspBust) {
      busted.set(seat, perspBust)
      continue
    }

    // 破綻2: 結果が確定役職と矛盾（Retar確定に依存）
    const bust = checkResultContradiction(status, confirmed, resultField)
    if (bust) {
      busted.set(seat, bust)
      continue
    }

    // 破綻3: Retarが別の役職に確定（フォールバック）
    const confirmedAs = confirmed.get(seat)
    if (confirmedAs != null && confirmedAs !== claimRole) {
      busted.set(seat, { type: 'confirmed_as_other_role', confirmedRole: confirmedAs })
    }
  }

  const remaining = candidates.filter(s => !busted.has(s))
  const confirmedHolder = remaining.length === slots ? remaining[0] : null

  return { candidates, busted, confirmed: confirmedHolder }
}

function checkResultContradiction(
  status: SeatStatus,
  confirmed: Map<Seat, SystemRole>,
  resultField: 'seerResult' | 'mediumResult',
): BustReason | null {
  for (const [night, { target, species }] of status.assertions) {
    if (night < 0) continue

    const targetRole = confirmed.get(target)
    if (targetRole == null) continue

    const roleInfo = systemRoles.get(targetRole)
    if (!roleInfo) continue

    const expectedResult = roleInfo[resultField]

    // 黒判定だが対象は人狼ではない（占い/霊媒で白が出るはずの役職）
    if (species === 'wolf' && expectedResult !== 'wolf') {
      return { type: 'result_contradicts_confirmed', target, confirmedRole: targetRole, night }
    }
    // 白判定だが対象は人狼（占い/霊媒で黒が出るはずの役職）
    if (species === 'human' && expectedResult === 'wolf') {
      return { type: 'result_contradicts_confirmed', target, confirmedRole: targetRole, night }
    }
  }
  return null
}

/**
 * 視点人外数の超過による破綻判定
 *
 * このCO者が真だと仮定した場合:
 * - 同役職の他CO者は全員偽（人外）
 * - 他役職のCO超過分は最低限の偽者（人外）
 * - 黒判定の対象（CO者でないもの）は追加の人外
 * - 合計がセットアップの人外数を超えれば矛盾
 */
function checkPerspectiveLiarBudget(
  seat: Seat,
  status: SeatStatus,
  claimRole: SystemRole,
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  players?: Map<number, string>,
): BustReason | null {
  const coRoles: SystemRole[] = ['seer', 'medium', 'bodyguard', 'mason', 'nekomata']
  const evilRoleNames: SystemRole[] = ['werewolf', 'possessed', 'fanatic', 'werehamster', 'immoralist']

  let evilBudget = 0
  for (const r of evilRoleNames) evilBudget += setup.get(r) || 0

  // 全CO者を収集（黒判定との重複排除用）
  const allCoSeats = new Set<Seat>()
  for (const r of coRoles) {
    for (const s of (village.claims.get(r) || [])) allCoSeats.add(s as Seat)
  }

  // CO視点での最低偽者数（内訳付き）
  const roleNameJa: Record<string, string> = {
    seer: '占い', medium: '霊媒', bodyguard: '狩人', mason: '共有', nekomata: '猫又',
  }
  let minFakes = 0
  const breakdown: LiarBreakdownEntry[] = []

  for (const r of coRoles) {
    const coHolders = [...(village.claims.get(r) || [])] as Seat[]
    const realSlots = setup.get(r) || 0
    let fakes: number

    if (r === claimRole) {
      fakes = coHolders.filter(s => s !== seat).length
    } else {
      fakes = Math.max(0, coHolders.length - realSlots)
    }

    if (fakes > 0) {
      const label = r === claimRole ? `${roleNameJa[r]}対抗` : `${roleNameJa[r]}偽(${coHolders.length}CO枠${realSlots})`
      breakdown.push({ label, count: fakes })
      minFakes += fakes
    }
  }

  // 黒判定の対象でCO者でないもの = 追加の人外
  let additionalEvil = 0
  for (const [night, { target, species }] of status.assertions) {
    if (night < 0) continue
    if (species === 'wolf' && !allCoSeats.has(target)) {
      const targetName = players?.get(target) ?? `${target}`
      breakdown.push({ label: `${targetName}黒判定`, count: 1 })
      additionalEvil++
    }
  }

  const totalNeeded = minFakes + additionalEvil
  if (totalNeeded > evilBudget) {
    return { type: 'perspective_liar_budget', needed: totalNeeded, budget: evilBudget, breakdown }
  }
  return null
}

// ── 個別分析関数 ────────────────────────────────────────────────────

export function analyzeSeer(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  confirmed: Map<Seat, SystemRole>,
  players?: Map<number, string>,
): RoleAnalysis {
  const base = analyzeRole(village, setup, confirmed, 'seer', 'seerResult', players)

  // 追加破綻判定: 対抗占い師が襲撃死かつ人外枠不足
  // confirmed_as_other_role よりも自己完結した説明を優先する
  for (const candidate of base.candidates) {
    const existing = base.busted.get(candidate)
    if (existing && existing.type !== 'confirmed_as_other_role') continue
    const status = village.statuses.get(candidate)!
    const bust = checkRivalSeerBust(candidate, status, village, setup, base.candidates)
    if (bust) {
      base.busted.set(candidate, bust)
    }
  }

  const seerSlots = setup.get('seer') || 0
  const remaining = base.candidates.filter(s => !base.busted.has(s))
  base.confirmed = remaining.length === seerSlots ? remaining[0] : null

  return base
}

/**
 * 対抗占い師の人外枠分析による破綻判定
 *
 * この占い師が真だと仮定した場合:
 * - 白判定を出した他役職CO者のうち、枠を超える分は人外(狂人等)
 * - 占い白 = seerResult が 'human' の役職 → 人狼以外の人外(狂人・狂信者等)を消費
 * - 対抗占い師が襲撃死(=非人狼)の場合、残りの人間表示人外枠が必要
 * - 枠が不足すれば矛盾 → この占い師は破綻
 */
function checkRivalSeerBust(
  seerSeat: Seat,
  seerStatus: SeatStatus,
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  allSeerCandidates: Seat[],
): BustReason | null {
  const rivals = allSeerCandidates.filter(s => s !== seerSeat)

  // 対抗のうち、単独襲撃死の者（人狼ではありえない）
  const nightKilledRivals: Seat[] = []
  for (const rival of rivals) {
    const rs = village.statuses.get(rival)!
    if (!rs.surviving && rs.causeOfDeath === 'night_kill' && rs.diedDay != null) {
      const nightDeaths = village.kills.get(rs.diedDay) || []
      if (nightDeaths.length === 1) {
        nightKilledRivals.push(rival)
      }
    }
  }
  if (nightKilledRivals.length === 0) return null

  // 配役上の「占い白で出る人外」枠の合計 (seerResult === 'human' の人外)
  const humanAppearingEvil: SystemRole[] = ['possessed', 'fanatic', 'immoralist']
  let totalHumanEvil = 0
  for (const r of humanAppearingEvil) {
    totalHumanEvil += setup.get(r) || 0
  }
  // werehamster も占い白だが独立陣営。偽COの動機は薄いため含めない

  // この占い師の白判定先が他役職CO者の偽枠をどれだけ消費するか
  const coRoles: SystemRole[] = ['medium', 'bodyguard', 'mason', 'nekomata']
  let minConsumed = 0

  for (const coRole of coRoles) {
    const coHolders = [...(village.claims.get(coRole) || [])] as Seat[]
    const realSlots = setup.get(coRole) || 0

    let whiteTargetsInCo = 0
    for (const holder of coHolders) {
      for (const [night, { target, species }] of seerStatus.assertions) {
        if (night < 0) continue
        if (target === holder && species === 'human') {
          whiteTargetsInCo++
          break
        }
      }
    }

    // 白判定のCO者数が実枠を超えた分 = 偽者かつ非人狼 → 人間表示人外枠を消費
    minConsumed += Math.max(0, whiteTargetsInCo - realSlots)
  }

  const remainingHumanEvil = totalHumanEvil - minConsumed

  // 襲撃死の対抗は非人狼 → 人間表示人外でなければならない
  // 枠が足りなければ矛盾
  if (nightKilledRivals.length > remainingHumanEvil) {
    return { type: 'rival_not_wolf_no_evil_slot', rival: nightKilledRivals[0] }
  }

  return null
}

export function analyzeMedium(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  confirmed: Map<Seat, SystemRole>,
  players?: Map<number, string>,
): RoleAnalysis {
  return analyzeRole(village, setup, confirmed, 'medium', 'mediumResult', players)
}

// ── CO者の信頼性判定 ────────────────────────────────────────────────

/**
 * あるCO者が信頼できるかどうかを判定する
 *
 * 確定役職がCO役職と一致しない場合は信頼できない
 */
export function isTrustworthy(
  seat: Seat,
  claimedRole: SystemRole,
  confirmed: Map<Seat, SystemRole>,
): boolean {
  const confirmedAs = confirmed.get(seat)
  if (confirmedAs == null) return true  // 未確定なら信頼可能
  return confirmedAs === claimedRole
}

// ── 分析結果の集約 ──────────────────────────────────────────────────

export type AnalysisResult = {
  confirmed: Map<Seat, SystemRole>
  seer: RoleAnalysis
  medium: RoleAnalysis
}

export function runAnalysis(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  possibilities: Map<Seat, Set<SystemRole>>,
  players?: Map<number, string>,
): AnalysisResult {
  const confirmed = getConfirmedRoles(possibilities)
  const seer = analyzeSeer(village, setup, confirmed, players)
  const medium = analyzeMedium(village, setup, confirmed, players)
  return { confirmed, seer, medium }
}
