/**
 * Agent Adapter — Agent/TeamAgent を GameHandlers に変換
 *
 * ランダム/ヒューリスティック agent をプラグインして
 * lupa engine を回すための小さな adapter.
 */

import type { SystemRole, Regulation } from '../types/index.ts'
import type { GameState, NightAction, DayClaim, PlayerState } from '../lupa/types.ts'
import type { GameHandlers, PhaseContext, PlayerView } from '../lupa/handlers.ts'
import { buildPlayerView } from '../lupa/player-view.ts'
import { alivePlayers } from '../lupa/roles.ts'
import { Rng } from '../lupa/random.ts'

/** 個人エージェントが受け取る意思決定コンテキスト */
export type DecisionContext = {
  mySeat: number
  myRole: SystemRole
  myPlayer: PlayerState
  day: number
  phase: 'night' | 'day'
  alivePlayers: number[]
  publicEvents: readonly unknown[]
  rng: Rng
  gameState: GameState
  lastExecutedSeat: number | null
  wolfTeammates: number[] | null
  knownWolves: number[] | null
  knownHamster: number | null
  masonPartner: number | null
  revoteRound: number | null
  revoteCandidates: number[] | null
  rules: Regulation
}

/** チーム意思決定コンテキスト */
export type TeamDecisionContext = DecisionContext & {
  teamSeats: number[]
  teamPlayers: PlayerState[]
  currentActorSeat?: number
}

/** 狼チーム夜行動 (target=襲撃先、 attacker=猫又道連れリスクを負う個体) */
export type WolfNightAction = {
  target: number
  attacker: number
}

/** 個人エージェント interface */
export type Agent = {
  decideNightAction(ctx: DecisionContext): NightAction
  decideDayClaim(ctx: DecisionContext): DayClaim
  decideVote(ctx: DecisionContext): number
}

/** チームエージェント interface */
export type TeamAgent = {
  decideNightAction(ctx: TeamDecisionContext): WolfNightAction | NightAction
  decideDayClaim(ctx: TeamDecisionContext): DayClaim
  decideVote(ctx: TeamDecisionContext): number
}

export type AgentAdapterConfig = {
  agents?: Map<number, Agent>
  defaultAgent: Agent
  wolfTeamAgent?: TeamAgent
  masonTeamAgent?: TeamAgent
  onRolesAssigned?: (seatRoles: Map<number, SystemRole>) => void
  seed?: number
  roles: Map<SystemRole, number>
}

export function agentAdapter(adapterConfig: AgentAdapterConfig): GameHandlers {
  const rng = new Rng(adapterConfig.seed)

  function getAgent(seat: number): Agent {
    return adapterConfig.agents?.get(seat) ?? adapterConfig.defaultAgent
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
      rng,
      gameState: pctx.state as GameState,
      lastExecutedSeat: pctx.state.executionHistory.get(pctx.day - 1) ?? null,
      wolfTeammates: view.wolfTeammates,
      knownWolves: view.knownWolves,
      knownHamster: view.knownHamster,
      masonPartner: view.masonPartner,
      revoteRound: null,
      revoteCandidates: null,
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
      adapterConfig.onRolesAssigned?.(roles)
    },

    onNight(pctx) {
      const state = pctx.state as GameState
      const actions = new Map<number, NightAction>()

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

      for (const player of alivePlayers(state)) {
        if (actions.has(player.seat)) continue
        const view = buildPlayerView(state, player.seat)
        const ctx = buildCtx(pctx, player, view)
        actions.set(player.seat, getAgent(player.seat).decideNightAction(ctx))
      }

      return actions
    },

    onDayClaims(pctx) {
      const state = pctx.state as GameState
      const claims = new Map<number, DayClaim>()

      for (const player of alivePlayers(state)) {
        const view = buildPlayerView(state, player.seat)
        const ctx = buildCtx(pctx, player, view)
        const teamAgent = player.role === 'werewolf' ? adapterConfig.wolfTeamAgent
          : player.role === 'mason' ? adapterConfig.masonTeamAgent
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
          votes.set(player.seat, getAgent(player.seat).decideVote(ctx))
        }
      }

      return votes
    },
  }
}
