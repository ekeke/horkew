/**
 * FenrirStrategy: MLベースの Strategy 実装
 * NeuralNetworkの推論結果をLupaのアクションに変換する。
 */

import type { Strategy, DecisionContext, TeamStrategy, TeamDecisionContext, WolfNightAction } from '../../lupa/strategy.ts'
import type { NightAction, DayClaim } from '../../lupa/types.ts'
import type { CommunicationAction } from '../../lupa/communication.ts'
import type { Proposal, LeadershipResponse } from '../../lupa/leadership.ts'
import type { AnyNetwork, ForwardResult } from './ml/nn.ts'
import type { TrajectoryStep } from './ml/trajectory.ts'
import { encodeObservation, encodeTeamObservation, encodeCollectiveWolfObservation, encodeCollectiveMasonObservation, type VillageNNOutput } from './observation.ts'
import {
  maskNightAction, maskClaim, maskVote, maskComm, maskPropose, maskPredict, maskLeader, maskTarget,
  maskAttackTarget, maskAttacker, decodeWolfNightAction,
  sampleMasked,
  decodeNightActionWithRole, decodeClaim, decodeComm, decodePropose, decodePredict, decodeLeader,
} from './action.ts'
import { endgameVoteReward } from './reward.ts'
import { sigmoid } from './ml/nn.ts'
import * as ruleAction from './rule-action.ts'
import { isVillagerAligned } from '../../lupa/roles.ts'

export type FenrirStrategyConfig = {
  /** trueなら探索ノイズあり（学習時）、falseなら貪欲（評価時） */
  explore: boolean
  /** trueなら戦略NNのみ使用、行動はルールベース (Step 1 bootstrap) */
  strategyOnly?: boolean
}

export class FenrirStrategy implements Strategy {
  readonly network: AnyNetwork
  readonly config: FenrirStrategyConfig

  /** 学習時にトラジェクトリを収集するバッファ */
  trajectory: TrajectoryStep[] = []
  /** NN推論の累積時間 (ms) */
  inferMs = 0
  /** NN推論の呼び出し回数 */
  inferCount = 0
  /** 戦略NN出力キャッシュ（strategyOnly時、1日1回計算） */
  private cachedStrategyResult: ForwardResult | null = null
  private cachedDay = -1

  constructor(network: AnyNetwork, config?: Partial<FenrirStrategyConfig>) {
    this.network = network
    this.config = { explore: true, ...config }
  }

  private lastObs: Float32Array | null = null

  private infer(ctx: DecisionContext): ForwardResult {
    const t = performance.now()
    const obs = encodeObservation(ctx)
    this.lastObs = obs
    const result = this.network.forward(obs)
    this.inferMs += performance.now() - t
    this.inferCount++
    return result
  }

  /** 戦略NNの出力を取得（strategyOnly時はキャッシュ） */
  private getStrategyResult(ctx: DecisionContext): ForwardResult {
    if (this.config.strategyOnly && this.cachedDay === ctx.day && this.cachedStrategyResult) {
      // 同じ日のキャッシュを再利用（observationは投票時に記録）
      return this.cachedStrategyResult
    }
    const result = this.infer(ctx)
    if (this.config.strategyOnly) {
      this.cachedStrategyResult = result
      this.cachedDay = ctx.day
    }
    return result
  }

  /** Forward plan tokensの数（config依存） */
  private get numForwardTokens(): number {
    return this.network.config.transformer?.numForwardTokens ?? 8
  }

  private get numEndgameTokens(): number {
    return this.network.config.transformer?.numEndgameTokens ?? 4
  }

  private get planVocabSize(): number {
    return this.network.config.transformer?.planVocabSize ?? 22
  }

  private record(
    head: string, actionIdx: number,
    logProb: number, value: number, reward: number,
    seat: number,
  ): void {
    this.trajectory.push({
      seat,
      observation: this.lastObs!,
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

  /** Sigmoid head: 各次元を独立にサンプリング/閾値判定 */
  private selectSigmoidAction(
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
      if (mask[i] === -Infinity) {
        actions[i] = 0
        continue
      }
      const p = probs[i]
      if (this.config.explore) {
        actions[i] = Math.random() < p ? 1 : 0
      } else {
        actions[i] = p >= 0.5 ? 1 : 0
      }
      // log prob: a*log(p) + (1-a)*log(1-p)
      logProb += actions[i] === 1
        ? Math.log(p + 1e-8)
        : Math.log(1 - p + 1e-8)
    }

    return { actions, logProb }
  }

  private recordSigmoid(
    head: string, actions: Float32Array,
    logProb: number, value: number, reward: number,
    seat: number,
  ): void {
    this.trajectory.push({
      seat,
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

  /** Plan token logitsから各位置のアクションをサンプリング/argmax */
  private selectPlanTokens(
    logits: Float32Array, numTokens: number, vocabSize: number,
  ): { actions: number[], logProbs: number[] } {
    const actions: number[] = []
    const logProbs: number[] = []
    for (let k = 0; k < numTokens; k++) {
      const off = k * vocabSize
      // softmax over vocab for this position
      let maxVal = -Infinity
      for (let v = 0; v < vocabSize; v++) {
        if (logits[off + v] > maxVal) maxVal = logits[off + v]
      }
      const expVals = new Float32Array(vocabSize)
      let sumExp = 0
      for (let v = 0; v < vocabSize; v++) {
        expVals[v] = Math.exp(logits[off + v] - maxVal)
        sumExp += expVals[v]
      }

      let chosenIdx: number
      if (this.config.explore) {
        // Sample from distribution
        const r = Math.random() * sumExp
        let cumulative = 0
        chosenIdx = vocabSize - 1
        for (let v = 0; v < vocabSize; v++) {
          cumulative += expVals[v]
          if (cumulative >= r) { chosenIdx = v; break }
        }
      } else {
        // Greedy
        chosenIdx = 0
        for (let v = 1; v < vocabSize; v++) {
          if (expVals[v] > expVals[chosenIdx]) chosenIdx = v
        }
      }

      const prob = expVals[chosenIdx] / sumExp
      actions.push(chosenIdx)
      logProbs.push(Math.log(prob + 1e-8))
    }
    return { actions, logProbs }
  }

  /** 戦略ステップ（plan tokens + predict）を1つのtrajectoryステップとして記録 */
  private recordStrategy(
    forwardActions: number[], forwardLogProbs: number[],
    endgameActions: number[], endgameLogProbs: number[],
    predictActions: Float32Array | undefined,
    value: number, seat: number,
  ): void {
    // plan tokensの合算logProbをPPO用に使う（predictはBCE補助損失で別途処理）
    let totalLogProb = 0
    for (const lp of forwardLogProbs) totalLogProb += lp
    for (const lp of endgameLogProbs) totalLogProb += lp

    this.trajectory.push({
      seat,
      observation: this.lastObs!,
      actionHead: 'strategy',
      actionIdx: -1,
      logProb: totalLogProb,
      reward: 0,
      value,
      done: false,
      planForwardActions: forwardActions,
      planForwardLogProbs: forwardLogProbs,
      planEndgameActions: endgameActions,
      planEndgameLogProbs: endgameLogProbs,
      sigmoidActions: predictActions,
    })
  }

  // ============================================================
  // Strategy interface implementation
  // ============================================================

  decideNightAction(ctx: DecisionContext): NightAction {
    if (this.config.strategyOnly) return ruleAction.nightAction(ctx)

    const result = this.infer(ctx)
    const logits = result.policies.get('night')!
    const mask = maskNightAction(ctx)
    const { action, logProb } = this.selectAction(logits, mask)

    this.record('night', action, logProb, result.value, 0, ctx.mySeat)

    return decodeNightActionWithRole(action, ctx.myRole)
  }

  decideDayClaim(ctx: DecisionContext): DayClaim {
    if (this.config.strategyOnly) return ruleAction.dayClaim(ctx)

    const result = this.infer(ctx)
    const claimLogits = result.policies.get('claim')!
    const claimMask = maskClaim(ctx)
    const { action: claimIdx, logProb: claimLogProb } = this.selectAction(claimLogits, claimMask)

    // target選択（CO内容によっては必要）
    const targetLogits = result.policies.get('target')!
    const targetMask = maskTarget(ctx)
    const { action: targetIdx } = this.selectAction(targetLogits, targetMask)

    this.record('claim', claimIdx, claimLogProb, result.value, 0, ctx.mySeat)

    return decodeClaim(claimIdx, targetIdx, ctx)
  }

  decideForecast(ctx: DecisionContext): DayClaim {
    if (this.config.strategyOnly) return { type: 'none' }

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
    if (this.config.strategyOnly) {
      // 戦略NNの推論（キャッシュ or 新規）+ plan logitsで投票
      const result = this.getStrategyResult(ctx)
      const forwardLogits = result.policies.get('plan_forward')
      const endgameLogits = result.policies.get('plan_endgame')

      // observationを確保（キャッシュ済みなら高速）
      if (!this.lastObs) this.infer(ctx)

      // predict head のサンプリング
      const predictLogits = result.policies.get('predict')
      let predictActions: Float32Array | undefined
      if (predictLogits) {
        const predictMask = new Float32Array(predictLogits.length).fill(0)
        predictActions = this.selectSigmoidAction(predictLogits, predictMask).actions
      }

      // plan + predict を1つの strategy ステップとして記録
      if (forwardLogits && endgameLogits) {
        const fwd = this.selectPlanTokens(forwardLogits, this.numForwardTokens, this.planVocabSize)
        const eg = this.selectPlanTokens(endgameLogits, this.numEndgameTokens, this.planVocabSize)
        this.recordStrategy(fwd.actions, fwd.logProbs, eg.actions, eg.logProbs, predictActions, result.value, ctx.mySeat)
      }

      // 村陣営のみplanに従って投票、人外は自由（ランダム）
      if (isVillagerAligned(ctx.myRole) && forwardLogits) {
        const voteSeat = ruleAction.planToVote(forwardLogits, this.numForwardTokens, ctx, endgameLogits, this.numEndgameTokens)
        if (voteSeat && voteSeat !== ctx.mySeat) return voteSeat
      }
      // フォールバック: ランダム生存者
      const targets = ctx.alivePlayers.filter(s => s !== ctx.mySeat)
      return targets[Math.floor(ctx.rng.next() * targets.length)]
    }

    const result = this.infer(ctx)
    const logits = result.policies.get('vote')!
    const mask = maskVote(ctx)
    const { action, logProb } = this.selectAction(logits, mask)

    // Endgame vote reward: Retar可能性に基づく投票先評価
    let reward = 0
    if (ctx.retarPossibilities) {
      const targetSeat = action + 1
      reward = endgameVoteReward(
        ctx.alivePlayers.length,
        ctx.retarPossibilities.get(targetSeat),
      )
    }

    this.record('vote', action, logProb, result.value, reward, ctx.mySeat)

    // predict head: 投票時に常時出力（trajectoryに記録、ゲームイベントには非公開）
    const predictLogits = result.policies.get('predict')
    if (predictLogits) {
      const predictMask = new Float32Array(predictLogits.length).fill(0)
      const { actions: predictActions, logProb: predictLogProb } = this.selectSigmoidAction(predictLogits, predictMask)
      this.recordSigmoid('predict', predictActions, predictLogProb, result.value, 0, ctx.mySeat)
    }

    return action + 1  // action is seat-1
  }

  decideCommunication(ctx: DecisionContext): CommunicationAction {
    if (this.config.strategyOnly) {
      const result = this.getStrategyResult(ctx)
      const forwardLogits = result.policies.get('plan_forward') ?? null
      return ruleAction.communication(forwardLogits, this.numForwardTokens, ctx)
    }

    const result = this.infer(ctx)

    // comm head (softmax)
    const commLogits = result.policies.get('comm')!
    const commMask = maskComm(ctx)
    const { action: commAction, logProb: commLogProb } = this.selectAction(commLogits, commMask)
    this.record('comm', commAction, commLogProb, result.value, 0, ctx.mySeat)
    const signal = decodeComm(commAction)

    // propose head (sigmoid)
    const proposeLogits = result.policies.get('propose')!
    const proposeMask = maskPropose(ctx)
    const { actions: proposeActions, logProb: proposeLogProb } = this.selectSigmoidAction(proposeLogits, proposeMask)
    this.recordSigmoid('propose', proposeActions, proposeLogProb, result.value, 0, ctx.mySeat)
    const proposals = decodePropose(proposeActions, 0.5)

    // prediction head (sigmoid, submit_prediction時のみ)
    const predictMask = maskPredict(commAction)
    let predictions = undefined
    if (predictMask[0] !== -Infinity) {
      const predictLogits = result.policies.get('predict')!
      const { actions: predictActions, logProb: predictLogProb } = this.selectSigmoidAction(predictLogits, predictMask)
      this.recordSigmoid('predict', predictActions, predictLogProb, result.value, 0, ctx.mySeat)
      predictions = decodePredict(predictActions, 0.5)
    }

    return { signal, proposals, predictions }
  }

  decideProposal(ctx: DecisionContext): Proposal | null {
    if (ctx.commander !== ctx.mySeat) return null

    if (this.config.strategyOnly) {
      const result = this.getStrategyResult(ctx)
      const forwardLogits = result.policies.get('plan_forward') ?? null
      return ruleAction.proposal(forwardLogits, this.numForwardTokens, ctx)
    }

    // 指揮者は vote head を使って処刑対象を提案
    const result = this.infer(ctx)
    const logits = result.policies.get('vote')!
    const mask = maskVote(ctx)
    const { action } = this.selectAction(logits, mask)

    return { type: 'execute_order', target: action + 1 }
  }

  decideLeadershipResponse(ctx: DecisionContext, _proposal: Proposal): LeadershipResponse {
    if (this.config.strategyOnly) return ruleAction.leadershipResponse()

    const result = this.infer(ctx)
    const logits = result.policies.get('leader')!
    const mask = maskLeader(ctx)
    const { action, logProb } = this.selectAction(logits, mask)

    this.record('leader', action, logProb, result.value, 0, ctx.mySeat)

    return decodeLeader(action)
  }

  decideDefensiveClaim(_ctx: DecisionContext): DayClaim {
    return { type: 'none' }
  }

  /** トラジェクトリをリセット */
  resetTrajectory(): void {
    this.trajectory = []
    this.inferMs = 0
    this.inferCount = 0
  }
}

// ============================================================
// チームエージェント共通ベース
// ============================================================

abstract class TeamStrategyBase {
  readonly network: AnyNetwork
  readonly config: FenrirStrategyConfig
  trajectory: TrajectoryStep[] = []
  /** NN推論の累積時間 (ms) */
  inferMs = 0
  /** NN推論の呼び出し回数 */
  inferCount = 0

  constructor(network: AnyNetwork, config?: Partial<FenrirStrategyConfig>) {
    this.network = network
    this.config = { explore: true, ...config }
  }

  protected lastObs: Float32Array | null = null

  protected infer(ctx: TeamDecisionContext): ForwardResult {
    const t = performance.now()
    const obs = encodeTeamObservation(ctx)
    this.lastObs = obs
    const result = this.network.forward(obs)
    this.inferMs += performance.now() - t
    this.inferCount++
    return result
  }

  protected record(
    head: string, actionIdx: number,
    logProb: number, value: number, reward: number,
    seat: number,
  ): void {
    this.trajectory.push({
      seat,
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
  ): void {
    this.trajectory.push({
      seat,
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

  // Day action helpers shared by both team types
  protected decideDayClaimImpl(ctx: TeamDecisionContext): DayClaim {
    const result = this.infer(ctx)
    const claimLogits = result.policies.get('claim')!
    const claimMask = maskClaim(ctx)
    const { action: claimIdx, logProb: claimLogProb } = this.selectAction(claimLogits, claimMask)

    const targetLogits = result.policies.get('target')!
    const targetMask = maskTarget(ctx)
    const { action: targetIdx } = this.selectAction(targetLogits, targetMask)

    const seat = ctx.currentActorSeat ?? ctx.teamSeats[0]
    this.record('claim', claimIdx, claimLogProb, result.value, 0, seat)
    return decodeClaim(claimIdx, targetIdx, ctx)
  }

  protected decideForecastImpl(ctx: TeamDecisionContext): DayClaim {
    const result = this.infer(ctx)
    const targetLogits = result.policies.get('target')!
    const targetMask = maskTarget(ctx)
    const { action: targetIdx } = this.selectAction(targetLogits, targetMask)

    if (ctx.myPlayer.claimedRole === 'seer') {
      return { type: 'forecast', target: targetIdx + 1 }
    }
    return { type: 'none' }
  }

  protected decideVoteImpl(ctx: TeamDecisionContext): number {
    const result = this.infer(ctx)
    const logits = result.policies.get('vote')!
    const mask = maskVote(ctx)
    const { action, logProb } = this.selectAction(logits, mask)
    const seat = ctx.currentActorSeat ?? ctx.teamSeats[0]
    this.record('vote', action, logProb, result.value, 0, seat)
    return action + 1
  }

  protected decideCommunicationImpl(ctx: TeamDecisionContext): CommunicationAction {
    const result = this.infer(ctx)
    const seat = ctx.currentActorSeat ?? ctx.teamSeats[0]

    const commLogits = result.policies.get('comm')!
    const commMask = maskComm(ctx)
    const { action: commAction, logProb: commLogProb } = this.selectAction(commLogits, commMask)
    this.record('comm', commAction, commLogProb, result.value, 0, seat)
    const signal = decodeComm(commAction)

    const proposeLogits = result.policies.get('propose')!
    const proposeMask = maskPropose(ctx)
    const { actions: proposeActions, logProb: proposeLogProb } = this.selectSigmoidAction(proposeLogits, proposeMask)
    this.recordSigmoid('propose', proposeActions, proposeLogProb, result.value, 0, seat)
    const proposals = decodePropose(proposeActions, 0.5)

    const predictMask = maskPredict(commAction)
    let predictions = undefined
    if (predictMask[0] !== -Infinity) {
      const predictLogits = result.policies.get('predict')!
      const { actions: predictActions, logProb: predictLogProb } = this.selectSigmoidAction(predictLogits, predictMask)
      this.recordSigmoid('predict', predictActions, predictLogProb, result.value, 0, seat)
      predictions = decodePredict(predictActions, 0.5)
    }

    return { signal, proposals, predictions }
  }

  protected decideProposalImpl(ctx: TeamDecisionContext): Proposal | null {
    if (ctx.commander !== ctx.mySeat) return null
    const result = this.infer(ctx)
    const logits = result.policies.get('vote')!
    const mask = maskVote(ctx)
    const { action } = this.selectAction(logits, mask)
    return { type: 'execute_order', target: action + 1 }
  }

  protected decideLeadershipResponseImpl(ctx: TeamDecisionContext): LeadershipResponse {
    const result = this.infer(ctx)
    const logits = result.policies.get('leader')!
    const mask = maskLeader(ctx)
    const { action, logProb } = this.selectAction(logits, mask)
    const seat = ctx.currentActorSeat ?? ctx.teamSeats[0]
    this.record('leader', action, logProb, result.value, 0, seat)
    return decodeLeader(action)
  }

  resetTrajectory(): void {
    this.trajectory = []
    this.inferMs = 0
    this.inferCount = 0
  }
}

// ============================================================
// 狼チームMLエージェント
// ============================================================

export class WolfTeamStrategy extends TeamStrategyBase implements TeamStrategy {
  decideNightAction(ctx: TeamDecisionContext): WolfNightAction {
    const result = this.infer(ctx)

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

// ============================================================
// 共有者チームMLエージェント
// ============================================================

export class MasonTeamStrategy extends TeamStrategyBase implements TeamStrategy {
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

// ============================================================
// 集団エージェント共通ベース
// ============================================================

/**
 * 集団戦略の共通基盤。TeamStrategyBase を拡張し、
 * once-per-day キャッシュと集団用observation encoding を提供する。
 */
abstract class CollectiveStrategyBase extends TeamStrategyBase {
  private cachedResult: ForwardResult | null = null
  private cachedDay = -1

  /**
   * キャッシュ付き推論。同じ日の2回目以降はキャッシュを返す。
   */
  protected getOrInfer(ctx: TeamDecisionContext): ForwardResult {
    if (this.cachedDay === ctx.day && this.cachedResult) {
      return this.cachedResult
    }
    const result = this.infer(ctx)
    this.cachedResult = result
    this.cachedDay = ctx.day
    return result
  }

  resetTrajectory(): void {
    super.resetTrajectory()
    this.cachedResult = null
    this.cachedDay = -1
  }
}

// ============================================================
// 狼集団MLエージェント
// ============================================================

export class WolfCollectiveStrategy extends CollectiveStrategyBase implements TeamStrategy {
  /** frozen村NNの出力（外部から注入） */
  villageNNOutput: VillageNNOutput | undefined = undefined

  protected override infer(ctx: TeamDecisionContext): ForwardResult {
    const t = performance.now()
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

// ============================================================
// 共有集団MLエージェント
// ============================================================

export class MasonCollectiveStrategy extends CollectiveStrategyBase implements TeamStrategy {
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
