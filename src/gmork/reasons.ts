import type { Seat, Day, SystemRole, VillageStatus, SeatStatus } from '../types/index.ts'
import type { AnalysisResult, BustReason } from './analysis.ts'

export type DenialReason =
  // CO constraint: 村役職COは他の村役職を否定
  | { type: 'co_implies_not_other_village_role', claimedRole: SystemRole }
  // Tier 0: Analysis-based (confirmed roles from Retar)
  | { type: 'confirmed_seer_white', seerSeat: Seat, seerName: string, night: Day }
  | { type: 'confirmed_seer_black', seerSeat: Seat, seerName: string, night: Day }
  | { type: 'confirmed_medium_white', mediumSeat: Seat, mediumName: string, night: Day }
  | { type: 'confirmed_medium_black', mediumSeat: Seat, mediumName: string, night: Day }
  | { type: 'confirmed_role_holder_exists', confirmedSeat: Seat, confirmedName: string, confirmedRole: SystemRole }
  | { type: 'seer_claim_contradicted', bustReason: BustReason }
  | { type: 'medium_claim_contradicted', bustReason: BustReason }
  // Tier 1: Direct inference
  | { type: 'not_in_setup' }
  | { type: 'no_hamster_no_immoralist' }
  | { type: 'cursed_by_nekomata' }
  | { type: 'follow_hamster' }
  | { type: 'sole_night_kill', night: Day }
  | { type: 'villager_co' }
  | { type: 'surrender_co' }
  | { type: 'silent_execution' }
  | { type: 'denied_by_negative_co' }
  // Tier 2: Simple combination
  | { type: 'seer_black', claimants: { name: string, night: Day }[] }
  | { type: 'seer_white', claimants: { name: string, night: Day }[] }
  | { type: 'seer_fox_kill', seerSeat: Seat, seerName: string, night: Day }
  | { type: 'medium_black', claimants: { name: string, night: Day }[] }
  | { type: 'medium_white', claimants: { name: string, night: Day }[] }
  | { type: 'mason_partner', masonSeat: Seat, masonName: string }
  | { type: 'role_slots_filled', claimants: Seat[] }
  | { type: 'nekomata_no_companion', night: Day }
  | { type: 'all_hamsters_dead', lastHamsterDiedDay: Day }
  // Tier 3: Chained reasoning
  | { type: 'village_won_survivor' }
  | { type: 'liar_budget_exceeded', required: number, available: number, budgetDetail: string, hypothesisLabel: string, breakdown: { label: string, count: number }[] }

export type ConfirmationReason =
  // 死因による確定
  | { type: 'cursed_by_nekomata' }
  | { type: 'follow_hamster' }
  | { type: 'execution_companion', companionSeat: Seat, companionName: string }
  // CO分析による確定
  | { type: 'all_other_cos_busted', role: SystemRole, eliminatedCandidates: { seat: Seat, name: string }[] }
  // 結果合意による確定
  | { type: 'seer_consensus_black', claimants: { name: string, night: Day }[] }
  | { type: 'medium_consensus_black', claimants: { name: string, night: Day }[] }
  // 共有相方
  | { type: 'mason_partner', masonSeat: Seat, masonName: string }
  // 呪殺
  | { type: 'seer_fox_kill', seerSeat: Seat, seerName: string, night: Day }
  // 死亡人狼カウント
  | { type: 'dead_werewolf_count', requiredDead: number, candidates: { seat: Seat, name: string }[] }
  // 全人外位置判明によるCO信用
  | { type: 'all_evil_accounted', role: SystemRole, evilSeats: { seat: Seat, name: string }[] }
  // 霊媒白 + 人外確定 → 狂人/狂信者
  | { type: 'medium_white_non_wolf', claimants: { name: string, night: Day }[] }

export type ConfirmationCheckerInput = {
  village: VillageStatus
  setup: Map<SystemRole, number>
  seat: Seat
  role: SystemRole
  status: SeatStatus
  analysis: AnalysisResult
  players: Map<number, string> | undefined
  possibilities: Map<Seat, Set<SystemRole>> | undefined
}

export type ConfirmationChecker = (input: ConfirmationCheckerInput) => ConfirmationReason | null

export type CheckerInput = {
  village: VillageStatus
  setup: Map<SystemRole, number>
  seat: Seat
  role: SystemRole
  status: SeatStatus
  analysis: AnalysisResult | null
  players: Map<number, string> | undefined
}

export type Checker = (input: CheckerInput) => DenialReason | null

export const villageSpecialRoles: SystemRole[] = ['seer', 'medium', 'bodyguard', 'mason', 'nekomata']
export const villageSideRoles: SystemRole[] = ['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata']
export const evilRoles: SystemRole[] = ['werewolf', 'possessed', 'fanatic', 'werehamster', 'immoralist']
