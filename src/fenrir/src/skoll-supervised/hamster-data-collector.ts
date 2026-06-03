/**
 * Hamster (狐) perspective skoll 教師データコレクタ
 *
 * 個人役職のため、team context ではなく個別 DecisionContext から採取する。
 * 観測: encodeObservation (1029 dims)
 * ラベル: analyzeHamsterVotesByWorld (mySeat = hamster 自席)
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { SystemRole } from '../../../types/index.ts'
import type { LupaConfig } from '../../../lupa/types.ts'
import type { Agent, DecisionContext } from '../agents/agent.ts'
import { runGame } from '../../../lupa/engine.ts'
import { fullAdapter } from '../adapters/full-adapter.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../agents/rule-based-agent.ts'
import { encodeObservation, SEATS } from '../observation.ts'
import { resolveRegulation } from '../../../howl/ruleset.ts'
import { analyzeHamsterVotesByWorld } from '../../../skoll/hamster-analysis.ts'
import { RetarArtifactsCache, buildPossibilities } from './skoll-utils.ts'

const DEFAULT_ROLES: Record<string, number> = {
  werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1,
  mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1,
}
const DEFAULT_REVOTE = { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const }

const MASK_NEG = -1e9
const SKOLL_MAX_WORLDS = 2_000_000

export type HamsterSampleMetadata = {
  gameId: number
  day: number
  seat: number
  aliveCount: number
  topMargin: number
  rawHamsterWinRates: Array<{ seat: number, hamsterWinRate: number }>
  bestVote: number
}

export type HamsterSample = {
  observation: Float32Array
  label: Float32Array
  mask: Float32Array
  metadata: HamsterSampleMetadata
}

export type HamsterCollectorOptions = {
  numGames: number
  baseSeed: number
  minAlive: number
  minMargin: number
  temperature: number
  outputPath: string
  progressInterval: number
}

export const DEFAULT_HAMSTER_COLLECTOR_OPTIONS: HamsterCollectorOptions = {
  numGames: 100,
  baseSeed: 28000,
  minAlive: 7,
  minMargin: 0,
  temperature: 0.3,
  outputPath: 'tmp/skoll-hamster-data/samples.jsonl',
  progressInterval: 10,
}

/** hamster_won 確率から (label, mask, topMargin) を生成。自席は除外 */
export function makeHamsterSoftLabel(
  candidates: Array<{ seat: number, hamsterWinRate: number, isSelf: boolean }>,
  temperature: number,
): { label: Float32Array, mask: Float32Array, topMargin: number } {
  const label = new Float32Array(SEATS)
  const mask = new Float32Array(SEATS)
  for (let i = 0; i < SEATS; i++) mask[i] = MASK_NEG

  // 自席除外
  const nonSelf = candidates.filter(c => !c.isSelf)
  if (nonSelf.length === 0) return { label, mask, topMargin: 0 }

  const rates = nonSelf.map(c => c.hamsterWinRate)
  const minRate = Math.min(...rates)
  const maxRate = Math.max(...rates)
  const span = maxRate - minRate

  const normalized = new Map<number, number>()
  for (const c of nonSelf) {
    if (c.seat < 1 || c.seat > SEATS) continue
    const norm = span > 0 ? (c.hamsterWinRate - minRate) / span : 0
    normalized.set(c.seat, norm)
    mask[c.seat - 1] = 0
  }

  const expSum = [...normalized.values()].reduce((s, v) => s + Math.exp(v / temperature), 0)
  for (const [seat, norm] of normalized) {
    label[seat - 1] = Math.exp(norm / temperature) / expSum
  }

  const sortedRates = [...rates].sort((a, b) => b - a)
  const topMargin = sortedRates.length >= 2 ? sortedRates[0] - sortedRates[1] : 0

  return { label, mask, topMargin }
}

async function collectSamplesFromGame(gameId: number, options: HamsterCollectorOptions): Promise<HamsterSample[]> {
  const samples: HamsterSample[] = []
  const roles = new Map(Object.entries(DEFAULT_ROLES) as [SystemRole, number][])
  const rules = resolveRegulation()
  const lupaConfig: LupaConfig = { roles, rules } as LupaConfig
  const artifactsCache = new RetarArtifactsCache()

  class CapturingHamster implements Agent {
    private inner = new RuleBasedAgent()
    decideNightAction(ctx: DecisionContext) { return this.inner.decideNightAction(ctx) }
    decideDayClaim(ctx: DecisionContext) { return this.inner.decideDayClaim(ctx) }
    decideForecast(ctx: DecisionContext) { return this.inner.decideForecast(ctx) }
    decideCommunication(ctx: DecisionContext) { return this.inner.decideCommunication(ctx) }
    decideProposal(ctx: DecisionContext) { return this.inner.decideProposal(ctx) }
    decideLeadershipResponse(ctx: DecisionContext, p: any) { return this.inner.decideLeadershipResponse(ctx, p) }
    decideDefensiveClaim(ctx: DecisionContext) { return this.inner.decideDefensiveClaim(ctx) }
    decideVote(ctx: DecisionContext): number {
      tryCaptureSample(ctx, gameId, options, samples, lupaConfig, artifactsCache)
      return this.inner.decideVote(ctx)
    }
  }

  const handlers = fullAdapter({
    agents: new Map<number, Agent>(),
    defaultAgent: new CapturingHamster(),  // hamster 席だけで capture されるよう tryCaptureSample で role フィルタ
    wolfTeamAgent: new WolfTeamRuleAgent(),
    masonTeamAgent: new MasonTeamRuleAgent(),
    onRolesAssigned: () => {},
    seed: options.baseSeed + gameId,
    enableRetar: true,
    roles,
    rules,
  })

  await runGame(
    {
      roles,
      seed: options.baseSeed + gameId,
      hasFirstGhost: true,
      revoteConfig: DEFAULT_REVOTE,
    },
    handlers,
  )

  return samples
}

function tryCaptureSample(
  ctx: DecisionContext,
  gameId: number,
  options: HamsterCollectorOptions,
  samples: HamsterSample[],
  lupaConfig: LupaConfig,
  artifactsCache: RetarArtifactsCache,
): void {
  if (ctx.myRole !== 'werehamster') return

  const globalPoss = ctx.globalRetarPossibilities
  if (!globalPoss) return

  const artifacts = artifactsCache.get(ctx, lupaConfig)
  if (!artifacts) return

  const aliveSeats: number[] = []
  for (const [seat, status] of artifacts.vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }
  if (aliveSeats.length < options.minAlive) return

  const possibilities = buildPossibilities(globalPoss, artifacts.setup)
  let analysis
  try {
    analysis = analyzeHamsterVotesByWorld(possibilities, artifacts.setup, artifacts.vs, ctx.mySeat, SKOLL_MAX_WORLDS)
  } catch {
    return
  }
  if (analysis.truncated) return
  if (analysis.bestVote === null) return

  const { label, mask, topMargin } = makeHamsterSoftLabel(analysis.candidates, options.temperature)
  if (topMargin < options.minMargin) return

  samples.push({
    observation: encodeObservation(ctx),
    label,
    mask,
    metadata: {
      gameId,
      day: ctx.day,
      seat: ctx.mySeat,
      aliveCount: aliveSeats.length,
      topMargin,
      rawHamsterWinRates: analysis.candidates
        .filter(c => !c.isSelf)
        .map(c => ({ seat: c.seat, hamsterWinRate: c.hamsterWinRate })),
      bestVote: analysis.bestVote,
    },
  })
}

export function writeHamsterSamplesAsJsonl(samples: HamsterSample[], outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true })
  const lines: string[] = []
  for (const s of samples) {
    lines.push(JSON.stringify({
      observation: Array.from(s.observation),
      label: Array.from(s.label),
      mask: Array.from(s.mask),
      metadata: s.metadata,
    }))
  }
  writeFileSync(outputPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8')
}

export async function collectAndSaveHamster(opts: Partial<HamsterCollectorOptions> = {}): Promise<{
  numSamples: number
  outputPath: string
  marginStats: { p10: number, p50: number, p90: number, mean: number }
}> {
  const options = { ...DEFAULT_HAMSTER_COLLECTOR_OPTIONS, ...opts }
  process.stderr.write(`[hamster-collect] running ${options.numGames} games (seed ${options.baseSeed}..)\n`)

  const allSamples: HamsterSample[] = []
  for (let g = 0; g < options.numGames; g++) {
    const s = await collectSamplesFromGame(g, options)
    allSamples.push(...s)
    if ((g + 1) % options.progressInterval === 0) {
      process.stderr.write(`[hamster-collect] ${g + 1}/${options.numGames} games, ${allSamples.length} samples\n`)
    }
  }

  writeHamsterSamplesAsJsonl(allSamples, options.outputPath)

  const margins = allSamples.map(s => s.metadata.topMargin).sort((a, b) => a - b)
  const pct = (p: number) => margins[Math.min(margins.length - 1, Math.floor(p * margins.length))] ?? 0
  const meanMargin = margins.length > 0 ? margins.reduce((s, v) => s + v, 0) / margins.length : 0

  const result = {
    numSamples: allSamples.length,
    outputPath: options.outputPath,
    marginStats: { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), mean: meanMargin },
  }

  process.stderr.write(`[hamster-collect] === Done ===\n`)
  process.stderr.write(`[hamster-collect] samples: ${result.numSamples}\n`)
  process.stderr.write(`[hamster-collect] margin: p10=${result.marginStats.p10.toFixed(3)} p50=${result.marginStats.p50.toFixed(3)} p90=${result.marginStats.p90.toFixed(3)} mean=${result.marginStats.mean.toFixed(3)}\n`)
  process.stderr.write(`[hamster-collect] output: ${result.outputPath}\n`)

  return result
}

function parseCli(): Partial<HamsterCollectorOptions> {
  const opts: Partial<HamsterCollectorOptions> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--games': opts.numGames = parseInt(args[++i], 10); break
      case '--seed': opts.baseSeed = parseInt(args[++i], 10); break
      case '--min-alive': opts.minAlive = parseInt(args[++i], 10); break
      case '--min-margin': opts.minMargin = parseFloat(args[++i]); break
      case '--temperature': opts.temperature = parseFloat(args[++i]); break
      case '--output': opts.outputPath = args[++i]; break
      case '--progress': opts.progressInterval = parseInt(args[++i], 10); break
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('hamster-data-collector.ts')) {
  collectAndSaveHamster(parseCli()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
