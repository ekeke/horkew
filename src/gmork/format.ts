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
      return `確定${roleName(br.confirmedRole)}のため${claimLabel}ではありえない`
    case 'result_contradicts_confirmed':
      return `確定${roleName(br.confirmedRole)}(${br.target})に矛盾する判定を出しているため${claimLabel}ではありえない`
    case 'perspective_liar_budget': {
      const items = br.breakdown.map(e => ` - ${e.label}に${e.count}人`).join('\n')
      return `視点人外数超過。この村の人外は${br.budgetDetail}の計${br.budget}人ですが、${br.claimerName}視点では以下のように${br.needed}人以上になり矛盾します。\n${items}`
    }
    case 'white_evil_exceeded': {
      const items = br.breakdown.map(e => ` - ${e.label}`).join('\n')
      return `白人外数超過。この村の白人外は${br.budgetDetail}の計${br.budget}人ですが、${br.claimerName}視点では以下のように${br.needed}人以上になり破綻します。\n${items}`
    }
  }
}

export function formatReason(reason: DenialReason, role: SystemRole): string {
  switch (reason.type) {
    // CO constraint
    case 'co_implies_not_other_village_role':
      return `${roleName(reason.claimedRole)}をCOしているため${roleName(role)}ではありえない`

    // Tier 0: Analysis-based
    case 'confirmed_seer_white':
      return `真占い師(${reason.seerSeat})の${reason.night + 1}d白判定により人狼ではありえない`
    case 'confirmed_seer_black':
      return `真占い師(${reason.seerSeat})の${reason.night + 1}d黒判定により人狼に確定`
    case 'confirmed_medium_white':
      return `真霊媒師(${reason.mediumSeat})の${reason.night + 1}d白判定により人狼ではありえない`
    case 'confirmed_medium_black':
      return `真霊媒師(${reason.mediumSeat})の${reason.night + 1}d黒判定により人狼に確定`
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
      return '猫又の呪殺道連れで死亡しているため人狼に確定'
    case 'follow_hamster':
      return '妖狐の死亡に後追いしているため背徳者に確定'
    case 'sole_night_kill':
      return `${reason.night}d夜に単独で襲撃死しているため人狼ではありえない`
    case 'villager_co':
      return `村人をCOしているため${roleName(role)}ではありえない`
    case 'surrender_co':
      return `人外をCOしているため${roleName(role)}ではありえない`
    case 'silent_execution':
      return `COなしで処刑されているため${roleName(role)}ではありえない`
    case 'denied_by_negative_co':
      return `CO内容から${roleName(role)}ではありえない`

    // Tier 2
    case 'seer_black': {
      const names = reason.claimants.map(c => `${c.name}(${c.night + 1}d)`).join('・')
      return `占い師候補全員（破綻した候補は除く）（${names}）が黒判定を出しており、この中に必ず真の結果があるため人狼に確定`
    }
    case 'seer_white': {
      const names = reason.claimants.map(c => `${c.name}(${c.night + 1}d)`).join('・')
      return `占い師候補全員（破綻した候補は除く）（${names}）が白判定を出しており、この中に必ず真の結果があるため人狼ではありえない`
    }
    case 'seer_fox_kill':
      return `占い師(${reason.seerSeat})の${reason.night + 1}d占い先が呪殺されているため妖狐に確定`
    case 'medium_black': {
      const names = reason.claimants.map(c => `${c.name}(${c.night + 1}d)`).join('・')
      return `霊媒師候補全員（破綻した候補は除く）（${names}）が黒判定を出しており、この中に必ず真の結果があるため人狼に確定`
    }
    case 'medium_white': {
      const names = reason.claimants.map(c => `${c.name}(${c.night + 1}d)`).join('・')
      return `霊媒師候補全員（破綻した候補は除く）（${names}）が白判定を出しており、この中に必ず真の結果があるため人狼ではありえない`
    }
    case 'mason_partner':
      return `共有者(${reason.masonSeat})に相方と認定されているため共有者に確定`
    case 'role_slots_filled':
      return `${roleName(role)}の対抗に出なかったため${roleName(role)}ではありえない`
    case 'nekomata_no_companion':
      return `${reason.night}d夜の死者が1人だけのため猫又ではありえない（道連れがいない）`
    case 'all_hamsters_dead':
      return `${reason.lastHamsterDiedDay}dに妖狐が全滅しているため背徳者ではありえない`

    // Tier 3
    case 'village_won_survivor':
      return '村が勝利しているため、生存者は人狼ではありえない'
    case 'liar_budget_exceeded': {
      const items = reason.breakdown.map(e => ` - ${e.label}`).join('\n')
      return `偽者数超過。${reason.hypothesisLabel}の場合、人外枠は${reason.budgetDetail}人ですが、以下のように偽者が${reason.required}人必要となり矛盾します。\n${items}`
    }
  }
}
