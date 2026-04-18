/**
 * SkollMasonTeamAgent — Skoll 分析で処刑先を決定する共有チームエージェント
 *
 * MasonTeamRuleAgent を継承し、decideProposal のみ Skoll 分析に差し替える。
 * CO行動・夜行動・投票はベースクラスのルールベース実装を使う。
 *
 * ベンチ用 adapter が collectProposals でこのエージェントの decideProposal を呼び、
 * execute_order として全村プレイヤーに伝播する。
 *
 * 内部は UnifiedVoteAnalysis で正規化し、NN フォールバックは
 * estimateWorldCount.upperBound > threshold のとき発火する。
 */

import type { TeamDecisionContext } from '../fenrir/src/agents/agent.ts'
import type { Proposal } from '../fenrir/src/leadership.ts'
import type { VillageStatus, SystemRole } from '../types/index.ts'
import { MasonTeamRuleAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import { analyzeExecutionsByWorld } from './world-analysis.ts'
import { estimateWorldCount } from './estimate.ts'
import { encodeCollectiveMasonObservation } from '../fenrir/src/observation.ts'
import type { AnyNetwork } from '../fenrir/src/ml/nn.ts'
import {
  unifyVillageAnalysis, nnInferVote,
  buildPossibilitiesFromRetar,
  type UnifiedVoteAnalysis,
} from './unified.ts'

/** mason_brain NN フォールバック設定 */
export type MasonNNFallback = {
  /** mason_brain と互換の NN (createMasonBrainNetwork で作って checkpoint load 済み) */
  network: AnyNetwork
  /** estimateWorldCount.upperBound > threshold で NN にフォールバック (default 100_000) */
  threshold?: number
  /** デバッグ: フォールバック発火を計測 */
  onFallback?: (estimatedWorlds: number) => void
}

const DEFAULT_MASON_THRESHOLD = 100_000

export class SkollMasonTeamAgent extends MasonTeamRuleAgent {
  private nnFallback: MasonNNFallback | null

  constructor(opts?: { nnFallback?: MasonNNFallback }) {
    super()
    this.nnFallback = opts?.nnFallback ?? null
  }

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
    const analysis = this.analyzeVote(ctx)
    return analysis?.bestVote ?? null
  }

  /** mason team 視点の UnifiedVoteAnalysis を返す (null = 解析不能) */
  analyzeVote(ctx: TeamDecisionContext): UnifiedVoteAnalysis | null {
    const artifacts = (ctx.gameState.ext as { retarCache?: { lastArtifacts?: { vs: VillageStatus, setup: Map<string, number> } | null } } | undefined)?.retarCache?.lastArtifacts
    const globalPoss = ctx.globalRetarPossibilities
    if (!artifacts?.vs || !artifacts?.setup || !globalPoss) return null

    const setup = artifacts.setup as Map<SystemRole, number>
    const possibilities = buildPossibilitiesFromRetar(globalPoss, setup)
    const masonSeats = new Set<number>(ctx.teamSeats)

    // NN フォールバック: 重盤面なら skoll を skip
    if (this.nnFallback) {
      const est = estimateWorldCount(possibilities, setup)
      const threshold = this.nnFallback.threshold ?? DEFAULT_MASON_THRESHOLD
      if (est.upperBound > threshold) {
        this.nnFallback.onFallback?.(est.upperBound)
        return nnInferVote(
          this.nnFallback.network,
          encodeCollectiveMasonObservation(ctx),
          ctx.alivePlayers,
          masonSeats,
        )
      }
    }

    // Mason 視点は village skoll (bestExecution を masonSeats 外で選ぶ)
    const raw = analyzeExecutionsByWorld(possibilities, setup, artifacts.vs)
    if (raw.totalWorlds === 0) return null
    // partnerSeat を null で渡し、excluded に masonSeats 全体をあとで差し込む
    const unified = unifyVillageAnalysis(raw, ctx.mySeat, null)
    // mason team 全員を除外扱いに
    for (const c of unified.candidates) if (masonSeats.has(c.seat)) c.excluded = true
    if (unified.bestVote !== null && masonSeats.has(unified.bestVote)) {
      // 次善手へ
      let best: number | null = null
      let bestScore = -Infinity
      for (const c of unified.candidates) {
        if (c.excluded) continue
        if (c.score > bestScore) {
          bestScore = c.score
          best = c.seat
        }
      }
      unified.bestVote = best
    }
    return unified
  }
}
