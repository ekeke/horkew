/**
 * Village perspective skoll 教師データコレクタ
 *
 * 村陣営 (villager / seer / medium / bodyguard / nekomata) の vote 機会で
 *   - 観測 (encodeObservation、1029 dims standard)
 *   - skoll soft label (analyzeExecutionsByWorld、村勝率最大化目線)
 *   - mask
 * を採取して JSONL で保存する。
 *
 * mason は専用 NN (mason_brain、1030 dims) があるので除外。村陣営の中でも
 * skoll-zero の `createStandardZeroNetwork` (1029 dims) と整合する役職のみ採取する。
 *
 * 学習対象: skoll-zero curriculum の village slot (= 1029 dims standard NN)。
 * 出力 checkpoint は `src/skoll/models/village.json` に書き、phase/runner.ts:buildSlot
 * の warm-start 経路で自動的にロードされる。
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
import { analyzeExecutionsByWorld } from '../../../skoll/world-analysis.ts'
import { RetarArtifactsCache, buildPossibilities } from './skoll-utils.ts'

const DEFAULT_ROLES: Record<string, number> = {
  werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1,
  mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1,
}
const DEFAULT_REVOTE = { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const }

const MASK_NEG = -1e9
const SKOLL_MAX_WORLDS = 2_000_000

/** 採取対象の村陣営役職 (mason は専用 NN なので除外) */
const VILLAGE_INDIVIDUAL_ROLES: ReadonlySet<SystemRole> = new Set<SystemRole>([
  'villager', 'seer', 'medium', 'bodyguard', 'nekomata',
])

export type VillageSampleMetadata = {
  gameId: number
  day: number
  seat: number
  role: SystemRole
  aliveCount: number
  topMargin: number
  /** alive seat のみ {seat, winRate}、自席除外 */
  rawWinRates: Array<{ seat: number, winRate: number }>
  bestExecution: number
}

export type VillageSample = {
  observation: Float32Array
  label: Float32Array
  mask: Float32Array
  metadata: VillageSampleMetadata
}

export type VillageCollectorOptions = {
  numGames: number
  baseSeed: number
  minAlive: number
  /** 0 でフィルタなし。0.05 程度で識別不能盤面を除外 */
  minMargin: number
  /** softmax 温度 (小さいほど argmax 寄り) */
  temperature: number
  outputPath: string
  progressInterval: number
}

export const DEFAULT_VILLAGE_COLLECTOR_OPTIONS: VillageCollectorOptions = {
  numGames: 100,
  baseSeed: 38000,
  minAlive: 7,
  minMargin: 0,
  temperature: 0.3,
  outputPath: 'tmp/skoll-village-data/samples.jsonl',
  progressInterval: 10,
}

/**
 * village winRate (= 各 seat を吊った場合の村勝率) から (label, mask, topMargin) を生成。
 * 自席は除外。winRate が高い seat ほど soft label の確率が高くなる (= 吊るべき先)。
 */
export function makeVillageSoftLabel(
  candidates: Array<{ seat: number, winRate: number, isSelf: boolean }>,
  temperature: number,
): { label: Float32Array, mask: Float32Array, topMargin: number } {
  const label = new Float32Array(SEATS)
  const mask = new Float32Array(SEATS)
  for (let i = 0; i < SEATS; i++) mask[i] = MASK_NEG

  const nonSelf = candidates.filter(c => !c.isSelf)
  if (nonSelf.length === 0) return { label, mask, topMargin: 0 }

  const rates = nonSelf.map(c => c.winRate)
  const minRate = Math.min(...rates)
  const maxRate = Math.max(...rates)
  const span = maxRate - minRate

  const normalized = new Map<number, number>()
  for (const c of nonSelf) {
    if (c.seat < 1 || c.seat > SEATS) continue
    const norm = span > 0 ? (c.winRate - minRate) / span : 0
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

async function collectSamplesFromGame(gameId: number, options: VillageCollectorOptions): Promise<VillageSample[]> {
  const samples: VillageSample[] = []
  const roles = new Map(Object.entries(DEFAULT_ROLES) as [SystemRole, number][])
  const rules = resolveRegulation()
  const lupaConfig: LupaConfig = { roles, rules } as LupaConfig
  const artifactsCache = new RetarArtifactsCache()

  // village 役職の vote を capture する Agent。defaultAgent として登録、
  // tryCaptureSample で myRole フィルタ (mason / wolf / hamster / immoralist / fanatic は早期 return)
  class CapturingVillager implements Agent {
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
    defaultAgent: new CapturingVillager(),
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
  options: VillageCollectorOptions,
  samples: VillageSample[],
  lupaConfig: LupaConfig,
  artifactsCache: RetarArtifactsCache,
): void {
  // 採取対象は villager / seer / medium / bodyguard / nekomata のみ
  if (!VILLAGE_INDIVIDUAL_ROLES.has(ctx.myRole)) return

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
    analysis = analyzeExecutionsByWorld(possibilities, artifacts.setup, artifacts.vs, SKOLL_MAX_WORLDS)
  } catch {
    return
  }
  if (analysis.truncated) return
  if (analysis.executions.length === 0) return

  // analyzeExecutionsByWorld は alive 全 seat の {seat, winRate} を返す。自席判定を付与
  const candidates = analysis.executions.map(e => ({
    seat: e.seat,
    winRate: e.winRate,
    isSelf: e.seat === ctx.mySeat,
  }))
  const { label, mask, topMargin } = makeVillageSoftLabel(candidates, options.temperature)
  if (topMargin < options.minMargin) return

  samples.push({
    observation: encodeObservation(ctx),
    label,
    mask,
    metadata: {
      gameId,
      day: ctx.day,
      seat: ctx.mySeat,
      role: ctx.myRole,
      aliveCount: aliveSeats.length,
      topMargin,
      rawWinRates: candidates
        .filter(c => !c.isSelf)
        .map(c => ({ seat: c.seat, winRate: c.winRate })),
      bestExecution: analysis.bestExecution,
    },
  })
}

export function writeVillageSamplesAsJsonl(samples: VillageSample[], outputPath: string): void {
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

export async function collectAndSaveVillage(opts: Partial<VillageCollectorOptions> = {}): Promise<{
  numSamples: number
  outputPath: string
  marginStats: { p10: number, p50: number, p90: number, mean: number }
}> {
  const options = { ...DEFAULT_VILLAGE_COLLECTOR_OPTIONS, ...opts }
  process.stderr.write(`[village-collect] running ${options.numGames} games (seed ${options.baseSeed}..)\n`)

  const allSamples: VillageSample[] = []
  for (let g = 0; g < options.numGames; g++) {
    const s = await collectSamplesFromGame(g, options)
    allSamples.push(...s)
    if ((g + 1) % options.progressInterval === 0) {
      process.stderr.write(`[village-collect] ${g + 1}/${options.numGames} games, ${allSamples.length} samples\n`)
    }
  }

  writeVillageSamplesAsJsonl(allSamples, options.outputPath)

  const margins = allSamples.map(s => s.metadata.topMargin).sort((a, b) => a - b)
  const pct = (p: number) => margins[Math.min(margins.length - 1, Math.floor(p * margins.length))] ?? 0
  const meanMargin = margins.length > 0 ? margins.reduce((s, v) => s + v, 0) / margins.length : 0

  const result = {
    numSamples: allSamples.length,
    outputPath: options.outputPath,
    marginStats: { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), mean: meanMargin },
  }

  process.stderr.write(`[village-collect] === Done ===\n`)
  process.stderr.write(`[village-collect] samples: ${result.numSamples}\n`)
  process.stderr.write(`[village-collect] margin: p10=${result.marginStats.p10.toFixed(3)} p50=${result.marginStats.p50.toFixed(3)} p90=${result.marginStats.p90.toFixed(3)} mean=${result.marginStats.mean.toFixed(3)}\n`)
  process.stderr.write(`[village-collect] output: ${result.outputPath}\n`)

  return result
}

function parseCli(): Partial<VillageCollectorOptions> {
  const opts: Partial<VillageCollectorOptions> = {}
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
        process.stderr.write('Usage: village-data-collector.ts [--games N] [--seed S] [--min-alive K] [--min-margin M] [--temperature T] [--output PATH] [--progress N]\n')
        process.exit(0)
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('village-data-collector.ts')) {
  collectAndSaveVillage(parseCli()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
