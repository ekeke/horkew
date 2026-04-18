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
 * 夜行動 (decideNightAction 等) は super (RuleBased) に委譲。将来 skoll 化する余地あり。
 */

import type { SystemRole, VillageStatus } from '../types/index.ts'
import type { DecisionContext } from '../fenrir/src/agents/agent.ts'
import { RuleBasedAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import { Possibilities, possibilityFromRoles, RoleBitIndex } from '../retar/possibilities.ts'
import { analyzeExecutionsByWorld } from './world-analysis.ts'
import { analyzeWolfVotesByWorld } from './wolf-vote-analysis.ts'
import { analyzeFanaticVotesByWorld } from './fanatic-analysis.ts'
import { analyzeHamsterVotesByWorld } from './hamster-analysis.ts'
import { analyzeImmoralistVotesByWorld } from './immoralist-analysis.ts'
import { estimateWorldCount } from './estimate.ts'
import { encodeObservation, SEATS } from '../fenrir/src/observation.ts'
import type { AnyNetwork } from '../fenrir/src/ml/nn.ts'

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
    const artifacts = (ctx.gameState.ext as { retarCache?: { lastArtifacts?: RetarArtifacts | null } } | undefined)?.retarCache?.lastArtifacts
    const globalPoss = ctx.globalRetarPossibilities

    if (!artifacts?.vs || !artifacts?.setup || !globalPoss) {
      return super.decideVote(ctx)
    }

    const possibilities = buildPossibilities(globalPoss, artifacts.setup as Map<SystemRole, number>)
    const setup = artifacts.setup as Map<SystemRole, number>

    let bestVote: number | null = null

    switch (ctx.myRole) {
      case 'villager':
      case 'seer':
      case 'medium':
      case 'bodyguard':
      case 'nekomata': {
        const a = analyzeExecutionsByWorld(possibilities, setup, artifacts.vs)
        bestVote = pickVillageBest(a.executions, a.bestExecution, ctx.mySeat, null)
        break
      }
      case 'mason': {
        const a = analyzeExecutionsByWorld(possibilities, setup, artifacts.vs)
        bestVote = pickVillageBest(a.executions, a.bestExecution, ctx.mySeat, ctx.masonPartner)
        break
      }
      case 'werewolf': {
        const teammates = new Set<number>(ctx.wolfTeammates ?? [])
        teammates.add(ctx.mySeat)
        const a = analyzeWolfVotesByWorld(possibilities, setup, artifacts.vs, teammates)
        bestVote = a.bestVote
        break
      }
      case 'fanatic': {
        const knownWolves = new Set<number>(ctx.knownWolves ?? [])
        const excluded = new Set<number>(knownWolves)
        excluded.add(ctx.mySeat)
        const nnVote = this.tryNNFallback(this.opts.fanaticFallback, ctx, possibilities, setup, excluded)
        if (nnVote !== undefined) return nnVote
        const a = analyzeFanaticVotesByWorld(possibilities, setup, artifacts.vs, knownWolves, ctx.mySeat)
        bestVote = a.bestVote
        break
      }
      case 'werehamster': {
        const excluded = new Set<number>([ctx.mySeat])
        const nnVote = this.tryNNFallback(this.opts.hamsterFallback, ctx, possibilities, setup, excluded)
        if (nnVote !== undefined) return nnVote
        const a = analyzeHamsterVotesByWorld(possibilities, setup, artifacts.vs, ctx.mySeat)
        bestVote = a.bestVote
        break
      }
      case 'immoralist': {
        if (ctx.knownHamster === null) {
          return super.decideVote(ctx)
        }
        const excluded = new Set<number>([ctx.mySeat, ctx.knownHamster])
        const nnVote = this.tryNNFallback(this.opts.immoralistFallback, ctx, possibilities, setup, excluded)
        if (nnVote !== undefined) return nnVote
        const a = analyzeImmoralistVotesByWorld(possibilities, setup, artifacts.vs, ctx.knownHamster)
        bestVote = a.bestVote
        break
      }
      // possessed: skoll を持たない → fallback
      default:
        return super.decideVote(ctx)
    }

    return bestVote ?? super.decideVote(ctx)
  }

  /**
   * NN フォールバック判定。estimate が閾値超なら NN 推論を返す（undefined なら skoll を続行）。
   * NN の出力は excluded 外で最大 logit の生存席。
   */
  private tryNNFallback(
    fallback: PerspectiveNNFallback | undefined,
    ctx: DecisionContext,
    possibilities: Possibilities,
    setup: Map<SystemRole, number>,
    excluded: Set<number>,
  ): number | undefined {
    if (!fallback) return undefined
    const threshold = fallback.threshold ?? DEFAULT_FALLBACK_THRESHOLD
    const est = estimateWorldCount(possibilities, setup)
    if (est.upperBound <= threshold) return undefined

    fallback.onFallback?.(est.upperBound)
    const obs = encodeObservation(ctx)
    const result = fallback.network.forward(obs)
    const voteLogits = result.policies.get('vote')
    if (!voteLogits) return undefined

    let bestSeat = -1
    let bestLogit = -Infinity
    for (const seat of ctx.alivePlayers) {
      if (excluded.has(seat)) continue
      if (seat < 1 || seat > SEATS) continue
      const logit = voteLogits[seat - 1]
      if (logit > bestLogit) {
        bestLogit = logit
        bestSeat = seat
      }
    }
    return bestSeat > 0 ? bestSeat : undefined
  }
}

/** village 視点で bestExecution を選ぶ。自席 / partner は除外し、必要なら次善手を返す */
function pickVillageBest(
  executions: ReadonlyArray<{ seat: number, winRate: number }>,
  bestSeat: number,
  mySeat: number,
  partnerSeat: number | null,
): number | null {
  const excluded = new Set<number>([mySeat])
  if (partnerSeat !== null) excluded.add(partnerSeat)

  if (!excluded.has(bestSeat)) return bestSeat

  const sorted = [...executions]
    .filter(e => !excluded.has(e.seat))
    .sort((a, b) => b.winRate - a.winRate)
  return sorted[0]?.seat ?? null
}

function buildPossibilities(
  globalPoss: Map<number, Set<SystemRole>>,
  setup: Map<SystemRole, number>,
): Possibilities {
  let maxSeat = 0
  for (const seat of globalPoss.keys()) {
    if (seat > maxSeat) maxSeat = seat
  }
  const possibilities = new Possibilities(maxSeat)
  for (const [role, count] of setup) {
    const idx = RoleBitIndex[role]
    if (idx !== undefined) possibilities.setup[idx] = count
  }
  possibilities.setupOriginal = new Uint8Array(possibilities.setup)
  for (const [seat, roles] of globalPoss) {
    possibilities.possibilities[seat] = possibilityFromRoles(roles)
  }
  return possibilities
}
