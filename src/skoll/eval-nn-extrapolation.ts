/**
 * Skoll NN extrapolation evaluation
 *
 * 既存 NN (mason / wolf) は MAX_WORLDS=500K で生成した教師で学習している。
 * このスクリプトでは 14D-neko で各 vote 局面ごとに:
 *   - skoll を大 MAX (5M デフォルト) で再実行して bestVote を ground truth とする
 *   - 同じ盤面で NN forward した bestVote を取る
 *   - 一致 / 不一致を totalWorlds bucket 別に集計
 *
 * 「学習時より大きい盤面 (= totalWorlds > 500K)」での NN の正解率を見るのが主目的。
 *
 * 使い方:
 *   node --experimental-strip-types src/skoll/eval-nn-extrapolation.ts [--games=N] [--gt-max=N]
 */

import type { SystemRole, VillageStatus } from '../types/index.ts'
import type { VoteContext } from '../lupa/handlers.ts'
import type { FenrirExt } from '../fenrir/src/ext.ts'
import type { FenrirExtEvent } from '../fenrir/src/events.ts'
import type { Proposal } from '../fenrir/src/leadership.ts'
import type { TeamDecisionContext } from '../fenrir/src/agents/agent.ts'
import { runGame } from '../lupa/engine.ts'
import { StrategyBaseAdapter } from '../fenrir/src/adapters/strategy-base-adapter.ts'
import { RuleBasedAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import { buildPlayerView } from '../lupa/player-view.ts'
import { alivePlayers } from '../lupa/roles.ts'
import { SkollMasterAgent } from './skoll-master-agent.ts'
import { SkollMasonTeamAgent } from './skoll-mason-agent.ts'
import { SkollWolfTeamAgent } from './skoll-wolf-agent.ts'
import { analyzeExecutionsByWorld } from './world-analysis.ts'
import { analyzeWolfVotesByWorld } from './wolf-vote-analysis.ts'
import { unifyVillageAnalysis, unifyWolfAnalysis, nnInferVote, buildPossibilitiesFromRetar } from './unified.ts'
import { createMasonBrainNetwork, createWolfBrainNetwork } from '../fenrir/src/training.ts'
import { loadCheckpoint } from '../fenrir/src/ml/checkpoint.ts'
import { encodeCollectiveMasonObservation, encodeCollectiveWolfObservation } from '../fenrir/src/observation.ts'
import type { AnyNetwork } from '../fenrir/src/ml/nn.ts'

type PerspectiveTag = 'mason_team' | 'wolf_team'

type Record = {
  perspective: PerspectiveTag
  day: number
  groundTruthTotalWorlds: number
  groundTruthTruncated: boolean
  groundTruthBestVote: number | null
  nnBestVote: number | null
  match: boolean
}

const records: Record[] = []

// ─── Args ─────────────────────────────────────────────────────────────

const gamesArg = process.argv.find(a => a.startsWith('--games='))
const games = gamesArg ? parseInt(gamesArg.slice('--games='.length), 10) : 10
const gtMaxArg = process.argv.find(a => a.startsWith('--gt-max='))
const GROUND_TRUTH_MAX_WORLDS = gtMaxArg ? parseInt(gtMaxArg.slice('--gt-max='.length), 10) : 5_000_000

// ─── NN load ──────────────────────────────────────────────────────────

const masonNet: AnyNetwork = createMasonBrainNetwork()
loadCheckpoint(masonNet, 'src/skoll/models/mason.json')
const wolfNet: AnyNetwork = createWolfBrainNetwork()
loadCheckpoint(wolfNet, 'src/skoll/models/wolf.json')

// ─── Eval agents ──────────────────────────────────────────────────────

function getArtifacts(ctx: TeamDecisionContext): { vs: VillageStatus, setup: Map<SystemRole, number> } | null {
  const a = (ctx.gameState.ext as { retarCache?: { lastArtifacts?: { vs: VillageStatus, setup: Map<string, number> } | null } } | undefined)?.retarCache?.lastArtifacts
  if (!a?.vs || !a?.setup) return null
  return { vs: a.vs, setup: a.setup as Map<SystemRole, number> }
}

class EvalMasonAgent extends SkollMasonTeamAgent {
  override decideProposal(ctx: TeamDecisionContext): Proposal | null {
    this.measure(ctx)
    return super.decideProposal(ctx)
  }
  override decideVote(ctx: TeamDecisionContext): number {
    this.measure(ctx)
    return super.decideVote(ctx)
  }
  private measure(ctx: TeamDecisionContext) {
    const artifacts = getArtifacts(ctx)
    if (!artifacts || !ctx.globalRetarPossibilities) return
    const possibilities = buildPossibilitiesFromRetar(ctx.globalRetarPossibilities, artifacts.setup)
    const masonSeats = new Set<number>(ctx.teamSeats)

    // ground truth: 大 MAX で skoll を実行
    const gtRaw = analyzeExecutionsByWorld(possibilities, artifacts.setup, artifacts.vs, GROUND_TRUTH_MAX_WORLDS)
    if (gtRaw.totalWorlds === 0) return
    const gtUnified = unifyVillageAnalysis(gtRaw, ctx.mySeat, null)
    for (const c of gtUnified.candidates) if (masonSeats.has(c.seat)) c.excluded = true
    let gtBest: number | null = null
    let gtBestScore = -Infinity
    for (const c of gtUnified.candidates) {
      if (c.excluded) continue
      if (c.score > gtBestScore) {
        gtBestScore = c.score
        gtBest = c.seat
      }
    }

    // NN: 同じ盤面で forward
    const nnAnalysis = nnInferVote(masonNet, encodeCollectiveMasonObservation(ctx), ctx.alivePlayers, masonSeats)
    const nnBest = nnAnalysis.bestVote

    records.push({
      perspective: 'mason_team',
      day: ctx.day,
      groundTruthTotalWorlds: gtRaw.totalWorlds,
      groundTruthTruncated: gtRaw.truncated,
      groundTruthBestVote: gtBest,
      nnBestVote: nnBest,
      match: gtBest !== null && gtBest === nnBest,
    })
  }
}

class EvalWolfAgent extends SkollWolfTeamAgent {
  override decideVote(ctx: TeamDecisionContext): number {
    this.measure(ctx)
    return super.decideVote(ctx)
  }
  private measure(ctx: TeamDecisionContext) {
    const artifacts = getArtifacts(ctx)
    if (!artifacts || !ctx.globalRetarPossibilities) return
    const possibilities = buildPossibilitiesFromRetar(ctx.globalRetarPossibilities, artifacts.setup)
    const wolfSeats = new Set<number>(ctx.teamSeats)

    // ground truth: 大 MAX で wolf skoll を実行
    const gtRaw = analyzeWolfVotesByWorld(possibilities, artifacts.setup, artifacts.vs, wolfSeats, GROUND_TRUTH_MAX_WORLDS)
    if (gtRaw.totalWorlds === 0) return
    const gtUnified = unifyWolfAnalysis(gtRaw)
    const gtBest = gtUnified.bestVote

    // NN: 同じ盤面で forward
    const nnAnalysis = nnInferVote(wolfNet, encodeCollectiveWolfObservation(ctx), ctx.alivePlayers, wolfSeats)
    const nnBest = nnAnalysis.bestVote

    records.push({
      perspective: 'wolf_team',
      day: ctx.day,
      groundTruthTotalWorlds: gtRaw.totalWorlds,
      groundTruthTruncated: gtRaw.truncated,
      groundTruthBestVote: gtBest,
      nnBestVote: nnBest,
      match: gtBest !== null && gtBest === nnBest,
    })
  }
}

// ─── Adapter ──────────────────────────────────────────────────────────

class EvalAdapter extends StrategyBaseAdapter {
  protected override collectProposals(
    vctx: VoteContext<FenrirExtEvent, FenrirExt>,
    ext: FenrirExt,
  ): Proposal[] {
    if (vctx.revoteRound != null && vctx.revoteRound > 0) return []
    const state = vctx.state
    const aliveMasonPlayers = alivePlayers(state).filter(p => p.role === 'mason')
    if (aliveMasonPlayers.length === 0) return []
    const mason = aliveMasonPlayers[0]
    const view = buildPlayerView(state, mason.seat)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = this.buildCtx(vctx as any, mason, view, ext, { proposals: [] })
    const teamCtx = this.buildTeamCtx(ctx, state, 'mason', mason.seat)
    const proposal = this.config.masonTeamAgent?.decideProposal(teamCtx)
    return proposal ? [proposal] : []
  }
}

// ─── Main loop ────────────────────────────────────────────────────────

const roles = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])

console.log(`=== Skoll NN extrapolation eval (14D-neko, GT_MAX_WORLDS=${(GROUND_TRUTH_MAX_WORLDS / 1_000_000).toFixed(1)}M, N=${games}) ===\n`)

const t0 = performance.now()
let villageWins = 0, wolfWins = 0, otherWins = 0

for (let i = 0; i < games; i++) {
  const seed = i
  const adapterCfg = {
    agents: new Map(),
    defaultAgent: new SkollMasterAgent(),
    wolfTeamAgent: new EvalWolfAgent(),
    masonTeamAgent: new EvalMasonAgent(),
    enableRetar: true,
    roles,
    seed,
  }
  const handlers = new EvalAdapter(adapterCfg)
  const { state } = await runGame({ roles, seed, hasFirstGhost: true }, handlers)
  if (state.result === 'villager_won') villageWins++
  else if (state.result === 'werewolf_won') wolfWins++
  else otherWins++
}

const elapsedMs = performance.now() - t0
console.log(`村勝 ${villageWins} 狼勝 ${wolfWins} 他 ${otherWins} (elapsed ${(elapsedMs / 1000).toFixed(1)}s)\n`)

// ─── 集計: totalWorlds bucket × match rate ────────────────────────────

type BucketKey = `${PerspectiveTag}|${string}`
type BucketStat = {
  perspective: PerspectiveTag
  bucketLabel: string
  bucketLo: number
  samples: number
  matches: number
  truncated: number
}

// log-scale bucket: 0-1K / 1K-10K / 10K-100K / 100K-500K / 500K-5M / 5M+
const bucketEdges: { lo: number, label: string }[] = [
  { lo: 0, label: '<1K' },
  { lo: 1_000, label: '1K-10K' },
  { lo: 10_000, label: '10K-100K' },
  { lo: 100_000, label: '100K-500K' },
  { lo: 500_000, label: '500K-5M' },
  { lo: 5_000_000, label: '>=5M' },
]
function bucketOf(n: number): { lo: number, label: string } {
  let chosen = bucketEdges[0]
  for (const b of bucketEdges) if (n >= b.lo) chosen = b
  return chosen
}

const bucketMap = new Map<BucketKey, BucketStat>()
for (const r of records) {
  const b = bucketOf(r.groundTruthTotalWorlds)
  const key = `${r.perspective}|${b.label}` as BucketKey
  let s = bucketMap.get(key)
  if (!s) {
    s = { perspective: r.perspective, bucketLabel: b.label, bucketLo: b.lo, samples: 0, matches: 0, truncated: 0 }
    bucketMap.set(key, s)
  }
  s.samples++
  if (r.match) s.matches++
  if (r.groundTruthTruncated) s.truncated++
}

const stats = Array.from(bucketMap.values()).sort((a, b) => {
  if (a.perspective !== b.perspective) return a.perspective.localeCompare(b.perspective)
  return a.bucketLo - b.bucketLo
})

console.log('perspective   totalWorlds   samples  match-rate  (gt-truncated)')
console.log('───────────   ───────────   ───────  ──────────  ──────────────')
for (const s of stats) {
  const rate = s.samples > 0 ? (s.matches / s.samples * 100).toFixed(1) : '-'
  const trunc = s.truncated > 0 ? `${s.truncated}/${s.samples}` : '-'
  console.log(
    s.perspective.padEnd(13) + ' '
    + s.bucketLabel.padEnd(13) + ' '
    + String(s.samples).padStart(7) + '  '
    + (rate + '%').padStart(10) + '  '
    + trunc.padStart(14),
  )
}

// ─── 集計: perspective × day ──────────────────────────────────────────

console.log('\n=== Per perspective × day ===')
type DayKey = `${PerspectiveTag}|${number}`
const dayMap = new Map<DayKey, { samples: number, matches: number }>()
for (const r of records) {
  const key = `${r.perspective}|${r.day}` as DayKey
  let s = dayMap.get(key)
  if (!s) { s = { samples: 0, matches: 0 }; dayMap.set(key, s) }
  s.samples++
  if (r.match) s.matches++
}
const dayStats = Array.from(dayMap.entries()).sort()
console.log('perspective   day  samples  match-rate')
console.log('───────────   ───  ───────  ──────────')
for (const [key, s] of dayStats) {
  const [persp, day] = key.split('|')
  const rate = (s.matches / s.samples * 100).toFixed(1)
  console.log(persp.padEnd(13) + ' ' + day.padStart(3) + '  ' + String(s.samples).padStart(7) + '  ' + (rate + '%').padStart(10))
}

// ─── Per-perspective summary ──────────────────────────────────────────
console.log('\n=== Per-perspective summary ===')
const perspMap = new Map<PerspectiveTag, { samples: number, matches: number, gtTruncated: number }>()
for (const r of records) {
  let p = perspMap.get(r.perspective)
  if (!p) { p = { samples: 0, matches: 0, gtTruncated: 0 }; perspMap.set(r.perspective, p) }
  p.samples++
  if (r.match) p.matches++
  if (r.groundTruthTruncated) p.gtTruncated++
}
for (const [persp, p] of perspMap) {
  const rate = (p.matches / p.samples * 100).toFixed(1)
  console.log(`${persp.padEnd(13)} samples=${p.samples} match=${p.matches}(${rate}%) gt-truncated=${p.gtTruncated}`)
}
