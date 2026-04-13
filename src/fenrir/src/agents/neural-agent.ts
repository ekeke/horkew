/**
 * NeuralAgent: MLベースの Agent 実装
 * TransformerNetworkの推論結果をLupaのアクションに変換する。
 */

import type { Agent, DecisionContext } from './agent.ts'
import type { NightAction, DayClaim } from '../../../lupa/types.ts'
import type { CommunicationAction } from '../communication.ts'
import type { Proposal, LeadershipResponse } from '../leadership.ts'
import type { AnyNetwork, ForwardResult, PlanContext } from '../ml/nn.ts'
import type { TrajectoryStep } from '../ml/trajectory.ts'
import { encodeObservation, SEATS, CO_ROLES } from '../observation.ts'
import {
  maskNightAction, maskClaim, applyTruthfulClaimMask, maskVote, maskComm, maskPropose, maskPredict, maskLeader, maskTarget,
  sampleMasked, CLAIM,
  decodeNightActionWithRole, decodeClaim, decodeComm, decodePropose, decodePredict, decodeLeader,
} from '../action.ts'
import { generateStrategicFakeResult, revalidateFakeDivineHistory, reportFakeMediumResult } from './rule-based-agent.ts'
import { endgameVoteReward } from '../reward.ts'
import { sigmoid } from '../ml/nn.ts'
import { parsePlanSlots } from '../plan/plan-vocab.ts'
import { planToVote, nightAction, dayClaim, communication, proposal, leadershipResponse, nooseCount } from '../plan/plan-helpers.ts'
import { isVillagerAligned } from '../../../lupa/roles.ts'


/** plan depth 報酬の最大値（groups == nawa のとき） */
const PLAN_DEPTH_REWARD_SCALE = 0.1

export type NeuralAgentConfig = {
  /** trueなら探索ノイズあり（学習時）、falseなら貪欲（評価時） */
  explore: boolean
  /** trueなら戦略NNのみ使用、行動はルールベース (Step 1 bootstrap) */
  strategyOnly?: boolean
  /** CO マスク: この役職の CO のみ許可（村陣営の偽 CO 防止） */
  truthfulRole?: import('../../../types/index.ts').SystemRole
}

export class NeuralAgent implements Agent {
  readonly network: AnyNetwork
  readonly config: NeuralAgentConfig

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

    // CO 状況: publicEvents から生存 CO 者の有無を判定
    const claimedRoles = new Array(CO_ROLES.length).fill(false)
    for (const e of ctx.publicEvents) {
      if ('actor' in e && typeof (e as any).type === 'string') {
        for (let r = 0; r < CO_ROLES.length; r++) {
          if ((e as any).type.startsWith(`${CO_ROLES[r]}_claim`) && aliveSet.has((e as any).actor)) {
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

    // role token マスク: CO者が全員「確定白 or 自席」なら、その role token を禁止
    // （resolve しても処刑対象にならない role を出力させない）
    const maskedRoles = new Array(CO_ROLES.length).fill(false)
    for (let r = 0; r < CO_ROLES.length; r++) {
      if (!claimedRoles[r]) continue  // CO者なし → 既にマスク（claimedRoles で処理）
      // この role の生存CO者を収集
      let allExcluded = true
      for (const e of ctx.publicEvents) {
        if ('actor' in e && typeof (e as any).type === 'string'
          && (e as any).type.startsWith(`${CO_ROLES[r]}_claim`)
          && aliveSet.has((e as any).actor)) {
          const seat0 = (e as any).actor - 1
          const isMySeat = seat0 === ctx.mySeat - 1
          const isConfirmed = confirmedVillageSeats?.[seat0] ?? false
          if (!isMySeat && !isConfirmed) {
            allExcluded = false
            break
          }
        }
      }
      if (allExcluded) maskedRoles[r] = true
    }

    return { aliveSeats, claimedRoles, confirmedVillageSeats, mySeat: ctx.mySeat - 1, maskedRoles }
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
    planActions: number[], planLogProbs: number[],
    predictActions: Float32Array | undefined,
    value: number, seat: number,
    aliveCount: number,
    day?: number,
    source?: string,
  ): void {
    let totalLogProb = 0
    for (const lp of planLogProbs) totalLogProb += lp

    const nawa = nooseCount(aliveCount)
    const slots = parsePlanSlots(planActions).length
    const depthReward = nawa > 0 ? Math.max(0, 1 - Math.abs(slots - nawa) / nawa) * PLAN_DEPTH_REWARD_SCALE : 0

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
      planActions,
      planLogProbs,
      sigmoidActions: predictActions,
      source,
    })
  }

  // ============================================================
  // Agent interface implementation
  // ============================================================

  decideNightAction(ctx: DecisionContext): NightAction {

    if (this.config.strategyOnly) return nightAction(ctx)

    const result = this.infer(ctx)
    const logits = result.policies.get('night')!
    const mask = maskNightAction(ctx)
    const { action, logProb } = this.selectAction(logits, mask)

    this.record('night', action, logProb, result.value, 0, ctx.mySeat)

    return decodeNightActionWithRole(action, ctx.myRole)
  }

  /**
   * decodeClaim を呼ぶ前に、人外（非 villager-aligned）が seer/medium 騙りを選んだ場合に
   * fakeDivineHistory を生成する。MEDIUM_RESULT は decodeClaim が none を返す仕様なので
   * 直接 reportFakeMediumResult を呼んで結果を組み立てる。
   */
  private decodeClaimWithFakeGen(claimIdx: number, targetIdx: number, ctx: DecisionContext): DayClaim {
    const role = ctx.myRole
    const isFakingSeer = role !== 'seer'
    const isFakingMedium = role !== 'medium'
    const myPlayer = ctx.myPlayer

    if (claimIdx === CLAIM.SEER_CO && isFakingSeer) {
      for (let n = 0; n < ctx.day; n++) {
        generateStrategicFakeResult(ctx.gameState, myPlayer, n, ctx)
      }
      revalidateFakeDivineHistory(myPlayer, ctx)
    } else if (claimIdx === CLAIM.SEER_RESULT && isFakingSeer) {
      const night = ctx.day - 1
      if (night >= 0) generateStrategicFakeResult(ctx.gameState, myPlayer, night, ctx)
    } else if (claimIdx === CLAIM.MEDIUM_RESULT && isFakingMedium) {
      return reportFakeMediumResult(ctx.lastExecutedSeat, ctx.rng, ctx)
    }

    return decodeClaim(claimIdx, targetIdx, ctx)
  }

  decideDayClaim(ctx: DecisionContext): DayClaim {

    if (this.config.strategyOnly) return dayClaim(ctx)

    const result = this.infer(ctx)
    const claimLogits = result.policies.get('claim')!
    const claimMask = maskClaim(ctx)
    if (this.config.truthfulRole) applyTruthfulClaimMask(claimMask, this.config.truthfulRole)
    const { action: claimIdx, logProb: claimLogProb } = this.selectAction(claimLogits, claimMask)

    const targetLogits = result.policies.get('target')!
    const targetMask = maskTarget(ctx)
    const { action: targetIdx } = this.selectAction(targetLogits, targetMask)

    this.record('claim', claimIdx, claimLogProb, result.value, 0, ctx.mySeat)

    return this.decodeClaimWithFakeGen(claimIdx, targetIdx, ctx)
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

  /**
   * observation を外部からセットする（adapter が trajectory 記録前に使用）。
   */
  setLastObs(obs: Float32Array): void {
    this.lastObs = obs
  }

  decideVote(ctx: DecisionContext): number {

    if (this.config.strategyOnly) {
      const result = this.getStrategyResult(ctx)
      this.lastObs = encodeObservation(ctx)

      const predictLogits = result.policies.get('predict')
      const predictActions = predictLogits ? sigmoid(predictLogits) : undefined

      if (result.planActions) {
        this.recordStrategy(
          result.planActions, result.planLogProbs!,
          predictActions, result.value, ctx.mySeat,
          ctx.alivePlayers.length, ctx.day,
          'NeuralAgent.decideVote:strategyOnly',
        )
      }

      if (isVillagerAligned(ctx.myRole) && result.planActions) {
        const voteSeat = planToVote(result.planActions, ctx)
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

    // predict は BCE auxiliary loss のみで学習（RL action ではない）

    return action + 1
  }

  decideCommunication(ctx: DecisionContext): CommunicationAction {

    if (this.config.strategyOnly) {
      const result = this.getStrategyResult(ctx)
      return communication(result.planActions ?? null, ctx)
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

    let predictions = undefined
    if (maskPredict(commAction)[0] !== -Infinity) {
      const predictLogits = result.policies.get('predict')!
      predictions = decodePredict(sigmoid(predictLogits), 0.5)
    }

    return { signal, proposals, predictions }
  }

  decideProposal(ctx: DecisionContext): Proposal | null {

    if (ctx.commander !== ctx.mySeat) return null

    if (this.config.strategyOnly) {
      const result = this.getStrategyResult(ctx)
      return proposal(result.planActions ?? null, ctx)
    }

    const result = this.infer(ctx)
    const logits = result.policies.get('vote')!
    const mask = maskVote(ctx)
    const { action } = this.selectAction(logits, mask)

    return { type: 'execute_order', target: action + 1 }
  }

  decideLeadershipResponse(ctx: DecisionContext, _proposal: Proposal): LeadershipResponse {

    if (this.config.strategyOnly) return leadershipResponse()

    const result = this.infer(ctx)
    const logits = result.policies.get('leader')!
    const mask = maskLeader(ctx)
    const { action, logProb } = this.selectAction(logits, mask)

    this.record('leader', action, logProb, result.value, 0, ctx.mySeat)

    return decodeLeader(action)
  }

  decideDefensiveClaim(ctx: DecisionContext): DayClaim {

    if (this.config.strategyOnly) return dayClaim(ctx)

    const result = this.infer(ctx)
    const claimLogits = result.policies.get('claim')!
    const claimMask = maskClaim(ctx)
    const { action: claimIdx, logProb: claimLogProb } = this.selectAction(claimLogits, claimMask)

    const targetLogits = result.policies.get('target')!
    const targetMask = maskTarget(ctx)
    const { action: targetIdx } = this.selectAction(targetLogits, targetMask)

    this.record('claim', claimIdx, claimLogProb, result.value, 0, ctx.mySeat)

    return this.decodeClaimWithFakeGen(claimIdx, targetIdx, ctx)
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
): { refPlanLogits: Float32Array | undefined } {
  const result = refNetwork.forward(observation)
  return {
    refPlanLogits: result.policies.get('plan'),
  }
}
