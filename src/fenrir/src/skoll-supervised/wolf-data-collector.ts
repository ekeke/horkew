/**
 * Wolf perspective skoll 教師データコレクタ
 *
 * heuristic vs heuristic でゲームを回し、wolf team の vote 機会で
 *   - 観測 (encodeCollectiveWolfObservation)
 *   - skoll soft label (analyzeWolfVotesByWorld)
 *   - mask
 * を採取して JSONL で保存する。
 *
 * mason 版 (data-collector.ts) と同じ構造。差分:
 *   - CapturingWolfTeam を wolfTeamAgent として使う
 *   - encodeCollectiveWolfObservation で観測（villageNNOutput=undefined）
 *   - analyzeWolfVotesByWorld でラベル（teammates 除外、PP shortcut 含む）
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { SystemRole } from '../../../types/index.ts'
import type { LupaConfig } from '../../../lupa/types.ts'
import type { Agent, TeamAgent, TeamDecisionContext } from '../agents/agent.ts'
import { runGame } from '../../../lupa/engine.ts'
import { fullAdapter } from '../adapters/full-adapter.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../agents/rule-based-agent.ts'
import { encodeCollectiveWolfObservation, SEATS } from '../observation.ts'
import { resolveRules } from '../../../howl/ruleset.ts'
import { analyzeWolfVotesByWorld } from '../../../skoll/wolf-vote-analysis.ts'
import { RetarArtifactsCache, buildPossibilities } from './skoll-utils.ts'

const DEFAULT_ROLES: Record<string, number> = {
  werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1,
  mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1,
}
const DEFAULT_REVOTE = { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const }

const MASK_NEG = -1e9
const SKOLL_MAX_WORLDS = 2_000_000

export type WolfSampleMetadata = {
  gameId: number
  day: number
  /** wolf team の主席 (currentActorSeat or teamSeats[0]) */
  primarySeat: number
  teamSeats: number[]
  aliveCount: number
  topMargin: number
  rawWolfWinRates: Array<{ seat: number, wolfWinRate: number }>
  bestVote: number
  /** PP 確定が trigger された場合 true */
  ppByExecution: boolean
}

export type WolfSample = {
  observation: Float32Array
  label: Float32Array
  mask: Float32Array
  metadata: WolfSampleMetadata
}

export type WolfCollectorOptions = {
  numGames: number
  baseSeed: number
  minAlive: number
  minMargin: number
  temperature: number
  outputPath: string
  progressInterval: number
}

export const DEFAULT_WOLF_COLLECTOR_OPTIONS: WolfCollectorOptions = {
  numGames: 100,
  baseSeed: 18000,
  minAlive: 7,
  minMargin: 0,
  temperature: 0.3,
  outputPath: 'tmp/skoll-wolf-data/samples.jsonl',
  progressInterval: 10,
}

/**
 * wolfWinRates から (label, mask, topMargin) を生成。
 * - alive seat の wolfWinRate を min-max 正規化 → softmax(./T)
 * - teammates seat も label に含める（マスクは alive=true）
 *   → 学習時に NN は teammates を学ぶが推論時に呼び出し側で除外できる
 *   ※ より厳密にやるなら teammates を mask=-inf にして label=0 にもできる
 */
export function makeWolfSoftLabel(
  candidates: Array<{ seat: number, wolfWinRate: number, isTeammate: boolean }>,
  temperature: number,
): { label: Float32Array, mask: Float32Array, topMargin: number } {
  const label = new Float32Array(SEATS)
  const mask = new Float32Array(SEATS)
  for (let i = 0; i < SEATS; i++) mask[i] = MASK_NEG

  // teammates 除外して評価
  const nonTeam = candidates.filter(c => !c.isTeammate)
  if (nonTeam.length === 0) return { label, mask, topMargin: 0 }

  const rates = nonTeam.map(c => c.wolfWinRate)
  const minRate = Math.min(...rates)
  const maxRate = Math.max(...rates)
  const span = maxRate - minRate

  const normalized = new Map<number, number>()
  for (const c of nonTeam) {
    if (c.seat < 1 || c.seat > SEATS) continue
    const norm = span > 0 ? (c.wolfWinRate - minRate) / span : 0
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

async function collectSamplesFromGame(gameId: number, options: WolfCollectorOptions): Promise<WolfSample[]> {
  const samples: WolfSample[] = []
  const roles = new Map(Object.entries(DEFAULT_ROLES) as [SystemRole, number][])
  const rules = resolveRules()
  const lupaConfig: LupaConfig = { roles, rules } as LupaConfig
  const artifactsCache = new RetarArtifactsCache()

  class CapturingWolfTeam implements TeamAgent {
    private inner = new WolfTeamRuleAgent()
    decideNightAction(ctx: TeamDecisionContext) { return this.inner.decideNightAction(ctx) }
    decideDayClaim(ctx: TeamDecisionContext) { return this.inner.decideDayClaim(ctx) }
    decideForecast(ctx: TeamDecisionContext) { return this.inner.decideForecast(ctx) }
    decideCommunication(ctx: TeamDecisionContext) { return this.inner.decideCommunication(ctx) }
    decideProposal(ctx: TeamDecisionContext) { return this.inner.decideProposal(ctx) }
    decideLeadershipResponse(ctx: TeamDecisionContext, p: any) { return this.inner.decideLeadershipResponse(ctx, p) }
    decideDefensiveClaim(ctx: TeamDecisionContext) { return this.inner.decideDefensiveClaim(ctx) }
    decideVote(ctx: TeamDecisionContext): number {
      tryCaptureSample(ctx, gameId, options, samples, lupaConfig, artifactsCache)
      return this.inner.decideVote(ctx)
    }
  }

  const handlers = fullAdapter({
    agents: new Map<number, Agent>(),
    defaultAgent: new RuleBasedAgent(),
    wolfTeamAgent: new CapturingWolfTeam(),
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
  ctx: TeamDecisionContext,
  gameId: number,
  options: WolfCollectorOptions,
  samples: WolfSample[],
  lupaConfig: LupaConfig,
  artifactsCache: RetarArtifactsCache,
): void {
  // 自席 = wolf 確定だが、汎用 check として myRole 確認（CapturingWolfTeam なので werewolf）
  if (ctx.myRole !== 'werewolf') return

  const globalPoss = ctx.globalRetarPossibilities
  if (!globalPoss) return

  const artifacts = artifactsCache.get(ctx, lupaConfig)
  if (!artifacts) return

  const aliveSeats: number[] = []
  for (const [seat, status] of artifacts.vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }
  if (aliveSeats.length < options.minAlive) return

  // wolf team は ctx.teamSeats から取得（自席含む）
  const knownWolves = new Set<number>(ctx.teamSeats)

  const possibilities = buildPossibilities(globalPoss, artifacts.setup)
  let analysis
  try {
    analysis = analyzeWolfVotesByWorld(possibilities, artifacts.setup, artifacts.vs, knownWolves, SKOLL_MAX_WORLDS)
  } catch {
    return
  }
  if (analysis.truncated) return
  if (analysis.bestVote === null) return

  const { label, mask, topMargin } = makeWolfSoftLabel(analysis.candidates, options.temperature)
  if (topMargin < options.minMargin) return

  samples.push({
    observation: encodeCollectiveWolfObservation(ctx),
    label,
    mask,
    metadata: {
      gameId,
      day: ctx.day,
      primarySeat: ctx.currentActorSeat ?? ctx.teamSeats[0],
      teamSeats: [...ctx.teamSeats],
      aliveCount: aliveSeats.length,
      topMargin,
      rawWolfWinRates: analysis.candidates
        .filter(c => !c.isTeammate)
        .map(c => ({ seat: c.seat, wolfWinRate: c.wolfWinRate })),
      bestVote: analysis.bestVote,
      ppByExecution: analysis.ppByExecution.length > 0,
    },
  })
}

export function writeWolfSamplesAsJsonl(samples: WolfSample[], outputPath: string): void {
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

export async function collectAndSaveWolf(opts: Partial<WolfCollectorOptions> = {}): Promise<{
  numSamples: number
  outputPath: string
  marginStats: { p10: number, p50: number, p90: number, mean: number }
}> {
  const options = { ...DEFAULT_WOLF_COLLECTOR_OPTIONS, ...opts }
  process.stderr.write(`[wolf-collect] running ${options.numGames} games (seed ${options.baseSeed}..)\n`)

  const allSamples: WolfSample[] = []
  for (let g = 0; g < options.numGames; g++) {
    const s = await collectSamplesFromGame(g, options)
    allSamples.push(...s)
    if ((g + 1) % options.progressInterval === 0) {
      process.stderr.write(`[wolf-collect] ${g + 1}/${options.numGames} games, ${allSamples.length} samples\n`)
    }
  }

  writeWolfSamplesAsJsonl(allSamples, options.outputPath)

  const margins = allSamples.map(s => s.metadata.topMargin).sort((a, b) => a - b)
  const pct = (p: number) => margins[Math.min(margins.length - 1, Math.floor(p * margins.length))] ?? 0
  const meanMargin = margins.length > 0 ? margins.reduce((s, v) => s + v, 0) / margins.length : 0

  const result = {
    numSamples: allSamples.length,
    outputPath: options.outputPath,
    marginStats: { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), mean: meanMargin },
  }

  process.stderr.write(`[wolf-collect] === Done ===\n`)
  process.stderr.write(`[wolf-collect] samples: ${result.numSamples}\n`)
  process.stderr.write(`[wolf-collect] margin: p10=${result.marginStats.p10.toFixed(3)} p50=${result.marginStats.p50.toFixed(3)} p90=${result.marginStats.p90.toFixed(3)} mean=${result.marginStats.mean.toFixed(3)}\n`)
  process.stderr.write(`[wolf-collect] output: ${result.outputPath}\n`)

  return result
}

function parseCli(): Partial<WolfCollectorOptions> {
  const opts: Partial<WolfCollectorOptions> = {}
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
      case '--help':
        process.stderr.write('Usage: wolf-data-collector.ts [--games N] [--seed S] [--min-alive K] [--min-margin M] [--temperature T] [--output PATH] [--progress N]\n')
        process.exit(0)
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('wolf-data-collector.ts')) {
  collectAndSaveWolf(parseCli()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
