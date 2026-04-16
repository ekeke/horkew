/**
 * 共有者チームMLエージェント
 *
 * MasonTeamAgent: 個別共有チームNN
 * MasonCollective: 集団共有NN
 */

import type { TeamDecisionContext, TeamAgent } from './agent.ts'
import type { NightAction, DayClaim } from '../../../lupa/types.ts'
import type { CommunicationAction } from '../communication.ts'
import type { Proposal, LeadershipResponse } from '../leadership.ts'
import type { ForwardResult } from '../ml/nn.ts'
import { encodeTeamObservation, encodeCollectiveMasonObservation } from '../observation.ts'
import { TeamAgentBase, CollectiveAgentBase } from './team-base.ts'

/** @deprecated Use MasonCollective instead */
export class MasonTeamAgent extends TeamAgentBase implements TeamAgent {
  protected override infer(ctx: TeamDecisionContext): ForwardResult {
    const t = performance.now()
    const obs = encodeTeamObservation(ctx)
    this.lastObs = obs
    const result = this.network.forward(obs)
    this.inferMs += performance.now() - t
    this.inferCount++
    return result
  }

  decideNightAction(_ctx: TeamDecisionContext): NightAction {
    return { type: 'none' }
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

export class MasonCollective extends CollectiveAgentBase implements TeamAgent {
  protected override infer(ctx: TeamDecisionContext): ForwardResult {
    const t = performance.now()
    const obs = encodeCollectiveMasonObservation(ctx)
    this.lastObs = obs
    const result = this.network.forward(obs)
    this.inferMs += performance.now() - t
    this.inferCount++
    return result
  }

  /** Record plan tokens as a trajectory step (for Brain Battle PPO) */
  recordPlan(result: ForwardResult, seat: number): void {
    if (!result.planActions || !result.planLogProbs || !this.lastObs) return
    let totalLogProb = 0
    for (const lp of result.planLogProbs) totalLogProb += lp
    this.trajectory.push({
      seat,
      observation: this.lastObs,
      actionHead: 'strategy',
      actionIdx: -1,
      logProb: totalLogProb,
      reward: 0,
      value: result.value,
      done: false,
      planActions: result.planActions,
      planLogProbs: result.planLogProbs,
    })
  }

  decideNightAction(_ctx: TeamDecisionContext): NightAction {
    return { type: 'none' }
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
