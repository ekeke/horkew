/**
 * Skoll truncation 計測スクリプト
 *
 * 14D-neko 構成で N ゲーム回し、各 vote / wolf attack 局面で
 * (perspective, day, totalWorlds, truncated, source) を記録する。
 *
 * 目的: DEFAULT_MAX_WORLDS (constants.ts、現状 2_000_000) でどの perspective × Day が
 * truncate されるかを見て、引き上げ判断の材料にする。
 *
 * 使い方:
 *   node --experimental-strip-types src/skoll/measure-truncation.ts [--games=N]
 */

import type { SystemRole } from '../types/index.ts'
import type { VoteContext } from '../lupa/handlers.ts'
import type { FenrirExt } from '../fenrir/src/ext.ts'
import type { FenrirExtEvent } from '../fenrir/src/events.ts'
import type { Proposal } from '../fenrir/src/leadership.ts'
import type {
  DecisionContext, TeamDecisionContext, WolfNightAction,
} from '../fenrir/src/agents/agent.ts'
import { runGame } from '../lupa/engine.ts'
import { StrategyBaseAdapter } from '../fenrir/src/adapters/strategy-base-adapter.ts'
import { RuleBasedAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import { buildPlayerView } from '../lupa/player-view.ts'
import { alivePlayers } from '../lupa/roles.ts'
import { SkollMasterAgent } from './skoll-master-agent.ts'
import { SkollMasonTeamAgent } from './skoll-mason-agent.ts'
import { SkollWolfTeamAgent } from './skoll-wolf-agent.ts'
import { analyzeAttacksByWorld } from './wolf-attack-analysis.ts'
import { buildPossibilitiesFromRetar } from './unified.ts'
import { DEFAULT_MAX_WORLDS } from './constants.ts'

type PerspectiveTag =
  | 'villager' | 'seer' | 'medium' | 'bodyguard' | 'nekomata'
  | 'mason_solo' | 'werewolf_solo' | 'fanatic' | 'werehamster' | 'immoralist'
  | 'mason_team' | 'wolf_team_vote' | 'wolf_team_attack'

type Record = {
  perspective: PerspectiveTag
  day: number
  totalWorlds: number
  truncated: boolean
  source: 'skoll-exact' | 'skoll-truncated' | 'nn'
}

const records: Record[] = []

function logRecord(r: Record) { records.push(r) }

// ─── Measured agents ─────────────────────────────────────────────────────

class MeasuredSkollMasterAgent extends SkollMasterAgent {
  override decideVote(ctx: DecisionContext): number {
    const analysis = this.analyzeVote(ctx)
    if (analysis && analysis.totalWorlds !== undefined) {
      logRecord({
        perspective: roleToPerspective(ctx.myRole),
        day: ctx.day,
        totalWorlds: analysis.totalWorlds,
        truncated: analysis.source === 'skoll-truncated',
        source: analysis.source,
      })
    }
    return analysis?.bestVote ?? super.decideVote(ctx)
  }
}

function roleToPerspective(role: SystemRole): PerspectiveTag {
  switch (role) {
    case 'villager': return 'villager'
    case 'seer': return 'seer'
    case 'medium': return 'medium'
    case 'bodyguard': return 'bodyguard'
    case 'nekomata': return 'nekomata'
    case 'mason': return 'mason_solo'
    case 'werewolf': return 'werewolf_solo'
    case 'fanatic': return 'fanatic'
    case 'werehamster': return 'werehamster'
    case 'immoralist': return 'immoralist'
    default: return 'villager'
  }
}

class MeasuredSkollMasonTeamAgent extends SkollMasonTeamAgent {
  override decideProposal(ctx: TeamDecisionContext): Proposal | null {
    this.measure(ctx)
    return super.decideProposal(ctx)
  }
  override decideVote(ctx: TeamDecisionContext): number {
    this.measure(ctx)
    return super.decideVote(ctx)
  }
  private measure(ctx: TeamDecisionContext) {
    const a = this.analyzeVote(ctx)
    if (a && a.totalWorlds !== undefined) {
      logRecord({
        perspective: 'mason_team',
        day: ctx.day,
        totalWorlds: a.totalWorlds,
        truncated: a.source === 'skoll-truncated',
        source: a.source,
      })
    }
  }
}

class MeasuredSkollWolfTeamAgent extends SkollWolfTeamAgent {
  override decideVote(ctx: TeamDecisionContext): number {
    const a = this.analyzeVote(ctx)
    if (a && a.totalWorlds !== undefined) {
      logRecord({
        perspective: 'wolf_team_vote',
        day: ctx.day,
        totalWorlds: a.totalWorlds,
        truncated: a.source === 'skoll-truncated',
        source: a.source,
      })
    }
    return a?.bestVote ?? super.decideVote(ctx)
  }

  override decideNightAction(ctx: TeamDecisionContext): WolfNightAction {
    this.measureAttack(ctx)
    return super.decideNightAction(ctx)
  }

  private measureAttack(ctx: TeamDecisionContext) {
    const artifacts = (ctx.gameState.ext as { retarCache?: { lastArtifacts?: { vs: unknown, setup: Map<string, number> } | null } } | undefined)?.retarCache?.lastArtifacts
    const globalPoss = ctx.globalRetarPossibilities
    if (!artifacts?.setup || !globalPoss) return
    const setup = artifacts.setup as Map<SystemRole, number>
    const possibilities = buildPossibilitiesFromRetar(globalPoss, setup)
    const aliveNowSeats = alivePlayers(ctx.gameState).map(p => p.seat)
    const wolfSeats = new Set<number>(ctx.teamSeats)
    const a = analyzeAttacksByWorld(possibilities, setup, aliveNowSeats, wolfSeats)
    logRecord({
      perspective: 'wolf_team_attack',
      day: ctx.day,
      totalWorlds: a.totalWorlds,
      truncated: a.truncated,
      source: a.truncated ? 'skoll-truncated' : 'skoll-exact',
    })
  }
}

// ─── Adapter (bench.ts と同型) ──────────────────────────────────────────

class MeasureAdapter extends StrategyBaseAdapter {
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

// ─── Main loop ──────────────────────────────────────────────────────────

const roles = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])

const gamesArg = process.argv.find(a => a.startsWith('--games='))
const games = gamesArg ? parseInt(gamesArg.slice('--games='.length), 10) : 10

console.log(`=== Skoll truncation measurement (14D-neko, MAX_WORLDS=${(DEFAULT_MAX_WORLDS / 1_000_000).toFixed(1)}M, N=${games} games) ===\n`)

const t0 = performance.now()
let villageWins = 0
let wolfWins = 0
let otherWins = 0

for (let i = 0; i < games; i++) {
  const seed = i
  const adapterCfg = {
    agents: new Map(),
    defaultAgent: new MeasuredSkollMasterAgent(),
    wolfTeamAgent: new MeasuredSkollWolfTeamAgent(),
    masonTeamAgent: new MeasuredSkollMasonTeamAgent(),
    enableRetar: true,
    roles,
    seed,
  }
  const handlers = new MeasureAdapter(adapterCfg)
  const { state } = await runGame({ roles, seed, hasFirstGhost: true }, handlers)
  if (state.result === 'villager_won') villageWins++
  else if (state.result === 'werewolf_won') wolfWins++
  else otherWins++
}

const elapsedMs = performance.now() - t0

// ─── 集計 ───────────────────────────────────────────────────────────────

type Stat = {
  perspective: PerspectiveTag
  day: number
  samples: number
  truncatedCount: number
  worlds: number[]
}

const statMap = new Map<string, Stat>()
for (const r of records) {
  const key = `${r.perspective}::${r.day}`
  let s = statMap.get(key)
  if (!s) {
    s = { perspective: r.perspective, day: r.day, samples: 0, truncatedCount: 0, worlds: [] }
    statMap.set(key, s)
  }
  s.samples++
  if (r.truncated) s.truncatedCount++
  s.worlds.push(r.totalWorlds)
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.floor(sorted.length * q)
  return sorted[Math.min(idx, sorted.length - 1)]
}

function fmtN(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

const stats = Array.from(statMap.values()).sort((a, b) => {
  if (a.perspective !== b.perspective) return a.perspective.localeCompare(b.perspective)
  return a.day - b.day
})

console.log(`村勝 ${villageWins} 狼勝 ${wolfWins} 他 ${otherWins} (elapsed ${(elapsedMs / 1000).toFixed(1)}s)\n`)
console.log('perspective         day  samples  truncated      p50      p95     p99      max')
console.log('─────────────────── ───  ───────  ─────────  ───────  ───────  ───────  ───────')
for (const s of stats) {
  s.worlds.sort((a, b) => a - b)
  const p50 = quantile(s.worlds, 0.5)
  const p95 = quantile(s.worlds, 0.95)
  const p99 = quantile(s.worlds, 0.99)
  const max = s.worlds[s.worlds.length - 1]
  const trucPct = ((s.truncatedCount / s.samples) * 100).toFixed(0)
  const trucMark = s.truncatedCount > 0 ? '*' : ' '
  console.log(
    s.perspective.padEnd(19) + ' '
    + String(s.day).padStart(3) + '  '
    + String(s.samples).padStart(7) + '  '
    + (s.truncatedCount + '(' + trucPct + '%)' + trucMark).padStart(9) + '  '
    + fmtN(p50).padStart(7) + '  '
    + fmtN(p95).padStart(7) + '  '
    + fmtN(p99).padStart(7) + '  '
    + fmtN(max).padStart(7),
  )
}

// perspective 別の総 truncate 率と max
console.log('\n=== Per-perspective summary ===')
const perspMap = new Map<PerspectiveTag, { samples: number, truncated: number, max: number }>()
for (const r of records) {
  let p = perspMap.get(r.perspective)
  if (!p) {
    p = { samples: 0, truncated: 0, max: 0 }
    perspMap.set(r.perspective, p)
  }
  p.samples++
  if (r.truncated) p.truncated++
  if (r.totalWorlds > p.max) p.max = r.totalWorlds
}

console.log('perspective         samples  truncated     max')
console.log('─────────────────── ───────  ─────────  ──────')
for (const [persp, p] of Array.from(perspMap.entries()).sort()) {
  const trucPct = ((p.truncated / p.samples) * 100).toFixed(1)
  console.log(
    persp.padEnd(19) + ' '
    + String(p.samples).padStart(7) + '  '
    + (p.truncated + '(' + trucPct + '%)').padStart(9) + '  '
    + fmtN(p.max).padStart(6),
  )
}
