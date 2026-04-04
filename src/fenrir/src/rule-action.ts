/**
 * Re-export shim — plan/ モジュールへのリダイレクト
 * Phase 8 で削除予定
 */

// plan-vocab
export { PLAN_VOCAB, argmaxPlanTokens, parsePlanIndices } from './plan/plan-vocab.ts'
export type { PlanDayGroup } from './plan/plan-vocab.ts'

// plan-resolve
export { resolvePlanGroup as resolvePlanGroupSimple } from './plan/plan-resolve.ts'

// plan-helpers
export { planToVote, nightAction, dayClaim, communication, proposal, leadershipResponse } from './plan/plan-helpers.ts'
