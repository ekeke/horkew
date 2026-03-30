/**
 * Minimal Adapter — strategyOnly訓練用
 *
 * onNight + onDayClaims + onVote のみ実装。
 * onPreVote なし → シグナル/指揮者/予告/防御CO全スキップ。
 * Retar計算もなし。最速のゲーム実行。
 */

import type { SystemRole } from '../../types/index.ts'
import type { GameState, NightAction, DayClaim, PlayerState } from '../types.ts'
import type { DecisionContext, TeamDecisionContext, Strategy, TeamStrategy, WolfNightAction } from '../strategy.ts'
import type { GameHandlers, PhaseContext, PlayerView } from '../handlers.ts'
import { buildPlayerView } from '../player-view.ts'
import { alivePlayers } from '../roles.ts'
import { Rng } from '../random.ts'

export type MinimalAdapterConfig = {
  strategies: Map<number, Strategy>
  defaultStrategy?: Strategy
  wolfTeamStrategy?: TeamStrategy
  masonTeamStrategy?: TeamStrategy
  /** 役職割当後にstrategy差し替え用コールバック */
  onRolesAssigned?: (seatRoles: Map<number, SystemRole>) => void
  seed?: number
}

export function minimalAdapter(config: MinimalAdapterConfig): GameHandlers {
  const rng = new Rng(config.seed)

  function getStrategy(seat: number): Strategy {
    return config.strategies.get(seat) ?? config.defaultStrategy!
  }

  function buildCtx(
    pctx: PhaseContext, player: PlayerState, view: PlayerView,
    extra?: Partial<DecisionContext>,
  ): DecisionContext {
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
      retarPossibilities: null,
      maxSurvivingNV: null,
      globalRetarPossibilities: null,
      fakeRetarPossibilities: null,
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
  }
}
