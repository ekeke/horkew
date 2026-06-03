/**
 * Stage 0: 観測十分性の診断
 *
 * NN 観測 (1209 dims) に skoll が必要とする情報が含まれているかを検証する。
 * 致命的観測穴 = (観測コサイン類似度 > THR_COS) かつ (skoll winRate L2 距離 > THR_L2) なペア。
 *
 * GO/NOGO 判定: 致命的観測穴ゼロなら Stage 1 へ進める。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { SystemRole, VillageStatus } from '../../../types/index.ts'
import type { GameEvent, LupaConfig } from '../../../lupa/types.ts'
import type { Agent, DecisionContext, TeamAgent } from '../agents/agent.ts'
import { runGame } from '../../../lupa/engine.ts'
import { fullAdapter } from '../adapters/full-adapter.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../agents/rule-based-agent.ts'
import { encodeObservation, SEATS } from '../observation.ts'
import { resolveRegulation } from '../../../howl/ruleset.ts'
import { alivePlayers } from '../../../lupa/roles.ts'
import { Possibilities, possibilityFromRoles, RoleBitIndex } from '../../../retar/possibilities.ts'
import { analyzeExecutionsByWorld } from '../../../skoll/world-analysis.ts'
import { analyzePerPlayer as retarAnalyzePerPlayer } from '../retar-bridge.ts'

const DEFAULT_ROLES: Record<string, number> = {
  werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1,
  mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1,
}
const DEFAULT_REVOTE = { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const }

const VILLAGE_ROLES: Set<SystemRole> = new Set(['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata'])

type Sample = {
  gameId: number
  day: number
  seat: number
  role: SystemRole
  aliveCount: number
  observation: Float32Array
  /** length = SEATS, 0.0 for dead seats, winRate ∈ [-0.5, 1.0] otherwise */
  winRates: Float32Array
  /** alive seat の最大 winRate と 2nd の差 */
  topMargin: number
}

type DiagnoseOptions = {
  numGames: number
  minAlive: number
  baseSeed: number
  /** obs L2 がこれ未満で winRates L2 がこれ以上 → 異常ペア */
  obsCloseThreshold: number
  winRatesFarThreshold: number
  topPairs: number
  outputPath: string
  /** GO 判定: Pearson 相関がこれ以上なら観測十分 */
  minCorrelation: number
}

const DEFAULT_OPTIONS: DiagnoseOptions = {
  numGames: 50,
  minAlive: 7,
  baseSeed: 7000,
  obsCloseThreshold: 0.5,
  winRatesFarThreshold: 0.3,
  topPairs: 50,
  outputPath: 'tmp/skoll-diag/report.json',
  minCorrelation: 0.3,
}

/**
 * vs/setup を per-day キャッシュしながら算出する。
 * full-adapter の retar とは別に走らせるが、頻度は 1 day につき 1 回。
 */
class RetarArtifactsCache {
  private cachedDay: number = -1
  private cachedArtifacts: { vs: VillageStatus; setup: Map<SystemRole, number> } | null = null

  get(ctx: DecisionContext, lupaConfig: LupaConfig): { vs: VillageStatus; setup: Map<SystemRole, number> } | null {
    const day = ctx.day
    const phase = ctx.phase
    const cacheKey = day * 2 + (phase === 'day' ? 1 : 0)
    if (this.cachedDay === cacheKey && this.cachedArtifacts) return this.cachedArtifacts

    const events = ctx.publicEvents as GameEvent[]
    const alives = alivePlayers(ctx.gameState)
    let ppResult
    try {
      ppResult = retarAnalyzePerPlayer(events, ctx.gameState, lupaConfig, alives)
    } catch {
      return null
    }
    if (!ppResult.vs || !ppResult.setup) return null

    this.cachedDay = cacheKey
    this.cachedArtifacts = { vs: ppResult.vs, setup: ppResult.setup }
    return this.cachedArtifacts
  }

  reset() {
    this.cachedDay = -1
    this.cachedArtifacts = null
  }
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

async function collectSamplesFromGame(gameId: number, options: DiagnoseOptions): Promise<Sample[]> {
  const samples: Sample[] = []
  const roles = new Map(Object.entries(DEFAULT_ROLES) as [SystemRole, number][])
  const rules = resolveRegulation()
  const lupaConfig: LupaConfig = { roles, rules } as LupaConfig
  const artifactsCache = new RetarArtifactsCache()

  class CapturingStrategy implements Agent {
    private inner = new RuleBasedAgent()

    decideNightAction(ctx: DecisionContext) { return this.inner.decideNightAction(ctx) }
    decideDayClaim(ctx: DecisionContext) { return this.inner.decideDayClaim(ctx) }
    decideForecast(ctx: DecisionContext) { return this.inner.decideForecast(ctx) }
    decideCommunication(ctx: DecisionContext) { return this.inner.decideCommunication(ctx) }
    decideProposal(ctx: DecisionContext) { return this.inner.decideProposal(ctx) }
    decideLeadershipResponse(ctx: DecisionContext, proposal: any) { return this.inner.decideLeadershipResponse(ctx, proposal) }
    decideDefensiveClaim(ctx: DecisionContext) { return this.inner.decideDefensiveClaim(ctx) }

    decideVote(ctx: DecisionContext): number {
      tryCaptureSample(ctx, gameId, options, samples, lupaConfig, artifactsCache)
      return this.inner.decideVote(ctx)
    }
  }

  // Mason team agent をラップして mason vote も capture
  class CapturingMasonTeam implements TeamAgent {
    private inner = new MasonTeamRuleAgent()

    decideNightAction(ctx: any) { return this.inner.decideNightAction(ctx) }
    decideDayClaim(ctx: any) { return this.inner.decideDayClaim(ctx) }
    decideForecast(ctx: any) { return this.inner.decideForecast(ctx) }
    decideCommunication(ctx: any) { return this.inner.decideCommunication(ctx) }
    decideProposal(ctx: any) { return this.inner.decideProposal(ctx) }
    decideLeadershipResponse(ctx: any, proposal: any) { return this.inner.decideLeadershipResponse(ctx, proposal) }
    decideDefensiveClaim(ctx: any) { return this.inner.decideDefensiveClaim(ctx) }

    decideVote(ctx: any): number {
      tryCaptureSample(ctx, gameId, options, samples, lupaConfig, artifactsCache)
      return this.inner.decideVote(ctx)
    }
  }

  const handlers = fullAdapter({
    agents: new Map<number, Agent>(),
    defaultAgent: new CapturingStrategy(),
    wolfTeamAgent: new WolfTeamRuleAgent(),
    masonTeamAgent: new CapturingMasonTeam(),
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
  options: DiagnoseOptions,
  samples: Sample[],
  lupaConfig: LupaConfig,
  artifactsCache: RetarArtifactsCache,
): void {
  if (!VILLAGE_ROLES.has(ctx.myRole)) return

  const globalPoss = ctx.globalRetarPossibilities
  if (!globalPoss) return

  const artifacts = artifactsCache.get(ctx, lupaConfig)
  if (!artifacts) return

  const aliveSeats: number[] = []
  for (const [seat, status] of artifacts.vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }
  if (aliveSeats.length < options.minAlive) return

  let masonAlive = false
  for (const seat of aliveSeats) {
    const player = ctx.gameState.players.find(p => p.seat === seat)
    if (player?.role === 'mason') { masonAlive = true; break }
  }
  if (!masonAlive) return

  const possibilities = buildPossibilities(globalPoss, artifacts.setup)

  let analysis
  try {
    analysis = analyzeExecutionsByWorld(possibilities, artifacts.setup, artifacts.vs, 2_000_000)
  } catch {
    return
  }
  if (analysis.truncated) return

  const winRates = new Float32Array(SEATS)
  for (const exe of analysis.executions) {
    if (exe.seat >= 1 && exe.seat <= SEATS) {
      winRates[exe.seat - 1] = exe.winRate
    }
  }

  const sortedRates = [...analysis.executions].map(e => e.winRate).sort((a, b) => b - a)
  const topMargin = sortedRates.length >= 2 ? sortedRates[0] - sortedRates[1] : 0

  samples.push({
    gameId,
    day: ctx.day,
    seat: ctx.mySeat,
    role: ctx.myRole,
    aliveCount: aliveSeats.length,
    observation: encodeObservation(ctx),
    winRates,
    topMargin,
  })
}

function l2Dist(a: Float32Array, b: Float32Array): number {
  let sum = 0
  const n = a.length
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return Math.sqrt(sum)
}

function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n === 0) return 0
  let sx = 0, sy = 0
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i] }
  const mx = sx / n, my = sy / n
  let num = 0, dx2 = 0, dy2 = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my
    num += dx * dy
    dx2 += dx * dx
    dy2 += dy * dy
  }
  const denom = Math.sqrt(dx2) * Math.sqrt(dy2)
  return denom > 0 ? num / denom : 0
}

type PairStat = {
  i: number
  j: number
  obsL2: number
  wrL2: number
}

type DiagnoseReport = {
  options: DiagnoseOptions
  numSamples: number
  /** obs L2 と winRates L2 の Pearson 相関 (高いほど観測十分) */
  pearsonCorrelation: number
  /** 異常ペア: obs が近い (< obsCloseThreshold) のに winRates が遠い (> winRatesFarThreshold) */
  numAnomalousPairs: number
  anomalousPairs: Array<PairStat & {
    sampleI: { gameId: number, day: number, seat: number, role: SystemRole, aliveCount: number }
    sampleJ: { gameId: number, day: number, seat: number, role: SystemRole, aliveCount: number }
  }>
  obsL2Stats: { min: number, max: number, mean: number, p10: number, p50: number, p90: number }
  wrL2Stats: { min: number, max: number, mean: number, p10: number, p50: number, p90: number }
  topMarginStats: { min: number, max: number, mean: number, p10: number, p50: number, p90: number }
  verdict: 'GO' | 'NOGO'
}

function summary(values: number[]): { min: number, max: number, mean: number, p10: number, p50: number, p90: number } {
  if (values.length === 0) return { min: 0, max: 0, mean: 0, p10: 0, p50: 0, p90: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const sum = values.reduce((s, v) => s + v, 0)
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / values.length,
    p10: pct(0.1),
    p50: pct(0.5),
    p90: pct(0.9),
  }
}

function describeSample(s: Sample): { gameId: number, day: number, seat: number, role: SystemRole, aliveCount: number } {
  return { gameId: s.gameId, day: s.day, seat: s.seat, role: s.role, aliveCount: s.aliveCount }
}

export async function runDiagnostic(opts: Partial<DiagnoseOptions> = {}): Promise<DiagnoseReport> {
  const options = { ...DEFAULT_OPTIONS, ...opts }
  process.stderr.write(`[skoll-diag] running ${options.numGames} games (seed ${options.baseSeed}..)\n`)

  const samples: Sample[] = []
  for (let g = 0; g < options.numGames; g++) {
    const s = await collectSamplesFromGame(g, options)
    samples.push(...s)
    if ((g + 1) % 10 === 0) {
      process.stderr.write(`[skoll-diag] ${g + 1}/${options.numGames} games, ${samples.length} samples so far\n`)
    }
  }

  process.stderr.write(`[skoll-diag] ${samples.length} samples collected, computing pairs...\n`)

  if (samples.length > 2000) {
    process.stderr.write(`[skoll-diag] WARNING: ${samples.length} samples → ${samples.length * (samples.length - 1) / 2} pairs\n`)
  }

  const pairs: PairStat[] = []
  const obsL2s: number[] = []
  const wrL2s: number[] = []
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const obsL2 = l2Dist(samples[i].observation, samples[j].observation)
      const wrL2 = l2Dist(samples[i].winRates, samples[j].winRates)
      pairs.push({ i, j, obsL2, wrL2 })
      obsL2s.push(obsL2)
      wrL2s.push(wrL2)
    }
  }

  const correlation = pearsonCorrelation(obsL2s, wrL2s)

  // 異常ペア: obs が近いのに winRates が遠い (NN-indistinguishable だが skoll は区別する)
  const anomalous = pairs.filter(
    p => p.obsL2 < options.obsCloseThreshold && p.wrL2 > options.winRatesFarThreshold,
  )

  // top 異常ペアを obs L2 昇順で
  anomalous.sort((a, b) => a.obsL2 - b.obsL2)
  const anomalousDetail = anomalous.slice(0, options.topPairs).map(p => ({
    ...p,
    sampleI: describeSample(samples[p.i]),
    sampleJ: describeSample(samples[p.j]),
  }))

  const verdict: 'GO' | 'NOGO' = correlation >= options.minCorrelation && anomalous.length === 0
    ? 'GO'
    : 'NOGO'

  const report: DiagnoseReport = {
    options,
    numSamples: samples.length,
    pearsonCorrelation: correlation,
    numAnomalousPairs: anomalous.length,
    anomalousPairs: anomalousDetail,
    obsL2Stats: summary(obsL2s),
    wrL2Stats: summary(wrL2s),
    topMarginStats: summary(samples.map(s => s.topMargin)),
    verdict,
  }

  mkdirSync(dirname(options.outputPath), { recursive: true })
  writeFileSync(options.outputPath, JSON.stringify(report, null, 2))

  process.stderr.write(`[skoll-diag] === Result ===\n`)
  process.stderr.write(`[skoll-diag] samples: ${report.numSamples}\n`)
  process.stderr.write(`[skoll-diag] obs  L2: min=${report.obsL2Stats.min.toFixed(2)} p50=${report.obsL2Stats.p50.toFixed(2)} p90=${report.obsL2Stats.p90.toFixed(2)} max=${report.obsL2Stats.max.toFixed(2)}\n`)
  process.stderr.write(`[skoll-diag] wr   L2: min=${report.wrL2Stats.min.toFixed(2)} p50=${report.wrL2Stats.p50.toFixed(2)} p90=${report.wrL2Stats.p90.toFixed(2)} max=${report.wrL2Stats.max.toFixed(2)}\n`)
  process.stderr.write(`[skoll-diag] Pearson corr (obs L2, wr L2): ${correlation.toFixed(3)} (target ≥ ${options.minCorrelation})\n`)
  process.stderr.write(`[skoll-diag] anomalous pairs (obs L2 < ${options.obsCloseThreshold}, wr L2 > ${options.winRatesFarThreshold}): ${report.numAnomalousPairs}\n`)
  process.stderr.write(`[skoll-diag] topMargin: min=${report.topMarginStats.min.toFixed(3)} p50=${report.topMarginStats.p50.toFixed(3)} max=${report.topMarginStats.max.toFixed(3)}\n`)
  process.stderr.write(`[skoll-diag] report → ${options.outputPath}\n`)
  process.stderr.write(`[skoll-diag] verdict: ${verdict}${verdict === 'GO' ? ' (Stage 1 へ)' : ' (観測拡張が必要 or 閾値見直し)'}\n`)

  return report
}

function parseCli(): Partial<DiagnoseOptions> {
  const opts: Partial<DiagnoseOptions> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--games': opts.numGames = parseInt(args[++i], 10); break
      case '--min-alive': opts.minAlive = parseInt(args[++i], 10); break
      case '--seed': opts.baseSeed = parseInt(args[++i], 10); break
      case '--obs-close': opts.obsCloseThreshold = parseFloat(args[++i]); break
      case '--wr-far': opts.winRatesFarThreshold = parseFloat(args[++i]); break
      case '--min-corr': opts.minCorrelation = parseFloat(args[++i]); break
      case '--top-pairs': opts.topPairs = parseInt(args[++i], 10); break
      case '--output': opts.outputPath = args[++i]; break
      case '--help':
        process.stderr.write('Usage: diagnose-observation.ts [--games N] [--min-alive K] [--seed S] [--obs-close T] [--wr-far T] [--min-corr T] [--top-pairs M] [--output PATH]\n')
        process.exit(0)
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('diagnose-observation.ts')) {
  runDiagnostic(parseCli()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
