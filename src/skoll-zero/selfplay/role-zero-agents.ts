/**
 * Village / Wolf / Fanatic / Hamster / Immoralist 用の zero agent。
 *
 * いずれも SkollZeroRoleAgent を継承し、対応する SkollZeroModule を constructor で init する。
 *
 * ## 役職別 Module 対応
 *
 * - Village (villager/seer/medium/bodyguard/nekomata): VillageIndividualModule
 * - Wolf: WolfSkollZeroModule (wolf_collective obs)
 * - Fanatic: FanaticIndividualModule (individual obs, wolf faction)
 * - Hamster / Immoralist: ThirdIndividualModule (individual obs, hamster faction)
 *
 * Night action (seer divine / bodyguard guard / wolf attack) は Module の
 * proposeNightAction を呼び出す。村系の villager/medium/nekomata は夜行動なしなので
 * super (heuristic) に委譲。
 */

import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { NightAction } from '../../lupa/types.ts'
import { SkollZeroRoleAgent, type SkollZeroRoleAgentOptions } from './role-zero-agent.ts'
import { argmaxFromVisits, sampleFromVisits } from './policy-utils.ts'
import {
  VillageIndividualModule,
  FanaticIndividualModule,
  ThirdIndividualModule,
} from '../module/individual-modules.ts'
import { WolfSkollZeroModule } from '../module/wolf-module.ts'

/** Village 視点 (villager/seer/medium/bodyguard/nekomata): individual obs、village faction */
export class VillageRoleAgent extends SkollZeroRoleAgent {
  constructor(opts: SkollZeroRoleAgentOptions) {
    const module = new VillageIndividualModule({
      nn: opts.nn,
      setup: opts.setup,
      buffer: opts.buffer,
      mctsConfig: opts.mctsConfig,
      determinizerMaxWorlds: opts.determinizerMaxWorlds,
    })
    super(module, opts.selectionMode ?? 'sample')
  }

  /**
   * 夜行動: seer は divine head、bodyguard は guard head で ISMCTS を実行。
   * 他役職 (villager/medium/nekomata) は super (RuleBasedAgent) に委譲。
   */
  override decideNightAction(ctx: DecisionContext): NightAction {
    if (ctx.myRole === 'seer') return this.proposeNight(ctx, 'divine')
    if (ctx.myRole === 'bodyguard') return this.proposeNight(ctx, 'guard')
    return super.decideNightAction(ctx)
  }

  private proposeNight(ctx: DecisionContext, mode: 'divine' | 'guard'): NightAction {
    const r = this.module.proposeNightAction(ctx, mode)
    if (!r) return super.decideNightAction(ctx)
    const target = this.selectionMode === 'argmax'
      ? argmaxFromVisits(r.visits)
      : sampleFromVisits(r.visits, () => ctx.rng.next())
    return { type: mode, target }
  }
}

/** Wolf 視点: wolf_collective obs、wolf faction。各 wolf 席が独立に MCTS を回す近似 */
export class WolfRoleAgent extends SkollZeroRoleAgent {
  constructor(opts: SkollZeroRoleAgentOptions) {
    const module = new WolfSkollZeroModule({
      nn: opts.nn,
      setup: opts.setup,
      buffer: opts.buffer,
      mctsConfig: opts.mctsConfig,
      determinizerMaxWorlds: opts.determinizerMaxWorlds,
    })
    super(module, opts.selectionMode ?? 'sample')
  }

  /**
   * 夜の噛み先を ISMCTS + NN で決定する。
   * Retar 無効 / Determinizer overflow 時は super (heuristic) に委譲。
   */
  override decideNightAction(ctx: DecisionContext): NightAction {
    const r = this.module.proposeNightAction(ctx, 'attack')
    if (!r) return super.decideNightAction(ctx)
    const target = this.selectionMode === 'argmax'
      ? argmaxFromVisits(r.visits)
      : sampleFromVisits(r.visits, () => ctx.rng.next())
    // 個別 Agent の NightAction は lupa 型 (attacker は team agent が決める)
    return { type: 'attack', target }
  }
}

/** Fanatic 視点: standard obs、wolf faction (狼勝ち = +1) */
export class FanaticRoleAgent extends SkollZeroRoleAgent {
  constructor(opts: SkollZeroRoleAgentOptions) {
    const module = new FanaticIndividualModule({
      nn: opts.nn,
      setup: opts.setup,
      buffer: opts.buffer,
      mctsConfig: opts.mctsConfig,
      determinizerMaxWorlds: opts.determinizerMaxWorlds,
    })
    super(module, opts.selectionMode ?? 'sample')
  }
}

/** Hamster 視点: standard obs、hamster faction */
export class HamsterRoleAgent extends SkollZeroRoleAgent {
  constructor(opts: SkollZeroRoleAgentOptions) {
    const module = new ThirdIndividualModule({
      nn: opts.nn,
      setup: opts.setup,
      buffer: opts.buffer,
      mctsConfig: opts.mctsConfig,
      determinizerMaxWorlds: opts.determinizerMaxWorlds,
    })
    super(module, opts.selectionMode ?? 'sample')
  }
}

/** Immoralist 視点: standard obs、hamster faction (狐勝ち = +1) */
export class ImmoralistRoleAgent extends SkollZeroRoleAgent {
  constructor(opts: SkollZeroRoleAgentOptions) {
    const module = new ThirdIndividualModule({
      nn: opts.nn,
      setup: opts.setup,
      buffer: opts.buffer,
      mctsConfig: opts.mctsConfig,
      determinizerMaxWorlds: opts.determinizerMaxWorlds,
    })
    super(module, opts.selectionMode ?? 'sample')
  }
}
