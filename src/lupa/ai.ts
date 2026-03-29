/**
 * 互換性ラッパー: HeuristicStrategy への委譲
 * 新しいコードは strategy.ts + heuristic.ts を直接使うこと
 */
import type { GameState, PlayerState, NightAction, DayClaim } from './types.ts'
import type { Rng } from './random.ts'
import { HeuristicStrategy, forceTrueRoleCO as _forceTrueRoleCO, resolveVotes as _resolveVotes } from './heuristic.ts'
import type { DecisionContext } from './strategy.ts'

const heuristic = new HeuristicStrategy()

function makeCompatCtx(
  state: GameState, player: PlayerState, day: number,
  lastExecutedSeat: number | null, rng: Rng,
): DecisionContext {
  return {
    mySeat: player.seat,
    myRole: player.role,
    myPlayer: player,
    day,
    phase: state.phase,
    alivePlayers: state.players.filter(p => p.alive).map(p => p.seat),
    publicEvents: [],
    signals: [],
    commander: null,
    proposals: [],
    rng,
    gameState: state,
    lastExecutedSeat,
    retarPossibilities: null,
    maxSurvivingNV: null,
    wolfTeammates: null,
    knownWolves: null,
    knownHamster: null,
    masonPartner: null,
    revoteRound: null,
    revoteCandidates: null,
    executionPlans: [],
  }
}

export function decideNightAction(
  state: GameState, player: PlayerState, _night: number, rng: Rng,
): NightAction {
  const ctx = makeCompatCtx(state, player, state.day, null, rng)
  return heuristic.decideNightAction(ctx)
}

export function decideDayClaim(
  state: GameState, player: PlayerState, day: number,
  lastExecutedSeat: number | null, rng: Rng,
): DayClaim {
  const ctx = makeCompatCtx(state, player, day, lastExecutedSeat, rng)
  return heuristic.decideDayClaim(ctx)
}

export function decideForecast(
  state: GameState, player: PlayerState, rng: Rng,
): DayClaim {
  const ctx = makeCompatCtx(state, player, state.day, null, rng)
  return heuristic.decideForecast(ctx)
}

export function decideVote(
  state: GameState, voter: PlayerState, rng: Rng,
): number {
  const ctx = makeCompatCtx(state, voter, state.day, null, rng)
  return heuristic.decideVote(ctx)
}

export { _forceTrueRoleCO as forceTrueRoleCO }
export { _resolveVotes as resolveVotes }
