/**
 * 3-way 勝率比較: skoll-mason / NN-mason / heuristic-mason
 *
 * 同 seed 範囲で 3 変種のゲームを回し、村陣営勝率を比較する。
 * - skoll-mason  : 村陣営の defaultAgent が StandaloneSkollAgent (analyzeExecutionsByWorld)
 * - nn-mason     : 村陣営の defaultAgent が NeuralVoteAgent（pretrained checkpoint を load）
 * - heuristic-mason : 村陣営の defaultAgent が RuleBasedAgent
 *
 * 統合経路（mason_collective / village NN への重み注入）の前段階で、
 * skoll-pretrained NN が actually 強いかを実ゲームで確認する目的。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { SystemRole } from '../../../types/index.ts'
import type { LupaConfig } from '../../../lupa/types.ts'
import type { Agent, DecisionContext } from '../agents/agent.ts'
import type { AnyNetwork } from '../ml/nn.ts'
import { runGame } from '../../../lupa/engine.ts'
import { fullAdapter } from '../adapters/full-adapter.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../agents/rule-based-agent.ts'
import { AgentBase } from '../agents/agent.ts'
import type { TeamAgent, TeamDecisionContext } from '../agents/agent.ts'
import { encodeCollectiveMasonObservation, SEATS } from '../observation.ts'
import { resolveRegulation } from '../../../howl/ruleset.ts'
import { createMasonBrainNetwork } from '../training.ts'
import { loadCheckpoint } from '../ml/checkpoint.ts'
import { analyzeExecutionsByWorld } from '../../../skoll/world-analysis.ts'
import { RetarArtifactsCache, buildPossibilities } from './skoll-utils.ts'

const DEFAULT_ROLES: Record<string, number> = {
  werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1,
  mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1,
}
const DEFAULT_REVOTE = { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const }

export type Variant = 'skoll' | 'nn' | 'heuristic'

export type VariantStats = {
  variant: Variant
  numGames: number
  villageWin: number
  wolfWin: number
  hamsterWin: number
  draw: number
  villageWinRate: number
}

// ════════════════════════════════════════════
// MasonBrainTeamAgent: pretrained mason_brain (team obs + 直接 vote head) で投票
// ════════════════════════════════════════════
class MasonBrainTeamAgent extends AgentBase<TeamDecisionContext> implements TeamAgent {
  private fallback = new MasonTeamRuleAgent()
  private network: AnyNetwork

  constructor(network: AnyNetwork) {
    super()
    this.network = network
  }

  override decideNightAction(_ctx: TeamDecisionContext) { return { type: 'none' as const } }
  override decideDayClaim(ctx: TeamDecisionContext) { return this.fallback.decideDayClaim(ctx) }
  override decideForecast(ctx: TeamDecisionContext) { return this.fallback.decideForecast(ctx) }
  override decideCommunication(ctx: TeamDecisionContext) { return this.fallback.decideCommunication(ctx) }
  override decideProposal(ctx: TeamDecisionContext) { return this.fallback.decideProposal(ctx) }
  override decideLeadershipResponse(ctx: TeamDecisionContext, p: any) { return this.fallback.decideLeadershipResponse(ctx, p) }
  override decideDefensiveClaim(ctx: TeamDecisionContext) { return this.fallback.decideDefensiveClaim(ctx) }

  override decideVote(ctx: TeamDecisionContext): number {
    const obs = encodeCollectiveMasonObservation(ctx)
    const result = this.network.forward(obs)
    const voteLogits = result.policies.get('vote')
    if (!voteLogits) return this.fallback.decideVote(ctx)

    // alive マスク + self/partner 除外（mason の私的知識）
    const aliveMask = new Uint8Array(SEATS)
    for (const seat of ctx.alivePlayers) {
      if (seat >= 1 && seat <= SEATS) aliveMask[seat - 1] = 1
    }
    const actorSeat = ctx.currentActorSeat ?? ctx.mySeat
    if (actorSeat >= 1 && actorSeat <= SEATS) aliveMask[actorSeat - 1] = 0
    for (const partnerSeat of ctx.teamSeats) {
      if (partnerSeat !== actorSeat && partnerSeat >= 1 && partnerSeat <= SEATS) {
        aliveMask[partnerSeat - 1] = 0
      }
    }

    let bestSeat = -1
    let bestLogit = -Infinity
    for (let i = 0; i < SEATS; i++) {
      if (aliveMask[i] && voteLogits[i] > bestLogit) {
        bestLogit = voteLogits[i]
        bestSeat = i + 1
      }
    }
    if (bestSeat < 1) return this.fallback.decideVote(ctx)
    return bestSeat
  }
}

// ════════════════════════════════════════════
// StandaloneSkollAgent: ext 非依存（自前で retar 計算）
// ════════════════════════════════════════════
class StandaloneSkollAgent implements Agent {
  private fallback = new RuleBasedAgent()
  private cache = new RetarArtifactsCache()
  private lupaConfig: LupaConfig

  constructor(lupaConfig: LupaConfig) {
    this.lupaConfig = lupaConfig
  }

  decideNightAction(ctx: DecisionContext) { return this.fallback.decideNightAction(ctx) }
  decideDayClaim(ctx: DecisionContext) { return this.fallback.decideDayClaim(ctx) }
  decideForecast(ctx: DecisionContext) { return this.fallback.decideForecast(ctx) }
  decideCommunication(ctx: DecisionContext) { return this.fallback.decideCommunication(ctx) }
  decideProposal(ctx: DecisionContext) { return this.fallback.decideProposal(ctx) }
  decideLeadershipResponse(ctx: DecisionContext, p: any) { return this.fallback.decideLeadershipResponse(ctx, p) }
  decideDefensiveClaim(ctx: DecisionContext) { return this.fallback.decideDefensiveClaim(ctx) }

  decideVote(ctx: DecisionContext): number {
    const globalPoss = ctx.globalRetarPossibilities
    if (!globalPoss) return this.fallback.decideVote(ctx)

    const artifacts = this.cache.get(ctx, this.lupaConfig)
    if (!artifacts) return this.fallback.decideVote(ctx)

    const possibilities = buildPossibilities(globalPoss, artifacts.setup)
    let analysis
    try {
      analysis = analyzeExecutionsByWorld(possibilities, artifacts.setup, artifacts.vs)
    } catch {
      return this.fallback.decideVote(ctx)
    }

    if (analysis.bestExecution === ctx.mySeat) {
      const sorted = [...analysis.executions]
        .filter(e => e.seat !== ctx.mySeat)
        .sort((a, b) => b.winRate - a.winRate)
      return sorted[0]?.seat ?? this.fallback.decideVote(ctx)
    }
    return analysis.bestExecution
  }
}

// ════════════════════════════════════════════
// MasonTeamWrapper: 任意の Agent を mason TeamAgent として束ねる
// MasonTeamRuleAgent と同じ buildActorCtx 規約で個別 vote を委譲する。
// ════════════════════════════════════════════
class MasonTeamWrapper extends AgentBase<TeamDecisionContext> implements TeamAgent {
  private inner: Agent
  private fallback = new RuleBasedAgent()

  constructor(inner: Agent) {
    super()
    this.inner = inner
  }

  override decideNightAction(_ctx: TeamDecisionContext) { return { type: 'none' as const } }
  override decideDayClaim(ctx: TeamDecisionContext) { return this.fallback.decideDayClaim(this.buildActorCtx(ctx)) }
  override decideForecast(ctx: TeamDecisionContext) { return this.fallback.decideForecast(this.buildActorCtx(ctx)) }
  override decideVote(ctx: TeamDecisionContext): number {
    const actorCtx = this.buildActorCtx(ctx)
    const vote = this.inner.decideVote(actorCtx)
    // skoll/NN は globalRetar しか見ないので mason の私的知識（相方=既知白）を考慮できない。
    // self/partner への投票は heuristic にフォールバックする（実運用時の安全ガードと同じ pattern）
    if (vote === actorCtx.mySeat || (actorCtx.masonPartner !== null && vote === actorCtx.masonPartner)) {
      return this.fallback.decideVote(actorCtx)
    }
    return vote
  }
  override decideCommunication(ctx: TeamDecisionContext) { return this.fallback.decideCommunication(this.buildActorCtx(ctx)) }
  override decideProposal(ctx: TeamDecisionContext) { return this.fallback.decideProposal(this.buildActorCtx(ctx)) }
  override decideLeadershipResponse(ctx: TeamDecisionContext, p: any) { return this.fallback.decideLeadershipResponse(this.buildActorCtx(ctx), p) }
  override decideDefensiveClaim(ctx: TeamDecisionContext) { return this.fallback.decideDefensiveClaim(this.buildActorCtx(ctx)) }

  private buildActorCtx(ctx: TeamDecisionContext): DecisionContext {
    const seat = ctx.currentActorSeat ?? ctx.teamSeats[0]
    const player = ctx.gameState.players.find(p => p.seat === seat)!
    const partner = ctx.teamSeats.find(s => s !== seat) ?? null
    return { ...ctx, mySeat: seat, myRole: player.role, myPlayer: player, masonPartner: partner }
  }
}

// ════════════════════════════════════════════
// 1 変種 × N ゲーム
// ════════════════════════════════════════════
async function runVariantGames(
  variant: Variant,
  numGames: number,
  baseSeed: number,
  network: AnyNetwork | null,
): Promise<VariantStats> {
  const roles = new Map(Object.entries(DEFAULT_ROLES) as [SystemRole, number][])
  const rules = resolveRegulation()
  const lupaConfig: LupaConfig = { roles, rules } as LupaConfig

  const stats: VariantStats = {
    variant,
    numGames,
    villageWin: 0,
    wolfWin: 0,
    hamsterWin: 0,
    draw: 0,
    villageWinRate: 0,
  }

  for (let g = 0; g < numGames; g++) {
    const seed = baseSeed + g

    // mason の vote だけを variant で差し替える。それ以外（村パワーロール、
    // fanatic、hamster、immoralist、wolf）は全変種で heuristic 統一。
    // → 評価対象は「mason の vote 品質」のみ。skoll/NN を非 mason に適用すると
    //   skoll 視点が hamster 等の利益と逆転するためバグになる
    let masonTeamAgent: TeamAgent
    switch (variant) {
      case 'skoll':
        masonTeamAgent = new MasonTeamWrapper(new StandaloneSkollAgent(lupaConfig))
        break
      case 'nn':
        if (!network) throw new Error('nn variant requires network')
        masonTeamAgent = new MasonBrainTeamAgent(network)
        break
      case 'heuristic':
        masonTeamAgent = new MasonTeamRuleAgent()
        break
    }

    const handlers = fullAdapter({
      agents: new Map<number, Agent>(),
      defaultAgent: new RuleBasedAgent(),  // 非 mason は全変種で heuristic
      wolfTeamAgent: new WolfTeamRuleAgent(),
      masonTeamAgent,
      onRolesAssigned: () => {},
      seed,
      enableRetar: true,
      roles,
      rules,
    })

    const result = await runGame(
      { roles, seed, hasFirstGhost: true, revoteConfig: DEFAULT_REVOTE },
      handlers,
    )

    const r = result.state.result
    if (r === 'villager_won') stats.villageWin++
    else if (r === 'werewolf_won') stats.wolfWin++
    else if (r === 'werehamster_won') stats.hamsterWin++
    else stats.draw++
  }

  stats.villageWinRate = stats.villageWin / Math.max(1, numGames)
  return stats
}

// ════════════════════════════════════════════
// 3-way 比較
// ════════════════════════════════════════════
export type WinrateEvalOptions = {
  checkpointPath: string
  numGames: number
  baseSeed: number
  outputPath: string
  /** 比較する variant のサブセット（デフォルト: 3 つすべて） */
  variants: Variant[]
}

export const DEFAULT_WINRATE_EVAL_OPTIONS: WinrateEvalOptions = {
  checkpointPath: 'tmp/skoll-pilot/phases/00-skoll-supervised/ckpt-skoll/checkpoint.json',
  numGames: 100,
  baseSeed: 200000,
  outputPath: 'tmp/skoll-eval/winrate-3way.json',
  variants: ['skoll', 'nn', 'heuristic'],
}

export async function runThreeWayEval(opts: Partial<WinrateEvalOptions> = {}): Promise<{
  results: VariantStats[]
  outputPath: string
}> {
  const options = { ...DEFAULT_WINRATE_EVAL_OPTIONS, ...opts }

  let network: AnyNetwork | null = null
  if (options.variants.includes('nn')) {
    process.stderr.write(`[winrate-eval] loading checkpoint ${options.checkpointPath}\n`)
    network = createMasonBrainNetwork()
    loadCheckpoint(network, options.checkpointPath)
  }

  const results: VariantStats[] = []
  for (const variant of options.variants) {
    process.stderr.write(`[winrate-eval] === ${variant} (${options.numGames} games) ===\n`)
    const t0 = performance.now()
    const stats = await runVariantGames(variant, options.numGames, options.baseSeed, network)
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
    process.stderr.write(
      `[winrate-eval] ${variant}: village=${stats.villageWin} wolf=${stats.wolfWin} `
      + `hamster=${stats.hamsterWin} draw=${stats.draw} | villageWinRate=${(stats.villageWinRate * 100).toFixed(1)}% (${elapsed}s)\n`,
    )
    results.push(stats)
  }

  // 結果保存
  mkdirSync(dirname(options.outputPath), { recursive: true })
  writeFileSync(options.outputPath, JSON.stringify({ options, results }, null, 2))

  // 比較サマリ
  process.stderr.write(`\n[winrate-eval] === Summary ===\n`)
  process.stderr.write(`[winrate-eval] (numGames=${options.numGames}, baseSeed=${options.baseSeed})\n`)
  for (const s of results) {
    process.stderr.write(`[winrate-eval]   ${s.variant.padEnd(10)} villageWin=${(s.villageWinRate * 100).toFixed(1)}%\n`)
  }
  process.stderr.write(`[winrate-eval] output: ${options.outputPath}\n`)

  return { results, outputPath: options.outputPath }
}

function parseCli(): Partial<WinrateEvalOptions> {
  const opts: Partial<WinrateEvalOptions> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--checkpoint': opts.checkpointPath = args[++i]; break
      case '--games': opts.numGames = parseInt(args[++i], 10); break
      case '--seed': opts.baseSeed = parseInt(args[++i], 10); break
      case '--output': opts.outputPath = args[++i]; break
      case '--variants': opts.variants = args[++i].split(',') as Variant[]; break
      case '--help':
        process.stderr.write('Usage: winrate-eval.ts [--checkpoint PATH] [--games N] [--seed S] [--output PATH] [--variants skoll,nn,heuristic]\n')
        process.exit(0)
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('winrate-eval.ts')) {
  runThreeWayEval(parseCli()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
