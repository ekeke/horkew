/**
 * Minimal Adapter — strategyOnly訓練用
 *
 * onNight + onDayClaims + onVote のみ実装。
 * onPreVote なし → シグナル/指揮者/予告/防御CO全スキップ。
 * Retar計算はオプション（enableRetar時のみ）。
 */

import type { SystemRole, ResolvedRules } from '../../types/index.ts'
import type { GameState, GameEvent, NightAction, DayClaim, PlayerState } from '../types.ts'
import type { DecisionContext, TeamDecisionContext, Strategy, TeamStrategy, WolfNightAction } from '../strategy.ts'
import type { GameHandlers, PhaseContext, PlayerView, GameTiming } from '../handlers.ts'
import { buildPlayerView } from '../player-view.ts'
import { alivePlayers } from '../roles.ts'
import { Rng } from '../random.ts'
import {
  analyzeFromEvents as retarAnalyze,
  analyzePerPlayer as retarAnalyzePerPlayer,
  type RetarResult,
} from '../retar-bridge.ts'

export type MinimalAdapterConfig = {
  strategies: Map<number, Strategy>
  defaultStrategy?: Strategy
  wolfTeamStrategy?: TeamStrategy
  masonTeamStrategy?: TeamStrategy
  /** 役職割当後にstrategy差し替え用コールバック */
  onRolesAssigned?: (seatRoles: Map<number, SystemRole>) => void
  seed?: number
  /** Retar有効化（デフォルト: false） */
  enableRetar?: boolean
  /** enableRetar時に必要 */
  roles?: Map<SystemRole, number>
  /** enableRetar時に必要 */
  rules?: Partial<ResolvedRules>
}

export function minimalAdapter(config: MinimalAdapterConfig): GameHandlers {
  const rng = new Rng(config.seed)

  // Retar state
  let retarPossibilities: Map<number, Set<SystemRole>> | null = null
  let maxSurvivingNV: number | null = null
  let globalRetarPossibilities: Map<number, Set<SystemRole>> | null = null
  let perPlayerRetar: Map<number, RetarResult> | null = null
  let retarAccMs = 0

  function getStrategy(seat: number): Strategy {
    return config.strategies.get(seat) ?? config.defaultStrategy!
  }

  function runRetar(pctx: PhaseContext): void {
    if (!config.enableRetar) return
    const t0 = performance.now()
    const state = pctx.state as GameState
    const events = [...pctx.events] as GameEvent[]
    const lupaConfig = { roles: config.roles, rules: config.rules } as any
    const r = retarAnalyze(events, state, lupaConfig)
    retarPossibilities = r.possibilities
    maxSurvivingNV = r.maxSurvivingNV
    const ppResult = retarAnalyzePerPlayer(events, state, lupaConfig, alivePlayers(state))
    perPlayerRetar = ppResult.perPlayer
    globalRetarPossibilities = ppResult.global.possibilities
    retarAccMs += performance.now() - t0
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
      signals: [],
      commander: null,
      proposals: [],
      rng,
      gameState: pctx.state as GameState,
      lastExecutedSeat: null,
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

  return {
    onSetup(roles) {
      config.onRolesAssigned?.(roles)
    },

    onNight(pctx) {
      const state = pctx.state as GameState
      const actions = new Map<number, NightAction>()

      // 狼チーム夜行動
      if (config.wolfTeamStrategy) {
        const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
        if (aliveWolves.length > 0) {
          const leader = aliveWolves[0]
          const view = buildPlayerView(state, leader.seat)
          const ctx = buildCtx(pctx, leader, view)
          const teamCtx = buildTeamCtx(ctx, state, 'werewolf')
          const wolfAction = config.wolfTeamStrategy.decideNightAction(teamCtx) as WolfNightAction

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
        if (actions.has(player.seat)) continue  // 狼チームで処理済み
        const view = buildPlayerView(state, player.seat)
        const ctx = buildCtx(pctx, player, view)
        actions.set(player.seat, getStrategy(player.seat).decideNightAction(ctx))
      }

      return actions
    },

    onDayClaims(pctx) {
      runRetar(pctx)
      const state = pctx.state as GameState
      const claims = new Map<number, DayClaim>()

      for (const player of alivePlayers(state)) {
        const view = buildPlayerView(state, player.seat)
        const ctx = buildCtx(pctx, player, view)

        // チーム戦略があればそちらを使う
        const teamStrategy = player.role === 'werewolf' ? config.wolfTeamStrategy
          : player.role === 'mason' ? config.masonTeamStrategy
          : null

        if (teamStrategy) {
          const teamCtx = buildTeamCtx(ctx, state, player.role, player.seat)
          claims.set(player.seat, teamStrategy.decideDayClaim(teamCtx))
        } else {
          claims.set(player.seat, getStrategy(player.seat).decideDayClaim(ctx))
        }
      }

      return claims
    },

    // onPreVote なし → 議論フェーズ全スキップ

    onVote(vctx) {
      runRetar(vctx)
      const state = vctx.state as GameState
      const votes = new Map<number, number>()

      for (const player of alivePlayers(state)) {
        const view = buildPlayerView(state, player.seat)
        const ctx = buildCtx(vctx as PhaseContext, player, view, {
          revoteRound: vctx.revoteRound,
          revoteCandidates: vctx.candidates,
        })

        const teamStrategy = player.role === 'werewolf' ? config.wolfTeamStrategy
          : player.role === 'mason' ? config.masonTeamStrategy
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
