/**
 * WolfImitationModule — wolf_collective 観測 (1212 dims) + wolf faction、
 * claim_fake / morning は WolfImitationNetwork.mixForward 経由で frozen village NN と
 * mix した policy を返す。
 *
 * - execute / attack は通常経路 (super.forwardAt) で 純 wolf head を出す
 * - claim_fake / morning は virtualSeerObs を構築して mixForward を呼ぶ
 *
 * 依存:
 * - `WolfImitationNetwork` を nn として受け取る (constructor で type narrow)
 * - `buildVirtualSeerObs` で「wolfSeat が真 seer だったら」の obs を構築
 */

import type { SystemRole } from '../../types/index.ts'
import type { HeadName, NNOutput } from '../mcts/nn.ts'
import type { SimState } from '../simulator/world-state.ts'
import type { RolloutInvariants } from '../observation/from-sim-state.ts'
import { BENCH_ENABLED, benchEnd } from '../bench/profiler.ts'
import { buildVirtualSeerObs } from '../observation/wolf-imitation.ts'
import { WolfImitationNetwork } from '../network/wolf-imitation-network.ts'
import { WolfSkollZeroModule } from './wolf-module.ts'
import type { BaseSkollZeroModuleOptions } from './base-module.ts'

/** WolfImitationModule 専用の constructor opts。nn は必ず WolfImitationNetwork。 */
export type WolfImitationModuleOptions =
  Omit<BaseSkollZeroModuleOptions, 'nn'> & { nn: WolfImitationNetwork }

export class WolfImitationModule extends WolfSkollZeroModule {
  /** type-narrowed nn (constructor で同じインスタンスを再格納) */
  private readonly imitationNN: WolfImitationNetwork

  constructor(opts: WolfImitationModuleOptions) {
    super(opts)
    this.imitationNN = opts.nn
  }

  override forwardAt(
    state: SimState,
    actorSeat: number,
    actorRole: SystemRole,
    headName: HeadName,
    invariants: RolloutInvariants,
  ): NNOutput {
    if (headName !== 'claim_fake' && headName !== 'morning') {
      return super.forwardAt(state, actorSeat, actorRole, headName, invariants)
    }
    const t0 = BENCH_ENABLED ? performance.now() : 0
    const rootObs = this.encodeStateObs(state, actorSeat, actorRole, invariants)
    const virtualSeerObs = buildVirtualSeerObs(state, actorSeat, invariants)
    if (BENCH_ENABLED) benchEnd('obs_encode', t0)
    const t1 = BENCH_ENABLED ? performance.now() : 0
    const result = this.imitationNN.mixForward(rootObs, virtualSeerObs, state, actorSeat, headName)
    if (BENCH_ENABLED) benchEnd('nn_forward', t1)
    return result
  }

  override forwardBatchAt(
    states: SimState[],
    actorSeats: number[],
    actorRoles: SystemRole[],
    headName: HeadName,
    invariants: RolloutInvariants,
  ): NNOutput[] {
    if (headName !== 'claim_fake' && headName !== 'morning') {
      return super.forwardBatchAt(states, actorSeats, actorRoles, headName, invariants)
    }
    // mix forward は virtual seer obs を per-state で 1 つずつ構築する必要があるため、
    // batch 化せず forwardAt を順次呼ぶ。GPU batched forward は frozen village NN だけが
    // batch されないだけで、wolf NN は per-call で forward される。将来的には
    // virtualSeerObs を batched に集めて 1 回の frozen village forward に集約可能。
    const outputs: NNOutput[] = []
    for (let i = 0; i < states.length; i++) {
      outputs.push(this.forwardAt(states[i], actorSeats[i], actorRoles[i], headName, invariants))
    }
    return outputs
  }
}
