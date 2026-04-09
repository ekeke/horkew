/**
 * StrategyBaseAdapter — strategy-only 系 adapter の基底クラス
 *
 * Plan ライフサイクル（planState → executionPlans 通達）と
 * 共通の Retar/Tsumi/投票収集ロジックを管理。
 *
 * Plan 消費は縄数ベースで暗黙的に決まるため、明示的な dayIndex 進行は不要。
 *
 * onVote はテンプレートメソッドパターンで構成:
 *   1. Retar + Tsumi
 *   2. beforePlanDistribution()  — hook (planState 更新の機会)
 *   3. distributePlans()         — planState → ext.executionPlans
 *   4. collectProposals()        — hook → Proposal[]
 *   5. Vote collection           — 全員の decideVote
 *   6. afterVoteCollection()     — hook
 */

import type { SystemRole } from '../../../types/index.ts'
import type { GameState, GameEvent, NightAction, DayClaim, PlayerState } from '../../../lupa/types.ts'
import type { GameHandlers, PhaseContext, PlayerView, VoteContext, GameTiming } from '../../../lupa/handlers.ts'
import type { DecisionContext, TeamDecisionContext, Agent, WolfNightAction, ExecutionPlan } from '../agents/agent.ts'
import type { FenrirExt } from '../ext.ts'
import type { FenrirExtEvent } from '../events.ts'
import type { StrategyBaseAdapterConfig, CapturedObservation } from './adapter-types.ts'
import type { PlanSlot } from '../plan/plan-vocab.ts'
import type { Proposal } from '../leadership.ts'
import { createFenrirExt } from '../ext.ts'
import { buildPlayerView } from '../../../lupa/player-view.ts'
import { alivePlayers } from '../../../lupa/roles.ts'
import { Rng } from '../../../lupa/random.ts'
import {
  analyzePerPlayer as retarAnalyzePerPlayer,
  retarResultToPossibilities,
  lupaRunRetar,
} from '../retar-bridge.ts'
import { searchTsumi, searchTsumiStrategy } from '../../../hati/index.ts'
import { resolvePlanSlot } from '../plan/plan-resolve.ts'
import { parseDualPlanSlots } from '../plan/plan-vocab.ts'
import { nooseCount } from '../plan/plan-helpers.ts'
import { collectObservation } from '../observation.ts'

/** PlanSlot[] → ExecutionPlan[] に変換（observation 注入用） */
function planSlotsToExecutionPlans(
  slots: PlanSlot[],
  aliveSeats: number[],
  events: readonly any[],
  rng?: Rng,
): ExecutionPlan[] {
  const plans: ExecutionPlan[] = []
  for (const slot of slots) {
    const seat = resolvePlanSlot(slot, aliveSeats, events, { rng })
    if (seat != null) {
      plans.push({ targets: [seat], type: 'designated' })
    }
  }
  return plans
}

export abstract class StrategyBaseAdapter
  implements GameHandlers<FenrirExtEvent, FenrirExt> {

  protected readonly config: StrategyBaseAdapterConfig
  protected readonly rng: Rng
  protected readonly capturedObservations: CapturedObservation[] = []
  private retarAccMs = 0
  private retarCallCount = 0

  constructor(config: StrategyBaseAdapterConfig) {
    this.config = config
    this.rng = new Rng(config.seed)
  }

  // ════════════════════════════════════════════
  // GameHandlers implementation
  // ════════════════════════════════════════════

  onSetup(roles: Map<number, SystemRole>, state: GameState<FenrirExt>): void {
    state.ext = createFenrirExt()
    this.config.onRolesAssigned?.(roles)
  }

  onNight(pctx: PhaseContext<FenrirExtEvent, FenrirExt>): Map<number, NightAction> {
    const state = pctx.state as GameState<FenrirExt>
    const ext = state.ext
    const actions = new Map<number, NightAction>()

    // 狼チーム夜行動
    if (this.config.wolfTeamAgent) {
      const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
      if (aliveWolves.length > 0) {
        const leader = aliveWolves[0]
        const view = buildPlayerView(state, leader.seat)
        const ctx = this.buildCtx(pctx, leader, view, ext)
        const teamCtx = this.buildTeamCtx(ctx, state, 'werewolf')
        const wolfAction = this.config.wolfTeamAgent.decideNightAction(teamCtx) as WolfNightAction

        for (const wolf of aliveWolves) {
          if (wolf.seat === wolfAction.attacker) {
            actions.set(wolf.seat, { type: 'attack', target: wolfAction.target })
          } else {
            actions.set(wolf.seat, { type: 'none' })
          }
        }
      }
    }

    // 個別プレイヤー夜行動
    for (const player of alivePlayers(state)) {
      if (actions.has(player.seat)) continue
      const view = buildPlayerView(state, player.seat)
      const ctx = this.buildCtx(pctx, player, view, ext)
      actions.set(player.seat, this.getAgent(player.seat).decideNightAction(ctx))
    }

    return actions
  }

  onDayClaims(pctx: PhaseContext<FenrirExtEvent, FenrirExt>): Map<number, DayClaim> {
    const state = pctx.state as GameState<FenrirExt>
    const ext = state.ext
    this.runRetar(pctx, ext)
    const claims = new Map<number, DayClaim>()

    for (const player of alivePlayers(state)) {
      const view = buildPlayerView(state, player.seat)
      const ctx = this.buildCtx(pctx, player, view, ext)

      const teamAgent = player.role === 'werewolf' ? this.config.wolfTeamAgent
        : player.role === 'mason' ? this.config.masonTeamAgent
        : null

      if (teamAgent) {
        const teamCtx = this.buildTeamCtx(ctx, state, player.role, player.seat)
        claims.set(player.seat, teamAgent.decideDayClaim(teamCtx))
      } else {
        claims.set(player.seat, this.getAgent(player.seat).decideDayClaim(ctx))
      }
    }

    return claims
  }

  /**
   * onVote — テンプレートメソッド
   *
   * フロー:
   *   1. Retar + Tsumi
   *   2. beforePlanDistribution()  — サブクラスが planState を更新
   *   3. distributePlans()         — planState → ext.executionPlans
   *   4. collectProposals()        — サブクラスが Proposal[] を生成
   *   5. 全プレイヤー投票収集
   *   6. afterVoteCollection()     — サブクラスの後処理
   */
  onVote(vctx: VoteContext<FenrirExtEvent, FenrirExt>): Map<number, number> {
    const state = vctx.state as GameState<FenrirExt>
    const ext = state.ext

    // 1. Retar + Tsumi
    this.runRetar(vctx as PhaseContext<FenrirExtEvent, FenrirExt>, ext)
    this.runTsumiSearch(ext)
    if (vctx.revoteRound === 0 || vctx.revoteRound == null) {
      ext.tsumiCache.set(vctx.day, ext.tsumiTarget !== null)
    }

    // 2. Hook: planState 更新の機会
    this.beforePlanDistribution(vctx, ext)

    // 3. planState → ext.executionPlans
    const aliveSeats = alivePlayers(state).map(p => p.seat)
    this.distributePlans(ext, aliveSeats, vctx.events)

    // 4. Hook: Proposal 生成
    const dayProposals = this.collectProposals(vctx, ext)

    // 5. 投票収集
    const votes = new Map<number, number>()
    for (const player of alivePlayers(state)) {
      const view = buildPlayerView(state, player.seat)
      const ctx = this.buildCtx(
        vctx as PhaseContext<FenrirExtEvent, FenrirExt>, player, view, ext, {
          revoteRound: vctx.revoteRound,
          revoteCandidates: vctx.candidates,
          proposals: dayProposals,
        },
      )

      // inspect 用: observation キャプチャ（初回投票のみ）
      if (this.config.captureObservations && (vctx.revoteRound === 0 || vctx.revoteRound == null)) {
        this.capturedObservations.push({
          seat: player.seat,
          role: player.role,
          day: ctx.day,
          observation: collectObservation(ctx),
          proposals: dayProposals.map(p => ({ type: p.type, target: p.target })),
        })
      }

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

    // 6. Hook: 後処理
    this.afterVoteCollection(vctx, ext)

    return votes
  }

  getTiming(): GameTiming {
    return { retarMs: this.retarAccMs, retarCount: this.retarCallCount }
  }

  getTsumiCache(): Map<number, boolean> {
    return (undefined as any)  // TODO: read from ext after game ends
  }

  getCapturedObservations(): CapturedObservation[] {
    return this.capturedObservations
  }

  // ════════════════════════════════════════════
  // Template hooks (サブクラスがオーバーライド)
  // ════════════════════════════════════════════

  /** planState を更新する機会。distributePlans の前に呼ばれる。 */
  protected beforePlanDistribution(
    _vctx: VoteContext<FenrirExtEvent, FenrirExt>,
    _ext: FenrirExt,
  ): void {}

  /** Proposal[] を返す。distributePlans の後、投票収集の前に呼ばれる。 */
  protected collectProposals(
    _vctx: VoteContext<FenrirExtEvent, FenrirExt>,
    _ext: FenrirExt,
  ): Proposal[] {
    return []
  }

  /** 投票収集の後に呼ばれる。公認プランの forward slot を日送りする。 */
  protected afterVoteCollection(
    vctx: VoteContext<FenrirExtEvent, FenrirExt>,
    ext: FenrirExt,
  ): void {
    // 公認プラン: 初回投票後に forward slot を1つ消費（日送り）
    const isFirstRound = vctx.revoteRound === 0 || vctx.revoteRound == null
    if (isFirstRound && ext.planState.slots.length > 0) {
      ext.planState.slots.shift()
    }
  }

  // ════════════════════════════════════════════
  // Plan distribution (base が所有)
  // ════════════════════════════════════════════

  /** planState → ext.executionPlans に変換・配布 */
  protected distributePlans(
    ext: FenrirExt,
    aliveSeats: number[],
    events: readonly (GameEvent | FenrirExtEvent)[],
  ): void {
    const ps = ext.planState
    if (ps.slots.length > 0) {
      ext.executionPlans = planSlotsToExecutionPlans(ps.slots, aliveSeats, events, this.rng)
    }
  }

  /** NN 出力の plan tokens を ext に保存する（infrastructure） */
  protected commitPlanTokens(
    ext: FenrirExt,
    planActions: number[] | null,
    aliveCount: number,
  ): void {
    if (planActions) {
      ext.planIndices = [...planActions]
      const { forwardSlots, endgameSlots } = parseDualPlanSlots(planActions)
      ext.planState.slots = forwardSlots
      ext.planState.endgameSlots = endgameSlots
      ext.planState.initialNooseCount = nooseCount(aliveCount)
    }
  }

  // ════════════════════════════════════════════
  // Protected helpers
  // ════════════════════════════════════════════

  protected getAgent(seat: number): Agent {
    return this.config.agents.get(seat) ?? this.config.defaultAgent!
  }

  protected runRetar(pctx: PhaseContext<FenrirExtEvent, FenrirExt>, ext: FenrirExt): void {
    if (!this.config.enableRetar) return
    const t0 = performance.now()
    const state = pctx.state as GameState<FenrirExt>
    const events = [...pctx.events] as GameEvent[]
    const lupaConfig = { roles: this.config.roles, rules: this.config.rules } as any
    const ppResult = retarAnalyzePerPlayer(events, state, lupaConfig, alivePlayers(state))

    ext.retarCache = {
      possibilities: ppResult.global.possibilities,
      maxSurvivingNV: ppResult.global.maxSurvivingNV,
      globalPossibilities: ppResult.global.possibilities,
      perPlayer: ppResult.perPlayer,
      lastArtifacts: ppResult.vs && ppResult.setup
        ? { vs: ppResult.vs, setup: ppResult.setup, options: ppResult.analyzeOptions }
        : null,
    }

    this.retarAccMs += performance.now() - t0
    this.retarCallCount++
  }

  protected runTsumiSearch(ext: FenrirExt): void {
    ext.tsumiTarget = null
    if (!this.config.enableTsumi || !ext.retarCache?.lastArtifacts || !ext.retarCache.possibilities) return
    const { lastArtifacts, possibilities, maxSurvivingNV } = ext.retarCache
    const conclusions = retarResultToPossibilities(
      { possibilities, maxSurvivingNV: maxSurvivingNV ?? 0 },
      lastArtifacts.setup,
    )
    try {
      const result = searchTsumi(
        lastArtifacts.vs, lastArtifacts.setup, lastArtifacts.options,
        lupaRunRetar, conclusions,
      )
      if (result.isTsumi) {
        const sr = searchTsumiStrategy(result, { maxDepth: 4 })
        if (sr.strategy?.type === 'action') {
          ext.tsumiTarget = sr.strategy.action.execute
        }
      }
    } catch { /* skip */ }
  }

  protected buildCtx(
    pctx: PhaseContext<FenrirExtEvent, FenrirExt>,
    player: PlayerState,
    view: PlayerView,
    ext: FenrirExt,
    extra?: Partial<DecisionContext>,
  ): DecisionContext {
    const playerRetarResult = ext.retarCache?.perPlayer?.get(player.seat)
    const playerRetar = playerRetarResult?.possibilities ?? ext.retarCache?.possibilities ?? null
    const playerMaxNV = playerRetarResult?.maxSurvivingNV ?? ext.retarCache?.maxSurvivingNV ?? null

    return {
      mySeat: player.seat,
      myRole: player.role,
      myPlayer: player,
      day: pctx.day,
      phase: pctx.state.phase,
      alivePlayers: pctx.alivePlayers,
      publicEvents: [...pctx.events],
      signals: [],
      commander: null,
      proposals: [],
      rng: this.rng,
      gameState: pctx.state as GameState,
      lastExecutedSeat: pctx.state.executionHistory.get(pctx.day - 1) ?? null,
      retarPossibilities: playerRetar,
      maxSurvivingNV: playerMaxNV,
      globalRetarPossibilities: ext.retarCache?.globalPossibilities ?? null,
      wolfTeammates: view.wolfTeammates,
      knownWolves: view.knownWolves,
      knownHamster: view.knownHamster,
      masonPartner: view.masonPartner,
      revoteRound: null,
      revoteCandidates: null,
      executionPlans: ext.executionPlans,
      planIndices: ext.planIndices,
      tsumiTarget: ext.tsumiTarget,
      rules: pctx.rules,
      ...extra,
    }
  }

  protected buildTeamCtx(
    ctx: DecisionContext, state: Readonly<GameState<FenrirExt>>, role: SystemRole,
    currentActorSeat?: number,
  ): TeamDecisionContext {
    const teamPlayers = (state.players as PlayerState[]).filter(p => p.role === role && p.alive)
    return {
      ...ctx,
      teamSeats: teamPlayers.map(p => p.seat),
      teamPlayers,
      currentActorSeat,
    }
  }
}
