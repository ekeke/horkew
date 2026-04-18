/**
 * Immoralist (背徳者) perspective skoll 教師データコレクタ
 *
 * hamster-data-collector とほぼ同じ。差分:
 *   - role フィルタ = 'immoralist'
 *   - analyzeImmoralistVotesByWorld (ctx.knownHamster 必須)
 *   - 自席 (immoralist) 除外不要、狐席 (knownHamster) のみ bestVote から除外
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
import { analyzeImmoralistVotesByWorld } from '../../../skoll/immoralist-analysis.ts'
import { RetarArtifactsCache, buildPossibilities } from './skoll-utils.ts'
import { makeHamsterSoftLabel } from './hamster-data-collector.ts'

const DEFAULT_ROLES: Record<string, number> = {
  werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1,
  mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1,
}
const DEFAULT_REVOTE = { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const }

const SKOLL_MAX_WORLDS = 2_000_000

export type ImmoralistSampleMetadata = {
  gameId: number
  day: number
  seat: number
  knownHamster: number
  aliveCount: number
  topMargin: number
  rawHamsterWinRates: Array<{ seat: number, hamsterWinRate: number }>
  bestVote: number
}

export type ImmoralistSample = {
  observation: Float32Array
  label: Float32Array
  mask: Float32Array
  metadata: ImmoralistSampleMetadata
}

export type ImmoralistCollectorOptions = {
  numGames: number
  baseSeed: number
  minAlive: number
  minMargin: number
  temperature: number
  outputPath: string
  progressInterval: number
}

export const DEFAULT_IMMORALIST_COLLECTOR_OPTIONS: ImmoralistCollectorOptions = {
  numGames: 100,
  baseSeed: 38000,
  minAlive: 7,
  minMargin: 0,
  temperature: 0.3,
  outputPath: 'tmp/skoll-immoralist-data/samples.jsonl',
  progressInterval: 10,
}

async function collectSamplesFromGame(gameId: number, options: ImmoralistCollectorOptions): Promise<ImmoralistSample[]> {
  const samples: ImmoralistSample[] = []
  const roles = new Map(Object.entries(DEFAULT_ROLES) as [SystemRole, number][])
  const rules = resolveRules()
  const lupaConfig: LupaConfig = { roles, rules } as LupaConfig
  const artifactsCache = new RetarArtifactsCache()

  class CapturingImmoralist implements Agent {
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
    defaultAgent: new CapturingImmoralist(),
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
  options: ImmoralistCollectorOptions,
  samples: ImmoralistSample[],
  lupaConfig: LupaConfig,
  artifactsCache: RetarArtifactsCache,
): void {
  if (ctx.myRole !== 'immoralist') return
  if (ctx.knownHamster === null) return

  const globalPoss = ctx.globalRetarPossibilities
  if (!globalPoss) return

  const artifacts = artifactsCache.get(ctx, lupaConfig)
  if (!artifacts) return

  const aliveSeats: number[] = []
  for (const [seat, status] of artifacts.vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }
  if (aliveSeats.length < options.minAlive) return
  if (!aliveSeats.includes(ctx.knownHamster)) return  // 狐既に死亡 → 背徳者は負け確なので skip

  const possibilities = buildPossibilities(globalPoss, artifacts.setup)
  let analysis
  try {
    analysis = analyzeImmoralistVotesByWorld(possibilities, artifacts.setup, artifacts.vs, ctx.knownHamster, SKOLL_MAX_WORLDS)
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
      knownHamster: ctx.knownHamster,
      aliveCount: aliveSeats.length,
      topMargin,
      rawHamsterWinRates: analysis.candidates
        .filter(c => !c.isSelf)
        .map(c => ({ seat: c.seat, hamsterWinRate: c.hamsterWinRate })),
      bestVote: analysis.bestVote,
    },
  })
}

export function writeImmoralistSamplesAsJsonl(samples: ImmoralistSample[], outputPath: string): void {
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

export async function collectAndSaveImmoralist(opts: Partial<ImmoralistCollectorOptions> = {}): Promise<{
  numSamples: number
  outputPath: string
  marginStats: { p10: number, p50: number, p90: number, mean: number }
}> {
  const options = { ...DEFAULT_IMMORALIST_COLLECTOR_OPTIONS, ...opts }
  process.stderr.write(`[immoralist-collect] running ${options.numGames} games (seed ${options.baseSeed}..)\n`)

  const allSamples: ImmoralistSample[] = []
  for (let g = 0; g < options.numGames; g++) {
    const s = await collectSamplesFromGame(g, options)
    allSamples.push(...s)
    if ((g + 1) % options.progressInterval === 0) {
      process.stderr.write(`[immoralist-collect] ${g + 1}/${options.numGames} games, ${allSamples.length} samples\n`)
    }
  }

  writeImmoralistSamplesAsJsonl(allSamples, options.outputPath)

  const margins = allSamples.map(s => s.metadata.topMargin).sort((a, b) => a - b)
  const pct = (p: number) => margins[Math.min(margins.length - 1, Math.floor(p * margins.length))] ?? 0
  const meanMargin = margins.length > 0 ? margins.reduce((s, v) => s + v, 0) / margins.length : 0

  process.stderr.write(`[immoralist-collect] === Done ===\n`)
  process.stderr.write(`[immoralist-collect] samples: ${allSamples.length}\n`)
  process.stderr.write(`[immoralist-collect] output: ${options.outputPath}\n`)

  return {
    numSamples: allSamples.length,
    outputPath: options.outputPath,
    marginStats: { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), mean: meanMargin },
  }
}

if (process.argv[1]?.endsWith('immoralist-data-collector.ts')) {
  collectAndSaveImmoralist({}).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
