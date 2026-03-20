import type { SystemRole, Seat } from '../types/index.ts'
import type { Checker, CheckerInput, DenialReason } from './reasons.ts'
import { villageSpecialRoles, villageSideRoles, evilRoles } from './reasons.ts'
import { isTrustworthy } from './analysis.ts'

// ── CO constraint: 村役職COは他の村役職を否定 ──────────────────────

function checkCoImpliesNotOtherVillageRole({ status, role }: CheckerInput): DenialReason | null {
  if (!status.claiming) return null
  const claimed = status.claimingRole as SystemRole
  if (!villageSpecialRoles.includes(claimed)) return null
  if (claimed === role) return null
  // 村役職COは他の村役職と村人を否定（真なら村人ではない、偽なら人外で村人ではない）
  if (role === 'villager' || villageSpecialRoles.includes(role)) {
    return { type: 'co_implies_not_other_village_role', claimedRole: claimed }
  }
  return null
}

// ── Tier 0: Analysis-based (confirmed roles from Retar) ────────────

function checkConfirmedSeerResult({ village, analysis, seat, role }: CheckerInput): DenialReason | null {
  if (!analysis?.seer.confirmed) return null

  const seerSeat = analysis.seer.confirmed
  const seerStatus = village.statuses.get(seerSeat)
  if (!seerStatus) return null

  for (const [night, { target, species }] of seerStatus.assertions) {
    if (night < 0 || target !== seat) continue
    if (species === 'human' && role === 'werewolf') {
      return { type: 'confirmed_seer_white', seerSeat, night }
    }
    if (species === 'wolf' && role !== 'werewolf') {
      return { type: 'confirmed_seer_black', seerSeat, night }
    }
  }
  return null
}

function checkConfirmedMediumResult({ village, analysis, seat, role }: CheckerInput): DenialReason | null {
  if (!analysis?.medium.confirmed) return null

  const mediumSeat = analysis.medium.confirmed
  const mediumStatus = village.statuses.get(mediumSeat)
  if (!mediumStatus) return null

  for (const [night, { target, species }] of mediumStatus.assertions) {
    if (night < 0 || target !== seat) continue
    if (species === 'human' && role === 'werewolf') {
      return { type: 'confirmed_medium_white', mediumSeat, night }
    }
    if (species === 'wolf' && role !== 'werewolf') {
      return { type: 'confirmed_medium_black', mediumSeat, night }
    }
  }
  return null
}

function checkSeerClaimContradicted({ analysis, seat, role }: CheckerInput): DenialReason | null {
  if (!analysis || role !== 'seer') return null
  const bustReason = analysis.seer.busted.get(seat)
  if (bustReason) return { type: 'seer_claim_contradicted', bustReason }
  return null
}

function checkMediumClaimContradicted({ analysis, seat, role }: CheckerInput): DenialReason | null {
  if (!analysis || role !== 'medium') return null
  const bustReason = analysis.medium.busted.get(seat)
  if (bustReason) return { type: 'medium_claim_contradicted', bustReason }
  return null
}

// ── Tier 1: Direct inference ────────────────────────────────────────

function checkNotInSetup({ setup, role }: CheckerInput): DenialReason | null {
  if (!setup.has(role) || setup.get(role) === 0) {
    return { type: 'not_in_setup' }
  }
  return null
}

function checkNoHamsterNoImmoralist({ setup, role }: CheckerInput): DenialReason | null {
  if (role === 'immoralist' && (!setup.has('werehamster') || setup.get('werehamster') === 0)) {
    return { type: 'no_hamster_no_immoralist' }
  }
  return null
}

function checkCursedByNekomata({ status, role }: CheckerInput): DenialReason | null {
  if (
    (status.causeOfDeath === 'cursed_by_killed_nekomata' ||
     status.causeOfDeath === 'cursed_by_executed_nekomata') &&
    !status.surviving &&
    role !== 'werewolf'
  ) {
    return { type: 'cursed_by_nekomata' }
  }
  return null
}

function checkFollowHamster({ status, role }: CheckerInput): DenialReason | null {
  if (
    (status.causeOfDeath === 'follow_executed_hamster' ||
     status.causeOfDeath === 'follow_killed_hamster') &&
    !status.surviving &&
    role !== 'immoralist'
  ) {
    return { type: 'follow_hamster' }
  }
  return null
}

function checkSoleNightKill({ village, status, role }: CheckerInput): DenialReason | null {
  if (
    role === 'werewolf' &&
    !status.surviving &&
    status.causeOfDeath === 'night_kill' &&
    status.diedDay != null
  ) {
    const nightDeaths = village.kills.get(status.diedDay) || []
    if (nightDeaths.length === 1) {
      return { type: 'sole_night_kill', night: status.diedDay }
    }
  }
  return null
}

function checkVillagerCo({ status, role }: CheckerInput): DenialReason | null {
  if (status.claimingRole === 'villager' && villageSpecialRoles.includes(role)) {
    return { type: 'villager_co' }
  }
  return null
}

function checkSurrenderCo({ status, role }: CheckerInput): DenialReason | null {
  if (status.claimingRole === 'surrender' && villageSideRoles.includes(role)) {
    return { type: 'surrender_co' }
  }
  return null
}

function checkSilentExecution({ status, role }: CheckerInput): DenialReason | null {
  if (
    !status.surviving &&
    status.causeOfDeath === 'execution' &&
    !status.claiming &&
    villageSpecialRoles.includes(role)
  ) {
    return { type: 'silent_execution' }
  }
  return null
}

function checkDeniedByNegativeCo({ status, role }: CheckerInput): DenialReason | null {
  if (status.deniedRoles.includes(role)) {
    return { type: 'denied_by_negative_co' }
  }
  return null
}

// ── Tier 2: Simple combination ──────────────────────────────────────

function checkSeerBlack({ village, analysis, seat, role }: CheckerInput): DenialReason | null {
  if (role === 'werewolf') return null
  const seerClaimants = (village.claims.get('seer') || []) as Seat[]
  for (const seerSeat of seerClaimants) {
    if (analysis && !isTrustworthy(seerSeat, 'seer', analysis.confirmed)) continue
    const seerStatus = village.statuses.get(seerSeat)!
    for (const [night, { target, species }] of seerStatus.assertions) {
      if (target === seat && species === 'wolf') {
        return { type: 'seer_black', seerSeat, night }
      }
    }
  }
  return null
}

function checkSeerWhite({ village, analysis, seat, role }: CheckerInput): DenialReason | null {
  if (role !== 'werewolf') return null
  const seerClaimants = (village.claims.get('seer') || []) as Seat[]
  for (const seerSeat of seerClaimants) {
    if (analysis && !isTrustworthy(seerSeat, 'seer', analysis.confirmed)) continue
    const seerStatus = village.statuses.get(seerSeat)!
    for (const [night, { target, species }] of seerStatus.assertions) {
      if (target === seat && species === 'human') {
        return { type: 'seer_white', seerSeat, night }
      }
    }
  }
  return null
}

function checkSeerFoxKill({ village, analysis, seat, status, role }: CheckerInput): DenialReason | null {
  if (role === 'werehamster') return null
  if (status.surviving || status.causeOfDeath !== 'night_kill' || status.diedDay == null) return null

  const nightDeaths = village.kills.get(status.diedDay) || []
  if (nightDeaths.length < 2) return null

  const seerClaimants = (village.claims.get('seer') || []) as Seat[]
  for (const seerSeat of seerClaimants) {
    if (analysis && !isTrustworthy(seerSeat, 'seer', analysis.confirmed)) continue
    const seerStatus = village.statuses.get(seerSeat)!
    for (const [night, { target }] of seerStatus.assertions) {
      if (target === seat && night === status.diedDay) {
        if (seerStatus.surviving || (seerStatus.diedDay != null && seerStatus.diedDay >= night)) {
          return { type: 'seer_fox_kill', seerSeat, night }
        }
      }
    }
  }
  return null
}

function checkMediumBlack({ village, analysis, seat, role }: CheckerInput): DenialReason | null {
  if (role === 'werewolf') return null
  const mediumClaimants = (village.claims.get('medium') || []) as Seat[]
  for (const mediumSeat of mediumClaimants) {
    if (analysis && !isTrustworthy(mediumSeat, 'medium', analysis.confirmed)) continue
    const mediumStatus = village.statuses.get(mediumSeat)!
    for (const [night, { target, species }] of mediumStatus.assertions) {
      if (target === seat && species === 'wolf') {
        return { type: 'medium_black', mediumSeat, night }
      }
    }
  }
  return null
}

function checkMediumWhite({ village, analysis, seat, role }: CheckerInput): DenialReason | null {
  if (role !== 'werewolf') return null
  const mediumClaimants = (village.claims.get('medium') || []) as Seat[]
  for (const mediumSeat of mediumClaimants) {
    if (analysis && !isTrustworthy(mediumSeat, 'medium', analysis.confirmed)) continue
    const mediumStatus = village.statuses.get(mediumSeat)!
    for (const [night, { target, species }] of mediumStatus.assertions) {
      if (target === seat && species === 'human') {
        return { type: 'medium_white', mediumSeat, night }
      }
    }
  }
  return null
}

function checkMasonPartner({ village, seat, role }: CheckerInput): DenialReason | null {
  if (role === 'mason') return null
  const masonClaimants = (village.claims.get('mason') || []) as Seat[]
  for (const masonSeat of masonClaimants) {
    const masonStatus = village.statuses.get(masonSeat)!
    for (const [, { target, species }] of masonStatus.assertions) {
      if (target === seat && species === 'human') {
        return { type: 'mason_partner', masonSeat }
      }
    }
  }
  return null
}

function checkRoleSlotsFilled({ village, setup, status, role }: CheckerInput): DenialReason | null {
  if (!villageSpecialRoles.includes(role)) return null
  if (status.claiming && status.claimingRole === role) return null

  const claimants = (village.claims.get(role) || []) as Seat[]
  const slots = setup.get(role) || 0
  if (slots > 0 && claimants.length >= slots) {
    return { type: 'role_slots_filled', claimants }
  }
  return null
}

function checkNekomataNoCompanion({ village, status, role }: CheckerInput): DenialReason | null {
  if (role !== 'nekomata') return null
  if (status.surviving || status.causeOfDeath !== 'night_kill' || status.diedDay == null) return null

  const nightDeaths = village.kills.get(status.diedDay) || []
  if (nightDeaths.length === 1) {
    return { type: 'nekomata_no_companion', night: status.diedDay }
  }
  return null
}

function checkAllHamstersDead({ village, setup, status, role }: CheckerInput): DenialReason | null {
  if (role !== 'immoralist') return null

  const hamsterCount = setup.get('werehamster') || 0
  if (hamsterCount === 0) return null

  const hamsterDeathDays = new Set<number>()
  for (const [, s] of village.statuses) {
    if (
      !s.surviving &&
      (s.causeOfDeath === 'follow_executed_hamster' || s.causeOfDeath === 'follow_killed_hamster') &&
      s.diedDay != null
    ) {
      hamsterDeathDays.add(s.diedDay)
    }
  }

  if (hamsterDeathDays.size < hamsterCount) return null

  const lastHamsterDiedDay = Math.max(...hamsterDeathDays)

  if (status.surviving || (status.diedDay != null && status.diedDay > lastHamsterDiedDay)) {
    return { type: 'all_hamsters_dead', lastHamsterDiedDay }
  }
  return null
}

// ── Tier 3: Chained reasoning ───────────────────────────────────────

function checkVillageWon({ village, status, role }: CheckerInput): DenialReason | null {
  if (village.result === 'villager_won' && status.surviving && role === 'werewolf') {
    return { type: 'village_won_survivor' }
  }
  return null
}

function checkLiarBudget({ village, setup, status, role }: CheckerInput): DenialReason | null {
  const coRoles: SystemRole[] = ['seer', 'medium', 'bodyguard', 'mason', 'nekomata']

  let evilCapacity = 0
  for (const r of evilRoles) {
    evilCapacity += setup.get(r) || 0
  }
  if (evilRoles.includes(role)) {
    evilCapacity -= 1
  }
  if (evilCapacity < 0) return null

  let minFakes = 0
  for (const r of coRoles) {
    const claimants = (village.claims.get(r) || []) as Seat[]
    let realSlots = setup.get(r) || 0

    if (role === r) {
      realSlots = Math.max(0, realSlots - 1)
    }

    const seatClaimsR = status.claiming && status.claimingRole === r

    if (seatClaimsR && role !== r) {
      minFakes += 1 + Math.max(0, claimants.length - 1 - realSlots)
    } else if (seatClaimsR && role === r) {
      minFakes += Math.max(0, claimants.length - 1 - realSlots)
    } else {
      minFakes += Math.max(0, claimants.length - realSlots)
    }
  }

  if (minFakes > evilCapacity) {
    return { type: 'liar_budget_exceeded', required: minFakes, available: evilCapacity }
  }
  return null
}

// ── Exported checker list ───────────────────────────────────────────

export const allCheckers: Checker[] = [
  // CO constraint
  checkCoImpliesNotOtherVillageRole,
  // Tier 0: Analysis-based
  checkConfirmedSeerResult,
  checkConfirmedMediumResult,
  checkSeerClaimContradicted,
  checkMediumClaimContradicted,
  // Tier 1
  checkNotInSetup,
  checkNoHamsterNoImmoralist,
  checkCursedByNekomata,
  checkFollowHamster,
  checkSoleNightKill,
  checkVillagerCo,
  checkSurrenderCo,
  checkSilentExecution,
  checkDeniedByNegativeCo,
  // Tier 2
  checkSeerBlack,
  checkSeerWhite,
  checkSeerFoxKill,
  checkMediumBlack,
  checkMediumWhite,
  checkMasonPartner,
  checkRoleSlotsFilled,
  checkNekomataNoCompanion,
  checkAllHamstersDead,
  // Tier 3
  checkVillageWon,
  checkLiarBudget,
]
