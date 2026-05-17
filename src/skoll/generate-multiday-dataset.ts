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
    if (vctx.revoteRound === 0) {
      this.snapshots.push({
        day: vctx.day,
        events: [...vctx.events],
        state: structuredClone(vctx.state) as GameState<FenrirExt>,
      })
    }
    return super.onVote(vctx)
  }
}

// ---- 1 ゲーム実行 ----
async function runOneGame(seed: number): Promise<Snapshot[]> {
  const adapter = new SnapshotAdapter({
    agents: new Map(),
    defaultAgent: new RuleBasedAgent(),
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

  // recursive skoll
  const result = recursiveSkoll(possibilitiesObj, detailed.setup, vs)

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

// ---- main ----
async function main(): Promise<void> {
  console.log(`[generate-multiday-dataset] games=${NUM_GAMES} out=${OUT_PATH} seed_base=${SEED_BASE} resume=${RESUME}`)

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
      snapshots = await runOneGame(seed)
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

      for (const viewer of viewers) {
        let sample: Sample | null
        try {
          sample = generateSample(snapshot, config, viewer, seed)
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
