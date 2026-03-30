/**
 * Strategy Adapter — 既存Strategy/TeamStrategyをGameHandlersに変換
 *
 * 全フェーズ対応: シグナル3R、指揮者選出、予告、防御CO。
 * Retar統合はオプション。旧エンジンとの互換性を保つ。
 */

import type { SystemRole, ResolvedRules } from '../../types/index.ts'
import type { GameState, GameEvent, NightAction, DayClaim, PlayerState } from '../types.ts'
import type {
  DecisionContext, TeamDecisionContext,
  Strategy, TeamStrategy, WolfNightAction,
} from '../strategy.ts'
import type { SignalRecord } from '../communication.ts'
import type { Proposal } from '../leadership.ts'
import type { GameHandlers, PhaseContext, PlayerView, GameTiming } from '../handlers.ts'
import { buildPlayerView } from '../player-view.ts'
import { alivePlayers } from '../roles.ts'
import { detectCommander } from '../leadership.ts'
import { Rng } from '../random.ts'
import {
  analyzeFromEvents as retarAnalyze,
  analyzePerPlayer as retarAnalyzePerPlayer,
  type RetarResult,
} from '../retar-bridge.ts'

export type StrategyAdapterConfig = {
  strategies?: Map<number, Strategy>
  defaultStrategy: Strategy
  wolfTeamStrategy?: TeamStrategy
  masonTeamStrategy?: TeamStrategy
  enableRetar?: boolean
  /** 役職割当後にstrategy差し替え用コールバック */
  onRolesAssigned?: (seatRoles: Map<number, SystemRole>) => void
  seed?: number
  roles: Map<SystemRole, number>
  rules?: Partial<ResolvedRules>
}

export function strategyAdapter(adapterConfig: StrategyAdapterConfig): GameHandlers {
  const rng = new Rng(adapterConfig.seed)
  let retarPossibilities: Map<number, Set<SystemRole>> | null = null
  let maxSurvivingNV: number | null = null
  let globalRetarPossibilities: Map<number, Set<SystemRole>> | null = null
  let perPlayerRetar: Map<number, RetarResult> | null = null
  let signals: SignalRecord[] = []
  let daySignals: SignalRecord[] = []
  let dayProposals: Proposal[] = []
  let signalIdCounter = 0
  let lastExecutedSeat: number | null = null
  let retarAccMs = 0

  function getStrategy(seat: number): Strategy {
    return adapterConfig.strategies?.get(seat) ?? adapterConfig.defaultStrategy
  }

  function buildCtx(
    pctx: PhaseContext, player: PlayerState, view: PlayerView,
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
      lastExecutedSeat,
      retarPossibilities: playerRetar,
      maxSurvivingNV: playerMaxNV,
      globalRetarPossibilities,
      fakeRetarPossibilities: globalRetarPossibilities,
      wolfTeammates: view.wolfTeammates,
      knownWolves: view.knownWolves,
      knownHamster: view.knownHamster,
      masonPartner: view.masonPartner,
      revoteRound: null,
      revoteCandidates: null,
      executionPlans: [],
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
    pctx: PhaseContext, player: PlayerState,
    individualFn: (s: Strategy, c: DecisionContext) => T,
    teamFn: (s: TeamStrategy, c: TeamDecisionContext) => T,
  ): T {
    const state = pctx.state as GameState
    const view = buildPlayerView(state, player.seat)
    const ctx = buildCtx(pctx, player, view)

    const teamStrategy = player.role === 'werewolf' ? adapterConfig.wolfTeamStrategy
      : player.role === 'mason' ? adapterConfig.masonTeamStrategy
      : null

    if (teamStrategy) {
      const teamCtx = buildTeamCtx(ctx, state, player.role, player.seat)
      return teamFn(teamStrategy, teamCtx)
    }
    return individualFn(getStrategy(player.seat), ctx)
  }

  function runRetar(pctx: PhaseContext): void {
    if (adapterConfig.enableRetar === false) return
    const t0 = performance.now()
    const state = pctx.state as GameState
    const events = [...pctx.events] as GameEvent[]
    const lupaConfig = {
      roles: adapterConfig.roles,
      rules: adapterConfig.rules,
    } as any
    const r = retarAnalyze(events, state, lupaConfig)
    retarPossibilities = r.possibilities
    maxSurvivingNV = r.maxSurvivingNV
    const ppResult = retarAnalyzePerPlayer(events, state, lupaConfig, alivePlayers(state))
    perPlayerRetar = ppResult.perPlayer
    globalRetarPossibilities = ppResult.global.possibilities
    retarAccMs += performance.now() - t0
  }

  return {
    onSetup(roles) {
      adapterConfig.onRolesAssigned?.(roles)
    },

    onNight(pctx) {
      const state = pctx.state as GameState
      const actions = new Map<number, NightAction>()

      // 狼チーム夜行動
      if (adapterConfig.wolfTeamStrategy) {
        const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
        if (aliveWolves.length > 0) {
          const leader = aliveWolves[0]
          const view = buildPlayerView(state, leader.seat)
          const ctx = buildCtx(pctx, leader, view)
          const teamCtx = buildTeamCtx(ctx, state, 'werewolf')
          const wolfAction = adapterConfig.wolfTeamStrategy.decideNightAction(teamCtx) as WolfNightAction

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
      const preVoteEvents: GameEvent[] = []

      // Post-CO Retar
      runRetar(pctx)

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

      // 防御COフェーズ
      for (const player of alivePlayers(state)) {
        if (player.claimedRole !== null) continue
        const claim = decideForPlayer(pctx, player,
          (s, c) => s.decideDefensiveClaim(c),
          (s, c) => s.decideDefensiveClaim(c),
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

        const teamStrategy = player.role === 'werewolf' ? adapterConfig.wolfTeamStrategy
          : player.role === 'mason' ? adapterConfig.masonTeamStrategy
          : null

        if (teamStrategy) {
          const teamCtx = buildTeamCtx(ctx, state, player.role, player.seat)
          votes.set(player.seat, teamStrategy.decideVote(teamCtx))
        } else {
          votes.set(player.seat, getStrategy(player.seat).decideVote(ctx))
        }
      }

      return votes
    },

    getTiming(): GameTiming {
      return { retarMs: retarAccMs }
    },
  }
}
