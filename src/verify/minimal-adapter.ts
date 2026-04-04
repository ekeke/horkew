/**
 * Minimal Adapter — agentOnly訓練用
 *
 * onNight + onDayClaims + onVote のみ実装。
 * onPreVote なし → シグナル/指揮者/予告/防御CO全スキップ。
 * Retar計算はオプション（enableRetar時のみ）。
 */

import type { SystemRole, ResolvedRules } from '../types/index.ts'
import type { GameState, GameEvent, NightAction, DayClaim, PlayerState } from '../lupa/types.ts'
import type { DecisionContext, TeamDecisionContext, Agent, TeamAgent, WolfNightAction } from '../fenrir/src/agents/agent.ts'
import type { GameHandlers, PhaseContext, PlayerView, GameTiming } from '../lupa/handlers.ts'
import { buildPlayerView } from '../lupa/player-view.ts'
import { alivePlayers } from '../lupa/roles.ts'
import { Rng } from '../lupa/random.ts'
import {
  analyzePerPlayer as retarAnalyzePerPlayer,
  retarResultToPossibilities,
  lupaRunRetar,
  type RetarResult,
} from '../fenrir/src/retar-bridge.ts'
import { searchTsumi, searchTsumiStrategy } from '../hati/index.ts'

export type MinimalAdapterConfig = {
  agents: Map<number, Agent>
  defaultAgent?: Agent
  wolfTeamAgent?: TeamAgent
  masonTeamAgent?: TeamAgent
  /** 役職割当後にagent差し替え用コールバック */
  onRolesAssigned?: (seatRoles: Map<number, SystemRole>) => void
  seed?: number
  /** Retar有効化（デフォルト: false） */
  enableRetar?: boolean
  /** 詰み探索を有効化（デフォルトfalse） */
  enableTsumi?: boolean
  /** Retarを有効にする開始Day（このDay以降にretarを走らせる、カリキュラム用） */
  retarStartDay?: number
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
  let retarCallCount = 0
  let tsumiTarget: number | null = null
  let lastRetarArtifacts: { vs: any, setup: Map<SystemRole, number>, options: any } | null = null
  const tsumiCache = new Map<number, boolean>()  // day → isTsumi

  function getAgent(seat: number): Agent {
    return config.agents.get(seat) ?? config.defaultAgent!
  }

  function runRetar(pctx: PhaseContext): void {
    if (!config.enableRetar) return
    if (config.retarStartDay && pctx.day < config.retarStartDay) return
    const t0 = performance.now()
    const state = pctx.state as GameState
    const events = [...pctx.events] as GameEvent[]
    const lupaConfig = { roles: config.roles, rules: config.rules } as any
    // analyzePerPlayer 内部でグローバルRetarも走るので単独呼び出し不要
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
    if (!config.enableTsumi || !lastRetarArtifacts || !retarPossibilities) return
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

  return {
    onSetup(roles) {
      config.onRolesAssigned?.(roles)
    },

    onNight(pctx) {
      const state = pctx.state as GameState
      const actions = new Map<number, NightAction>()

      // 狼チーム夜行動
      if (config.wolfTeamAgent) {
        const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
        if (aliveWolves.length > 0) {
          const leader = aliveWolves[0]
          const view = buildPlayerView(state, leader.seat)
          const ctx = buildCtx(pctx, leader, view)
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
        if (actions.has(player.seat)) continue  // 狼チームで処理済み
        const view = buildPlayerView(state, player.seat)
        const ctx = buildCtx(pctx, player, view)
        actions.set(player.seat, getAgent(player.seat).decideNightAction(ctx))
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

        // チームエージェントがあればそちらを使う
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

    // onPreVote なし → 議論フェーズ全スキップ
    // ただし共有者の提案は executionPlans に直接注入

    onVote(vctx) {
      runRetar(vctx)
      runTsumiSearch()
      // 初回投票時のみキャッシュ（再投票は同じ日）
      if (vctx.revoteRound === 0 || vctx.revoteRound == null) {
        tsumiCache.set(vctx.day, tsumiTarget !== null)
      }
      const state = vctx.state as GameState
      const votes = new Map<number, number>()

      // 共有者の提案を executionPlans に注入（指揮者選出をスキップ）
      const executionPlans: import('../fenrir/src/agents/agent.ts').ExecutionPlan[] = []
      const aliveMasons = alivePlayers(state).filter(p => p.role === 'mason')
      if (aliveMasons.length > 0) {
        const mason = aliveMasons[0]
        const masonView = buildPlayerView(state, mason.seat)
        const masonCtx = buildCtx(vctx as PhaseContext, mason, masonView)
        masonCtx.commander = mason.seat  // 提案を出すために指揮者扱い
        const proposal = getAgent(mason.seat).decideProposal(masonCtx)
        if (proposal && proposal.type === 'execute_order') {
          executionPlans.push({ targets: [proposal.target], type: 'designated' })
        }
      }

      for (const player of alivePlayers(state)) {
        const view = buildPlayerView(state, player.seat)
        const ctx = buildCtx(vctx as PhaseContext, player, view, {
          revoteRound: vctx.revoteRound,
          revoteCandidates: vctx.candidates,
          executionPlans,
        })

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

    /** ゲーム中の詰み判定キャッシュ (day → isTsumi) */
    getTsumiCache(): Map<number, boolean> {
      return tsumiCache
    },
  }
}
