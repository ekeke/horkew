/**
 * Stage 1: skoll 教師データコレクタ
 *
 * heuristic vs heuristic でゲームを回し、各村陣営の vote 機会で
 *   - 観測（NN 入力 1209 dims）
 *   - skoll soft label（SEATS=14 dims、softmax 確率）
 *   - additive mask（生存 seat のみ valid、死亡 seat は -inf）
 * を採取して JSONL で disk に保存する。
 *
 * 採取条件フィルタ:
 *   - VILLAGE_ROLES のみ（mason 含む）
 *   - alive >= minAlive（skoll 終盤近似精度低下回避）
 *   - mason 生存中のみ（mason 死後 cached plan 期はスコープ外）
 *   - top1 - top2 winRate margin >= minMargin（識別不能盤面除外、デフォルト 0 = フィルタなし）
 *
 * Soft label 生成:
 *   1. alive seats の winRates を min-max 正規化 → [0, 1]
 *   2. softmax(normalized / temperature) で確率分布化
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { SystemRole } from '../../../types/index.ts'
import type { LupaConfig } from '../../../lupa/types.ts'
import type { Agent, TeamAgent, TeamDecisionContext } from '../agents/agent.ts'
import { runGame } from '../../../lupa/engine.ts'
import { fullAdapter } from '../adapters/full-adapter.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../agents/rule-based-agent.ts'
import { encodeCollectiveMasonObservation, SEATS } from '../observation.ts'
import { resolveRegulation } from '../../../howl/ruleset.ts'
import { analyzeExecutionsByWorld } from '../../../skoll/world-analysis.ts'
import { RetarArtifactsCache, buildPossibilities } from './skoll-utils.ts'

const DEFAULT_ROLES: Record<string, number> = {
  werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1,
  mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1,
}
const DEFAULT_REVOTE = { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const }

/** マスクの additive 値（softmax で 0 になる十分大きな負値） */
const MASK_NEG = -1e9

/** skoll の打ち切り閾値（default 500K の 4x）。truncated を減らすことで有効 sample が増える */
const SKOLL_MAX_WORLDS = 2_000_000

export type SkollSampleMetadata = {
  gameId: number
  day: number
  seat: number
  role: SystemRole
  aliveCount: number
  topMargin: number
  /** alive seat のみ {seat, winRate}、dead は含まない */
  rawWinRates: Array<{ seat: number, winRate: number }>
  bestExecution: number
}

export type SkollSample = {
  observation: Float32Array
  label: Float32Array
  mask: Float32Array
  metadata: SkollSampleMetadata
}

export type CollectorOptions = {
  numGames: number
  baseSeed: number
  minAlive: number
  /** 0 でフィルタなし。0.05 程度で識別不能盤面を除外 */
  minMargin: number
  /** softmax 温度（小さいほど argmax 寄り、大きいほど uniform 寄り） */
  temperature: number
  /** mason 生存中のみ採取するか */
  requireMasonAlive: boolean
  outputPath: string
  /** 進捗ログ間隔（ゲーム数） */
  progressInterval: number
}

export const DEFAULT_COLLECTOR_OPTIONS: CollectorOptions = {
  numGames: 100,
  baseSeed: 8000,
  minAlive: 7,
  minMargin: 0,
  temperature: 0.3,
  requireMasonAlive: true,
  outputPath: 'tmp/skoll-data/samples.jsonl',
  progressInterval: 10,
}

/**
 * winRates から (label, mask, topMargin) を生成する。
 * - alive seat の winRate を min-max 正規化 → softmax(./T)
 * - dead seat の mask は MASK_NEG
 */
export function makeSoftLabel(
  executions: Array<{ seat: number, winRate: number }>,
  temperature: number,
): { label: Float32Array, mask: Float32Array, topMargin: number } {
  const label = new Float32Array(SEATS)
  const mask = new Float32Array(SEATS)
  for (let i = 0; i < SEATS; i++) mask[i] = MASK_NEG

  if (executions.length === 0) return { label, mask, topMargin: 0 }

  const rates = executions.map(e => e.winRate)
  const minRate = Math.min(...rates)
  const maxRate = Math.max(...rates)
  const span = maxRate - minRate

  // alive 標識 + 正規化値計算
  const normalized = new Map<number, number>()
  for (const e of executions) {
    if (e.seat < 1 || e.seat > SEATS) continue
    const norm = span > 0 ? (e.winRate - minRate) / span : 0
    normalized.set(e.seat, norm)
    mask[e.seat - 1] = 0
  }

  // softmax (alive seats のみ)
  const expSum = [...normalized.values()].reduce((s, v) => s + Math.exp(v / temperature), 0)
  for (const [seat, norm] of normalized) {
    label[seat - 1] = Math.exp(norm / temperature) / expSum
  }

  // top1-top2 margin（生 winRate ベース、フィルタ用）
  const sortedRates = [...rates].sort((a, b) => b - a)
  const topMargin = sortedRates.length >= 2 ? sortedRates[0] - sortedRates[1] : 0

  return { label, mask, topMargin }
}

async function collectSamplesFromGame(gameId: number, options: CollectorOptions): Promise<SkollSample[]> {
  const samples: SkollSample[] = []
  const roles = new Map(Object.entries(DEFAULT_ROLES) as [SystemRole, number][])
  const rules = resolveRegulation()
  const lupaConfig: LupaConfig = { roles, rules } as LupaConfig
  const artifactsCache = new RetarArtifactsCache()

  // mason team perspective でのみ採取する。
  // 学習対象は brain-battle の mason_brain ネット (input=MASON_COLLECTIVE_OBSERVATION_SIZE)。
  class CapturingMasonTeam implements TeamAgent {
    private inner = new MasonTeamRuleAgent()
    decideNightAction(ctx: TeamDecisionContext) { return this.inner.decideNightAction(ctx) }
    decideDayClaim(ctx: TeamDecisionContext) { return this.inner.decideDayClaim(ctx) }
    decideForecast(ctx: TeamDecisionContext) { return this.inner.decideForecast(ctx) }
    decideCommunication(ctx: TeamDecisionContext) { return this.inner.decideCommunication(ctx) }
    decideProposal(ctx: TeamDecisionContext) { return this.inner.decideProposal(ctx) }
    decideLeadershipResponse(ctx: TeamDecisionContext, proposal: any) { return this.inner.decideLeadershipResponse(ctx, proposal) }
    decideDefensiveClaim(ctx: TeamDecisionContext) { return this.inner.decideDefensiveClaim(ctx) }
    decideVote(ctx: TeamDecisionContext): number {
      tryCaptureSample(ctx, gameId, options, samples, lupaConfig, artifactsCache)
      return this.inner.decideVote(ctx)
    }
  }

  const handlers = fullAdapter({
    agents: new Map<number, Agent>(),
    defaultAgent: new RuleBasedAgent(),  // 非 mason は heuristic で進める
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
  ctx: TeamDecisionContext,
  gameId: number,
  options: CollectorOptions,
  samples: SkollSample[],
  lupaConfig: LupaConfig,
  artifactsCache: RetarArtifactsCache,
): void {
  // mason 限定（呼び出し元が CapturingMasonTeam なので myRole は基本 mason）
  if (ctx.myRole !== 'mason') return

  const globalPoss = ctx.globalRetarPossibilities
  if (!globalPoss) return

  const artifacts = artifactsCache.get(ctx, lupaConfig)
  if (!artifacts) return

  const aliveSeats: number[] = []
  for (const [seat, status] of artifacts.vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }
  if (aliveSeats.length < options.minAlive) return

  // requireMasonAlive は mason perspective からの採取なので自明に満たされる

  const possibilities = buildPossibilities(globalPoss, artifacts.setup)
  let analysis
  try {
    analysis = analyzeExecutionsByWorld(possibilities, artifacts.setup, artifacts.vs, SKOLL_MAX_WORLDS)
  } catch {
    return
  }

  // 打ち切りサンプルは winRate が近似値で signal が歪むので除外
  if (analysis.truncated) return

  const { label, mask, topMargin } = makeSoftLabel(analysis.executions, options.temperature)
  if (topMargin < options.minMargin) return

  samples.push({
    observation: encodeCollectiveMasonObservation(ctx),
    label,
    mask,
    metadata: {
      gameId,
      day: ctx.day,
      seat: ctx.mySeat,
      role: ctx.myRole,
      aliveCount: aliveSeats.length,
      topMargin,
      rawWinRates: analysis.executions.map(e => ({ seat: e.seat, winRate: e.winRate })),
      bestExecution: analysis.bestExecution,
    },
  })
}

/**
 * バッチ全体を1ファイルに JSONL で書き出す。
 * 各行 = 1 サンプル。observation/label/mask は number[] にシリアライズ。
 */
export function writeSamplesAsJsonl(samples: SkollSample[], outputPath: string): void {
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

export async function collectAndSave(opts: Partial<CollectorOptions> = {}): Promise<{
  numSamples: number
  outputPath: string
  marginStats: { p10: number, p50: number, p90: number, mean: number }
}> {
  const options = { ...DEFAULT_COLLECTOR_OPTIONS, ...opts }
  process.stderr.write(`[skoll-collect] running ${options.numGames} games (seed ${options.baseSeed}..)\n`)

  const allSamples: SkollSample[] = []
  for (let g = 0; g < options.numGames; g++) {
    const s = await collectSamplesFromGame(g, options)
    allSamples.push(...s)
    if ((g + 1) % options.progressInterval === 0) {
      process.stderr.write(`[skoll-collect] ${g + 1}/${options.numGames} games, ${allSamples.length} samples\n`)
    }
  }

  writeSamplesAsJsonl(allSamples, options.outputPath)

  const margins = allSamples.map(s => s.metadata.topMargin).sort((a, b) => a - b)
  const pct = (p: number) => margins[Math.min(margins.length - 1, Math.floor(p * margins.length))] ?? 0
  const meanMargin = margins.length > 0 ? margins.reduce((s, v) => s + v, 0) / margins.length : 0

  const result = {
    numSamples: allSamples.length,
    outputPath: options.outputPath,
    marginStats: { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), mean: meanMargin },
  }

  process.stderr.write(`[skoll-collect] === Done ===\n`)
  process.stderr.write(`[skoll-collect] samples: ${result.numSamples}\n`)
  process.stderr.write(`[skoll-collect] margin: p10=${result.marginStats.p10.toFixed(3)} p50=${result.marginStats.p50.toFixed(3)} p90=${result.marginStats.p90.toFixed(3)} mean=${result.marginStats.mean.toFixed(3)}\n`)
  process.stderr.write(`[skoll-collect] output: ${result.outputPath}\n`)

  return result
}

function parseCli(): Partial<CollectorOptions> {
  const opts: Partial<CollectorOptions> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--games': opts.numGames = parseInt(args[++i], 10); break
      case '--seed': opts.baseSeed = parseInt(args[++i], 10); break
      case '--min-alive': opts.minAlive = parseInt(args[++i], 10); break
      case '--min-margin': opts.minMargin = parseFloat(args[++i]); break
      case '--temperature': opts.temperature = parseFloat(args[++i]); break
      case '--no-mason-required': opts.requireMasonAlive = false; break
      case '--output': opts.outputPath = args[++i]; break
      case '--progress': opts.progressInterval = parseInt(args[++i], 10); break
      case '--help':
        process.stderr.write('Usage: data-collector.ts [--games N] [--seed S] [--min-alive K] [--min-margin M] [--temperature T] [--no-mason-required] [--output PATH] [--progress N]\n')
        process.exit(0)
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('data-collector.ts')) {
  collectAndSave(parseCli()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
