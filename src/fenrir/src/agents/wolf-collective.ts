/**
 * 狼チームMLエージェント（集団狼NN、frozen村NN注入対応）
 */

import type { TeamDecisionContext, WolfNightAction } from './agent.ts'
import type { DayClaim } from '../../../lupa/types.ts'
import type { CommunicationAction } from '../communication.ts'
import type { Proposal, LeadershipResponse } from '../leadership.ts'
import type { AnyNetwork, ForwardResult } from '../ml/nn.ts'
import type { VillageNNOutput } from '../observation.ts'
import { encodeObservation, encodeCollectiveWolfObservation } from '../observation.ts'
import { maskAttackTarget, maskAttacker, decodeWolfNightAction } from '../action.ts'
import { CollectiveAgentBase } from './team-base.ts'

export class WolfCollective extends CollectiveAgentBase {
  /** frozen村NNの出力（外部から注入、またはfrozenVillageNetworkから自動生成） */
  villageNNOutput: VillageNNOutput | undefined = undefined
  /** frozen村NN（セットされていれば infer 時に自動で forward して villageNNOutput を更新） */
  frozenVillageNetwork: AnyNetwork | undefined = undefined

  protected override infer(ctx: TeamDecisionContext): ForwardResult {
    const t = performance.now()
    // frozen村NNからpredict/trust出力を取得
    if (this.frozenVillageNetwork) {
      const villageObs = encodeObservation(ctx)
      const villageResult = this.frozenVillageNetwork.forward(villageObs)
      this.villageNNOutput = {
        predict: villageResult.policies.get('predict')!,
        trust: villageResult.policies.get('trust')!,
      }
    }
    const obs = encodeCollectiveWolfObservation(ctx, this.villageNNOutput)
    this.lastObs = obs
    const result = this.network.forward(obs)
    this.inferMs += performance.now() - t
    this.inferCount++
    return result
  }

  decideNightAction(ctx: TeamDecisionContext): WolfNightAction {
    const result = this.getOrInfer(ctx)

    const attackLogits = result.policies.get('attack_target')!
    const attackMask = maskAttackTarget(ctx)
    const { action: attackIdx, logProb: attackLogProb } = this.selectAction(attackLogits, attackMask)
    const seat = ctx.currentActorSeat ?? ctx.teamSeats[0]
    this.record('attack_target', attackIdx, attackLogProb, result.value, 0, seat)

    const attackerLogits = result.policies.get('attacker')!
    const attackerMask = maskAttacker(ctx)
    const { action: attackerIdx, logProb: attackerLogProb } = this.selectAction(attackerLogits, attackerMask)
    this.record('attacker', attackerIdx, attackerLogProb, result.value, 0, seat)

    return decodeWolfNightAction(attackIdx, attackerIdx, ctx.teamSeats)
  }

  decideDayClaim(ctx: TeamDecisionContext): DayClaim {
    return this.decideDayClaimImpl(ctx)
  }

  decideForecast(ctx: TeamDecisionContext): DayClaim {
    return this.decideForecastImpl(ctx)
  }

  decideVote(ctx: TeamDecisionContext): number {
    return this.decideVoteImpl(ctx)
  }

  decideCommunication(ctx: TeamDecisionContext): CommunicationAction {
    return this.decideCommunicationImpl(ctx)
  }

  decideProposal(ctx: TeamDecisionContext): Proposal | null {
    return this.decideProposalImpl(ctx)
  }

  decideLeadershipResponse(ctx: TeamDecisionContext, _proposal: Proposal): LeadershipResponse {
    return this.decideLeadershipResponseImpl(ctx)
  }

  decideDefensiveClaim(_ctx: TeamDecisionContext): DayClaim {
    return { type: 'none' }
  }
}
