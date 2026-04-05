/**
 * NeuralAgent: MLベースの Agent 実装
 * NeuralNetworkの推論結果をLupaのアクションに変換する。
 */

import type { Agent, DecisionContext } from './agent.ts'
import type { NightAction, DayClaim } from '../../../lupa/types.ts'
import type { CommunicationAction } from '../communication.ts'
import type { Proposal, LeadershipResponse } from '../leadership.ts'
import type { AnyNetwork, ForwardResult, PlanContext } from '../ml/nn.ts'
import type { TrajectoryStep } from '../ml/trajectory.ts'
import { encodeObservation, SEATS, CO_ROLES } from '../observation.ts'
import {
  maskNightAction, maskClaim, maskVote, maskComm, maskPropose, maskPredict, maskLeader, maskTarget,
  sampleMasked,
  decodeNightActionWithRole, decodeClaim, decodeComm, decodePropose, decodePredict, decodeLeader,
} from '../action.ts'
import { endgameVoteReward } from '../reward.ts'
import { sigmoid } from '../ml/nn.ts'
import { parsePlanIndices } from '../plan/plan-vocab.ts'
import { planToVote, nightAction, dayClaim, communication, proposal, leadershipResponse } from '../plan/plan-helpers.ts'
import { isVillagerAligned } from '../../../lupa/roles.ts'
import { RuleBasedAgent } from './rule-based-agent.ts'

/** plan depth 報酬の最大値（groups == nawa のとき） */
const PLAN_DEPTH_REWARD_SCALE = 0.1

export type NeuralAgentConfig = {
  /** trueなら探索ノイズあり（学習時）、falseなら貪欲（評価時） */
  explore: boolean
  /** trueなら戦略NNのみ使用、行動はルールベース (Step 1 bootstrap) */
  strategyOnly?: boolean
  /** このDay以降でML動作、それ以前はheuristicフォールバック（カリキュラム用） */
  activeFromDay?: number
}

export class NeuralAgent implements Agent {
  readonly network: AnyNetwork
  readonly config: NeuralAgentConfig
  private heuristicFallback?: RuleBasedAgent

  /** 学習時にトラジェクトリを収集するバッファ */
  trajectory: TrajectoryStep[] = []
  /** NN推論の累積時間 (ms) */
  inferMs = 0
  /** NN推論の呼び出し回数 */
  inferCount = 0
  /** 戦略NN出力キャッシュ（strategyOnly時、1日1回計算） */
  private cachedStrategyResult: ForwardResult | null = null
  private cachedDay = -1

  constructor(network: AnyNetwork, config?: Partial<NeuralAgentConfig>) {
    this.network = network
    this.config = { explore: true, ...config }
    if (this.config.activeFromDay && this.config.activeFromDay >= 1) {
      this.heuristicFallback = new RuleBasedAgent()
    }
  }

  private isActive(day: number): boolean {
    return !this.config.activeFromDay || day >= this.config.activeFromDay
  }

  protected lastObs: Float32Array | null = null

  /** 村側役職の集合（確定白判定用） */
  private static readonly VILLAGE_ROLES: ReadonlySet<string> = new Set([
    'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
  ])

  /** DecisionContext から plan decoder 用の盤面文脈を構築 */
  static buildPlanContext(ctx: DecisionContext): PlanContext {
    const aliveSet = new Set(ctx.alivePlayers)
    const aliveSeats = new Array(SEATS).fill(false)
    for (let i = 0; i < SEATS; i++) aliveSeats[i] = aliveSet.has(i + 1)

    // CO 状況: publicEvents から CO 有無を判定
    const claimedRoles = new Array(CO_ROLES.length).fill(false)
    for (const e of ctx.publicEvents) {
      if ('actor' in e && typeof (e as any).type === 'string') {
        for (let r = 0; r < CO_ROLES.length; r++) {
          if ((e as any).type.startsWith(`${CO_ROLES[r]}_claim`)) {
            claimedRoles[r] = true
          }
        }
      }
    }

    // 確定白席: Retar possibilities が村側役職のみの席
    let confirmedVillageSeats: boolean[] | undefined
    if (ctx.retarPossibilities) {
      confirmedVillageSeats = new Array(SEATS).fill(false)
      for (const [seat, roles] of ctx.retarPossibilities) {
        if (seat === ctx.mySeat) continue
        let allVillage = true
        for (const r of roles) {
          if (!NeuralAgent.VILLAGE_ROLES.has(r)) { allVillage = false; break }
        }
        if (allVillage) confirmedVillageSeats[seat - 1] = true
      }
    }

    return { aliveSeats, claimedRoles, confirmedVillageSeats }
  }

  protected infer(ctx: DecisionContext): ForwardResult {
    const t = performance.now()
    const obs = encodeObservation(ctx)
    this.lastObs = obs
    const planContext = NeuralAgent.buildPlanContext(ctx)
    const result = this.network.forward(obs, this.config.explore, planContext)
    this.inferMs += performance.now() - t
    this.inferCount++
    return result
  }

  /** 戦略NNの出力を取得（strategyOnly時はキャッシュ） */
  getStrategyResult(ctx: DecisionContext): ForwardResult {
    if (this.config.strategyOnly && this.cachedDay === ctx.day && this.cachedStrategyResult) {
      return this.cachedStrategyResult
    }
    const result = this.infer(ctx)
    if (this.config.strategyOnly) {
      this.cachedStrategyResult = result
      this.cachedDay = ctx.day
    }
    return result
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

  /** 戦略ステップ（plan tokens + predict）を1つのtrajectoryステップとして記録 */
  recordStrategy(
    forwardActions: number[], forwardLogProbs: number[],
    endgameActions: number[], endgameLogProbs: number[],
    predictActions: Float32Array | undefined,
    value: number, seat: number,
    aliveCount: number,
    day?: number,
    source?: string,
  ): void {
    let totalLogProb = 0
    for (const lp of forwardLogProbs) totalLogProb += lp
    for (const lp of endgameLogProbs) totalLogProb += lp

    const nawa = Math.floor((aliveCount - 1) / 2)
    const groups = parsePlanIndices(forwardActions).length
    const depthReward = nawa > 0 ? Math.max(0, 1 - Math.abs(groups - nawa) / nawa) * PLAN_DEPTH_REWARD_SCALE : 0

    this.trajectory.push({
      seat,
      day,
      observation: this.lastObs!,
      actionHead: 'strategy',
      actionIdx: -1,
      logProb: totalLogProb,
      reward: depthReward,
      value,
      done: false,
      planForwardActions: forwardActions,
      planForwardLogProbs: forwardLogProbs,
      planEndgameActions: endgameActions,
      planEndgameLogProbs: endgameLogProbs,
      sigmoidActions: predictActions,
      source,
    })
  }

  // ============================================================
  // Agent interface implementation
  // ============================================================

  decideNightAction(ctx: DecisionContext): NightAction {
    if (!this.isActive(ctx.day)) return this.heuristicFallback!.decideNightAction(ctx)
    if (this.config.strategyOnly) return nightAction(ctx)

    const result = this.infer(ctx)
    const logits = result.policies.get('night')!
    const mask = maskNightAction(ctx)
    const { action, logProb } = this.selectAction(logits, mask)

    this.record('night', action, logProb, result.value, 0, ctx.mySeat)

    return decodeNightActionWithRole(action, ctx.myRole)
  }

  decideDayClaim(ctx: DecisionContext): DayClaim {
    if (!this.isActive(ctx.day)) return this.heuristicFallback!.decideDayClaim(ctx)
    if (this.config.strategyOnly) return dayClaim(ctx)

    const result = this.infer(ctx)
    const claimLogits = result.policies.get('claim')!
    const claimMask = maskClaim(ctx)
    const { action: claimIdx, logProb: claimLogProb } = this.selectAction(claimLogits, claimMask)

    const targetLogits = result.policies.get('target')!
    const targetMask = maskTarget(ctx)
    const { action: targetIdx } = this.selectAction(targetLogits, targetMask)

    this.record('claim', claimIdx, claimLogProb, result.value, 0, ctx.mySeat)

    return decodeClaim(claimIdx, targetIdx, ctx)
  }

  decideForecast(ctx: DecisionContext): DayClaim {
    if (!this.isActive(ctx.day)) return this.heuristicFallback!.decideForecast?.(ctx) ?? { type: 'none' }
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

  /**
   * observation を外部からセットする（adapter が trajectory 記録前に使用）。
   */
  setLastObs(obs: Float32Array): void {
    this.lastObs = obs
  }

  decideVote(ctx: DecisionContext): number {
    if (!this.isActive(ctx.day)) return this.heuristicFallback!.decideVote(ctx)
    if (this.config.strategyOnly) {
      const result = this.getStrategyResult(ctx)
      this.lastObs = encodeObservation(ctx)

      const predictLogits = result.policies.get('predict')
      let predictActions: Float32Array | undefined
      if (predictLogits) {
        const predictMask = new Float32Array(predictLogits.length).fill(0)
        predictActions = this.selectSigmoidAction(predictLogits, predictMask).actions
      }

      if (result.planForwardActions && result.planEndgameActions) {
        this.recordStrategy(
          result.planForwardActions, result.planForwardLogProbs!,
          result.planEndgameActions, result.planEndgameLogProbs!,
          predictActions, result.value, ctx.mySeat,
          ctx.alivePlayers.length, ctx.day,
          'NeuralAgent.decideVote:strategyOnly',
        )
      }

      const fwdActions = result.planForwardActions
      if (isVillagerAligned(ctx.myRole) && fwdActions) {
        const voteSeat = planToVote(fwdActions, ctx, result.planEndgameActions)
        if (voteSeat && voteSeat !== ctx.mySeat) return voteSeat
      }
      const targets = ctx.alivePlayers.filter(s => s !== ctx.mySeat)
      return targets[Math.floor(ctx.rng.next() * targets.length)]
    }

    const result = this.infer(ctx)
    const logits = result.policies.get('vote')!
    const mask = maskVote(ctx)
    const { action, logProb } = this.selectAction(logits, mask)

    let reward = 0
    if (ctx.retarPossibilities) {
      const targetSeat = action + 1
      reward = endgameVoteReward(
        ctx.alivePlayers.length,
        ctx.retarPossibilities.get(targetSeat),
      )
    }

    this.record('vote', action, logProb, result.value, reward, ctx.mySeat)

    const predictLogits = result.policies.get('predict')
    if (predictLogits) {
      const predictMask = new Float32Array(predictLogits.length).fill(0)
      const { actions: predictActions, logProb: predictLogProb } = this.selectSigmoidAction(predictLogits, predictMask)
      this.recordSigmoid('predict', predictActions, predictLogProb, result.value, 0, ctx.mySeat)
    }

    return action + 1
  }

  decideCommunication(ctx: DecisionContext): CommunicationAction {
    if (!this.isActive(ctx.day)) return this.heuristicFallback!.decideCommunication(ctx)
    if (this.config.strategyOnly) {
      const result = this.getStrategyResult(ctx)
      return communication(result.planForwardActions ?? null, ctx)
    }

    const result = this.infer(ctx)

    const commLogits = result.policies.get('comm')!
    const commMask = maskComm(ctx)
    const { action: commAction, logProb: commLogProb } = this.selectAction(commLogits, commMask)
    this.record('comm', commAction, commLogProb, result.value, 0, ctx.mySeat)
    const signal = decodeComm(commAction)

    const proposeLogits = result.policies.get('propose')!
    const proposeMask = maskPropose(ctx)
    const { actions: proposeActions, logProb: proposeLogProb } = this.selectSigmoidAction(proposeLogits, proposeMask)
    this.recordSigmoid('propose', proposeActions, proposeLogProb, result.value, 0, ctx.mySeat)
    const proposals = decodePropose(proposeActions, 0.5)

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
    if (!this.isActive(ctx.day)) return this.heuristicFallback!.decideProposal?.(ctx) ?? null
    if (ctx.commander !== ctx.mySeat) return null

    if (this.config.strategyOnly) {
      const result = this.getStrategyResult(ctx)
      return proposal(result.planForwardActions ?? null, ctx)
    }

    const result = this.infer(ctx)
    const logits = result.policies.get('vote')!
    const mask = maskVote(ctx)
    const { action } = this.selectAction(logits, mask)

    return { type: 'execute_order', target: action + 1 }
  }

  decideLeadershipResponse(ctx: DecisionContext, _proposal: Proposal): LeadershipResponse {
    if (!this.isActive(ctx.day)) return this.heuristicFallback!.decideLeadershipResponse?.(ctx, _proposal) ?? { type: 'follow' }
    if (this.config.strategyOnly) return leadershipResponse()

    const result = this.infer(ctx)
    const logits = result.policies.get('leader')!
    const mask = maskLeader(ctx)
    const { action, logProb } = this.selectAction(logits, mask)

    this.record('leader', action, logProb, result.value, 0, ctx.mySeat)

    return decodeLeader(action)
  }

  decideDefensiveClaim(ctx: DecisionContext): DayClaim {
    if (!this.isActive(ctx.day)) return this.heuristicFallback!.decideDefensiveClaim?.(ctx) ?? { type: 'none' }
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
// Reference logits computation for KL penalty
// ============================================================

/**
 * Reference network の plan logits を取得（KL penalty 用）。
 */
export function computeRefPlanLogits(
  refNetwork: AnyNetwork,
  observation: Float32Array,
): { refFwdLogits: Float32Array | undefined, refEgLogits: Float32Array | undefined } {
  const result = refNetwork.forward(observation)
  return {
    refFwdLogits: result.policies.get('plan_forward'),
    refEgLogits: result.policies.get('plan_endgame'),
  }
}
