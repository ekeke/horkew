/**
 * SkollMasterAgent — 全 perspective 対応の統一 skoll エージェント
 *
 * RuleBasedAgent を継承し、decideVote で myRole に応じて適切な perspective 分析を呼び分ける。
 * BrainBattle / その他のシナリオで RuleBasedAgent を「ヒューリスティック agent」として
 * 使っている箇所をそのまま置き換えられる drop-in replacement。
 *
 * 役職別の vote 戦略:
 *   - villager / seer / medium / bodyguard / nekomata / mason → village skoll (analyzeExecutionsByWorld)
 *     mason の場合は partner も除外
 *   - werewolf → wolf-vote skoll (PP shortcut + teammates 除外)
 *   - fanatic → fanatic-vote skoll (knownWolves + 自席を狼陣営として PP 計算)
 *   - werehamster → hamster-vote skoll (厳密 hamster_won 確率、自席除外)
 *   - immoralist → immoralist-vote skoll (knownHamster を守る vote)
 *   - possessed → fallback (RuleBased)
 *
 * 内部は UnifiedVoteAnalysis に正規化して dispatch。NN フォールバックは
 * estimateWorldCount.upperBound > threshold のとき skoll を skip して NN 推論に切替。
 *
 * 夜行動 (decideNightAction 等) は super (RuleBased) に委譲。将来 skoll 化する余地あり。
 */

import type { SystemRole, VillageStatus } from '../types/index.ts'
import type { DecisionContext } from '../fenrir/src/agents/agent.ts'
import { RuleBasedAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import { analyzeExecutionsByWorld } from './world-analysis.ts'
import { analyzeWolfVotesByWorld } from './wolf-vote-analysis.ts'
import { analyzeFanaticVotesByWorld } from './fanatic-analysis.ts'
import { analyzeHamsterVotesByWorld } from './hamster-analysis.ts'
import { analyzeImmoralistVotesByWorld } from './immoralist-analysis.ts'
import { estimateWorldCount } from './estimate.ts'
import { encodeObservation } from '../fenrir/src/observation.ts'
import type { AnyNetwork } from '../fenrir/src/ml/nn.ts'
import {
  unifyVillageAnalysis, unifyWolfAnalysis, unifyHamsterAnalysis, nnInferVote,
  buildPossibilitiesFromRetar,
  type UnifiedVoteAnalysis,
} from './unified.ts'

type RetarArtifacts = {
  vs: VillageStatus
  setup: Map<string, number>
}

/** 単一 perspective NN フォールバック設定 */
export type PerspectiveNNFallback = {
  /** perspective 専用 NN (standard observation を入力に取る) */
  network: AnyNetwork
  /** estimateWorldCount.upperBound > threshold で NN にフォールバック (default 5_000) */
  threshold?: number
  /** デバッグ: フォールバック発火を計測 */
  onFallback?: (estimatedWorlds: number) => void
}

export type SkollMasterOptions = {
  fanaticFallback?: PerspectiveNNFallback
  hamsterFallback?: PerspectiveNNFallback
  immoralistFallback?: PerspectiveNNFallback
}

const DEFAULT_FALLBACK_THRESHOLD = 5_000

export class SkollMasterAgent extends RuleBasedAgent {
  private opts: SkollMasterOptions

  constructor(opts: SkollMasterOptions = {}) {
    super()
    this.opts = opts
  }

  override decideVote(ctx: DecisionContext): number {
    const analysis = this.analyzeVote(ctx)
    return analysis?.bestVote ?? super.decideVote(ctx)
  }

  /**
   * 現在の perspective で UnifiedVoteAnalysis を返す (null = 解析不能/unsupported role)。
   * skoll 投入前提: estimateWorldCount 超過時は NN フォールバック、
   * フォールバック未設定なら skoll をそのまま走らせる。
   */
  analyzeVote(ctx: DecisionContext): UnifiedVoteAnalysis | null {
    const artifacts = (ctx.gameState.ext as { retarCache?: { lastArtifacts?: RetarArtifacts | null } } | undefined)?.retarCache?.lastArtifacts
    const globalPoss = ctx.globalRetarPossibilities
    if (!artifacts?.vs || !artifacts?.setup || !globalPoss) return null

    const setup = artifacts.setup as Map<SystemRole, number>
    const possibilities = buildPossibilitiesFromRetar(globalPoss, setup)

    switch (ctx.myRole) {
      case 'villager':
      case 'seer':
      case 'medium':
      case 'bodyguard':
      case 'nekomata':
        return unifyVillageAnalysis(
          analyzeExecutionsByWorld(possibilities, setup, artifacts.vs),
          ctx.mySeat, null,
        )
      case 'mason':
        return unifyVillageAnalysis(
          analyzeExecutionsByWorld(possibilities, setup, artifacts.vs),
          ctx.mySeat, ctx.masonPartner,
        )
      case 'werewolf': {
        const teammates = new Set<number>(ctx.wolfTeammates ?? [])
        teammates.add(ctx.mySeat)
        return unifyWolfAnalysis(
          analyzeWolfVotesByWorld(possibilities, setup, artifacts.vs, teammates),
        )
      }
      case 'fanatic': {
        const knownWolves = new Set<number>(ctx.knownWolves ?? [])
        const excluded = new Set<number>(knownWolves)
        excluded.add(ctx.mySeat)
        const nn = this.tryNNFallback(this.opts.fanaticFallback, ctx, possibilities, setup, excluded)
        if (nn) return nn
        return unifyWolfAnalysis(
          analyzeFanaticVotesByWorld(possibilities, setup, artifacts.vs, knownWolves, ctx.mySeat),
        )
      }
      case 'werehamster': {
        const excluded = new Set<number>([ctx.mySeat])
        const nn = this.tryNNFallback(this.opts.hamsterFallback, ctx, possibilities, setup, excluded)
        if (nn) return nn
        return unifyHamsterAnalysis(
          analyzeHamsterVotesByWorld(possibilities, setup, artifacts.vs, ctx.mySeat),
        )
      }
      case 'immoralist': {
        if (ctx.knownHamster === null) return null
        const excluded = new Set<number>([ctx.mySeat, ctx.knownHamster])
        const nn = this.tryNNFallback(this.opts.immoralistFallback, ctx, possibilities, setup, excluded)
        if (nn) return nn
        return unifyHamsterAnalysis(
          analyzeImmoralistVotesByWorld(possibilities, setup, artifacts.vs, ctx.knownHamster),
        )
      }
      default:
        return null  // possessed 等
    }
  }

  /**
   * NN フォールバック判定。estimate が閾値超なら UnifiedVoteAnalysis (source='nn') を返す。
   * 閾値以下なら null を返して skoll 分析を続けさせる。
   */
  private tryNNFallback(
    fallback: PerspectiveNNFallback | undefined,
    ctx: DecisionContext,
    possibilities: Possibilities,
    setup: Map<SystemRole, number>,
    excluded: Set<number>,
  ): UnifiedVoteAnalysis | null {
    if (!fallback) return null
    const threshold = fallback.threshold ?? DEFAULT_FALLBACK_THRESHOLD
    const est = estimateWorldCount(possibilities, setup)
    if (est.upperBound <= threshold) return null

    fallback.onFallback?.(est.upperBound)
    return nnInferVote(fallback.network, encodeObservation(ctx), ctx.alivePlayers, excluded)
  }
}

