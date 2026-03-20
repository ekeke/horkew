import type { DenialReason } from './reasons.ts'
import type { BustReason } from './analysis.ts'
import type { SystemRole } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'

function roleName(role: SystemRole): string {
  return systemRoles.get(role)?.name || role
}

function formatBustReason(br: BustReason, claimLabel: string): string {
  switch (br.type) {
    case 'confirmed_as_other_role':
      return `確定${roleName(br.confirmedRole)}のため${claimLabel}破綻`
    case 'result_contradicts_confirmed':
      return `確定${roleName(br.confirmedRole)}(${br.target})への矛盾判定により${claimLabel}破綻`
    case 'rival_not_wolf_no_evil_slot':
      return `対抗(${br.rival})が襲撃死で非人狼かつ人外枠不足のため${claimLabel}破綻`
    case 'perspective_liar_budget': {
      const items = br.breakdown.map(e => `${e.label}${e.count}`).join('+')
      return `視点人外${items}=${br.needed} > 人外枠${br.budget}のため${claimLabel}破綻`
    }
  }
}

export function formatReason(reason: DenialReason, role: SystemRole): string {
  switch (reason.type) {
    // CO constraint
    case 'co_implies_not_other_village_role':
      return `${roleName(reason.claimedRole)}COしているため${roleName(role)}ではありえない`

    // Tier 0: Analysis-based
    case 'confirmed_seer_white':
      return `真占い師${reason.seerSeat}の${reason.night + 1}d白判定により人狼ではない`
    case 'confirmed_seer_black':
      return `真占い師${reason.seerSeat}の${reason.night + 1}d黒判定により人狼確定`
    case 'confirmed_medium_white':
      return `真霊媒師${reason.mediumSeat}の${reason.night + 1}d白判定により人狼ではない`
    case 'confirmed_medium_black':
      return `真霊媒師${reason.mediumSeat}の${reason.night + 1}d黒判定により人狼確定`
    case 'seer_claim_contradicted':
      return formatBustReason(reason.bustReason, '占い師')
    case 'medium_claim_contradicted':
      return formatBustReason(reason.bustReason, '霊媒師')

    // Tier 1
    case 'not_in_setup':
      return `配役に${roleName(role)}が存在しない`
    case 'no_hamster_no_immoralist':
      return '配役に妖狐がいないため背徳者ではありえない'
    case 'cursed_by_nekomata':
      return '猫又の呪殺道連れにより人狼確定'
    case 'follow_hamster':
      return '妖狐死亡による後追い死のため背徳者確定'
    case 'sole_night_kill':
      return `${reason.night}d夜: 単独襲撃死のため人狼ではありえない`
    case 'villager_co':
      return `村人COしているため${roleName(role)}ではありえない`
    case 'surrender_co':
      return `降参COしているため${roleName(role)}ではありえない`
    case 'silent_execution':
      return `COなしで処刑されたため${roleName(role)}ではありえない`
    case 'denied_by_negative_co':
      return `CO内容により${roleName(role)}ではありえない`

    // Tier 2
    case 'seer_black':
      return `占い師${reason.seerSeat}の${reason.night + 1}d黒判定により人狼確定`
    case 'seer_white':
      return `占い師${reason.seerSeat}の${reason.night + 1}d白判定により人狼ではない`
    case 'seer_fox_kill':
      return `占い師${reason.seerSeat}の${reason.night + 1}d占い先呪殺により妖狐確定`
    case 'medium_black':
      return `霊媒師${reason.mediumSeat}の${reason.night + 1}d黒判定により人狼確定`
    case 'medium_white':
      return `霊媒師${reason.mediumSeat}の${reason.night + 1}d白判定により人狼ではない`
    case 'mason_partner':
      return `共有者${reason.masonSeat}の相方認定により共有者確定`
    case 'role_slots_filled':
      return `${roleName(role)}枠がCO者で充足済みのため${roleName(role)}ではありえない`
    case 'nekomata_no_companion':
      return `${reason.night}d夜: 死者が1人のため猫又ではありえない（道連れがいない）`
    case 'all_hamsters_dead':
      return `妖狐が${reason.lastHamsterDiedDay}dに全滅しているため背徳者ではない`

    // Tier 3
    case 'village_won_survivor':
      return '村勝利のため生存者は人狼ではありえない'
    case 'liar_budget_exceeded':
      return `人外枠${reason.available}人に対し偽者が${reason.required}人必要となり矛盾`
  }
}
