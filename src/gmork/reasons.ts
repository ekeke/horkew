import type { Seat, Day, SystemRole, VillageStatus, SeatStatus } from '../types/index.ts'
import type { AnalysisResult, BustReason } from './analysis.ts'

export type DenialReason =
  // CO constraint: 村役職COは他の村役職を否定
  | { type: 'co_implies_not_other_village_role', claimedRole: SystemRole }
  // Tier 0: Analysis-based (confirmed roles from Retar)
  | { type: 'confirmed_seer_white', seerSeat: Seat, night: Day }
  | { type: 'confirmed_seer_black', seerSeat: Seat, night: Day }
  | { type: 'confirmed_medium_white', mediumSeat: Seat, night: Day }
  | { type: 'confirmed_medium_black', mediumSeat: Seat, night: Day }
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
  | { type: 'seer_fox_kill', seerSeat: Seat, night: Day }
  | { type: 'medium_black', claimants: { name: string, night: Day }[] }
  | { type: 'medium_white', claimants: { name: string, night: Day }[] }
  | { type: 'mason_partner', masonSeat: Seat }
  | { type: 'role_slots_filled', claimants: Seat[] }
  | { type: 'nekomata_no_companion', night: Day }
  | { type: 'all_hamsters_dead', lastHamsterDiedDay: Day }
  // Tier 3: Chained reasoning
  | { type: 'village_won_survivor' }
  | { type: 'liar_budget_exceeded', required: number, available: number, budgetDetail: string, hypothesisLabel: string, breakdown: { label: string, count: number }[] }

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
