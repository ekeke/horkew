/**
 * 後方互換 re-export — 実体は fenrir/src/agents/agent.ts に移動
 */
export type {
  DecisionContext, PlanType, ExecutionPlan,
  Agent as Strategy, TeamDecisionContext, WolfNightAction, TeamAgent as TeamStrategy,
  AsyncAgent as AsyncStrategy, AsyncTeamAgent as AsyncTeamStrategy,
} from '../fenrir/src/agents/agent.ts'
