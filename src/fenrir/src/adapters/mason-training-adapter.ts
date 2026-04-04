/**
 * MasonTrainingAdapter — mason 訓練用 adapter
 *
 * StrategyBaseAdapter を継承し、mason 固有の責務を追加:
 *   1. onPreVote で NN mason の forward pass → plan 配布 → proposal 生成
 *   2. onVote で NN mason の投票 + trajectory 記録を adapter 層で完結
 *
 * NeuralAgent.decideVote は呼ばない。getStrategyResult は onPreVote で1回だけ呼び、
 * onVote では strategyVote に result を直接渡す。cache 依存なし。
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
import { alivePlayers } from '../../../lupa/roles.ts'
import { parsePlanIndices } from '../plan/plan-vocab.ts'
import { resolvePlanGroup } from '../plan/plan-resolve.ts'
import { planToVote } from '../plan/plan-helpers.ts'
import { collectObservation } from '../observation.ts'

export class MasonTrainingAdapter extends StrategyBaseAdapter {
  private readonly masonConfig: MasonTrainingAdapterConfig

  /** onPreVote で取得した NN mason の forward result（onVote で消費） */
  private masonResult: ForwardResult | null = null
  /** onPreVote で確定した NN mason の seat（onVote で使用） */
  private masonSeat: number | null = null
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

    this.masonResult = null
    this.masonSeat = null
    this.dayProposals = []

    if (aliveMasons.length > 0) {
      this.commitMasonPlans(pctx, ext, aliveMasons)
    }

    // 3. distributePlans: planState → ext.executionPlans
    const aliveSeats = alivePlayers(state).map(p => p.seat)
    this.distributePlans(ext, aliveSeats, pctx.events)

    // 4. Proposal 生成
    // eslint-disable-next-line -- TS narrows this.masonResult to null despite commitMasonPlans mutation
    const masonFwd = (this.masonResult as ForwardResult | null)
    if (aliveMasons.length > 0 && masonFwd) {
      const fwdActions = masonFwd.planForwardActions
      if (fwdActions) {
        const dummyCtx = this.buildCtx(pctx, aliveMasons[0], buildPlayerView(state, aliveMasons[0].seat), ext)
        const target = planToVote(fwdActions, dummyCtx, masonFwd.planEndgameActions)
        if (target != null) {
          this.dayProposals.push({ type: 'execute_order', target })
        }
      }
    } else if (allMasons.length > 0 && ext.planState.forwardGroups.length > 0) {
      // Mason 死亡: cached plan から解決
      const target = this.resolveDeadMasonTarget(pctx, ext)
      if (target != null) {
        this.dayProposals.push({ type: 'execute_order', target })
      }
    }

    return {}
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
    for (const player of alivePlayers(state)) {
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

      // NN mason: adapter が直接 vote + trajectory 記録
      if (isFirstRound && player.seat === this.masonSeat && this.masonResult) {
        const agent = this.getAgent(player.seat) as NeuralAgent
        votes.set(player.seat, agent.strategyVote(ctx, this.masonResult))
        continue
      }

      // 他のプレイヤー: 通常の decideVote
      const teamAgent = player.role === 'werewolf' ? this.config.wolfTeamAgent
        : player.role === 'mason' ? this.config.masonTeamAgent
        : null

      if (teamAgent) {
        const teamCtx = this.buildTeamCtx(ctx, state, player.role, player.seat)
        votes.set(player.seat, teamAgent.decideVote(teamCtx))
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
  ): void {
    const state = pctx.state as GameState<FenrirExt>
    const mason = aliveMasons.find(m => this.masonConfig.agents.has(m.seat)) ?? aliveMasons[0]
    const agent = this.getAgent(mason.seat) as any
    if (typeof agent.getStrategyResult !== 'function') return

    const masonView = buildPlayerView(state, mason.seat)
    const masonCtx = this.buildCtx(pctx, mason, masonView, ext)
    const result: ForwardResult = agent.getStrategyResult(masonCtx)

    this.masonResult = result
    this.masonSeat = mason.seat

    if (result.planForwardActions) {
      ext.planForwardIndices = [...result.planForwardActions]
      ext.planState.forwardGroups = parsePlanIndices(result.planForwardActions)
      ext.planState.dayIndex = 1  // groups[0] は今日使用済み
    }
    if (result.planEndgameActions) {
      ext.planEndgameIndices = [...result.planEndgameActions]
      ext.planState.endgameGroups = parsePlanIndices(result.planEndgameActions)
    }
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

    // Endgame plan 優先（≤6人）
    if (planState.endgameGroups.length > 0) {
      if (alive <= 4) {
        target = resolvePlanGroup(planState.endgameGroups[0], aliveSeats, pctx.events)
      } else if (alive <= 6) {
        const group = planState.endgameGroups.length >= 2
          ? planState.endgameGroups[1] : planState.endgameGroups[0]
        target = resolvePlanGroup(group, aliveSeats, pctx.events)
      }
    }

    // Forward plan フォールバック
    if (target == null && planState.dayIndex < planState.forwardGroups.length) {
      const group = planState.forwardGroups[planState.dayIndex]
      target = resolvePlanGroup(group, aliveSeats, pctx.events)
      this.advanceDayIndexOnce(ext, pctx.day)
    }

    return target
  }
}
