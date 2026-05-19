/**
 * skoll-multiday-NN の multi-scenario spot check
 *
 * lupa heuristic 自己対戦で N 14d-neko ゲームを回し、 Day 3+ の各 snapshot で:
 *   - single-day skoll bestVote
 *   - recursive (depth=1) skoll bestVote (= NN の学習目標)
 *   - NN bestVote
 * を計算、 一致率 + 「LW 回避」率を per-Day + overall に集計する。
 *
 * LW 検出: possibilities[seat] = {werewolf} 単独な seat がちょうど 1 つ
 * LW 回避: 上記 LW があり、 single-day がそれを best とした snapshot で、
 *          NN が別 seat を best と推定するケース
 *
 * 起動例:
 *   node --experimental-strip-types src/skoll/multiday-multi-spot-check.ts \
 *     --ckpt tmp/multiday-skoll/ckpt-10k-focal3.json --games 30
 */

import { readFileSync } from 'node:fs'
import type { SystemRole, VillageStatus } from '../types/index.ts'
import { runGame } from '../lupa/engine.ts'
import type { GameEvent, GameState } from '../lupa/types.ts'
import type { GameConfig } from '../lupa/handlers.ts'
import { StrategyBaseAdapter } from '../fenrir/src/adapters/strategy-base-adapter.ts'
import {
  RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent,
} from '../fenrir/src/agents/rule-based-agent.ts'
import {
  analyzeFromEventsDetailed, retarResultToPossibilities,
} from '../fenrir/src/retar-bridge.ts'
import { precomputeSkoll } from '../bloodhound/skoll-precompute.ts'
import { recursiveSkoll } from './recursive.ts'
import {
  MultidaySkollNetwork,
  DEFAULT_MULTIDAY_SKOLL_CONFIG,
  type MultidaySkollConfig,
} from '../fenrir/src/ml/multiday-skoll-network.ts'

// ---- 設定 ----
const ROLES = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])
const HAS_FIRST_GHOST = true
const MIN_SNAPSHOT_DAY = 3
const WEREWOLF_BIT = 6  // possibility bit for werewolf

// ---- args ----
function parseArg(name: string): string | null {
  const eq = `--${name}=`
  const found = process.argv.find(a => a.startsWith(eq))
  if (found) return found.slice(eq.length)
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1]
  return null
}

const CKPT_PATH = parseArg('ckpt') ?? 'tmp/multiday-skoll/ckpt-10k-focal3.json'
const NUM_GAMES = parseInt(parseArg('games') ?? '30', 10)
const SEED_BASE = parseInt(parseArg('seed-base') ?? '200000', 10)
const DETAIL_TOP = parseInt(parseArg('detail-top') ?? '0', 10)  // 0 = OFF

const ROLE_NAMES = ['vil', 'seer', 'med', 'BG', 'mason', 'neko', 'WOLF', 'poss', 'FANA', 'FOX', 'IMM']
function fmtPoss(mask: number): string {
  const roles: string[] = []
  for (let i = 0; i < 11; i++) if (mask & (1 << i)) roles.push(ROLE_NAMES[i])
  return roles.join('/')
}

// ---- network load ----
function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

function loadNetwork(path: string): MultidaySkollNetwork {
  const raw = readFileSync(path, 'utf-8')
  const data = JSON.parse(raw) as { config: MultidaySkollConfig, weights: Record<string, string> }
  const config = data.config ?? DEFAULT_MULTIDAY_SKOLL_CONFIG
  const network = new MultidaySkollNetwork(config)
  const weights = new Map<string, Float32Array>()
  for (const [name, b64] of Object.entries(data.weights)) {
    weights.set(name, base64ToFloat32(b64))
  }
  network.loadWeights(weights)
  return network
}

// ---- snapshot adapter ----
import type { VoteContext } from '../lupa/handlers.ts'
import type { FenrirExt } from '../fenrir/src/ext.ts'
import type { FenrirExtEvent } from '../fenrir/src/events.ts'

type Snapshot = {
  day: number
  events: (GameEvent | FenrirExtEvent)[]
  state: GameState<FenrirExt>
}

class SnapshotAdapter extends StrategyBaseAdapter {
  snapshots: Snapshot[] = []
  override onVote(vctx: VoteContext<FenrirExtEvent, FenrirExt>): Map<number, number> {
    if (vctx.revoteRound === 0 && vctx.day >= MIN_SNAPSHOT_DAY) {
      this.snapshots.push({
        day: vctx.day,
        events: [...vctx.events],
        state: structuredClone(vctx.state) as GameState<FenrirExt>,
      })
    }
    return super.onVote(vctx)
  }
}

async function runOneGame(seed: number): Promise<Snapshot[]> {
  const adapter = new SnapshotAdapter({
    agents: new Map(),
    defaultAgent: new RuleBasedAgent(),
    wolfTeamAgent: new WolfTeamRuleAgent(),
    masonTeamAgent: new MasonTeamRuleAgent(),
    enableRetar: false,
    roles: ROLES,
    seed,
  })
  const config: GameConfig = { roles: ROLES, seed, hasFirstGhost: HAS_FIRST_GHOST }
  await runGame(config, adapter)
  return adapter.snapshots
}

// ---- per-snapshot evaluation ----
type PerSeatDetail = {
  seat: number
  possibility: number
  nn: number
  depth1: number
  single: number
}

type Result = {
  seed: number
  day: number
  aliveCount: number
  lwSeat: number | null
  singleBest: number
  depth1Best: number
  nnBest: number
  singleBestRate: number
  depth1BestRate: number
  nnBestRate: number
  mae: number  // NN vs depth=1 across alive seats
  perSeat: PerSeatDetail[]
}

function evaluateSnapshot(snapshot: Snapshot, seed: number, network: MultidaySkollNetwork, config: GameConfig): Result | null {
  const detailed = analyzeFromEventsDetailed(
    snapshot.events as GameEvent[],
    snapshot.state as GameState,
    config,
  )
  if (!detailed.vs || !detailed.setup) return null

  const possibilities = retarResultToPossibilities(
    { possibilities: detailed.possibilities, maxSurvivingNV: detailed.maxSurvivingNV },
    detailed.setup,
  )

  const vs = detailed.vs as VillageStatus
  const aliveSeats: number[] = []
  for (const [seat, status] of vs.statuses) if (status.surviving) aliveSeats.push(seat)
  aliveSeats.sort((a, b) => a - b)
  if (aliveSeats.length < 3) return null

  // LW detection: seat with possibility = {werewolf} only
  let lwCandidates: number[] = []
  for (const seat of aliveSeats) {
    if (possibilities.possibilities[seat] === (1 << WEREWOLF_BIT)) lwCandidates.push(seat)
  }
  const lwSeat = lwCandidates.length === 1 ? lwCandidates[0] : null

  // Single-day skoll
  const single = precomputeSkoll({ possibilities, vs, setup: detailed.setup })
  const singleBest = pickBest(single.executions.map(e => ({ seat: e.seat, rate: e.winRate })))

  // Recursive depth=1
  const rec = recursiveSkoll(possibilities, detailed.setup, vs)
  const depth1Best = pickBest(rec.perX.map(r => ({ seat: r.executeToday, rate: r.expectedWinRate })))

  // NN
  const nnOut = network.forward({
    possibilities: [...possibilities.possibilities],
    aliveSeats,
    setup: Object.fromEntries(detailed.setup),
    day: snapshot.day,
    maxSurvivingNV: possibilities.maxSurvivingNV,
  })
  let nnBest = aliveSeats[0]
  let nnBestRate = -Infinity
  for (const seat of aliveSeats) {
    const rate = nnOut[seat - 1]
    if (rate > nnBestRate) { nnBest = seat; nnBestRate = rate }
  }

  // MAE NN vs depth=1 + per-seat detail
  let sumAbs = 0
  const perSeat: PerSeatDetail[] = []
  for (const seat of aliveSeats) {
    const nnRate = nnOut[seat - 1]
    const truth = rec.perX.find(r => r.executeToday === seat)?.expectedWinRate ?? 0
    const sng = single.executions.find(e => e.seat === seat)?.winRate ?? 0
    sumAbs += Math.abs(nnRate - truth)
    perSeat.push({
      seat,
      possibility: possibilities.possibilities[seat],
      nn: nnRate,
      depth1: truth,
      single: sng,
    })
  }
  const mae = sumAbs / aliveSeats.length

  return {
    seed,
    day: snapshot.day,
    aliveCount: aliveSeats.length,
    lwSeat,
    singleBest: singleBest.seat,
    depth1Best: depth1Best.seat,
    nnBest,
    singleBestRate: singleBest.rate,
    depth1BestRate: depth1Best.rate,
    nnBestRate,
    mae,
    perSeat,
  }
}

function pickBest(items: { seat: number, rate: number }[]): { seat: number, rate: number } {
  let best = items[0]
  for (const item of items) if (item.rate > best.rate) best = item
  return best
}

// ---- main ----
async function main(): Promise<void> {
  console.log(`[multi-spot-check] ckpt=${CKPT_PATH} games=${NUM_GAMES} seed_base=${SEED_BASE}`)
  const network = loadNetwork(CKPT_PATH)
  console.log(`[multi-spot-check] network params: ${network.totalParams}`)

  const results: Result[] = []
  const t0 = Date.now()
  for (let i = 0; i < NUM_GAMES; i++) {
    const seed = SEED_BASE + i
    let snapshots: Snapshot[]
    try {
      snapshots = await runOneGame(seed)
    } catch (e) {
      console.error(`[game ${i + 1}/${NUM_GAMES}] seed=${seed} failed: ${(e as Error).message}`)
      continue
    }
    const config: GameConfig = { roles: ROLES, seed, hasFirstGhost: HAS_FIRST_GHOST }
    let gameResults = 0
    for (const snapshot of snapshots) {
      try {
        const r = evaluateSnapshot(snapshot, seed, network, config)
        if (r) { results.push(r); gameResults++ }
      } catch (e) {
        // skip failing snapshot
      }
    }
    if ((i + 1) % 5 === 0 || i + 1 === NUM_GAMES) {
      const elapsed = (Date.now() - t0) / 1000
      console.log(`[game ${i + 1}/${NUM_GAMES}] seed=${seed} snapshots=${snapshots.length} evaluated=${gameResults} total=${results.length} elapsed=${elapsed.toFixed(1)}s`)
    }
  }

  // ---- per-Day aggregation ----
  const byDay = new Map<number, Result[]>()
  for (const r of results) {
    let arr = byDay.get(r.day)
    if (!arr) { arr = []; byDay.set(r.day, arr) }
    arr.push(r)
  }

  console.log('\n=== Per-Day agreement ===')
  console.log('Day  N    aliveAvg  NN=d1     NN=single   d1=single   MAE(NN vs d1)')
  console.log('───  ───  ────────  ────────  ──────────  ──────────  ─────────────')
  for (const [day, arr] of [...byDay].sort((a, b) => a[0] - b[0])) {
    const n = arr.length
    const aliveAvg = arr.reduce((s, r) => s + r.aliveCount, 0) / n
    const nnEqD1 = arr.filter(r => r.nnBest === r.depth1Best).length
    const nnEqSingle = arr.filter(r => r.nnBest === r.singleBest).length
    const d1EqSingle = arr.filter(r => r.depth1Best === r.singleBest).length
    const maeAvg = arr.reduce((s, r) => s + r.mae, 0) / n
    console.log(
      String(day).padStart(3) + '  '
      + String(n).padStart(3) + '  '
      + aliveAvg.toFixed(1).padStart(8) + '  '
      + `${nnEqD1}/${n} (${(nnEqD1 / n * 100).toFixed(0)}%)`.padStart(8) + '  '
      + `${nnEqSingle}/${n} (${(nnEqSingle / n * 100).toFixed(0)}%)`.padStart(10) + '  '
      + `${d1EqSingle}/${n} (${(d1EqSingle / n * 100).toFixed(0)}%)`.padStart(10) + '  '
      + maeAvg.toFixed(4).padStart(13),
    )
  }

  // ---- LW-avoid analysis ----
  const lwPresent = results.filter(r => r.lwSeat !== null)
  const lwSingleHits = lwPresent.filter(r => r.singleBest === r.lwSeat)
  const lwSingleHitsD1Avoid = lwSingleHits.filter(r => r.depth1Best !== r.lwSeat)
  const lwSingleHitsNNAvoid = lwSingleHits.filter(r => r.nnBest !== r.lwSeat)
  const lwSingleHitsBoth = lwSingleHits.filter(r => r.depth1Best !== r.lwSeat && r.nnBest !== r.lwSeat)
  const lwSingleHitsNNFollow = lwSingleHits.filter(r => r.nnBest === r.lwSeat)

  console.log('\n=== LW avoid analysis ===')
  console.log(`LW present snapshots:         ${lwPresent.length} / ${results.length}`)
  console.log(`  └ single-day picks LW:      ${lwSingleHits.length} / ${lwPresent.length}`)
  console.log(`    ├ depth=1 avoids LW:      ${lwSingleHitsD1Avoid.length} / ${lwSingleHits.length}`)
  console.log(`    ├ NN avoids LW:           ${lwSingleHitsNNAvoid.length} / ${lwSingleHits.length}`)
  console.log(`    ├ both (d1+NN) avoid:     ${lwSingleHitsBoth.length} / ${lwSingleHits.length}`)
  console.log(`    └ NN follows single (LW): ${lwSingleHitsNNFollow.length} / ${lwSingleHits.length}`)

  // ---- Show disagree cases (NN vs depth=1) ----
  const disagreements = results.filter(r => r.nnBest !== r.depth1Best)
  console.log(`\n=== NN ≠ depth=1 cases: ${disagreements.length} / ${results.length} ===`)
  if (disagreements.length > 0) {
    console.log('seed     day  alive  LW   single  d1   NN   NN-rate  d1-rate')
    console.log('──────   ───  ─────  ──   ──────  ───  ───  ───────  ───────')
    for (const r of disagreements.slice(0, 20)) {
      console.log(
        String(r.seed).padStart(6) + '   '
        + String(r.day).padStart(3) + '  '
        + String(r.aliveCount).padStart(5) + '  '
        + (r.lwSeat ?? '-').toString().padStart(2) + '   '
        + String(r.singleBest).padStart(6) + '  '
        + String(r.depth1Best).padStart(3) + '  '
        + String(r.nnBest).padStart(3) + '  '
        + r.nnBestRate.toFixed(3).padStart(7) + '  '
        + r.depth1BestRate.toFixed(3).padStart(7),
      )
    }
    if (disagreements.length > 20) console.log(`  (+${disagreements.length - 20} more)`)
  }

  // ---- Overall summary ----
  console.log('\n=== Overall summary ===')
  const totalNNEqD1 = results.filter(r => r.nnBest === r.depth1Best).length
  const totalNNEqSingle = results.filter(r => r.nnBest === r.singleBest).length
  const totalMAE = results.reduce((s, r) => s + r.mae, 0) / results.length
  console.log(`total snapshots: ${results.length}`)
  console.log(`NN best = depth=1 best:  ${totalNNEqD1} (${(totalNNEqD1 / results.length * 100).toFixed(1)}%)`)
  console.log(`NN best = single best:   ${totalNNEqSingle} (${(totalNNEqSingle / results.length * 100).toFixed(1)}%)`)
  console.log(`MAE (NN vs depth=1):     ${totalMAE.toFixed(4)}`)

  // ---- MAE 分布 ----
  console.log('\n=== MAE distribution ===')
  const maeBuckets = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1.0]
  const bucketCounts = new Array(maeBuckets.length).fill(0)
  for (const r of results) {
    for (let i = maeBuckets.length - 1; i >= 0; i--) {
      if (r.mae >= maeBuckets[i]) { bucketCounts[i]++; break }
    }
  }
  for (let i = 0; i < maeBuckets.length; i++) {
    const lo = maeBuckets[i]
    const hi = i + 1 < maeBuckets.length ? maeBuckets[i + 1] : Infinity
    const label = hi === Infinity ? `[${lo.toFixed(2)}+    ]` : `[${lo.toFixed(2)}, ${hi.toFixed(2)})`
    const bar = '█'.repeat(Math.round(bucketCounts[i] / Math.max(...bucketCounts) * 40))
    console.log(`  ${label}: ${String(bucketCounts[i]).padStart(3)} ${bar}`)
  }

  // ---- Top-N worst MAE 詳細 ----
  if (DETAIL_TOP > 0) {
    console.log(`\n=== Top-${DETAIL_TOP} worst MAE cases (per-seat detail) ===`)
    const sortedByMAE = [...results].sort((a, b) => b.mae - a.mae).slice(0, DETAIL_TOP)
    for (const r of sortedByMAE) {
      console.log(`\n--- seed=${r.seed} day=${r.day} alive=${r.aliveCount} MAE=${r.mae.toFixed(4)} LW=${r.lwSeat ?? '-'} ---`)
      console.log(`  best: NN=seat-${r.nnBest}(${r.nnBestRate.toFixed(3)}) d1=seat-${r.depth1Best}(${r.depth1BestRate.toFixed(3)}) single=seat-${r.singleBest}(${r.singleBestRate.toFixed(3)})`)
      console.log(`  seat  poss                              NN      d1      single  Δ(NN-d1)`)
      const seatSorted = [...r.perSeat].sort((a, b) => Math.abs(b.nn - b.depth1) - Math.abs(a.nn - a.depth1))
      for (const s of seatSorted) {
        const delta = s.nn - s.depth1
        const sign = delta >= 0 ? '+' : ''
        console.log(
          `  ${String(s.seat).padStart(4)}  ${fmtPoss(s.possibility).padEnd(34)}  ${s.nn.toFixed(3).padStart(6)}  ${s.depth1.toFixed(3).padStart(6)}  ${s.single.toFixed(3).padStart(6)}  ${(sign + delta.toFixed(3)).padStart(8)}`
        )
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
