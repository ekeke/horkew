/**
 * SkollWolfTeamAgent — Skoll 勝率分析で噛み先を決定する狼チームエージェント
 *
 * WolfTeamRuleAgent を継承し、decideNightAction の噛み先選択のみ
 * Skoll 分析（analyzeAttacksByWorld）に差し替える。
 * 噛んだ狼（attacker）の選択はベースクラスのヒューリスティックを流用する。
 * Retar が有効 (enableRetar: true) な環境で機能する。
 */

import type { TeamDecisionContext, WolfNightAction } from '../fenrir/src/agents/agent.ts'
import type { VillageStatus } from '../types/index.ts'
import { WolfTeamRuleAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import { Possibilities, possibilityFromRoles, RoleBitIndex } from '../retar/possibilities.ts'
import { analyzeAttacksByWorld } from './wolf-attack-analysis.ts'

export class SkollWolfTeamAgent extends WolfTeamRuleAgent {
  override decideNightAction(ctx: TeamDecisionContext): WolfNightAction {
    const target = this.skollAttackTarget(ctx)
    if (target == null) return super.decideNightAction(ctx)

    const aliveWolves = ctx.teamPlayers.filter(p => p.alive)
    if (aliveWolves.length === 0) return { target, attacker: ctx.teamSeats[0] }

    // 噛んだ狼（attacker）: 占い騙り狼を噛み役に使わない（道連れで騙りが崩れる）
    const fakeSeer = aliveWolves.find(p => p.claimedRole === 'seer')
    const nonFakeSeer = aliveWolves.filter(p => p.claimedRole !== 'seer')
    const attacker = (fakeSeer && nonFakeSeer.length > 0)
      ? ctx.rng.pick(nonFakeSeer).seat
      : ctx.rng.pick(aliveWolves).seat

    return { target, attacker }
  }

  private skollAttackTarget(ctx: TeamDecisionContext): number | null {
    const artifacts = (ctx.gameState.ext as any)?.retarCache?.lastArtifacts as
      | { vs: VillageStatus; setup: Map<string, number> }
      | null
      | undefined
    const globalPoss = ctx.globalRetarPossibilities

    if (!artifacts?.vs || !artifacts?.setup || !globalPoss) return null

    let maxSeat = 0
    for (const seat of globalPoss.keys()) {
      if (seat > maxSeat) maxSeat = seat
    }
    const possibilities = new Possibilities(maxSeat)
    for (const [role, count] of artifacts.setup as Map<string, number>) {
      const idx = RoleBitIndex[role as keyof typeof RoleBitIndex]
      if (idx !== undefined) possibilities.setup[idx] = count
    }
    possibilities.setupOriginal = new Uint8Array(possibilities.setup)
    for (const [seat, roles] of globalPoss) {
      possibilities.possibilities[seat] = possibilityFromRoles(roles as any)
    }

    const wolfSeats = new Set(ctx.teamSeats)
    const analysis = analyzeAttacksByWorld(
      possibilities,
      artifacts.setup as any,
      artifacts.vs,
      wolfSeats,
    )

    if (analysis.totalWorlds === 0 || analysis.attacks.length === 0) return null
    return analysis.bestAttack
  }
}
