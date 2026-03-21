import type { Seat, Day } from '../types/index.ts'
import type { ConfirmationChecker, ConfirmationCheckerInput, ConfirmationReason } from './reasons.ts'
import { isTrustworthy } from './analysis.ts'

// ── 死因による確定 ──────────────────────────────────────────────────

function checkCursedByNekomataConfirm({ status, role }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'werewolf') return null
  if (
    !status.surviving &&
    (status.causeOfDeath === 'cursed_by_killed_nekomata' ||
     status.causeOfDeath === 'cursed_by_executed_nekomata')
  ) {
    return { type: 'cursed_by_nekomata' }
  }
  return null
}

function checkFollowHamsterConfirm({ status, role }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'immoralist') return null
  if (
    !status.surviving &&
    (status.causeOfDeath === 'follow_executed_hamster' ||
     status.causeOfDeath === 'follow_killed_hamster')
  ) {
    return { type: 'follow_hamster' }
  }
  return null
}

// ── CO分析による確定 ────────────────────────────────────────────────

function checkAllOtherCosBusted({ analysis, seat, role }: ConfirmationCheckerInput): ConfirmationReason | null {
  const roleAnalysis =
    role === 'seer' ? analysis.seer :
    role === 'medium' ? analysis.medium :
    null
  if (!roleAnalysis) return null

  if (roleAnalysis.confirmed !== seat) return null

  const bustedSeats = Array.from(roleAnalysis.busted.keys())
  if (bustedSeats.length === 0) return null

  return { type: 'all_other_cos_busted', role, bustedSeats }
}

// ── 結果合意による確定 ──────────────────────────────────────────────

function checkSeerConsensusBlack({ village, analysis, seat, role, players }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'werewolf') return null
  const result = collectConsensus(village, analysis, 'seer', seat, 'wolf', players)
  if (!result) return null
  return { type: 'seer_consensus_black', claimants: result }
}

function checkMediumConsensusBlack({ village, analysis, seat, role, players }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'werewolf') return null
  const result = collectConsensus(village, analysis, 'medium', seat, 'wolf', players)
  if (!result) return null
  return { type: 'medium_consensus_black', claimants: result }
}

/** 破綻していないCO者全員が同じ結果を出しているか確認 */
function collectConsensus(
  village: import('../types/index.ts').VillageStatus,
  analysis: import('./analysis.ts').AnalysisResult,
  claimRole: 'seer' | 'medium',
  seat: Seat,
  species: 'human' | 'wolf',
  players: Map<number, string> | undefined,
): { name: string, night: Day }[] | null {
  const claimants = (village.claims.get(claimRole) || []) as Seat[]
  const eligible: Seat[] = []
  for (const claimant of claimants) {
    if (!isTrustworthy(claimant, claimRole, analysis.confirmed)) continue
    const roleAnalysis = claimRole === 'seer' ? analysis.seer : analysis.medium
    if (roleAnalysis.busted.has(claimant)) continue
    eligible.push(claimant)
  }
  if (eligible.length === 0) return null

  const matches: { name: string, night: Day }[] = []
  for (const claimant of eligible) {
    const claimantStatus = village.statuses.get(claimant)!
    let found = false
    for (const [night, { target, species: sp }] of claimantStatus.assertions) {
      if (target === seat && sp === species) {
        matches.push({ name: players?.get(claimant) ?? `${claimant}`, night })
        found = true
        break
      }
    }
    if (!found) return null
  }
  return matches
}

// ── 共有相方 ────────────────────────────────────────────────────────

function checkMasonPartnerConfirm({ village, seat, role }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'mason') return null
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

// ── 呪殺 ────────────────────────────────────────────────────────────

function checkSeerFoxKillConfirm({ village, analysis, seat, status, role }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'werehamster') return null
  if (status.surviving || status.causeOfDeath !== 'night_kill' || status.diedDay == null) return null

  const nightDeaths = village.kills.get(status.diedDay) || []
  if (nightDeaths.length < 2) return null

  const seerClaimants = (village.claims.get('seer') || []) as Seat[]
  for (const seerSeat of seerClaimants) {
    if (!isTrustworthy(seerSeat, 'seer', analysis.confirmed)) continue
    if (analysis.seer.busted.has(seerSeat)) continue
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

// ── Exported checker list ───────────────────────────────────────────

export const allConfirmationCheckers: ConfirmationChecker[] = [
  checkCursedByNekomataConfirm,
  checkFollowHamsterConfirm,
  checkAllOtherCosBusted,
  checkSeerConsensusBlack,
  checkMediumConsensusBlack,
  checkMasonPartnerConfirm,
  checkSeerFoxKillConfirm,
]
