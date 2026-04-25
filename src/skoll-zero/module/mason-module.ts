/**
 * MasonSkollZeroModule — mason_collective 観測 (1030 dims) + village faction。
 *
 * 旧 `MasonZeroAgent` (現 MasonRoleAgent) の Module 相当。共通ロジックは BaseSkollZeroModule。
 */

import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { Faction } from '../mcts/ISMCTS.ts'
import { captureObs as captureMasonObs } from '../selfplay/observation.ts'
import type { RootObs } from '../selfplay/observation.ts'
import { BaseSkollZeroModule } from './base-module.ts'

export class MasonSkollZeroModule extends BaseSkollZeroModule {
  captureObs(ctx: DecisionContext): RootObs {
    return captureMasonObs(ctx)
  }
  protected faction(): Faction { return 'village' }
}
