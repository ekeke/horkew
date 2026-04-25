/**
 * Individual 観測 (1029 dims) を使う役職 Module 群。
 *
 * Module class は faction ごとに分離:
 * - `VillageIndividualModule` (faction: village) — villager / seer / medium / bodyguard / nekomata で共用 class、
 *   ただしインスタンスは役職別 NN で別々に init (§5.5 役職別 10 NN 保持)
 * - `FanaticIndividualModule` (faction: wolf) — fanatic
 * - `ThirdIndividualModule` (faction: hamster) — werehamster / immoralist で共用 class
 *
 * 旧 Village/Fanatic/Hamster/Immoralist ZeroAgent (現 RoleAgent) の Module 相当。
 */

import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { Faction } from '../mcts/ISMCTS.ts'
import { encodeObservation } from '../../fenrir/src/observation.ts'
import type { RootObs } from '../selfplay/observation.ts'
import { BaseSkollZeroModule } from './base-module.ts'

/** Village 系 (villager / seer / medium / bodyguard / nekomata): individual obs, village faction */
export class VillageIndividualModule extends BaseSkollZeroModule {
  captureObs(ctx: DecisionContext): RootObs {
    return encodeObservation(ctx)
  }
  protected faction(): Faction { return 'village' }
}

/** Fanatic: individual obs, wolf faction (狼勝ち = +1) */
export class FanaticIndividualModule extends BaseSkollZeroModule {
  captureObs(ctx: DecisionContext): RootObs {
    return encodeObservation(ctx)
  }
  protected faction(): Faction { return 'wolf' }
}

/** Third 陣営 (werehamster / immoralist): individual obs, hamster faction (狐勝ち = +1) */
export class ThirdIndividualModule extends BaseSkollZeroModule {
  captureObs(ctx: DecisionContext): RootObs {
    return encodeObservation(ctx)
  }
  protected faction(): Faction { return 'hamster' }
}
