/**
 * SkollAgent — Skoll win-rate analysis を使った村陣営エージェント
 *
 * RuleBasedAgent を継承し、decideVote のみ Skoll 解析に差し替える。
 * 夜行動（占い・霊媒・護衛）は RuleBasedAgent のルールベース実装を使う。
 * Retar が有効 (enableRetar: true) な環境で機能する。
 */

import type { DecisionContext } from '../fenrir/src/agents/agent.ts'
import type { VillageStatus } from '../types/index.ts'
import { RuleBasedAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import { Possibilities, possibilityFromRoles, RoleBitIndex } from '../retar/possibilities.ts'
import { analyzeExecutionsByWorld } from './world-analysis.ts'

export class SkollAgent extends RuleBasedAgent {
  override decideVote(ctx: DecisionContext): number {
    const artifacts = (ctx.gameState.ext as any)?.retarCache?.lastArtifacts as
      | { vs: VillageStatus; setup: Map<string, number> }
      | null
      | undefined
    const globalPoss = ctx.globalRetarPossibilities

    if (!artifacts?.vs || !artifacts?.setup || !globalPoss) {
      return super.decideVote(ctx)
    }

    // Map<seat, Set<role>> → Possibilities 変換
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

    // 自分自身には投票しない
    if (analysis.bestExecution === ctx.mySeat) {
      const sorted = [...analysis.executions]
        .filter(e => e.seat !== ctx.mySeat)
        .sort((a, b) => b.winRate - a.winRate)
      return sorted[0]?.seat ?? super.decideVote(ctx)
    }
    return analysis.bestExecution
  }
}
