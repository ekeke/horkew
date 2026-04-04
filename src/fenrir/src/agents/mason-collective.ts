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
import { encodeCollectiveMasonObservation } from '../observation.ts'
import { TeamStrategyBase, CollectiveStrategyBase } from './team-base.ts'

export class MasonTeamAgent extends TeamStrategyBase implements TeamAgent {
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

export class MasonCollective extends CollectiveStrategyBase implements TeamAgent {
  protected override infer(ctx: TeamDecisionContext): ForwardResult {
    const t = performance.now()
    const obs = encodeCollectiveMasonObservation(ctx)
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
