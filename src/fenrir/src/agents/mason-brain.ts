/**
 * Mason Brain Agent for Brain Battle
 *
 * 共有チームの Brain Battle 専用エージェント。
 * plan token (GRU decoder) を使わず、per-seat vote head で直接処刑先を選択する。
 * WolfBrainAgent と対称的な構造。
 */

import type { TeamDecisionContext } from './agent.ts'
import type { AnyNetwork, ForwardResult } from '../ml/nn.ts'
import type { NeuralAgentConfig } from './neural-agent.ts'
import { encodeCollectiveMasonObservation, SEATS } from '../observation.ts'
import { CollectiveAgentBase } from './team-base.ts'
import { trace } from '../trace.ts'

export class MasonBrainAgent extends CollectiveAgentBase {
  constructor(network: AnyNetwork, config?: Partial<NeuralAgentConfig>) {
    super(network, config)
  }

  protected override infer(ctx: TeamDecisionContext): ForwardResult {
    const t = performance.now()
    const obs = encodeCollectiveMasonObservation(ctx)
    this.lastObs = obs
    const result = this.network.forward(obs)
    this.inferMs += performance.now() - t
    this.inferCount++
    return result
  }

  /**
   * Brain Battle: 直接処刑先を選択。
   * Returns seat number (1-based).
   */
  decideExecution(ctx: TeamDecisionContext): number {
    trace('agent', ctx.day, ctx.teamSeats[0] ?? null, 'mason', 'MasonBrainAgent.decideExecution')
    const result = this.getOrInfer(ctx)
    const logits = result.policies.get('vote')!
    // Mask: dead + mason team を除外
    const mask = new Float32Array(SEATS).fill(-Infinity)
    const teamSet = new Set(ctx.teamSeats)
    for (const seat of ctx.alivePlayers) {
      if (!teamSet.has(seat) && seat <= SEATS) {
        mask[seat - 1] = 0
      }
    }
    // Fallback: 全マスクなら alive non-self を開放
    if (mask.every(v => v === -Infinity)) {
      for (const seat of ctx.alivePlayers) {
        if (seat !== ctx.mySeat && seat <= SEATS) mask[seat - 1] = 0
      }
    }
    const primarySeat = ctx.teamSeats[0]
    const { action, logProb } = this.selectAction(logits, mask)
    this.record('vote', action, logProb, result.value, 0, primarySeat)
    return action + 1  // 0-indexed → 1-indexed seat
  }

  override decideVote(ctx: TeamDecisionContext): number {
    return this.decideExecution(ctx)
  }
}
