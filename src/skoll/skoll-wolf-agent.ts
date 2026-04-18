/**
 * SkollWolfTeamAgent — Skoll 勝率分析で噛み先 / vote 先を決定する狼チームエージェント
 *
 * WolfTeamRuleAgent を継承し、decideNightAction の噛み先選択と
 * decideVote を Skoll 分析に差し替える。噛んだ狼 (attacker) の選択は
 * ベースクラスのヒューリスティックを流用する。
 * Retar が有効 (enableRetar: true) な環境で機能する。
 *
 * 内部は UnifiedVoteAnalysis で正規化し、NN フォールバックは
 * estimateWorldCount.upperBound > threshold のとき発火する。
 */

import type { TeamDecisionContext, WolfNightAction } from '../fenrir/src/agents/agent.ts'
import type { VillageStatus, SystemRole } from '../types/index.ts'
import { WolfTeamRuleAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import { alivePlayers } from '../lupa/roles.ts'
import { analyzeAttacksByWorld } from './wolf-attack-analysis.ts'
import { analyzeWolfVotesByWorld } from './wolf-vote-analysis.ts'
import { estimateWorldCount } from './estimate.ts'
import { encodeCollectiveWolfObservation } from '../fenrir/src/observation.ts'
import type { AnyNetwork } from '../fenrir/src/ml/nn.ts'
import {
  unifyWolfAnalysis, nnInferVote,
  buildPossibilitiesFromRetar,
  type UnifiedVoteAnalysis,
} from './unified.ts'

/** wolf_brain NN フォールバック設定 (mason と同じ pattern) */
export type WolfNNFallback = {
  network: AnyNetwork
  /** estimateWorldCount.upperBound > threshold で NN にフォールバック (default 5_000) */
  threshold?: number
  onFallback?: (estimatedWorlds: number) => void
}

const DEFAULT_WOLF_THRESHOLD = 5_000

export class SkollWolfTeamAgent extends WolfTeamRuleAgent {
  private nnFallback: WolfNNFallback | null

  constructor(opts?: { nnFallback?: WolfNNFallback }) {
    super()
    this.nnFallback = opts?.nnFallback ?? null
  }

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

  override decideVote(ctx: TeamDecisionContext): number {
    const analysis = this.analyzeVote(ctx)
    return analysis?.bestVote ?? super.decideVote(ctx)
  }

  /** wolf team 視点の UnifiedVoteAnalysis を返す (null = 解析不能) */
  analyzeVote(ctx: TeamDecisionContext): UnifiedVoteAnalysis | null {
    const artifacts = (ctx.gameState.ext as { retarCache?: { lastArtifacts?: { vs: VillageStatus, setup: Map<string, number> } | null } } | undefined)?.retarCache?.lastArtifacts
    const globalPoss = ctx.globalRetarPossibilities
    if (!artifacts?.vs || !artifacts?.setup || !globalPoss) return null

    const setup = artifacts.setup as Map<SystemRole, number>
    const possibilities = buildPossibilitiesFromRetar(globalPoss, setup)
    const wolfSeats = new Set<number>(ctx.teamSeats)

    // NN フォールバック: 重盤面なら skoll を skip
    if (this.nnFallback) {
      const est = estimateWorldCount(possibilities, setup)
      const threshold = this.nnFallback.threshold ?? DEFAULT_WOLF_THRESHOLD
      if (est.upperBound > threshold) {
        this.nnFallback.onFallback?.(est.upperBound)
        return nnInferVote(
          this.nnFallback.network,
          encodeCollectiveWolfObservation(ctx),
          ctx.alivePlayers,
          wolfSeats,
        )
      }
    }

    return unifyWolfAnalysis(
      analyzeWolfVotesByWorld(possibilities, setup, artifacts.vs, wolfSeats),
    )
  }

  private skollAttackTarget(ctx: TeamDecisionContext): number | null {
    const artifacts = (ctx.gameState.ext as any)?.retarCache?.lastArtifacts as
      | { setup: Map<string, number> }
      | null
      | undefined
    const globalPoss = ctx.globalRetarPossibilities
    if (!artifacts?.setup || !globalPoss) return null

    const setup = artifacts.setup as Map<SystemRole, number>
    const possibilities = buildPossibilitiesFromRetar(globalPoss, setup)

    // 夜時点では vs.statuses が1回分古い（当日の処刑未反映）のため
    // alivePlayers(state) を正規の生存席として使う
    const aliveNowSeats = alivePlayers(ctx.gameState).map(p => p.seat)
    const wolfSeats = new Set<number>(ctx.teamSeats)
    const analysis = analyzeAttacksByWorld(
      possibilities,
      setup,
      aliveNowSeats,
      wolfSeats,
    )

    if (analysis.totalWorlds === 0 || analysis.attacks.length === 0) return null
    return analysis.bestAttack
  }
}
