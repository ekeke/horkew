/**
 * 後方互換 re-export — 実体は fenrir/src/strategy.ts に移動
 */
export type {
  DecisionContext, PlanType, ExecutionPlan,
  Strategy, TeamDecisionContext, WolfNightAction, TeamStrategy,
  AsyncStrategy, AsyncTeamStrategy,
} from '../fenrir/src/strategy.ts'
