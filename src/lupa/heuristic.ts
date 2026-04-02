/**
 * 後方互換 re-export — 実体は fenrir/src/heuristic.ts に移動
 */
export {
  HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic,
  forceTrueRoleCO, resolveVotes,
  isVillagePowerRole, isDefensiveCONeeded,
} from '../fenrir/src/heuristic.ts'
