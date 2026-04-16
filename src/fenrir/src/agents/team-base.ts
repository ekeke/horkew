/**
 * NN エージェント共通ベースクラス
 *
 * NeuralAgentBase: network + 推論・記録ユーティリティ
 * CollectiveAgentBase: 1日1回キャッシュ付き推論（チーム用）
 */

import type { DecisionContext, TeamDecisionContext } from './agent.ts'
import { AgentBase } from './agent.ts'
import type { DayClaim } from '../../../lupa/types.ts'
import type { CommunicationAction } from '../communication.ts'
import type { Proposal, LeadershipResponse } from '../leadership.ts'
import type { AnyNetwork, ForwardResult } from '../ml/nn.ts'
import type { NeuralAgentConfig } from './neural-agent.ts'
import {
  maskClaim, maskVote, maskComm, maskPropose, maskPredict, maskLeader, maskTarget,
  sampleMasked,
  decodeClaim, decodeComm, decodePropose, decodePredict, decodeLeader,
} from '../action.ts'
import { sigmoid } from '../ml/nn.ts'

/**
 * NN ベースエージェントの共通基盤。
 * network, config, 推論 (abstract infer), 記録, action 選択を提供。
 */
export abstract class NeuralAgentBase<Ctx extends DecisionContext = DecisionContext> extends AgentBase<Ctx> {
  readonly network: AnyNetwork
  readonly config: NeuralAgentConfig

  constructor(network: AnyNetwork, config?: Partial<NeuralAgentConfig>) {
    super()
    this.network = network
    this.config = { explore: true, ...config }
  }

  protected lastObs: Float32Array | null = null

  /** observation エンコード + NN forward。サブクラスが observation 構築を決定 */
  protected abstract infer(ctx: Ctx): ForwardResult

  protected record(
    head: string, actionIdx: number,
    logProb: number, value: number, reward: number,
    seat: number,
    day?: number,
  ): void {
    this.trajectory.push({
      seat,
      day,
      observation: this.lastObs!,
      actionHead: head,
      actionIdx,
      logProb,
      reward,
      value,
      done: false,
    })
  }

  protected recordSigmoid(
    head: string, actions: Float32Array,
    logProb: number, value: number, reward: number,
    seat: number,
    day?: number,
  ): void {
    this.trajectory.push({
      seat,
      day,
      observation: this.lastObs!,
      actionHead: head,
      actionIdx: -1,
      logProb,
      reward,
      value,
      done: false,
      sigmoidActions: actions,
    })
  }

  protected selectAction(
    logits: Float32Array, mask: Float32Array,
  ): { action: number, logProb: number } {
    if (this.config.explore) {
      return sampleMasked(logits, mask)
    }
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

  protected selectSigmoidAction(
    logits: Float32Array, mask: Float32Array,
  ): { actions: Float32Array, logProb: number } {
    const masked = new Float32Array(logits.length)
    for (let i = 0; i < logits.length; i++) {
      masked[i] = logits[i] + mask[i]
    }
    const probs = sigmoid(masked)
    const actions = new Float32Array(logits.length)
    let logProb = 0
    for (let i = 0; i < logits.length; i++) {
      if (mask[i] === -Infinity) { actions[i] = 0; continue }
      const p = probs[i]
      if (this.config.explore) {
        actions[i] = Math.random() < p ? 1 : 0
      } else {
        actions[i] = p >= 0.5 ? 1 : 0
      }
      logProb += actions[i] === 1 ? Math.log(p + 1e-8) : Math.log(1 - p + 1e-8)
    }
    return { actions, logProb }
  }

  // ── Team action helpers (shared by team-based subclasses) ──

  protected decideDayClaimImpl(ctx: TeamDecisionContext): DayClaim {
    const result = (this as any).infer(ctx)
    const claimLogits = result.policies.get('claim')!
    const claimMask = maskClaim(ctx)
    const { action: claimIdx, logProb: claimLogProb } = this.selectAction(claimLogits, claimMask)

    const targetLogits = result.policies.get('target')!
    const targetMask = maskTarget(ctx)
    const { action: targetIdx } = this.selectAction(targetLogits, targetMask)

    const seat = ctx.currentActorSeat ?? (ctx as any).teamSeats?.[0]
    this.record('claim', claimIdx, claimLogProb, result.value, 0, seat, ctx.day)
    return decodeClaim(claimIdx, targetIdx, ctx)
  }

  protected decideForecastImpl(ctx: TeamDecisionContext): DayClaim {
    const result = (this as any).infer(ctx)
    const targetLogits = result.policies.get('target')!
    const targetMask = maskTarget(ctx)
    const { action: targetIdx } = this.selectAction(targetLogits, targetMask)

    if (ctx.myPlayer.claimedRole === 'seer') {
      return { type: 'forecast', target: targetIdx + 1 }
    }
    return { type: 'none' }
  }

  protected decideVoteImpl(ctx: TeamDecisionContext): number {
    const result = (this as any).infer(ctx)
    const logits = result.policies.get('vote')!
    const mask = maskVote(ctx)
    const { action, logProb } = this.selectAction(logits, mask)
    const seat = ctx.currentActorSeat ?? (ctx as any).teamSeats?.[0]
    this.record('vote', action, logProb, result.value, 0, seat, ctx.day)
    return action + 1
  }

  protected decideCommunicationImpl(ctx: TeamDecisionContext): CommunicationAction {
    const result = (this as any).infer(ctx)
    const seat = ctx.currentActorSeat ?? (ctx as any).teamSeats?.[0]

    const commLogits = result.policies.get('comm')!
    const commMask = maskComm(ctx)
    const { action: commAction, logProb: commLogProb } = this.selectAction(commLogits, commMask)
    this.record('comm', commAction, commLogProb, result.value, 0, seat, ctx.day)
    const signal = decodeComm(commAction)

    const proposeLogits = result.policies.get('propose')!
    const proposeMask = maskPropose(ctx)
    const { actions: proposeActions, logProb: proposeLogProb } = this.selectSigmoidAction(proposeLogits, proposeMask)
    this.recordSigmoid('propose', proposeActions, proposeLogProb, result.value, 0, seat, ctx.day)
    const proposals = decodePropose(proposeActions, 0.5)

    const predictMask = maskPredict(commAction)
    let predictions = undefined
    if (predictMask[0] !== -Infinity) {
      const predictLogits = result.policies.get('predict')!
      const { actions: predictActions, logProb: predictLogProb } = this.selectSigmoidAction(predictLogits, predictMask)
      this.recordSigmoid('predict', predictActions, predictLogProb, result.value, 0, seat, ctx.day)
      predictions = decodePredict(predictActions, 0.5)
    }

    return { signal, proposals, predictions }
  }

  protected decideProposalImpl(ctx: TeamDecisionContext): Proposal | null {
    if (ctx.commander !== ctx.mySeat) return null
    const result = (this as any).infer(ctx)
    const logits = result.policies.get('vote')!
    const mask = maskVote(ctx)
    const { action } = this.selectAction(logits, mask)
    return { type: 'execute_order', target: action + 1 }
  }

  protected decideLeadershipResponseImpl(ctx: TeamDecisionContext): LeadershipResponse {
    const result = (this as any).infer(ctx)
    const logits = result.policies.get('leader')!
    const mask = maskLeader(ctx)
    const { action, logProb } = this.selectAction(logits, mask)
    const seat = ctx.currentActorSeat ?? (ctx as any).teamSeats?.[0]
    this.record('leader', action, logProb, result.value, 0, seat, ctx.day)
    return decodeLeader(action)
  }
}

/**
 * 集団戦略の共通基盤。NeuralAgentBase を拡張し、
 * once-per-day キャッシュを提供する。
 */
export abstract class CollectiveAgentBase<Ctx extends DecisionContext = DecisionContext> extends NeuralAgentBase<Ctx> {
  private cachedResult: ForwardResult | null = null
  private cachedDay = -1

  /** Day-cached inference. Public for external access (e.g., BrainBattleAdapter). */
  getOrInfer(ctx: Ctx): ForwardResult {
    if (this.cachedDay === (ctx as any).day && this.cachedResult) {
      return this.cachedResult
    }
    const result = this.infer(ctx)
    this.cachedResult = result
    this.cachedDay = (ctx as any).day
    return result
  }

  /** Clear day cache to force re-inference */
  clearDayCache(): void {
    this.cachedResult = null
    this.cachedDay = -1
  }

  resetTrajectory(): void {
    super.resetTrajectory()
    this.cachedResult = null
    this.cachedDay = -1
  }
}
