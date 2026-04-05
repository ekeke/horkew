/**
 * MasonTrainingAdapter — mason 訓練用 adapter
 *
 * StrategyBaseAdapter を継承し、mason 固有の責務を追加:
 *   1. onPreVote で全意思決定を完結: forward pass → plan 配布 → 投票先確定 → trajectory 記録
 *   2. onVote は機械的な票割り当て: 村陣営は plan に従い、非村は decideVote
 *
 * NeuralAgent.decideVote は呼ばない。getStrategyResult は onPreVote で1回だけ呼ぶ。
 */

import type { GameState, PlayerState } from '../../../lupa/types.ts'
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
import { resolvePlanGroup } from '../plan/plan-resolve.ts'
import { planToVote } from '../plan/plan-helpers.ts'
import { encodeObservation, collectObservation } from '../observation.ts'
import { RuleBasedAgent } from '../agents/rule-based-agent.ts'

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

    // 4. Plan token 保持 + proposal 生成 + trajectory 記録
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

    return {}
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
}
