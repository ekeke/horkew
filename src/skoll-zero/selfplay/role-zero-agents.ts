/**
 * Village / Wolf / Fanatic / Hamster / Immoralist 用の zero agent。
 *
 * いずれも RoleZeroAgent を継承し、faction と captureObservation だけ差し替える。
 *
 * 観測エンコーダ:
 *   - Village / Fanatic / Hamster / Immoralist: standard encodeObservation (1029 dims)
 *   - Wolf: encodeCollectiveWolfObservation (1212 dims, TeamDecisionContext 要)
 *
 * ※ Wolf は本質的にチーム(TeamDecisionContext)単位だが、fullAdapter は個別 agent に
 *    DecisionContext を渡すため、ここでは「個々の wolf 席が独立に MCTS を回す」
 *    近似とする。厳密なチーム協調は Phase 3 で検討。
 */

import type { DecisionContext, TeamDecisionContext } from '../../fenrir/src/agents/agent.ts'
import {
  encodeObservation,
  encodeCollectiveWolfObservation,
} from '../../fenrir/src/observation.ts'
import type { Faction } from '../mcts/ismcts.ts'
import { RoleZeroAgent } from './role-zero-agent.ts'
import type { RootObs } from './observation.ts'

/** Village 視点 (villager/seer/medium/bodyguard/nekomata): standard obs、village faction */
export class VillageZeroAgent extends RoleZeroAgent {
  protected override faction(): Faction { return 'village' }
  protected override captureObservation(ctx: DecisionContext): RootObs {
    return encodeObservation(ctx)
  }
}

/** Wolf 視点: wolf_collective obs、wolf faction。各 wolf 席が独立に MCTS を回す近似 */
export class WolfZeroAgent extends RoleZeroAgent {
  protected override faction(): Faction { return 'wolf' }
  protected override captureObservation(ctx: DecisionContext): RootObs {
    // encodeCollectiveWolfObservation は TeamDecisionContext を取る。
    // 個別 Agent の DecisionContext から team info を復元して渡す。
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
}

/** Fanatic 視点: standard obs、wolf faction (狼勝ち = +1) */
export class FanaticZeroAgent extends RoleZeroAgent {
  protected override faction(): Faction { return 'wolf' }
  protected override captureObservation(ctx: DecisionContext): RootObs {
    return encodeObservation(ctx)
  }
}

/** Hamster 視点: standard obs、hamster faction */
export class HamsterZeroAgent extends RoleZeroAgent {
  protected override faction(): Faction { return 'hamster' }
  protected override captureObservation(ctx: DecisionContext): RootObs {
    return encodeObservation(ctx)
  }
}

/** Immoralist 視点: standard obs、hamster faction (狐勝ち = +1) */
export class ImmoralistZeroAgent extends RoleZeroAgent {
  protected override faction(): Faction { return 'hamster' }
  protected override captureObservation(ctx: DecisionContext): RootObs {
    return encodeObservation(ctx)
  }
}
