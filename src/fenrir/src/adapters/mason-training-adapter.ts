/**
 * MasonTrainingAdapter — mason 訓練用 adapter
 *
 * StrategyBaseAdapter を継承し、mason 固有の責務を追加:
 *   1. onPreVote で全意思決定を完結: forward pass → plan 配布 → 投票先確定 → trajectory 記録
 *   2. onVote は機械的な票割り当て: 村陣営は plan に従い、非村は decideVote
 *
 * NeuralAgent.decideVote は呼ばない。getStrategyResult は onPreVote で呼ぶ
 * （指定→CO が発生した場合は 2nd forward で再評価、計2回）。
 */

import type { SystemRole } from '../../../types/index.ts'
import type { GameState, GameEvent, PlayerState, DayClaim } from '../../../lupa/types.ts'
import type { VoteContext, PhaseContext, PreVoteResult } from '../../../lupa/handlers.ts'
import type { FenrirExt } from '../ext.ts'
import type { FenrirExtEvent } from '../events.ts'
import type { MasonTrainingAdapterConfig } from './adapter-types.ts'
import type { PlanState } from '../plan/plan-helpers.ts'
import type { Proposal } from '../leadership.ts'
import type { ForwardResult } from '../ml/nn.ts'
import type { NeuralAgent } from '../agents/neural-agent.ts'
import { StrategyBaseAdapter } from './strategy-base-adapter.ts'
import { buildPlayerView } from '../../../lupa/player-view.ts'
import { alivePlayers, isVillagerAligned } from '../../../lupa/roles.ts'
import { forceTrueRoleCO } from '../../../lupa/engine-utils.ts'
import { isVillagePowerRole } from '../agents/rule-based-agent.ts'
import { resolvePlanGroup } from '../plan/plan-resolve.ts'
import { planToVote } from '../plan/plan-helpers.ts'
import { encodeObservation, collectObservation } from '../observation.ts'
import { RuleBasedAgent } from '../agents/rule-based-agent.ts'

// ============================================================
// 指定→CO シミュレーション確率定数（Phase 0 mason 学習用）
// ============================================================

const DESIGNATION_CO = {
  /** グレラン/role 指定時、村パワーロールが CO する確率 */
  VILLAGE_GRAYRAN_CO_PROB: 0.4,
  /** 非村が fake CO (bodyguard/nekomata) する確率 */
  NON_VILLAGE_FAKE_CO_PROB: 0.08,
  /** 対抗 CO フェーズで非村が対抗する確率 */
  NON_VILLAGE_COUNTER_CO_PROB: 0.05,
} as const

export class MasonTrainingAdapter extends StrategyBaseAdapter {
  private readonly masonConfig: MasonTrainingAdapterConfig
  /** plan が null のときの村陣営投票フォールバック（NN の decideVote を避ける） */
  private readonly heuristicFallback = new RuleBasedAgent()

  /** onPreVote で取得した plan token（onVote で各エージェントが独立に解決） */
  private planForwardActions: number[] | null = null
  private planEndgameActions: number[] | null = null
  /** onPreVote で生成した proposals（onVote に渡す） */
  private dayProposals: Proposal[] = []

  constructor(config: MasonTrainingAdapterConfig) {
    super(config)
    this.masonConfig = config
  }

  // ════════════════════════════════════════════
  // onPreVote: plan 生成 + 配布（投票前に完結）
  // ════════════════════════════════════════════

  onPreVote(pctx: PhaseContext<FenrirExtEvent, FenrirExt>): PreVoteResult<FenrirExtEvent> {
    const state = pctx.state as GameState<FenrirExt>
    const ext = state.ext

    // 1. Retar + Tsumi
    this.runRetar(pctx, ext)
    this.runTsumiSearch(ext)

    // 2. Mason takeover + plan 生成
    const allMasons = state.players.filter(p => p.role === 'mason')
    const aliveMasons = allMasons.filter(p => p.alive)
    this.handleMasonTakeover(state, ext.planState, allMasons, aliveMasons)

    this.planForwardActions = null
    this.planEndgameActions = null
    this.dayProposals = []

    let masonResult: ForwardResult | null = null
    if (aliveMasons.length > 0) {
      masonResult = this.commitMasonPlans(pctx, ext, aliveMasons)
    }

    // 3. distributePlans: planState → ext.executionPlans
    const aliveSeats = alivePlayers(state).map(p => p.seat)
    this.distributePlans(ext, aliveSeats, pctx.events)

    // 4. 指定→CO シミュレーション + plan 再評価
    let additionalClaims: Map<number, DayClaim> | undefined
    if (masonResult) {
      const coResult = this.simulateDesignationCO(pctx, ext, aliveMasons, masonResult)
      if (coResult.claims.size > 0) {
        additionalClaims = coResult.claims
        masonResult = coResult.masonResult
      }
    }

    // 5. Plan token 保持 + proposal 生成 + trajectory 記録
    if (masonResult) {
      this.planForwardActions = masonResult.planForwardActions ?? null
      this.planEndgameActions = masonResult.planEndgameActions ?? null

      // Proposal 用に1回解決（mason 視点）
      if (this.planForwardActions) {
        const mason = aliveMasons.find(m => this.masonConfig.agents.has(m.seat)) ?? aliveMasons[0]
        const masonCtx = this.buildCtx(pctx, mason, buildPlayerView(state, mason.seat), ext)
        const target = planToVote(this.planForwardActions, masonCtx, this.planEndgameActions)
        if (target != null) {
          this.dayProposals.push({ type: 'execute_order', target })
        }
      }

      // Trajectory 記録（NN mason）
      const nnMason = aliveMasons.find(m => this.masonConfig.agents.has(m.seat))
      if (nnMason) {
        const agent = this.getAgent(nnMason.seat) as NeuralAgent
        const trajCtx = this.buildCtx(pctx, nnMason, buildPlayerView(state, nnMason.seat), ext)
        agent.setLastObs(encodeObservation(trajCtx))
        this.recordMasonStrategy(agent, masonResult, nnMason.seat, aliveSeats.length, pctx.day)
      }
    } else if (allMasons.length > 0 && ext.planState.forwardGroups.length > 0) {
      // Mason 死亡: cached plan から解決（proposal 用）
      const target = this.resolveDeadMasonTarget(pctx, ext)
      if (target != null) {
        this.dayProposals.push({ type: 'execute_order', target })
      }
    }

    return additionalClaims ? { additionalClaims } : {}
  }

  /** NN mason の strategy trajectory を記録する */
  private recordMasonStrategy(
    agent: NeuralAgent, result: ForwardResult,
    seat: number, aliveCount: number, day: number,
  ): void {
    const predictLogits = result.policies.get('predict')
    let predictActions: Float32Array | undefined
    if (predictLogits) {
      const predictMask = new Float32Array(predictLogits.length).fill(0)
      // Greedy sigmoid for predict (学習時は explore だが predict は閾値判定)
      const actions = new Float32Array(predictLogits.length)
      for (let i = 0; i < predictLogits.length; i++) {
        const p = 1 / (1 + Math.exp(-(predictLogits[i] + predictMask[i])))
        actions[i] = p > 0.5 ? 1 : 0
      }
      predictActions = actions
    }

    if (result.planForwardActions && result.planEndgameActions) {
      agent.recordStrategy(
        result.planForwardActions, result.planForwardLogProbs!,
        result.planEndgameActions, result.planEndgameLogProbs!,
        predictActions, result.value, seat, aliveCount, day,
        'MasonAdapter.onPreVote',
      )
    }
  }

  // ════════════════════════════════════════════
  // onVote: 投票を adapter 層で完結
  // ════════════════════════════════════════════

  override onVote(vctx: VoteContext<FenrirExtEvent, FenrirExt>): Map<number, number> {
    const state = vctx.state as GameState<FenrirExt>
    const ext = state.ext
    const isFirstRound = vctx.revoteRound === 0 || vctx.revoteRound == null

    // revote 時は Retar/plan を再計算（onPreVote は初回のみ呼ばれる）
    if (!isFirstRound) {
      this.runRetar(vctx as PhaseContext<FenrirExtEvent, FenrirExt>, ext)
    }

    // tsumi cache（初回のみ）
    if (isFirstRound) {
      ext.tsumiCache.set(vctx.day, ext.tsumiTarget !== null)
    }

    const votes = new Map<number, number>()
    const alive = alivePlayers(state)
    for (const player of alive) {
      // 村陣営 + plan あり → 各自が独立に plan を解決して投票
      if (isFirstRound && isVillagerAligned(player.role) && this.planForwardActions) {
        const view = buildPlayerView(state, player.seat)
        const playerCtx = this.buildCtx(
          vctx as PhaseContext<FenrirExtEvent, FenrirExt>, player, view, ext, {
            revoteRound: vctx.revoteRound,
            revoteCandidates: vctx.candidates,
            proposals: this.dayProposals,
          },
        )
        const target = planToVote(this.planForwardActions, playerCtx, this.planEndgameActions)
        if (target != null && target !== player.seat) {
          votes.set(player.seat, target)
          continue
        }
        // plan 解決失敗 → heuristic フォールバック
        votes.set(player.seat, this.heuristicFallback.decideVote(playerCtx))
        continue
      }

      const view = buildPlayerView(state, player.seat)
      const ctx = this.buildCtx(
        vctx as PhaseContext<FenrirExtEvent, FenrirExt>, player, view, ext, {
          revoteRound: vctx.revoteRound,
          revoteCandidates: vctx.candidates,
          proposals: this.dayProposals,
        },
      )

      // inspect 用: observation キャプチャ（初回投票のみ）
      if (this.config.captureObservations && isFirstRound) {
        this.capturedObservations.push({
          seat: player.seat,
          role: player.role,
          day: ctx.day,
          observation: collectObservation(ctx),
          proposals: this.dayProposals.map(p => ({ type: p.type, target: p.target })),
        })
      }

      // 非村 → 従来の decideVote、村陣営 plan なし → heuristic フォールバック
      if (player.role === 'werewolf' && this.config.wolfTeamAgent) {
        const teamCtx = this.buildTeamCtx(ctx, state, player.role, player.seat)
        votes.set(player.seat, this.config.wolfTeamAgent.decideVote(teamCtx))
      } else if (isVillagerAligned(player.role)) {
        // plan なしの村陣営: heuristic で投票（NN の decideVote を避けて二重記録を防ぐ）
        votes.set(player.seat, this.heuristicFallback.decideVote(ctx))
      } else {
        votes.set(player.seat, this.getAgent(player.seat).decideVote(ctx))
      }
    }

    this.afterVoteCollection(vctx, ext)
    return votes
  }

  // ════════════════════════════════════════════
  // Mason 固有ロジック
  // ════════════════════════════════════════════

  /**
   * ML mason が死亡し、パートナーが生存 → agent を移譲する。
   * キャッシュをクリアして新しい seat で再推論させる。
   */
  private handleMasonTakeover(
    _state: GameState<FenrirExt>,
    planState: PlanState,
    allMasons: PlayerState[],
    aliveMasons: PlayerState[],
  ): void {
    if (!this.masonConfig.onMasonTakeover || planState.masonTakeoverDone) return

    if (planState.mlMasonSeat === null) {
      for (const m of allMasons) {
        if (this.masonConfig.agents.has(m.seat)) {
          planState.mlMasonSeat = m.seat
          break
        }
      }
    }

    if (planState.mlMasonSeat === null) return

    const mlMason = allMasons.find(p => p.seat === planState.mlMasonSeat)
    if (!mlMason || mlMason.alive || aliveMasons.length === 0) return

    const newSeat = aliveMasons[0].seat
    const agent = this.masonConfig.agents.get(planState.mlMasonSeat)
    if (agent) {
      this.masonConfig.agents.delete(planState.mlMasonSeat)
      this.masonConfig.agents.set(newSeat, agent)
      // agent cache クリア（新しい seat で再推論させる）
      const s = agent as any
      s.cachedDay = -1
      s.lastObs = null
      s.cachedStrategyResult = null
    }
    this.masonConfig.onMasonTakeover(planState.mlMasonSeat, newSeat)
    planState.mlMasonSeat = newSeat
    planState.masonTakeoverDone = true
  }

  /**
   * NN mason の forward pass → plan token を ext.planState に書き込む。
   * result は this.masonResult に保持し、onVote で消費する。
   */
  private commitMasonPlans(
    pctx: PhaseContext<FenrirExtEvent, FenrirExt>,
    ext: FenrirExt,
    aliveMasons: PlayerState[],
  ): ForwardResult | null {
    const state = pctx.state as GameState<FenrirExt>
    const mason = aliveMasons.find(m => this.masonConfig.agents.has(m.seat)) ?? aliveMasons[0]
    const agent = this.getAgent(mason.seat) as any
    if (typeof agent.getStrategyResult !== 'function') return null

    const masonView = buildPlayerView(state, mason.seat)
    const masonCtx = this.buildCtx(pctx, mason, masonView, ext)
    const result: ForwardResult = agent.getStrategyResult(masonCtx)

    this.commitPlanTokens(ext, result.planForwardActions ?? null, result.planEndgameActions ?? null)
    return result
  }

  /**
   * Mason 死亡時: cached planState から今日の投票先を解決する。
   * endgame (≤6人) を優先、なければ forward plan から消費。
   */
  private resolveDeadMasonTarget(
    pctx: PhaseContext<FenrirExtEvent, FenrirExt>,
    ext: FenrirExt,
  ): number | null {
    const state = pctx.state as GameState<FenrirExt>
    const planState = ext.planState
    const aliveSeats = alivePlayers(state).map(p => p.seat)
    const alive = aliveSeats.length
    let target: number | null = null

    const opts = { rng: this.rng }

    // Endgame plan 優先（���6人）
    if (planState.endgameGroups.length > 0) {
      if (alive <= 4) {
        target = resolvePlanGroup(planState.endgameGroups[0], aliveSeats, pctx.events, opts)
      } else if (alive <= 6) {
        const group = planState.endgameGroups.length >= 2
          ? planState.endgameGroups[1] : planState.endgameGroups[0]
        target = resolvePlanGroup(group, aliveSeats, pctx.events, opts)
      }
    }

    // Forward plan フォールバック（groups は afterVoteCollection で日送り済み、[0] が今日）
    if (target == null && planState.forwardGroups.length > 0) {
      const group = planState.forwardGroups[0]
      target = resolvePlanGroup(group, aliveSeats, pctx.events, opts)
    }

    return target
  }

  // ════════════════════════════════════════════
  // 指定→CO シミュレーション（Phase 0 mason 学習用）
  // ════════════════════════════════════════════

  /**
   * 1st forward の plan から指定→CO→対抗CO をシミュレーションし、
   * CO があれば 2nd forward で plan を再評価する。
   */
  private simulateDesignationCO(
    pctx: PhaseContext<FenrirExtEvent, FenrirExt>,
    ext: FenrirExt,
    aliveMasons: PlayerState[],
    firstResult: ForwardResult,
  ): { claims: Map<number, DayClaim>, masonResult: ForwardResult } {
    const state = pctx.state as GameState<FenrirExt>
    const claims = new Map<number, DayClaim>()

    // 指定タイプ判定
    const groups = ext.planState.forwardGroups
    if (groups.length === 0 || groups[0].targets.length === 0) {
      return { claims, masonResult: firstResult }
    }

    const firstTarget = groups[0].targets[0]
    const designationType: 'seat' | 'grayran' = firstTarget.type === 'seat' ? 'seat' : 'grayran'

    // 具体的な seat に解決
    const aliveSeats = alivePlayers(state).map(p => p.seat)
    const designatedSeat = resolvePlanGroup(
      { targets: [firstTarget] }, aliveSeats, pctx.events as any[], { rng: this.rng },
    )
    if (designatedSeat == null) {
      return { claims, masonResult: firstResult }
    }

    const lastExecutedSeat = state.executionHistory.get(pctx.day - 1) ?? null
    const events = pctx.events as (GameEvent | FenrirExtEvent)[]

    // 1. 指定対象の CO 判定
    const designatedPlayer = state.players.find(p => p.seat === designatedSeat)
    if (!designatedPlayer || !designatedPlayer.alive) {
      return { claims, masonResult: firstResult }
    }

    const designationClaim = this.generateDesignationResponse(
      state, designatedPlayer, designationType, pctx.day, lastExecutedSeat,
    )
    if (designationClaim.type !== 'none') {
      claims.set(designatedSeat, designationClaim)
      this.applyClaimLocally(state, designatedSeat, pctx.day, designationClaim, events)
    }

    // 2. 対抗 CO（bodyguard/nekomata CO が発生した場合のみ）
    if (designationClaim.type === 'bodyguard_co' || designationClaim.type === 'nekomata_co') {
      const triggeredRole: SystemRole = designationClaim.type === 'bodyguard_co' ? 'bodyguard' : 'nekomata'
      const counterClaims = this.generateCounterCOs(
        state, triggeredRole, designatedSeat, pctx.day, lastExecutedSeat,
      )
      for (const [seat, claim] of counterClaims) {
        claims.set(seat, claim)
        this.applyClaimLocally(state, seat, pctx.day, claim, events)
      }
    }

    if (claims.size === 0) {
      return { claims, masonResult: firstResult }
    }

    // 3. 2nd forward: CO を観測した上で plan を再評価
    const nnMason = aliveMasons.find(m => this.masonConfig.agents.has(m.seat))
    if (nnMason) {
      const agent = this.getAgent(nnMason.seat) as any
      agent.cachedDay = -1
      agent.cachedStrategyResult = null
    }

    const secondResult = this.commitMasonPlans(pctx, ext, aliveMasons)
    this.distributePlans(ext, aliveSeats, pctx.events)

    return { claims, masonResult: secondResult ?? firstResult }
  }

  /**
   * 指定された player の CO 判定。
   * - 村パワーロール (未CO) + seat 指定 → 100% CO
   * - 村パワーロール (未CO) + grayran → 確率 CO
   * - 素村 → none
   * - 非村 → 低確率で bodyguard_co / nekomata_co
   */
  private generateDesignationResponse(
    state: GameState<FenrirExt>,
    player: PlayerState,
    designationType: 'seat' | 'grayran',
    day: number,
    lastExecutedSeat: number | null,
  ): DayClaim {
    if (player.claimedRole !== null) return { type: 'none' }

    if (isVillagerAligned(player.role)) {
      if (!isVillagePowerRole(player.role)) return { type: 'none' }
      if (designationType === 'seat') {
        return forceTrueRoleCO(state, player, day, lastExecutedSeat)
      }
      // grayran/role → 確率 CO
      if (this.rng.next() < DESIGNATION_CO.VILLAGE_GRAYRAN_CO_PROB) {
        return forceTrueRoleCO(state, player, day, lastExecutedSeat)
      }
      return { type: 'none' }
    }

    // 非村: 低確率で bodyguard or nekomata fake CO（結果不要）
    if (this.rng.next() < DESIGNATION_CO.NON_VILLAGE_FAKE_CO_PROB) {
      return this.rng.next() < 0.5
        ? { type: 'bodyguard_co', targets: [] }
        : { type: 'nekomata_co' }
    }
    return { type: 'none' }
  }

  /**
   * bodyguard/nekomata CO に対する対抗 CO 生成。
   * - 村・同役職（未CO） → 100% CO
   * - 非村（未CO） → 低確率で同役職の fake CO
   */
  private generateCounterCOs(
    state: GameState<FenrirExt>,
    triggeredRole: SystemRole,
    triggerSeat: number,
    day: number,
    lastExecutedSeat: number | null,
  ): Map<number, DayClaim> {
    const counterClaims = new Map<number, DayClaim>()

    for (const player of state.players) {
      if (!player.alive || player.seat === triggerSeat || player.claimedRole !== null) continue

      if (player.role === triggeredRole) {
        // 村・同役職 → 100% 対抗 CO
        const claim = forceTrueRoleCO(state, player, day, lastExecutedSeat)
        if (claim.type !== 'none') counterClaims.set(player.seat, claim)
      } else if (!isVillagerAligned(player.role)) {
        // 非村 → 低確率で fake 対抗
        if (this.rng.next() < DESIGNATION_CO.NON_VILLAGE_COUNTER_CO_PROB) {
          const claim: DayClaim = triggeredRole === 'bodyguard'
            ? { type: 'bodyguard_co', targets: [] }
            : { type: 'nekomata_co' }
          counterClaims.set(player.seat, claim)
        }
      }
    }

    return counterClaims
  }

  /**
   * onPreVote 内で state を直接変更し、合成イベントを events に追加。
   * engine の applyClaim が後で再実行されるが冪等。
   */
  private applyClaimLocally(
    state: GameState<FenrirExt>,
    seat: number,
    day: number,
    claim: DayClaim,
    events: (GameEvent | FenrirExtEvent)[],
  ): void {
    const player = state.players.find(p => p.seat === seat)!
    switch (claim.type) {
      case 'seer_co':
        player.claimedRole = 'seer'
        player.claimedDay = day
        events.push({ type: 'seer_claim', actor: seat, results: claim.results })
        break
      case 'medium_co':
        player.claimedRole = 'medium'
        player.claimedDay = day
        events.push({ type: 'medium_claim', actor: seat })
        break
      case 'bodyguard_co':
        player.claimedRole = 'bodyguard'
        player.claimedDay = day
        events.push({ type: 'bodyguard_claim', actor: seat, targets: claim.targets })
        break
      case 'mason_co':
        player.claimedRole = 'mason'
        player.claimedDay = day
        events.push({ type: 'mason_claim', actor: seat, partner: claim.partner })
        if (!state.masonPartners) (state as any).masonPartners = new Map()
        state.masonPartners?.set(seat, claim.partner)
        break
      case 'nekomata_co':
        player.claimedRole = 'nekomata'
        player.claimedDay = day
        events.push({ type: 'nekomata_claim', actor: seat })
        break
    }
  }
}
