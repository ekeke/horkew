/**
 * Fanatic (狂信者) perspective skoll 教師データコレクタ
 *
 * 注: 簡略化のため standard encodeObservation (1029 dims) を使用する。
 * fenrir 本来の FanaticAgent は FANATIC_OBSERVATION_SIZE (1197 dims, 村NN注入込み) を使うが、
 * 本学習では zeros 注入と同等の扱い（standard obs のみ）で訓練し、distillation 精度への
 * 影響が許容範囲か bb-eval で検証する。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { SystemRole } from '../../../types/index.ts'
import type { LupaConfig } from '../../../lupa/types.ts'
import type { Agent, DecisionContext } from '../agents/agent.ts'
import { runGame } from '../../../lupa/engine.ts'
import { fullAdapter } from '../adapters/full-adapter.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../agents/rule-based-agent.ts'
import { encodeObservation } from '../observation.ts'
import { resolveRules } from '../../../howl/ruleset.ts'
import { analyzeFanaticVotesByWorld } from '../../../skoll/fanatic-analysis.ts'
import { RetarArtifactsCache, buildPossibilities } from './skoll-utils.ts'
import { makeWolfSoftLabel } from './wolf-data-collector.ts'

const DEFAULT_ROLES: Record<string, number> = {
  werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1,
  mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1,
}
const DEFAULT_REVOTE = { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const }

const SKOLL_MAX_WORLDS = 2_000_000

export type FanaticSampleMetadata = {
  gameId: number
  day: number
  seat: number
  knownWolves: number[]
  aliveCount: number
  topMargin: number
  rawWolfWinRates: Array<{ seat: number, wolfWinRate: number }>
  bestVote: number
}

export type FanaticSample = {
  observation: Float32Array
  label: Float32Array
  mask: Float32Array
  metadata: FanaticSampleMetadata
}

export type FanaticCollectorOptions = {
  numGames: number
  baseSeed: number
  minAlive: number
  minMargin: number
  temperature: number
  outputPath: string
  progressInterval: number
}

export const DEFAULT_FANATIC_COLLECTOR_OPTIONS: FanaticCollectorOptions = {
  numGames: 100,
  baseSeed: 48000,
  minAlive: 7,
  minMargin: 0,
  temperature: 0.3,
  outputPath: 'tmp/skoll-fanatic-data/samples.jsonl',
  progressInterval: 10,
}

async function collectSamplesFromGame(gameId: number, options: FanaticCollectorOptions): Promise<FanaticSample[]> {
  const samples: FanaticSample[] = []
  const roles = new Map(Object.entries(DEFAULT_ROLES) as [SystemRole, number][])
  const rules = resolveRules()
  const lupaConfig: LupaConfig = { roles, rules } as LupaConfig
  const artifactsCache = new RetarArtifactsCache()

  class CapturingFanatic implements Agent {
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
    defaultAgent: new CapturingFanatic(),
    wolfTeamAgent: new WolfTeamRuleAgent(),
    masonTeamAgent: new MasonTeamRuleAgent(),
    onRolesAssigned: () => {},
    seed: options.baseSeed + gameId,
    enableRetar: true,
    roles,
    rules,
  })

  await runGame(
    { roles, seed: options.baseSeed + gameId, hasFirstGhost: true, revoteConfig: DEFAULT_REVOTE },
    handlers,
  )

  return samples
}

function tryCaptureSample(
  ctx: DecisionContext,
  gameId: number,
  options: FanaticCollectorOptions,
  samples: FanaticSample[],
  lupaConfig: LupaConfig,
  artifactsCache: RetarArtifactsCache,
): void {
  if (ctx.myRole !== 'fanatic') return
  if (ctx.knownWolves === null) return

  const globalPoss = ctx.globalRetarPossibilities
  if (!globalPoss) return

  const artifacts = artifactsCache.get(ctx, lupaConfig)
  if (!artifacts) return

  const aliveSeats: number[] = []
  for (const [seat, status] of artifacts.vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }
  if (aliveSeats.length < options.minAlive) return

  const knownWolves = new Set<number>(ctx.knownWolves)
  const possibilities = buildPossibilities(globalPoss, artifacts.setup)
  let analysis
  try {
    analysis = analyzeFanaticVotesByWorld(possibilities, artifacts.setup, artifacts.vs, knownWolves, ctx.mySeat, SKOLL_MAX_WORLDS)
  } catch {
    return
  }
  if (analysis.truncated) return
  if (analysis.bestVote === null) return

  const { label, mask, topMargin } = makeWolfSoftLabel(analysis.candidates, options.temperature)
  if (topMargin < options.minMargin) return

  samples.push({
    observation: encodeObservation(ctx),
    label,
    mask,
    metadata: {
      gameId,
      day: ctx.day,
      seat: ctx.mySeat,
      knownWolves: [...ctx.knownWolves],
      aliveCount: aliveSeats.length,
      topMargin,
      rawWolfWinRates: analysis.candidates
        .filter(c => !c.isTeammate)
        .map(c => ({ seat: c.seat, wolfWinRate: c.wolfWinRate })),
      bestVote: analysis.bestVote,
    },
  })
}

export function writeFanaticSamplesAsJsonl(samples: FanaticSample[], outputPath: string): void {
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

export async function collectAndSaveFanatic(opts: Partial<FanaticCollectorOptions> = {}): Promise<{
  numSamples: number
  outputPath: string
  marginStats: { p10: number, p50: number, p90: number, mean: number }
}> {
  const options = { ...DEFAULT_FANATIC_COLLECTOR_OPTIONS, ...opts }
  process.stderr.write(`[fanatic-collect] running ${options.numGames} games (seed ${options.baseSeed}..)\n`)

  const allSamples: FanaticSample[] = []
  for (let g = 0; g < options.numGames; g++) {
    const s = await collectSamplesFromGame(g, options)
    allSamples.push(...s)
    if ((g + 1) % options.progressInterval === 0) {
      process.stderr.write(`[fanatic-collect] ${g + 1}/${options.numGames} games, ${allSamples.length} samples\n`)
    }
  }

  writeFanaticSamplesAsJsonl(allSamples, options.outputPath)

  const margins = allSamples.map(s => s.metadata.topMargin).sort((a, b) => a - b)
  const pct = (p: number) => margins[Math.min(margins.length - 1, Math.floor(p * margins.length))] ?? 0
  const meanMargin = margins.length > 0 ? margins.reduce((s, v) => s + v, 0) / margins.length : 0

  process.stderr.write(`[fanatic-collect] === Done ===\n`)
  process.stderr.write(`[fanatic-collect] samples: ${allSamples.length}\n`)
  process.stderr.write(`[fanatic-collect] output: ${options.outputPath}\n`)

  return {
    numSamples: allSamples.length,
    outputPath: options.outputPath,
    marginStats: { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), mean: meanMargin },
  }
}

if (process.argv[1]?.endsWith('fanatic-data-collector.ts')) {
  collectAndSaveFanatic({}).catch(err => { console.error(err); process.exit(1) })
}
