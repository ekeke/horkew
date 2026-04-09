/**
 * BrainBattleAdapter — 共有ブレイン vs 狼ブレインの対戦訓練用アダプタ
 *
 * 通常の人狼ゲームから個人の投票を排除し、2つのブレインが
 * 交互に処刑先を決定する。
 *
 * - 共有ブレイン: 既存 MasonCollective (plan token)
 * - 狼ブレイン: WolfBrainAgent (formation + vote + attack)
 * - ターン交代: 日ごとに mason/wolf が交代（先手はランダム）
 * - CO: 狼ブレインの formation に基づく。非狼はヒューリスティック
 * - 夜: 狼ブレインが襲撃。占い/狩人はヒューリスティック
 */

import type { SystemRole } from '../../../types/index.ts'
import type { GameState, NightAction, DayClaim, PlayerState } from '../../../lupa/types.ts'
import type { PhaseContext, VoteContext } from '../../../lupa/handlers.ts'
import type { TeamDecisionContext } from '../agents/agent.ts'
import type { FenrirExt } from '../ext.ts'
import type { FenrirExtEvent } from '../events.ts'
import type { StrategyBaseAdapterConfig } from './adapter-types.ts'
import type { WolfBrainAgent, WolfFormation } from '../agents/wolf-brain.ts'
import type { MasonCollective } from '../agents/mason-collective.ts'
import type { GameEvent } from '../../../lupa/types.ts'
import { StrategyBaseAdapter } from './strategy-base-adapter.ts'
import { buildPlayerView } from '../../../lupa/player-view.ts'
import { alivePlayers } from '../../../lupa/roles.ts'
import { planToVote } from '../plan/plan-helpers.ts'
import { parseDualPlanSlots, describePlanIndices } from '../plan/plan-vocab.ts'

// ============================================================
// Config
// ============================================================

export type BrainBattleAdapterConfig = StrategyBaseAdapterConfig & {
  wolfBrain: WolfBrainAgent
  masonBrain: MasonCollective
  /** ターン固定: 'mason_only' or 'wolf_only' で常に一方のターン。省略時は交互 */
  fixedTurnOwner?: 'mason' | 'wolf'
}

// ============================================================
// Adapter
// ============================================================

export class BrainBattleAdapter extends StrategyBaseAdapter {
  private readonly wolfBrain: WolfBrainAgent
  private readonly masonBrain: MasonCollective
  private readonly fixedTurnOwner: 'mason' | 'wolf' | undefined
  private turnOwner: 'mason' | 'wolf'
  private masonPrimarySeat = 0
  private wolfSeats: number[] = []
  private cachedFormation: WolfFormation | null = null

  constructor(config: BrainBattleAdapterConfig) {
    super(config)
    this.wolfBrain = config.wolfBrain
    this.masonBrain = config.masonBrain
    this.fixedTurnOwner = config.fixedTurnOwner
    // Initial turn (will be re-rolled each day in onDayClaims)
    this.turnOwner = config.fixedTurnOwner ?? (this.rng.next() < 0.75 ? 'mason' : 'wolf')
  }

  /** コメントイベントを events に追加 */
  private emitComment(pctx: PhaseContext<FenrirExtEvent, FenrirExt>, text: string): void {
    const events = pctx.events as (GameEvent | FenrirExtEvent)[]
    events.push({ type: 'comment', text })
  }

  override onSetup(
    roles: Map<number, SystemRole>,
    state: GameState<FenrirExt>,
  ): void {
    super.onSetup(roles, state)

    // Track mason and wolf seats
    for (const [seat, role] of roles) {
      if (role === 'mason' && this.masonPrimarySeat === 0) {
        this.masonPrimarySeat = seat
      }
      if (role === 'werewolf') {
        this.wolfSeats.push(seat)
      }
    }
  }

  // ============================================================
  // CO Phase: wolf formation → DayClaims
  // ============================================================

  override onDayClaims(pctx: PhaseContext<FenrirExtEvent, FenrirExt>): Map<number, DayClaim> {
    const state = pctx.state as GameState<FenrirExt>
    const ext = state.ext
    this.runRetar(pctx, ext)
    const claims = new Map<number, DayClaim>()

    // Roll turn for this day (75% mason, 25% wolf) — skip if fixed
    if (!this.fixedTurnOwner) {
      this.turnOwner = this.rng.next() < 0.75 ? 'mason' : 'wolf'
    }

    // Emit turn info
    this.emitComment(pctx, `[BB] Day ${pctx.day}: ${this.turnOwner} turn`)

    // Wolf brain: get formation for this day
    const wolfCtx = this.buildWolfBrainCtx(pctx, state, ext)
    if (wolfCtx) {
      this.cachedFormation = this.wolfBrain.getFormation(wolfCtx)
      // Emit formation details
      for (const w of this.cachedFormation.wolves) {
        const detail = w.claimRole === 'lurk' || w.claimRole === 'villager_co'
          ? w.claimRole
          : `${w.claimRole} → seat${w.fakeTarget}${w.claimRole === 'seer' || w.claimRole === 'medium' ? ` ${w.fakeResult}` : ''}`
        this.emitComment(pctx, `[BB] wolf seat${w.wolfSeat} (slot${w.wolfSlot}): ${detail}`)
      }
    }

    const wolfSeatSet = new Set(this.wolfSeats)

    for (const player of alivePlayers(state)) {
      if (wolfSeatSet.has(player.seat) && this.cachedFormation) {
        // Wolf player: use formation
        const entry = this.cachedFormation.wolves.find(w => w.wolfSeat === player.seat)
        if (entry) {
          claims.set(player.seat, this.formationToClaim(entry, player, pctx.day))
        } else {
          claims.set(player.seat, { type: 'none' })
        }
      } else {
        // Non-wolf: heuristic
        const view = buildPlayerView(state, player.seat)
        const ctx = this.buildCtx(pctx, player, view, ext)
        claims.set(player.seat, this.getAgent(player.seat).decideDayClaim(ctx))
      }
    }

    return claims
  }

  // ============================================================
  // Vote Phase: brain-controlled execution
  // ============================================================

  override onVote(vctx: VoteContext<FenrirExtEvent, FenrirExt>): Map<number, number> {
    const state = vctx.state as GameState<FenrirExt>
    const ext = state.ext
    const pctx = vctx as PhaseContext<FenrirExtEvent, FenrirExt>

    // Run Retar (needed for mason brain's observation)
    this.runRetar(pctx, ext)

    // Determine execution target based on whose turn it is
    let target: number | null = null

    if (this.turnOwner === 'mason') {
      target = this.getMasonTarget(pctx, state, ext)
      this.emitComment(pctx, `[BB] mason brain → execute seat${target ?? '?'}`)
    } else {
      target = this.getWolfTarget(pctx, state, ext)
      this.emitComment(pctx, `[BB] wolf brain → execute seat${target ?? '?'}`)
    }

    // Fallback: if no valid target, pick first alive non-self
    const alive = vctx.alivePlayers
    if (target == null || !alive.includes(target)) {
      this.emitComment(pctx, `[BB] fallback: target seat${target} invalid, using seat${alive[0]}`)
      target = alive[0]
    }

    // Unanimous vote: all alive players vote for the target
    const votes = new Map<number, number>()
    for (const seat of alive) {
      // Avoid self-vote (engine would override to random)
      if (seat === target && alive.length > 1) {
        votes.set(seat, alive.find(s => s !== seat)!)
      } else {
        votes.set(seat, target)
      }
    }

    return votes
  }

  // ============================================================
  // Night Phase: wolf brain attack
  // ============================================================

  override onNight(pctx: PhaseContext<FenrirExtEvent, FenrirExt>): Map<number, NightAction> {
    const state = pctx.state as GameState<FenrirExt>
    const ext = state.ext
    const actions = new Map<number, NightAction>()

    // Wolf brain attack
    const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
    if (aliveWolves.length > 0) {
      const wolfCtx = this.buildWolfBrainCtx(pctx, state, ext)
      if (wolfCtx) {
        const wolfAction = this.wolfBrain.decideNightAction(wolfCtx)
        this.emitComment(pctx, `[BB] wolf attack: seat${wolfAction.attacker} → seat${wolfAction.target}`)
        for (const wolf of aliveWolves) {
          if (wolf.seat === wolfAction.attacker) {
            actions.set(wolf.seat, { type: 'attack', target: wolfAction.target })
          } else {
            actions.set(wolf.seat, { type: 'none' })
          }
        }
      }
    }

    // Non-wolf night actions: heuristic
    for (const player of alivePlayers(state)) {
      if (actions.has(player.seat)) continue
      const view = buildPlayerView(state, player.seat)
      const ctx = this.buildCtx(pctx, player, view, ext)
      actions.set(player.seat, this.getAgent(player.seat).decideNightAction(ctx))
    }

    return actions
  }

  // ============================================================
  // Internal: brain-specific target resolution
  // ============================================================

  private getMasonTarget(
    pctx: PhaseContext<FenrirExtEvent, FenrirExt>,
    state: Readonly<GameState<FenrirExt>>,
    ext: FenrirExt,
  ): number | null {
    // Build mason TeamDecisionContext (even if mason is dead)
    const masonPlayer = state.players.find(p => p.seat === this.masonPrimarySeat)
    if (!masonPlayer) return null

    const view = buildPlayerView(state, this.masonPrimarySeat)
    const ctx = this.buildCtx(pctx, masonPlayer, view, ext)

    // Build team ctx — include dead masons for brain continuity
    const allMasons = state.players.filter(p => p.role === 'mason')
    const teamCtx: TeamDecisionContext = {
      ...ctx,
      teamSeats: allMasons.map(p => p.seat),
      teamPlayers: allMasons,
    }

    // Mason brain generates plan via getOrInfer → plan tokens
    const result = this.masonBrain.getOrInfer(teamCtx)
    if (!result.planActions || result.planActions.length === 0) {
      this.emitComment(pctx, `[BB] mason plan: (empty)`)
      return null
    }

    // Emit plan details
    const masonAlive = allMasons.some(p => p.alive)
    this.emitComment(pctx, `[BB] mason plan: ${describePlanIndices(result.planActions)}${masonAlive ? '' : ' (mason dead, ghost inference)'}`)

    // Resolve plan[0] to a target seat
    const { forwardSlots } = parseDualPlanSlots(result.planActions)
    if (forwardSlots.length === 0) return null

    // Use planToVote for resolution
    return planToVote(result.planActions, ctx)
  }

  private getWolfTarget(
    pctx: PhaseContext<FenrirExtEvent, FenrirExt>,
    state: Readonly<GameState<FenrirExt>>,
    ext: FenrirExt,
  ): number | null {
    const wolfCtx = this.buildWolfBrainCtx(pctx, state, ext)
    if (!wolfCtx) return null
    return this.wolfBrain.decideExecution(wolfCtx)
  }

  // ============================================================
  // Internal: context building
  // ============================================================

  private buildWolfBrainCtx(
    pctx: PhaseContext<FenrirExtEvent, FenrirExt>,
    state: Readonly<GameState<FenrirExt>>,
    ext: FenrirExt,
  ): TeamDecisionContext | null {
    // Use first alive wolf as the perspective player
    const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
    if (aliveWolves.length === 0) return null

    const leader = aliveWolves[0]
    const view = buildPlayerView(state, leader.seat)
    const ctx = this.buildCtx(pctx, leader, view, ext)

    // All wolves (alive) for team context
    return {
      ...ctx,
      teamSeats: aliveWolves.map(p => p.seat),
      teamPlayers: aliveWolves,
    }
  }

  // ============================================================
  // Internal: formation → DayClaim conversion
  // ============================================================

  private formationToClaim(
    entry: WolfFormation['wolves'][0],
    player: PlayerState,
    day: number,
  ): DayClaim {
    const role = entry.claimRole

    // Check if wolf already has an active CO from a previous day
    const alreadyClaimed = player.claimedRole != null

    switch (role) {
      case 'seer': {
        if (!alreadyClaimed) {
          // First day claiming seer: CO with all accumulated fake results
          this.setFakeResult(player, day, entry.fakeTarget, entry.fakeResult)
          const results = [...player.fakeDivineHistory.values()].map(r => ({
            target: r.target,
            result: r.result,
          }))
          return { type: 'seer_co', results }
        }
        // Already claimed seer: report today's result
        this.setFakeResult(player, day, entry.fakeTarget, entry.fakeResult)
        const latest = player.fakeDivineHistory.get(day - 1) ?? player.fakeDivineHistory.get(day)
        if (latest) {
          return { type: 'seer_result', target: latest.target, result: latest.result }
        }
        return { type: 'none' }
      }

      case 'medium': {
        if (!alreadyClaimed) {
          return { type: 'medium_co' }
        }
        // Report fake medium result (white/black based on brain output)
        return { type: 'medium_result', result: entry.fakeResult === 'wolf' ? 'wolf' : 'human' }
      }

      case 'bodyguard':
        if (!alreadyClaimed) return { type: 'bodyguard_co', targets: [] }
        return { type: 'none' }

      case 'nekomata':
        if (!alreadyClaimed) return { type: 'nekomata_co' }
        return { type: 'none' }

      case 'lurk':
      case 'villager_co':
      default:
        return { type: 'none' }
    }
  }

  private setFakeResult(
    player: PlayerState,
    day: number,
    target: number,
    result: 'human' | 'wolf',
  ): void {
    // Store in fakeDivineHistory for night before current day
    const night = day - 1
    if (night >= 0 && !player.fakeDivineHistory.has(night)) {
      player.fakeDivineHistory.set(night, { target, result })
    }
  }
}
