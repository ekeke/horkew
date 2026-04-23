/**
 * WolfSkollZeroModule — wolf_collective 観測 (1212 dims) + wolf faction。
 *
 * 旧 `WolfZeroAgent` の Module 相当。個別 wolf の DecisionContext から team obs を復元。
 */

import type { DecisionContext, TeamDecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { Faction } from '../mcts/ismcts.ts'
import { encodeCollectiveWolfObservation } from '../../fenrir/src/observation.ts'
import type { RootObs } from '../selfplay/observation.ts'
import { BaseSkollZeroModule } from './base-module.ts'

export class WolfSkollZeroModule extends BaseSkollZeroModule {
  captureObs(ctx: DecisionContext): RootObs {
    return buildWolfTeamObs(ctx)
  }
  protected faction(): Faction { return 'wolf' }
}

/**
 * 個別 wolf の DecisionContext から team obs を復元。
 * fullAdapter は wolf にも個別 DecisionContext を渡すので、teamSeats / teamPlayers を
 * この場で組み立てて encodeCollectiveWolfObservation に渡す。
 */
function buildWolfTeamObs(ctx: DecisionContext): RootObs {
  const teamSeats = [...(ctx.wolfTeammates ?? [])]
  if (!teamSeats.includes(ctx.mySeat)) teamSeats.unshift(ctx.mySeat)
  const teamPlayers = teamSeats
    .map(s => ctx.gameState.players.find(p => p.seat === s))
    .filter((p): p is NonNullable<typeof p> => !!p)
  const teamCtx: TeamDecisionContext = {
    ...ctx,
    teamSeats,
    teamPlayers,
    currentActorSeat: ctx.mySeat,
  }
  return encodeCollectiveWolfObservation(teamCtx)
}
