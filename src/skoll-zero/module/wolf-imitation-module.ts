/**
 * WolfImitationModule — wolf_collective 観測 (1212 dims) + wolf faction、
 * claim_decision / morning は WolfImitationNetwork.mixForward 経由で frozen village NN
 * と mix した policy を返す。
 *
 * - execute / attack は通常経路 (super.forwardAt) で 純 wolf head を出す
 * - claim_decision (A案): 4 種 virtualViewerObs (seer/medium/bg/nekomata) を構築 → mixForward
 *   で 57-dim joint distribution を出す
 * - morning (B案維持): seer 単体の virtualViewerObs を構築 → mixForward で 28-dim を出す
 *
 * 依存:
 * - `WolfImitationNetwork` を nn として受け取る (constructor で type narrow)
 * - `buildVirtualViewerObs` で「wolfSeat が真 {seer / medium / bg / nekomata} だったら」の
 *   obs を構築
 */

import type { SystemRole } from '../../types/index.ts'
import type { HeadName, NNOutput } from '../mcts/nn.ts'
import type { RootActionMode } from '../mcts/ISMCTS.ts'
import type { SimState } from '../simulator/world-state.ts'
import type { RolloutInvariants } from '../observation/from-sim-state.ts'
import type { PendingRecord } from '../selfplay/buffer.ts'
import { BENCH_ENABLED, benchEnd } from '../bench/profiler.ts'
import { buildVirtualViewerObs } from '../observation/wolf-imitation.ts'
import { WolfImitationNetwork, type VirtualViewerObsBundle } from '../network/wolf-imitation-network.ts'
import { WolfSkollZeroModule } from './wolf-module.ts'
import type { BaseSkollZeroModuleOptions } from './base-module.ts'

/** WolfImitationModule 専用の constructor opts。nn は必ず WolfImitationNetwork。 */
export type WolfImitationModuleOptions =
  Omit<BaseSkollZeroModuleOptions, 'nn'> & { nn: WolfImitationNetwork }

/** claim_decision の 4 viewer role 順序 (Bundle key と整合) */
const CLAIM_DECISION_VIEWER_ROLES: ReadonlyArray<'seer' | 'medium' | 'bodyguard' | 'nekomata'> =
  ['seer', 'medium', 'bodyguard', 'nekomata']

export class WolfImitationModule extends WolfSkollZeroModule {
  /** type-narrowed nn (constructor で同じインスタンスを再格納) */
  private readonly imitationNN: WolfImitationNetwork

  constructor(opts: WolfImitationModuleOptions) {
    super(opts)
    this.imitationNN = opts.nn
  }

  /**
   * Wolf imitation A案を要求する Module であることを宣言。
   *
   * これにより BaseSkollZeroModule.runMctsProposal 内で、当該 Module が `bundle.wolf` に
   * 入っている全 MCTS rollout で `state.wolfImitation = true` が設定される。
   * 結果、claim_decision phase が active になり、旧 claim_*_fake は自動 skip される
   * (WolfImitationNetwork に旧 'claim_fake' head が無いため、これを設定しないと throw する)。
   */
  requiresWolfImitationMode(): boolean {
    return true
  }

  override forwardAt(
    state: SimState,
    actorSeat: number,
    actorRole: SystemRole,
    headName: HeadName,
    invariants: RolloutInvariants,
  ): NNOutput {
    if (headName !== 'claim_decision' && headName !== 'morning') {
      return super.forwardAt(state, actorSeat, actorRole, headName, invariants)
    }
    const t0 = BENCH_ENABLED ? performance.now() : 0
    const rootObs = this.encodeStateObs(state, actorSeat, actorRole, invariants)
    if (BENCH_ENABLED) benchEnd('obs_encode', t0)

    if (headName === 'morning') {
      // morning は seer 視点のみ
      const t1 = BENCH_ENABLED ? performance.now() : 0
      const seerObs = buildVirtualViewerObs(state, actorSeat, 'seer', invariants)
      if (BENCH_ENABLED) benchEnd('obs_encode', t1)
      const t2 = BENCH_ENABLED ? performance.now() : 0
      const result = this.imitationNN.mixForward(rootObs, seerObs, state, actorSeat, headName)
      if (BENCH_ENABLED) benchEnd('nn_forward', t2)
      return result
    }

    // claim_decision: 4 種 viewer obs を構築
    const t1 = BENCH_ENABLED ? performance.now() : 0
    const bundle = buildClaimDecisionBundle(state, actorSeat, invariants)
    if (BENCH_ENABLED) benchEnd('obs_encode', t1)
    const t2 = BENCH_ENABLED ? performance.now() : 0
    const result = this.imitationNN.mixForward(rootObs, bundle, state, actorSeat, headName)
    if (BENCH_ENABLED) benchEnd('nn_forward', t2)
    return result
  }

  override forwardBatchAt(
    states: SimState[],
    actorSeats: number[],
    actorRoles: SystemRole[],
    headName: HeadName,
    invariants: RolloutInvariants,
  ): NNOutput[] {
    if (headName !== 'claim_decision' && headName !== 'morning') {
      return super.forwardBatchAt(states, actorSeats, actorRoles, headName, invariants)
    }
    // mix forward は virtual viewer obs を per-state で個別構築する必要があるため、
    // batch 化せず forwardAt を順次呼ぶ。GPU batched forward は frozen village NN だけが
    // batch されないだけで、wolf NN は per-call で forward される。将来的には
    // 4 viewer obs を batched に集めて 1 回の frozen village forward に集約可能。
    const outputs: NNOutput[] = []
    for (let i = 0; i < states.length; i++) {
      outputs.push(this.forwardAt(states[i], actorSeats[i], actorRoles[i], headName, invariants))
    }
    return outputs
  }

  /**
   * record 蓄積前に viewer obs を auxObs に inject。
   *
   * - claim_decision: `auxObs.virtualViewerObsBundle = {seer, medium, bg, nekomata}`
   * - morning: `auxObs.virtualViewerObs = seer obs` (single Float32Array)
   * - その他 (claim_*_fake legacy 経路、execute / attack / divine / guard): inject なし
   *
   * 注意: record.masonSeat は actor seat (wolf 自席)。virtualViewerObs はこの seat を
   * 真の各役職と仮定した観測。学習時に TF.js graph で frozen village NN に入力する。
   */
  protected override augmentRecord(
    record: PendingRecord,
    state: SimState,
    invariants: RolloutInvariants,
    actionMode: RootActionMode,
  ): PendingRecord {
    if (actionMode === 'claim_decision') {
      const bundle = buildClaimDecisionBundle(state, record.masonSeat, invariants)
      return {
        ...record,
        auxObs: {
          ...(record.auxObs ?? {}),
          virtualViewerObsBundle_seer: bundle.seer,
          virtualViewerObsBundle_medium: bundle.medium,
          virtualViewerObsBundle_bodyguard: bundle.bodyguard,
          virtualViewerObsBundle_nekomata: bundle.nekomata,
        },
      }
    }
    if (actionMode === 'morning') {
      const seerObs = buildVirtualViewerObs(state, record.masonSeat, 'seer', invariants)
      return {
        ...record,
        auxObs: { ...(record.auxObs ?? {}), virtualViewerObs: seerObs },
      }
    }
    return record
  }
}

/**
 * 4 種 viewer obs (seer/medium/bg/nekomata) を構築して Bundle として返す。
 *
 * 各 viewer での retar 自己再計算が走るため、global retar の prior cache がある場合は
 * invariants 経由で共有される (from-sim-state.ts:retarPriorCache)。
 */
function buildClaimDecisionBundle(
  state: SimState,
  wolfSeat: number,
  invariants: RolloutInvariants,
): VirtualViewerObsBundle {
  const result: Record<string, Float32Array> = {}
  for (const role of CLAIM_DECISION_VIEWER_ROLES) {
    result[role] = buildVirtualViewerObs(state, wolfSeat, role, invariants)
  }
  return result as unknown as VirtualViewerObsBundle
}
