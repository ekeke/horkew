/**
 * FenrirStrategy: MLベースの Strategy 実装
 * NeuralNetworkの推論結果をLupaのアクションに変換する。
 */

import type { Strategy, DecisionContext } from '../../lupa/strategy.ts'
import type { NightAction, DayClaim } from '../../lupa/types.ts'
import type { Signal } from '../../lupa/communication.ts'
import type { Proposal, LeadershipResponse } from '../../lupa/leadership.ts'
import type { NeuralNetwork, ForwardResult } from './ml/nn.ts'
import type { TrajectoryStep } from './ml/trajectory.ts'
import { encodeObservation } from './observation.ts'
import {
  maskNightAction, maskClaim, maskVote, maskComm, maskLeader, maskTarget,
  sampleMasked,
  decodeNightActionWithRole, decodeClaim, decodeComm, decodeLeader,
} from './action.ts'

export type FenrirStrategyConfig = {
  /** trueなら探索ノイズあり（学習時）、falseなら貪欲（評価時） */
  explore: boolean
}

export class FenrirStrategy implements Strategy {
  readonly network: NeuralNetwork
  readonly config: FenrirStrategyConfig

  /** 学習時にトラジェクトリを収集するバッファ */
  trajectory: TrajectoryStep[] = []

  constructor(network: NeuralNetwork, config?: Partial<FenrirStrategyConfig>) {
    this.network = network
    this.config = { explore: true, ...config }
  }

  private infer(ctx: DecisionContext): ForwardResult {
    const obs = encodeObservation(ctx)
    return this.network.forward(obs)
  }

  private record(
    ctx: DecisionContext, head: string, actionIdx: number,
    logProb: number, value: number, reward: number,
  ): void {
    this.trajectory.push({
      seat: ctx.mySeat,
      observation: encodeObservation(ctx),
      actionHead: head,
      actionIdx,
      logProb,
      reward,
      value,
      done: false,
    })
  }

  private selectAction(
    logits: Float32Array, mask: Float32Array,
  ): { action: number, logProb: number } {
    if (this.config.explore) {
      return sampleMasked(logits, mask)
    }
    // Greedy: pick highest masked logit
    let bestIdx = 0
    let bestVal = -Infinity
    for (let i = 0; i < logits.length; i++) {
      const val = logits[i] + mask[i]
      if (val > bestVal) {
        bestVal = val
        bestIdx = i
      }
    }
    return { action: bestIdx, logProb: 0 }
  }

  // ============================================================
  // Strategy interface implementation
  // ============================================================

  decideNightAction(ctx: DecisionContext): NightAction {
    const result = this.infer(ctx)
    const logits = result.policies.get('night')!
    const mask = maskNightAction(ctx)
    const { action, logProb } = this.selectAction(logits, mask)

    this.record(ctx, 'night', action, logProb, result.value, 0)

    return decodeNightActionWithRole(action, ctx.myRole)
  }

  decideDayClaim(ctx: DecisionContext): DayClaim {
    const result = this.infer(ctx)
    const claimLogits = result.policies.get('claim')!
    const claimMask = maskClaim(ctx)
    const { action: claimIdx, logProb: claimLogProb } = this.selectAction(claimLogits, claimMask)

    // target選択（CO内容によっては必要）
    const targetLogits = result.policies.get('target')!
    const targetMask = maskTarget(ctx)
    const { action: targetIdx } = this.selectAction(targetLogits, targetMask)

    this.record(ctx, 'claim', claimIdx, claimLogProb, result.value, 0)

    return decodeClaim(claimIdx, targetIdx, ctx)
  }

  decideForecast(ctx: DecisionContext): DayClaim {
    // Forecast はclaim headで FORECAST を選んだ時に発動
    // ここでは別途推論する
    const result = this.infer(ctx)
    const targetLogits = result.policies.get('target')!
    const targetMask = maskTarget(ctx)
    const { action: targetIdx } = this.selectAction(targetLogits, targetMask)

    if (ctx.myPlayer.claimedRole === 'seer') {
      return { type: 'forecast', target: targetIdx + 1 }
    }
    return { type: 'none' }
  }

  decideVote(ctx: DecisionContext): number {
    const result = this.infer(ctx)
    const logits = result.policies.get('vote')!
    const mask = maskVote(ctx)
    const { action, logProb } = this.selectAction(logits, mask)

    this.record(ctx, 'vote', action, logProb, result.value, 0)

    return action + 1  // action is seat-1
  }

  decideCommunication(ctx: DecisionContext): Signal {
    const result = this.infer(ctx)
    const logits = result.policies.get('comm')!
    const mask = maskComm(ctx)
    const { action, logProb } = this.selectAction(logits, mask)

    this.record(ctx, 'comm', action, logProb, result.value, 0)

    return decodeComm(action)
  }

  decideProposal(ctx: DecisionContext): Proposal | null {
    if (ctx.commander !== ctx.mySeat) return null

    // 指揮者は vote head を使って処刑対象を提案
    const result = this.infer(ctx)
    const logits = result.policies.get('vote')!
    const mask = maskVote(ctx)
    const { action } = this.selectAction(logits, mask)

    return { type: 'execute_order', target: action + 1 }
  }

  decideLeadershipResponse(ctx: DecisionContext, _proposal: Proposal): LeadershipResponse {
    const result = this.infer(ctx)
    const logits = result.policies.get('leader')!
    const mask = maskLeader(ctx)
    const { action, logProb } = this.selectAction(logits, mask)

    this.record(ctx, 'leader', action, logProb, result.value, 0)

    return decodeLeader(action)
  }

  /** トラジェクトリをリセット */
  resetTrajectory(): void {
    this.trajectory = []
  }
}
