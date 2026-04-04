/**
 * Full Adapter — 全フェーズ対応（議論・シグナル・提案・予告・防御CO）
 *
 * verify/agent-adapter.ts をベースに fenrir 用にコピー・リネーム。
 * Retar統合はオプション。
 */

import type { SystemRole, ResolvedRules } from '../../../types/index.ts'
import type { GameState, GameEvent, NightAction, DayClaim, PlayerState } from '../../../lupa/types.ts'
import type {
  DecisionContext, TeamDecisionContext,
  Agent, TeamAgent, WolfNightAction,
} from '../agents/agent.ts'
import type { SignalRecord } from '../communication.ts'
import type { Proposal } from '../leadership.ts'
import type { GameHandlers, PhaseContext, PlayerView, GameTiming } from '../../../lupa/handlers.ts'
import { buildPlayerView } from '../../../lupa/player-view.ts'
import { alivePlayers } from '../../../lupa/roles.ts'
import { detectCommander } from '../leadership.ts'
import type { FenrirExtEvent } from '../events.ts'
import { Rng } from '../../../lupa/random.ts'
import { forceTrueRoleCO, isVillagePowerRole } from '../agents/rule-based-agent.ts'
import {
  analyzePerPlayer as retarAnalyzePerPlayer,
  retarResultToPossibilities,
  lupaRunRetar,
  type RetarResult,
} from '../retar-bridge.ts'
import { searchTsumi, searchTsumiStrategy } from '../../../hati/index.ts'

export type FullAdapterConfig = {
  agents?: Map<number, Agent>
  defaultAgent: Agent
  wolfTeamAgent?: TeamAgent
  masonTeamAgent?: TeamAgent
  enableRetar?: boolean
  /** 詰み探索を有効化（pretrain用、デフォルトfalse） */
  enableTsumi?: boolean
  /** Retarを有効にする開始Day（このDay以降にretarを走らせる、カリキュラム用） */
  retarStartDay?: number
  /** 役職割当後にstrategy差し替え用コールバック */
  onRolesAssigned?: (seatRoles: Map<number, SystemRole>) => void
  seed?: number
  roles: Map<SystemRole, number>
  rules?: Partial<ResolvedRules>
}

export function fullAdapter(adapterConfig: FullAdapterConfig): GameHandlers<FenrirExtEvent> {
  const rng = new Rng(adapterConfig.seed)
  let retarPossibilities: Map<number, Set<SystemRole>> | null = null
  let maxSurvivingNV: number | null = null
  let globalRetarPossibilities: Map<number, Set<SystemRole>> | null = null
  let perPlayerRetar: Map<number, RetarResult> | null = null
  let signals: SignalRecord[] = []
  let daySignals: SignalRecord[] = []
  let dayProposals: Proposal[] = []
  let signalIdCounter = 0
  let retarAccMs = 0
  let retarCallCount = 0
  let tsumiTarget: number | null = null
  let lastRetarArtifacts: { vs: any, setup: Map<SystemRole, number>, options: any } | null = null
  const tsumiCache = new Map<number, boolean>()  // day → isTsumi

  function getStrategy(seat: number): Agent {
    return adapterConfig.agents?.get(seat) ?? adapterConfig.defaultAgent
  }

  function buildCtx(
    pctx: PhaseContext<FenrirExtEvent>, player: PlayerState, view: PlayerView,
    extra?: Partial<DecisionContext>,
  ): DecisionContext {
    const playerRetarResult = perPlayerRetar?.get(player.seat)
    const playerRetar = playerRetarResult?.possibilities ?? retarPossibilities
    const playerMaxNV = playerRetarResult?.maxSurvivingNV ?? maxSurvivingNV

    return {
      mySeat: player.seat,
      myRole: player.role,
      myPlayer: player,
      day: pctx.day,
      phase: pctx.state.phase,
      alivePlayers: pctx.alivePlayers,
      publicEvents: [...pctx.events],
      signals: daySignals,
      commander: (pctx.state as GameState).commander,
      proposals: dayProposals,
      rng,
      gameState: pctx.state as GameState,
      lastExecutedSeat: pctx.state.executionHistory.get(pctx.day - 1) ?? null,
      retarPossibilities: playerRetar,
      maxSurvivingNV: playerMaxNV,
      globalRetarPossibilities,
      wolfTeammates: view.wolfTeammates,
      knownWolves: view.knownWolves,
      knownHamster: view.knownHamster,
      masonPartner: view.masonPartner,
      revoteRound: null,
      revoteCandidates: null,
      executionPlans: [],
      planForwardIndices: null,
      planEndgameIndices: null,
      tsumiTarget,
      rules: pctx.rules,
      ...extra,
    }
  }

  function buildTeamCtx(
    ctx: DecisionContext, state: Readonly<GameState>, role: SystemRole,
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

  function decideForPlayer<T>(
    pctx: PhaseContext<FenrirExtEvent>, player: PlayerState,
    individualFn: (s: Agent, c: DecisionContext) => T,
    teamFn: (s: TeamAgent, c: TeamDecisionContext) => T,
  ): T {
    const state = pctx.state as GameState
    const view = buildPlayerView(state, player.seat)
    const ctx = buildCtx(pctx, player, view)

    const teamAgent = player.role === 'werewolf' ? adapterConfig.wolfTeamAgent
      : player.role === 'mason' ? adapterConfig.masonTeamAgent
      : null

    if (teamAgent) {
      const teamCtx = buildTeamCtx(ctx, state, player.role, player.seat)
      return teamFn(teamAgent, teamCtx)
    }
    return individualFn(getStrategy(player.seat), ctx)
  }

  function runRetar(pctx: PhaseContext<FenrirExtEvent>): void {
    if (adapterConfig.enableRetar === false) return
    if (adapterConfig.retarStartDay && pctx.day < adapterConfig.retarStartDay) return
    const t0 = performance.now()
    const state = pctx.state as GameState
    const events = [...pctx.events] as GameEvent[]
    const lupaConfig = {
      roles: adapterConfig.roles,
      rules: adapterConfig.rules,
    } as any
    const ppResult = retarAnalyzePerPlayer(events, state, lupaConfig, alivePlayers(state))
    retarPossibilities = ppResult.global.possibilities
    maxSurvivingNV = ppResult.global.maxSurvivingNV
    perPlayerRetar = ppResult.perPlayer
    globalRetarPossibilities = ppResult.global.possibilities
    lastRetarArtifacts = ppResult.vs && ppResult.setup
      ? { vs: ppResult.vs, setup: ppResult.setup, options: ppResult.analyzeOptions }
      : null
    retarAccMs += performance.now() - t0
    retarCallCount++
  }

  function runTsumiSearch(): void {
    tsumiTarget = null
    if (!adapterConfig.enableTsumi || !lastRetarArtifacts || !retarPossibilities) return
    const conclusions = retarResultToPossibilities(
      { possibilities: retarPossibilities, maxSurvivingNV: maxSurvivingNV ?? 0 },
      lastRetarArtifacts.setup,
    )
    try {
      const result = searchTsumi(
        lastRetarArtifacts.vs, lastRetarArtifacts.setup, lastRetarArtifacts.options,
        lupaRunRetar, conclusions,
      )
      if (result.isTsumi) {
        const sr = searchTsumiStrategy(result, { maxDepth: 4 })
        if (sr.strategy?.type === 'action') {
          tsumiTarget = sr.strategy.action.execute
        }
      }
    } catch { /* skip */ }
  }

  return {
    onSetup(roles) {
      adapterConfig.onRolesAssigned?.(roles)
    },

    onNight(pctx) {
      const state = pctx.state as GameState
      const actions = new Map<number, NightAction>()

      // 狼チーム夜行動
      if (adapterConfig.wolfTeamAgent) {
        const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
        if (aliveWolves.length > 0) {
          const leader = aliveWolves[0]
          const view = buildPlayerView(state, leader.seat)
          const ctx = buildCtx(pctx, leader, view)
          const teamCtx = buildTeamCtx(ctx, state, 'werewolf')
          const wolfAction = adapterConfig.wolfTeamAgent.decideNightAction(teamCtx) as WolfNightAction

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
        const ctx = buildCtx(pctx, player, view)
        actions.set(player.seat, getStrategy(player.seat).decideNightAction(ctx))
      }

      return actions
    },

    onDayClaims(pctx) {
      // Pre-CO Retar
      runRetar(pctx)

      const state = pctx.state as GameState
      const claims = new Map<number, DayClaim>()

      for (const player of alivePlayers(state)) {
        claims.set(player.seat, decideForPlayer(pctx, player,
          (s, c) => s.decideDayClaim(c),
          (s, c) => s.decideDayClaim(c),
        ))
      }

      return claims
    },

    onPreVote(pctx) {
      const state = pctx.state as GameState
      const additionalClaims = new Map<number, DayClaim>()
      const preVoteEvents: (GameEvent | FenrirExtEvent)[] = []

      // Post-CO Retar + 詰み探索
      runRetar(pctx)
      runTsumiSearch()
      tsumiCache.set(pctx.day, tsumiTarget !== null)

      // シグナルラウンド (3R)
      daySignals = []
      signalIdCounter = signals.length
      dayProposals = []
      ;(state as GameState).commander = null

      for (let round = 0; round < 3; round++) {
        for (const player of alivePlayers(state)) {
          const commAction = decideForPlayer(pctx, player,
            (s, c) => s.decideCommunication(c),
            (s, c) => s.decideCommunication(c),
          )
          // シグナル記録
          const record: SignalRecord = { id: signalIdCounter, sender: player.seat, day: pctx.day, signal: commAction.signal }
          daySignals.push(record)
          signals.push(record)
          if (commAction.signal.type !== 'no_signal') {
            preVoteEvents.push({ type: 'signal', actor: player.seat, signal: commAction.signal })
          }
          signalIdCounter++

          // 処刑提案イベント
          if (commAction.proposals.length > 0) {
            preVoteEvents.push({ type: 'execute_proposals', actor: player.seat, targets: commAction.proposals })
          }
        }
      }

      // 指揮者判定
      ;(state as GameState).commander = detectCommander(state, retarPossibilities, daySignals)
      if (state.commander !== null) {
        preVoteEvents.push({ type: 'commander_appointed', seat: state.commander })

        const commander = state.players.find(p => p.seat === state.commander)!
        if (commander.alive) {
          const proposal = decideForPlayer(pctx, commander,
            (s, c) => s.decideProposal(c),
            (s, c) => s.decideProposal(c),
          )
          if (proposal) {
            dayProposals.push(proposal)
            preVoteEvents.push({ type: 'proposal', actor: commander.seat, proposal })

            // 他プレイヤーの応答
            for (const player of alivePlayers(state)) {
              if (player.seat === state.commander) continue
              const response = decideForPlayer(pctx, player,
                (s, c) => s.decideLeadershipResponse(c, proposal),
                (s, c) => s.decideLeadershipResponse(c, proposal),
              )
              preVoteEvents.push({ type: 'leadership_response', actor: player.seat, response })
            }
          }
        }
      }

      // 予告フェーズ
      for (const player of alivePlayers(state)) {
        const forecast = decideForPlayer(pctx, player,
          (s, c) => s.decideForecast(c),
          (s, c) => s.decideForecast(c),
        )
        if (forecast.type === 'forecast') {
          player.forecastTarget = forecast.target
          preVoteEvents.push({ type: 'forecast', actor: player.seat, target: forecast.target })
        }
      }

      // 防御COフェーズ（当日のシグナル・提案を含めたコンテキストで判定）
      for (const player of alivePlayers(state)) {
        if (player.claimedRole !== null) continue
        const claim = decideForPlayer(pctx, player,
          (s, c) => s.decideDefensiveClaim({ ...c, publicEvents: [...c.publicEvents, ...preVoteEvents] }),
          (s, c) => s.decideDefensiveClaim({ ...c, publicEvents: [...c.publicEvents, ...preVoteEvents] }),
        )
        if (claim.type !== 'none') {
          additionalClaims.set(player.seat, claim)
        }
      }

      return {
        additionalClaims: additionalClaims.size > 0 ? additionalClaims : undefined,
        events: preVoteEvents.length > 0 ? preVoteEvents : undefined,
      }
    },

    onVote(vctx) {
      const state = vctx.state as GameState
      const votes = new Map<number, number>()

      for (const player of alivePlayers(state)) {
        const view = buildPlayerView(state, player.seat)
        const ctx = buildCtx(vctx as PhaseContext, player, view, {
          revoteRound: vctx.revoteRound,
          revoteCandidates: vctx.candidates,
        })

        const teamAgent = player.role === 'werewolf' ? adapterConfig.wolfTeamAgent
          : player.role === 'mason' ? adapterConfig.masonTeamAgent
          : null

        if (teamAgent) {
          const teamCtx = buildTeamCtx(ctx, state, player.role, player.seat)
          votes.set(player.seat, teamAgent.decideVote(teamCtx))
        } else {
          votes.set(player.seat, getStrategy(player.seat).decideVote(ctx))
        }
      }

      return votes
    },

    onLastWill(_ctx, executedSeat) {
      const state = _ctx.state as GameState
      const player = state.players.find(p => p.seat === executedSeat)!
      if (player.claimedRole !== null) return { type: 'none' as const }
      if (!isVillagePowerRole(player.role)) return { type: 'none' as const }
      return forceTrueRoleCO(state, player, _ctx.day, state.executionHistory.get(_ctx.day - 1) ?? null)
    },

    getTiming(): GameTiming {
      return { retarMs: retarAccMs, retarCount: retarCallCount }
    },

    getTsumiCache(): Map<number, boolean> {
      return tsumiCache
    },
  }
}
