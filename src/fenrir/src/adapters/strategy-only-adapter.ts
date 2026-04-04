/**
 * Strategy-Only Adapter
 *
 * Agent.getStrategy() → plan-helpers で game action に変換。
 * 全永続データは state.ext (FenrirExt) 経由で管理。
 * onPreVote なし → シグナル/指揮者/予告/防御CO全スキップ。
 */

import type { SystemRole } from '../../../types/index.ts'
import type { GameState, GameEvent, NightAction, DayClaim, PlayerState } from '../../../lupa/types.ts'
import type { GameHandlers, PhaseContext, PlayerView, GameTiming } from '../../../lupa/handlers.ts'
import type { DecisionContext, TeamDecisionContext, Agent, WolfNightAction, ExecutionPlan } from '../agents/agent.ts'
import type { FenrirExt } from '../ext.ts'
import type { FenrirExtEvent } from '../events.ts'
import type { StrategyOnlyAdapterConfig, CapturedObservation } from './adapter-types.ts'
import type { PlanDayGroup } from '../plan/plan-vocab.ts'
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
import { parsePlanIndices } from '../plan/plan-vocab.ts'
import { resolvePlanGroup } from '../plan/plan-resolve.ts'
import { encodeObservation } from '../observation.ts'

/** PlanDayGroup[] → ExecutionPlan[] に変換（observation 注入用） */
function planGroupsToExecutionPlans(
  groups: PlanDayGroup[],
  aliveSeats: number[],
  events: readonly any[],
  type: 'designated' | 'endgame',
): ExecutionPlan[] {
  const plans: ExecutionPlan[] = []
  for (const group of groups) {
    const seat = resolvePlanGroup(group, aliveSeats, events)
    if (seat != null) {
      plans.push({ targets: [seat], type })
    }
  }
  return plans
}

export function strategyOnlyAdapter(
  config: StrategyOnlyAdapterConfig,
): GameHandlers<FenrirExtEvent, FenrirExt> & { getCapturedObservations?: () => CapturedObservation[] } {
  // --- Adapter-local state (not game state, not snapshot-able) ---
  const rng = new Rng(config.seed)
  const capturedObservations: CapturedObservation[] = []
  let retarAccMs = 0
  let retarCallCount = 0

  function getAgent(seat: number): Agent {
    return config.agents.get(seat) ?? config.defaultAgent!
  }

  function runRetar(pctx: PhaseContext<FenrirExtEvent, FenrirExt>, ext: FenrirExt): void {
    if (!config.enableRetar) return
    if (config.retarStartDay && pctx.day < config.retarStartDay) return
    const t0 = performance.now()
    const state = pctx.state as GameState<FenrirExt>
    const events = [...pctx.events] as GameEvent[]
    const lupaConfig = { roles: config.roles, rules: config.rules } as any
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

    retarAccMs += performance.now() - t0
    retarCallCount++
  }

  function runTsumiSearch(ext: FenrirExt): void {
    ext.tsumiTarget = null
    if (!config.enableTsumi || !ext.retarCache?.lastArtifacts || !ext.retarCache.possibilities) return
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

  function buildCtx(
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
      rng,
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
      tsumiTarget: ext.tsumiTarget,
      rules: pctx.rules,
      ...extra,
    }
  }

  function buildTeamCtx(
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

  return {
    onSetup(roles, state) {
      state.ext = createFenrirExt()
      config.onRolesAssigned?.(roles)
    },

    onNight(pctx) {
      const state = pctx.state as GameState<FenrirExt>
      const ext = state.ext
      const actions = new Map<number, NightAction>()

      // 狼チーム夜行動
      if (config.wolfTeamAgent) {
        const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
        if (aliveWolves.length > 0) {
          const leader = aliveWolves[0]
          const view = buildPlayerView(state, leader.seat)
          const ctx = buildCtx(pctx, leader, view, ext)
          const teamCtx = buildTeamCtx(ctx, state, 'werewolf')
          const wolfAction = config.wolfTeamAgent.decideNightAction(teamCtx) as WolfNightAction

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
        const ctx = buildCtx(pctx, player, view, ext)
        actions.set(player.seat, getAgent(player.seat).decideNightAction(ctx))
      }

      return actions
    },

    onDayClaims(pctx) {
      const state = pctx.state as GameState<FenrirExt>
      const ext = state.ext
      runRetar(pctx, ext)
      const claims = new Map<number, DayClaim>()

      for (const player of alivePlayers(state)) {
        const view = buildPlayerView(state, player.seat)
        const ctx = buildCtx(pctx, player, view, ext)

        const teamAgent = player.role === 'werewolf' ? config.wolfTeamAgent
          : player.role === 'mason' ? config.masonTeamAgent
          : null

        if (teamAgent) {
          const teamCtx = buildTeamCtx(ctx, state, player.role, player.seat)
          claims.set(player.seat, teamAgent.decideDayClaim(teamCtx))
        } else {
          claims.set(player.seat, getAgent(player.seat).decideDayClaim(ctx))
        }
      }

      return claims
    },

    onVote(vctx) {
      const state = vctx.state as GameState<FenrirExt>
      const ext = state.ext
      const planState = ext.planState

      runRetar(vctx as PhaseContext<FenrirExtEvent, FenrirExt>, ext)
      runTsumiSearch(ext)

      // 初回投票時のみキャッシュ
      if (vctx.revoteRound === 0 || vctx.revoteRound == null) {
        ext.tsumiCache.set(vctx.day, ext.tsumiTarget !== null)
      }

      const votes = new Map<number, number>()
      const dayProposals: import('../leadership.ts').Proposal[] = []
      const allMasons = state.players.filter(p => p.role === 'mason')
      const aliveMasons = allMasons.filter(p => p.alive)

      // Mason takeover: ML mason が死亡し、パートナーが生存 → agent を移す
      if (config.onMasonTakeover && !planState.masonTakeoverDone) {
        if (planState.mlMasonSeat === null) {
          for (const m of allMasons) {
            if (config.agents.has(m.seat)) {
              planState.mlMasonSeat = m.seat
              break
            }
          }
        }
        if (planState.mlMasonSeat !== null) {
          const mlMason = allMasons.find(p => p.seat === planState.mlMasonSeat)
          if (mlMason && !mlMason.alive && aliveMasons.length > 0) {
            const newSeat = aliveMasons[0].seat
            const agent = config.agents.get(planState.mlMasonSeat)
            if (agent) {
              config.agents.delete(planState.mlMasonSeat)
              config.agents.set(newSeat, agent)
              // agent cache クリア（新しい seat で再推論させる）
              const s = agent as any
              s.cachedDay = -1
              s.lastObs = null
              s.cachedStrategyResult = null
            }
            config.onMasonTakeover(planState.mlMasonSeat, newSeat)
            planState.mlMasonSeat = newSeat
            planState.masonTakeoverDone = true
          }
        }
      }

      if (aliveMasons.length > 0) {
        // ML mason を優先
        const mason = aliveMasons.find(m => config.agents.has(m.seat)) ?? aliveMasons[0]
        const masonView = buildPlayerView(state, mason.seat)
        const masonCtx = buildCtx(vctx as PhaseContext<FenrirExtEvent, FenrirExt>, mason, masonView, ext)
        masonCtx.commander = mason.seat
        const proposal = getAgent(mason.seat).decideProposal?.(masonCtx)
        if (proposal && proposal.type === 'execute_order') {
          dayProposals.push(proposal)
        }

        // planグループをキャッシュ（死亡後の継続用）
        const s = getAgent(mason.seat) as any
        const result = s.cachedStrategyResult ?? s.getStrategyResult?.(masonCtx)
        if (result) {
          if (result.planForwardActions) {
            planState.forwardGroups = parsePlanIndices(result.planForwardActions)
            planState.dayIndex = 1  // groups[0]は今日使った
          }
          if (result.planEndgameActions) {
            planState.endgameGroups = parsePlanIndices(result.planEndgameActions)
          }
        }
      } else if (allMasons.length > 0 && planState.forwardGroups.length > 0) {
        // mason全滅: キャッシュされたplanから投票先を解決
        const aliveSeats = alivePlayers(state).map(p => p.seat)
        const alive = aliveSeats.length
        let target: number | null = null

        // Endgame plan 優先（≤6人）
        if (planState.endgameGroups.length > 0) {
          if (alive <= 4) {
            target = resolvePlanGroup(planState.endgameGroups[0], aliveSeats, vctx.events)
          } else if (alive <= 6) {
            const group = planState.endgameGroups.length >= 2 ? planState.endgameGroups[1] : planState.endgameGroups[0]
            target = resolvePlanGroup(group, aliveSeats, vctx.events)
          }
        }

        // Forward plan フォールバック
        if (!target && planState.dayIndex < planState.forwardGroups.length) {
          const group = planState.forwardGroups[planState.dayIndex++]
          target = resolvePlanGroup(group, aliveSeats, vctx.events)
        }

        if (target) {
          dayProposals.push({ type: 'execute_order', target })
        }
      }

      // cachedPlanGroups → ExecutionPlan[] に変換して ext に永続化
      {
        const aliveSeats = alivePlayers(state).map(p => p.seat)
        const fwdPlans = planState.forwardGroups.length > 0
          ? planGroupsToExecutionPlans(planState.forwardGroups, aliveSeats, vctx.events, 'designated')
          : []
        const egPlans = planState.endgameGroups.length > 0
          ? planGroupsToExecutionPlans(planState.endgameGroups, aliveSeats, vctx.events, 'endgame')
          : []
        if (fwdPlans.length > 0 || egPlans.length > 0) {
          ext.executionPlans = [...fwdPlans, ...egPlans]
        }
      }

      for (const player of alivePlayers(state)) {
        const view = buildPlayerView(state, player.seat)
        const ctx = buildCtx(vctx as PhaseContext<FenrirExtEvent, FenrirExt>, player, view, ext, {
          revoteRound: vctx.revoteRound,
          revoteCandidates: vctx.candidates,
          proposals: dayProposals,
        })

        // inspect 用: 全プレイヤーの observation をキャプチャ
        if (config.captureObservations && (vctx.revoteRound === 0 || vctx.revoteRound == null)) {
          capturedObservations.push({
            seat: player.seat,
            role: player.role,
            day: ctx.day,
            observation: encodeObservation(ctx),
            proposals: dayProposals.map(p => ({ type: p.type, target: p.target })),
          })
        }

        const teamAgent = player.role === 'werewolf' ? config.wolfTeamAgent
          : player.role === 'mason' ? config.masonTeamAgent
          : null

        if (teamAgent) {
          const teamCtx = buildTeamCtx(ctx, state, player.role, player.seat)
          votes.set(player.seat, teamAgent.decideVote(teamCtx))
        } else {
          votes.set(player.seat, getAgent(player.seat).decideVote(ctx))
        }
      }

      return votes
    },

    getTiming(): GameTiming {
      return { retarMs: retarAccMs, retarCount: retarCallCount }
    },

    getTsumiCache(): Map<number, boolean> {
      return (undefined as any)  // TODO: read from ext after game ends
    },

    getCapturedObservations() {
      return capturedObservations
    },
  }
}
