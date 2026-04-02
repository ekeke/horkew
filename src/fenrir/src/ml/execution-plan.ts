/**
 * 処刑プランの分類と人間向け表示変換
 */

import type { SystemRole } from '../../../types/index.ts'
import type { ExecutionPlan } from '../strategy.ts'

/** 席→CO役職のマップ */
type ClaimedRoles = Map<number, SystemRole>

const ROLE_JP: Partial<Record<SystemRole, string>> = {
  seer: '占い',
  medium: '霊能',
  bodyguard: '狩人',
  mason: '共有',
  nekomata: '猫又',
}

export type PlanLabel =
  | { type: 'roller', role: SystemRole, seats: number[] }
  | { type: 'decision', role: SystemRole, targets: number[], trusted: number[] }
  | { type: 'designated', seat: number }
  | { type: 'grayran' }
  | { type: 'endgame', candidates: number[] }
  | { type: 'mixed', seats: number[] }
  | { type: 'none' }

/**
 * 処刑プランを分類する
 *
 * - type === 'grayran' → grayran
 * - type === 'endgame' → endgame
 * - 全targets が同一役職CO → roller
 * - 全targets が同一役職COで、そのCO者数 > targets数 → decision
 * - targets.length === 1 → designated (ただしroller/decisionに該当しない場合)
 * - それ以外 → mixed
 */
export function classifyPlan(plan: ExecutionPlan, claims: ClaimedRoles): PlanLabel {
  if (plan.type === 'grayran') return { type: 'grayran' }
  if (plan.type === 'endgame') return { type: 'endgame', candidates: plan.targets }
  if (plan.targets.length === 0) return { type: 'none' }

  // targets全員のCO役職を取得
  const targetRoles = plan.targets.map(s => claims.get(s))
  const firstRole = targetRoles[0]

  if (firstRole && targetRoles.every(r => r === firstRole)) {
    // 全targetsが同一役職をCO
    // その役職のCO者全員を取得
    const allClaimers = [...claims.entries()]
      .filter(([, r]) => r === firstRole)
      .map(([s]) => s)

    if (allClaimers.length > plan.targets.length) {
      // CO者の一部だけがtargetsに含まれている → 決め打ち
      const trusted = allClaimers.filter(s => !plan.targets.includes(s))
      return { type: 'decision', role: firstRole, targets: plan.targets, trusted }
    }
    if (plan.targets.length >= 2) {
      // 全CO者がtargetsに含まれている → ローラー
      return { type: 'roller', role: firstRole, seats: plan.targets }
    }
  }

  if (plan.targets.length === 1) {
    return { type: 'designated', seat: plan.targets[0] }
  }

  return { type: 'mixed', seats: plan.targets }
}

/** 処刑プランを人間向けの日本語ラベルに変換 */
export function formatPlanLabel(label: PlanLabel): string {
  switch (label.type) {
    case 'roller': {
      const roleName = ROLE_JP[label.role] ?? label.role
      const seats = label.seats.join('→')
      return `${roleName}ローラー（${seats}）`
    }
    case 'decision': {
      const roleName = ROLE_JP[label.role] ?? label.role
      const targets = label.targets.join('→')
      const trusted = label.trusted.join(',')
      return `${roleName}決め打ち（${targets}処刑、${trusted}を真と判断）`
    }
    case 'designated':
      return `${label.seat}吊り指定`
    case 'grayran':
      return 'グレラン'
    case 'endgame': {
      const candidates = label.candidates.join('or')
      return `最終日決選（${candidates}）`
    }
    case 'mixed': {
      const seats = label.seats.join('→')
      return `${seats}処刑提案`
    }
    case 'none':
      return '処刑プランなし'
  }
}
