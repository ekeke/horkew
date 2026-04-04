/**
 * MasonTrainingAdapter — mason 訓練用 adapter
 *
 * StrategyBaseAdapter を継承し、mason 固有の2つの責務を追加:
 *   1. Mason が ext.planState を更新できる（plan 書き込み権限）
 *   2. 村エージェントの投票に plan が 100% 反映される
 *
 * Mason takeover（ML mason 死亡時のパートナーへの agent 移譲）もここで管理。
 */

import type { GameState, PlayerState } from '../../../lupa/types.ts'
import type { VoteContext, PhaseContext } from '../../../lupa/handlers.ts'
import type { FenrirExt } from '../ext.ts'
import type { FenrirExtEvent } from '../events.ts'
import type { MasonTrainingAdapterConfig } from './adapter-types.ts'
import type { PlanState } from '../plan/plan-helpers.ts'
import type { Proposal } from '../leadership.ts'
import { StrategyBaseAdapter } from './strategy-base-adapter.ts'
import { buildPlayerView } from '../../../lupa/player-view.ts'
import { alivePlayers } from '../../../lupa/roles.ts'
import { parsePlanIndices } from '../plan/plan-vocab.ts'
import { resolvePlanGroup } from '../plan/plan-resolve.ts'

export class MasonTrainingAdapter extends StrategyBaseAdapter {
  private readonly masonConfig: MasonTrainingAdapterConfig

  constructor(config: MasonTrainingAdapterConfig) {
    super(config)
    this.masonConfig = config
  }

  // ════════════════════════════════════════════
  // Hook overrides
  // ════════════════════════════════════════════

  /**
   * Mason takeover + plan 生成。distributePlans の前に planState を更新する。
   */
  protected override beforePlanDistribution(
    vctx: VoteContext<FenrirExtEvent, FenrirExt>,
    ext: FenrirExt,
  ): void {
    const state = vctx.state as GameState<FenrirExt>
    const planState = ext.planState
    const allMasons = state.players.filter(p => p.role === 'mason')
    const aliveMasons = allMasons.filter(p => p.alive)

    // Mason takeover: ML mason 死亡 + パートナー生存 → agent 移譲
    this.handleMasonTakeover(state, planState, allMasons, aliveMasons)

    // Mason 生存: NN の plan token → planState に書き込み
    if (aliveMasons.length > 0) {
      this.commitMasonPlans(vctx, ext, aliveMasons)
    }
  }

  /**
   * Mason の plan を Proposal として返す。
   * - 生存時: decideProposal → execute_order
   * - 死亡時: cached planState から解決
   */
  protected override collectProposals(
    vctx: VoteContext<FenrirExtEvent, FenrirExt>,
    ext: FenrirExt,
  ): Proposal[] {
    const state = vctx.state as GameState<FenrirExt>
    const allMasons = state.players.filter(p => p.role === 'mason')
    const aliveMasons = allMasons.filter(p => p.alive)
    const proposals: Proposal[] = []

    if (aliveMasons.length > 0) {
      // Mason 生存: decideProposal で今日の処刑対象を提案
      const mason = aliveMasons.find(m => this.masonConfig.agents.has(m.seat)) ?? aliveMasons[0]
      const masonView = buildPlayerView(state, mason.seat)
      const masonCtx = this.buildCtx(
        vctx as PhaseContext<FenrirExtEvent, FenrirExt>, mason, masonView, ext,
      )
      masonCtx.commander = mason.seat
      const proposal = this.getAgent(mason.seat).decideProposal?.(masonCtx)
      if (proposal?.type === 'execute_order') {
        proposals.push(proposal)
      }
    } else if (allMasons.length > 0 && ext.planState.forwardGroups.length > 0) {
      // Mason 死亡: cached plan から投票先を解決
      const target = this.resolveDeadMasonTarget(vctx, ext)
      if (target != null) {
        proposals.push({ type: 'execute_order', target })
      }
    }

    return proposals
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
   * Mason 生存時: NN の strategy result から plan token を取得し、planState に書き込む。
   */
  private commitMasonPlans(
    vctx: VoteContext<FenrirExtEvent, FenrirExt>,
    ext: FenrirExt,
    aliveMasons: PlayerState[],
  ): void {
    const state = vctx.state as GameState<FenrirExt>
    const mason = aliveMasons.find(m => this.masonConfig.agents.has(m.seat)) ?? aliveMasons[0]
    const agent = this.getAgent(mason.seat) as any
    const masonView = buildPlayerView(state, mason.seat)
    const masonCtx = this.buildCtx(
      vctx as PhaseContext<FenrirExtEvent, FenrirExt>, mason, masonView, ext,
    )
    // getStrategyResult は cachedDay !== ctx.day のとき再推論する。
    // cachedStrategyResult を直接読むと前日の stale result を使ってしまう。
    const result = agent.getStrategyResult?.(masonCtx) as import('../ml/nn.ts').ForwardResult | undefined
    if (!result) return

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
    vctx: VoteContext<FenrirExtEvent, FenrirExt>,
    ext: FenrirExt,
  ): number | null {
    const state = vctx.state as GameState<FenrirExt>
    const planState = ext.planState
    const aliveSeats = alivePlayers(state).map(p => p.seat)
    const alive = aliveSeats.length
    let target: number | null = null

    // Endgame plan 優先（≤6人）
    if (planState.endgameGroups.length > 0) {
      if (alive <= 4) {
        target = resolvePlanGroup(planState.endgameGroups[0], aliveSeats, vctx.events)
      } else if (alive <= 6) {
        const group = planState.endgameGroups.length >= 2
          ? planState.endgameGroups[1] : planState.endgameGroups[0]
        target = resolvePlanGroup(group, aliveSeats, vctx.events)
      }
    }

    // Forward plan フォールバック
    if (target == null && planState.dayIndex < planState.forwardGroups.length) {
      const group = planState.forwardGroups[planState.dayIndex]
      target = resolvePlanGroup(group, aliveSeats, vctx.events)
      this.advanceDayIndexOnce(ext, vctx.day)
    }

    return target
  }
}
