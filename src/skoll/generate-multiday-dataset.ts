/**
 * skoll-multiday-NN 訓練データ生成スクリプト。
 *
 * lupa 自己対戦 (rule-based agents) で 14d-neko ゲームを多数走らせ、
 * 各ゲームの各投票タイミング (= morning) で snapshot を取り、
 * 複数の viewer 視点 (public / random viewer with assumption) で
 * retar を実行して possibilities を作り、 `recursiveSkoll` で per-X
 * winRate label を計算する。
 *
 * 出力: jsonl (1 sample / line)
 *
 * 起動 (例):
 *   node --experimental-strip-types src/skoll/generate-multiday-dataset.ts \
 *     --games 100 --out data/skoll-multiday-train.jsonl
 *
 * 並列化は後追加 (worker_threads)。 まず single-thread で動作確認。
 */

import { mkdirSync, appendFileSync, existsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SystemRole, VillageStatus } from '../types/index.ts'
import { runGame } from '../lupa/engine.ts'
import type { GameEvent, GameState } from '../lupa/types.ts'
import type { GameConfig, VoteContext } from '../lupa/handlers.ts'
import { StrategyBaseAdapter } from '../fenrir/src/adapters/strategy-base-adapter.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import { RandomAgent } from '../fenrir/src/agents/random-agent.ts'
import type { Agent } from '../fenrir/src/agents/agent.ts'
import {
  analyzeFromEventsDetailed,
  retarResultToPossibilities,
  buildAssumptions,
} from '../fenrir/src/retar-bridge.ts'
import { recursiveSkoll } from './recursive.ts'
import type { FenrirExt } from '../fenrir/src/ext.ts'
import type { FenrirExtEvent } from '../fenrir/src/events.ts'

// ---- 設定 ----
const ROLES = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])
const HAS_FIRST_GHOST = true

// 1 snapshot あたり何人の viewer を作るか (public + N-1 ranom)
const VIEWERS_PER_SNAPSHOT = 2

// snapshot を取る最小 day (= 終盤重視のため Day 1-2 をスキップ可能)
// 1 にすると全 day、 3 にすると Day 1-2 を skip
const MIN_SNAPSHOT_DAY = parseInt(process.env.SKOLL_MULTIDAY_MIN_DAY ?? '1', 10)

// recursiveSkoll の lookahead 深さ (default = 1)。
// depth >= 2 は cost 爆発するので depth-min-day と組み合わせて day 別に切替推奨。
// CLI: --depth 2 --depth-min-day 4 → Day 1-3 は depth=1、 Day 4+ は depth=2
const DEFAULT_DEPTH = 1

// ---- snapshot capture adapter ----
type Snapshot = {
  day: number
  events: (GameEvent | FenrirExtEvent)[]
  state: GameState<FenrirExt>
}

class SnapshotAdapter extends StrategyBaseAdapter {
  snapshots: Snapshot[] = []

  override onVote(vctx: VoteContext<FenrirExtEvent, FenrirExt>): Map<number, number> {
    // 初回投票時のみ snapshot 取得 (再投票は重複データ)
    // Day MIN_SNAPSHOT_DAY 未満は skip (= 終盤重視)
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

type AgentMode = 'heuristic' | 'random' | 'mixed'

// ---- 1 ゲーム実行 ----
async function runOneGame(seed: number, agentMode: AgentMode, rng: () => number): Promise<Snapshot[]> {
  // mixed: 各 seat ごとに random/heuristic を確率で振り分け (~50%)
  let defaultAgent: Agent
  const perSeatAgents = new Map<number, Agent>()
  if (agentMode === 'random') {
    defaultAgent = new RandomAgent()
  } else if (agentMode === 'mixed') {
    // 各 seat に独立に random/heuristic を割当
    // (defaultAgent は heuristic、 一部 seat に random を per-seat 設定)
    defaultAgent = new RuleBasedAgent()
    const totalPlayers = Array.from(ROLES.values()).reduce((a, b) => a + b, 0)
    for (let seat = 1; seat <= totalPlayers; seat++) {
      if (rng() < 0.5) perSeatAgents.set(seat, new RandomAgent())
    }
  } else {
    defaultAgent = new RuleBasedAgent()
  }

  const adapter = new SnapshotAdapter({
    agents: perSeatAgents,
    defaultAgent,
    wolfTeamAgent: new WolfTeamRuleAgent(),
    masonTeamAgent: new MasonTeamRuleAgent(),
    enableRetar: false,  // retar はデータ生成側で別途呼ぶので不要
    roles: ROLES,
    seed,
  })
  const config: GameConfig = {
    roles: ROLES,
    seed,
    hasFirstGhost: HAS_FIRST_GHOST,
  }
  await runGame(config, adapter)
  return adapter.snapshots
}

// ---- snapshot から 1 サンプル生成 ----
type Sample = {
  game_seed: number
  day: number
  viewer: { seat: number, role: SystemRole } | null
  alive_seats: number[]
  possibilities: number[]  // index 0 unused, length = max_seat + 1
  setup: Record<string, number>
  max_seat: number
  max_surviving_nv: number
  labels: { seat: number, winRate: number }[]
}

function generateSample(
  snapshot: Snapshot,
  config: GameConfig,
  viewer: { seat: number, role: SystemRole } | null,
  gameSeed: number,
  maxDepth: number,
): Sample | null {
  let assumptions: Map<number, SystemRole> | undefined
  if (viewer !== null) {
    const player = snapshot.state.players.find(p => p.seat === viewer.seat)
    if (!player) return null
    assumptions = buildAssumptions(snapshot.state as GameState, player)
  }

  // retar
  const detailed = analyzeFromEventsDetailed(
    snapshot.events as GameEvent[],
    snapshot.state as GameState,
    config,
    assumptions,
  )
  if (!detailed.vs || !detailed.setup) return null

  const possibilitiesObj = retarResultToPossibilities(
    { possibilities: detailed.possibilities, maxSurvivingNV: detailed.maxSurvivingNV },
    detailed.setup,
  )

  const vs = detailed.vs as VillageStatus
  const aliveSeats: number[] = []
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }
  if (aliveSeats.length < 2) return null  // recursive skoll に意味なし

  // recursive skoll (depth は呼び出し側で day 別に決定)
  const result = recursiveSkoll(possibilitiesObj, detailed.setup, vs, { maxDepth })

  const labels = result.perX.map(r => ({ seat: r.executeToday, winRate: r.expectedWinRate }))

  return {
    game_seed: gameSeed,
    day: snapshot.day,
    viewer,
    alive_seats: aliveSeats,
    possibilities: [...possibilitiesObj.possibilities],
    setup: Object.fromEntries(detailed.setup) as Record<string, number>,
    max_seat: possibilitiesObj.possibilities.length - 1,
    max_surviving_nv: detailed.maxSurvivingNV,
    labels,
  }
}

// ---- viewer 選択 ----
function pickRandomViewer(snapshot: Snapshot, rng: () => number): { seat: number, role: SystemRole } | null {
  const aliveWithRole = snapshot.state.players
    .filter(p => p.alive)
    .map(p => ({ seat: p.seat, role: p.role }))
  if (aliveWithRole.length === 0) return null
  return aliveWithRole[Math.floor(rng() * aliveWithRole.length)]
}

// ---- CLI args ----
function parseArg(name: string): string | null {
  const prefix = `--${name}=`
  const found = process.argv.find(a => a.startsWith(prefix))
  if (found) return found.slice(prefix.length)
  // also support "--name value"
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1]
  return null
}

const NUM_GAMES = parseInt(parseArg('games') ?? '100', 10)
const OUT_PATH = parseArg('out') ?? 'data/skoll-multiday-train.jsonl'
const SEED_BASE = parseInt(parseArg('seed-base') ?? '0', 10)
const RESUME = parseArg('resume') === 'true' || parseArg('resume') === '1'
const AGENT_MODE_ARG = parseArg('agent-mode') ?? 'heuristic'
const AGENT_MODE: AgentMode = (AGENT_MODE_ARG === 'random' || AGENT_MODE_ARG === 'mixed' ? AGENT_MODE_ARG : 'heuristic')

// depth 設定: --depth N と --depth-min-day D
//   Day < D の snapshot は depth=1 (cheap)
//   Day >= D の snapshot は depth=N (deep, cost 注意)
// 全 snapshot を depth=N にしたい場合は --depth N --depth-min-day 1 (or 省略)
const DEPTH_N = parseInt(parseArg('depth') ?? String(DEFAULT_DEPTH), 10)
const DEPTH_MIN_DAY = parseInt(parseArg('depth-min-day') ?? '1', 10)

// ---- main ----
async function main(): Promise<void> {
  console.log(`[generate-multiday-dataset] games=${NUM_GAMES} out=${OUT_PATH} seed_base=${SEED_BASE} resume=${RESUME} agent_mode=${AGENT_MODE} depth=${DEPTH_N} depth_min_day=${DEPTH_MIN_DAY}`)

  mkdirSync(dirname(OUT_PATH), { recursive: true })
  if (!RESUME && existsSync(OUT_PATH)) {
    console.log(`[generate-multiday-dataset] removing existing ${OUT_PATH}`)
    unlinkSync(OUT_PATH)
  }

  const t0 = Date.now()
  let totalSamples = 0
  let totalSnapshots = 0
  let failedSnapshots = 0

  // 簡易 RNG (seed-dependent な viewer 選択用)
  let rngState = SEED_BASE * 12345 + 1
  const rng = () => {
    rngState = (rngState * 1664525 + 1013904223) | 0
    return ((rngState >>> 0) / 0xFFFFFFFF)
  }

  for (let i = 0; i < NUM_GAMES; i++) {
    const seed = SEED_BASE + i
    const gameStart = Date.now()
    let snapshots: Snapshot[]
    try {
      snapshots = await runOneGame(seed, AGENT_MODE, rng)
    } catch (e) {
      console.error(`[game ${i}/${NUM_GAMES}] seed=${seed} failed: ${(e as Error).message}`)
      continue
    }
    totalSnapshots += snapshots.length

    const config: GameConfig = { roles: ROLES, seed, hasFirstGhost: HAS_FIRST_GHOST }
    let gameSamples = 0

    for (const snapshot of snapshots) {
      // viewer 候補: public + (VIEWERS_PER_SNAPSHOT - 1) random alive viewer
      const viewers: ({ seat: number, role: SystemRole } | null)[] = [null]
      for (let v = 1; v < VIEWERS_PER_SNAPSHOT; v++) {
        const picked = pickRandomViewer(snapshot, rng)
        if (picked) viewers.push(picked)
      }

      const depthForSnapshot = snapshot.day >= DEPTH_MIN_DAY ? DEPTH_N : 1
      for (const viewer of viewers) {
        let sample: Sample | null
        try {
          sample = generateSample(snapshot, config, viewer, seed, depthForSnapshot)
        } catch (e) {
          failedSnapshots++
          continue
        }
        if (sample === null) {
          failedSnapshots++
          continue
        }
        appendFileSync(OUT_PATH, JSON.stringify(sample) + '\n')
        gameSamples++
        totalSamples++
      }
    }

    const gameMs = Date.now() - gameStart
    const elapsedMin = (Date.now() - t0) / 60000
    const rate = totalSamples / Math.max(elapsedMin, 0.001)
    console.log(`[game ${i + 1}/${NUM_GAMES}] seed=${seed} snapshots=${snapshots.length} samples=${gameSamples} (${gameMs}ms) | total=${totalSamples} rate=${rate.toFixed(1)}/min`)
  }

  const totalMin = (Date.now() - t0) / 60000
  console.log(`\n[done] games=${NUM_GAMES} samples=${totalSamples} snapshots=${totalSnapshots} failed=${failedSnapshots} elapsed=${totalMin.toFixed(2)}min rate=${(totalSamples / totalMin).toFixed(1)}/min`)
  console.log(`[done] output: ${OUT_PATH}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
