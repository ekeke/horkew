/**
 * MasonZeroAgent — mason 視点の zero agent (ISMCTS + mason_collective 観測)。
 *
 * 基底 `RoleZeroAgent` に faction='village' と captureObs (mason_collective obs) を注入。
 */

import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { Faction } from '../mcts/ismcts.ts'
import { RoleZeroAgent, type RoleZeroAgentOptions } from './role-zero-agent.ts'
import { captureObs } from './observation.ts'
import type { RootObs } from './observation.ts'

export type MasonZeroAgentOptions = RoleZeroAgentOptions

export class MasonZeroAgent extends RoleZeroAgent {
  protected override faction(): Faction { return 'village' }
  protected override captureObservation(ctx: DecisionContext): RootObs {
    return captureObs(ctx)
  }
}
