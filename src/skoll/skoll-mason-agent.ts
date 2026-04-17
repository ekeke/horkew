/**
 * SkollMasonTeamAgent — Skoll 分析で処刑先を決定する共有チームエージェント
 *
 * MasonTeamRuleAgent を継承し、decideProposal のみ Skoll 分析に差し替える。
 * CO行動・夜行動・投票はベースクラスのルールベース実装を使う。
 *
 * ベンチ用 adapter が collectProposals でこのエージェントの decideProposal を呼び、
 * execute_order として全村プレイヤーに伝播する。
 */

import type { TeamDecisionContext } from '../fenrir/src/agents/agent.ts'
import type { Proposal } from '../fenrir/src/leadership.ts'
import type { VillageStatus } from '../types/index.ts'
import { MasonTeamRuleAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import { Possibilities, possibilityFromRoles, RoleBitIndex } from '../retar/possibilities.ts'
import { analyzeExecutionsByWorld } from './world-analysis.ts'

export class SkollMasonTeamAgent extends MasonTeamRuleAgent {
  override decideProposal(ctx: TeamDecisionContext): Proposal | null {
    const target = this.skollTarget(ctx)
    if (target == null) return super.decideProposal(ctx)
    return { type: 'execute_order', target }
  }

  override decideVote(ctx: TeamDecisionContext): number {
    const target = this.skollTarget(ctx)
    if (target != null) return target
    return super.decideVote(ctx)
  }

  private skollTarget(ctx: TeamDecisionContext): number | null {
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

    const analysis = analyzeExecutionsByWorld(
      possibilities,
      artifacts.setup as any,
      artifacts.vs,
    )

    if (analysis.totalWorlds === 0) return null

    // 自分のチーム（共有）を処刑先から除外
    const masonSeats = new Set(ctx.teamSeats)
    if (!masonSeats.has(analysis.bestExecution)) return analysis.bestExecution

    const fallback = [...analysis.executions]
      .filter(e => !masonSeats.has(e.seat))
      .sort((a, b) => b.winRate - a.winRate)
    return fallback[0]?.seat ?? null
  }
}
