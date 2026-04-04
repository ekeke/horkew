/**
 * Re-export shim — agents/rule-based-agent.ts へのリダイレクト
 * Phase 8 で削除予定
 */

export {
  RuleBasedAgent as HeuristicStrategy,
  WolfTeamRuleAgent as WolfTeamHeuristic,
  MasonTeamRuleAgent as MasonTeamHeuristic,
  isVillagePowerRole,
  isDefensiveCONeeded,
} from './agents/rule-based-agent.ts'

export { forceTrueRoleCO, resolveVotes } from '../../lupa/engine-utils.ts'
