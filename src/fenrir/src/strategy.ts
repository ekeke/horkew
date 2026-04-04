/**
 * Re-export shim — agents/agent.ts へのリダイレクト
 * Phase 8 で削除予定
 */

export type {
  Agent as Strategy,
  TeamAgent as TeamStrategy,
  AsyncAgent as AsyncStrategy,
  AsyncTeamAgent as AsyncTeamStrategy,
  DecisionContext,
  TeamDecisionContext,
  WolfNightAction,
  ExecutionPlan,
  PlanType,
} from './agents/agent.ts'
