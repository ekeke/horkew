/**
 * Seed Bank — 中盤スナップショットの事前生成とディスク管理
 *
 * オフライン:  npm run generate-snapshots -- --day 3 --count 1000
 * 学習時:      loadRandomSnapshots() でランダムに読み込み
 *
 * ディレクトリ構造:
 *   tmp/snapshots/day3/
 *     0000.json
 *     0001.json
 *     ...
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { SystemRole } from '../../types/index.ts'
import type { GameSnapshot, GameState, GameEvent } from '../../lupa/types.ts'
import type { GameConfig } from '../../lupa/handlers.ts'
import { runGame } from '../../lupa/engine.ts'
import { strategyAdapter } from '../../lupa/adapters/strategy-adapter.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from '../../lupa/heuristic.ts'
import type { TrainingConfig } from './training.ts'
import { Rng } from '../../lupa/random.ts'

// ============================================================
// ディスクフォーマット（JSON-safe）
// ============================================================

type SerializedSnapshot = {
  state: SerializedGameState
  events: GameEvent[]
  rngState: number
  config: { roles: [string, number][], seed?: number, hasFirstGhost?: boolean, revoteConfig?: any, rules?: any }
  /** 生存役職ごとの席数（フィルタ用メタデータ） */
  aliveRoleCounts?: [string, number][]
  seatRoles: [number, string][]
}

type SerializedGameState = {
  players: SerializedPlayerState[]
  day: number
  phase: 'night' | 'day'
  finished: boolean
  result: string | null
  executionHistory: [number, number][]
  commander: number | null
  masonPartners: [number, number][]
}

type SerializedPlayerState = {
  seat: number
  name: string
  role: string
  alive: boolean
  claimedRole: string | null
  claimedDay: number | null
  divineHistory: [number, { target: number, result: string }][]
  guardHistory: [number, number][]
  fakeDivineHistory: [number, { target: number, result: string }][]
  forecastTarget: number | null
}

function serializeSnapshot(snap: GameSnapshot): SerializedSnapshot {
  return {
    state: {
      players: snap.state.players.map(p => ({
        seat: p.seat,
        name: p.name,
        role: p.role,
        alive: p.alive,
        claimedRole: p.claimedRole,
        claimedDay: p.claimedDay,
        divineHistory: [...p.divineHistory],
        guardHistory: [...p.guardHistory],
        fakeDivineHistory: [...p.fakeDivineHistory],
        forecastTarget: p.forecastTarget,
      })),
      day: snap.state.day,
      phase: snap.state.phase,
      finished: snap.state.finished,
      result: snap.state.result,
      executionHistory: [...snap.state.executionHistory],
      commander: snap.state.commander,
      masonPartners: snap.state.masonPartners ? [...snap.state.masonPartners] : [],
    },
    events: snap.events,
    rngState: snap.rngState,
    config: {
      roles: [...snap.config.roles],
      seed: snap.config.seed,
      hasFirstGhost: snap.config.hasFirstGhost,
      revoteConfig: snap.config.revoteConfig,
      rules: snap.config.rules,
    },
    seatRoles: [...snap.seatRoles],
    aliveRoleCounts: computeAliveRoleCounts(snap),
  }
}

function computeAliveRoleCounts(snap: GameSnapshot): [string, number][] {
  const counts = new Map<string, number>()
  for (const p of snap.state.players) {
    if (!p.alive) continue
    counts.set(p.role, (counts.get(p.role) ?? 0) + 1)
  }
  return [...counts]
}

/** 指定役職が minAlive 席以上生存しているか */
function checkAliveRoles(
  aliveRoleCounts: [string, number][],
  targetRoles: string[],
  minAlive: number,
): boolean {
  const counts = new Map(aliveRoleCounts)
  let aliveCount = 0
  for (const role of targetRoles) {
    aliveCount += counts.get(role) ?? 0
  }
  return aliveCount >= minAlive
}

function deserializeSnapshot(data: SerializedSnapshot): GameSnapshot {
  const state: GameState = {
    players: data.state.players.map(p => ({
      seat: p.seat,
      name: p.name,
      role: p.role as SystemRole,
      alive: p.alive,
      claimedRole: p.claimedRole as SystemRole | null,
      claimedDay: p.claimedDay,
      divineHistory: new Map(p.divineHistory),
      guardHistory: new Map(p.guardHistory),
      fakeDivineHistory: new Map(p.fakeDivineHistory),
      forecastTarget: p.forecastTarget,
    })),
    day: data.state.day,
    phase: data.state.phase,
    finished: data.state.finished,
    result: data.state.result as GameState['result'],
    executionHistory: new Map(data.state.executionHistory),
    commander: data.state.commander,
    masonPartners: new Map(data.state.masonPartners),
  }

  const config: GameConfig = {
    roles: new Map(data.config.roles as [SystemRole, number][]),
    seed: data.config.seed,
    hasFirstGhost: data.config.hasFirstGhost,
    revoteConfig: data.config.revoteConfig,
    rules: data.config.rules,
  }

  return {
    state,
    events: data.events,
    rngState: data.rngState,
    config,
    seatRoles: new Map(data.seatRoles as [number, SystemRole][]),
  }
}

// ============================================================
// ディスク I/O
// ============================================================

function snapshotDir(day: number): string {
  return `tmp/snapshots/day${day}`
}

export function saveSnapshot(snap: GameSnapshot, dir: string, index: number): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = `${dir}/${String(index).padStart(4, '0')}.json`
  writeFileSync(path, JSON.stringify(serializeSnapshot(snap)))
}

export function loadSnapshot(path: string): GameSnapshot {
  return deserializeSnapshot(JSON.parse(readFileSync(path, 'utf-8')))
}

export type SnapshotFilter = {
  /** フィルタ対象の役職 */
  aliveRoles?: string[]
  /** 最低生存席数 (デフォルト: 1) */
  minAlive?: number
}

/** ディレクトリからランダムに count 個のスナップショットを読み込む */
export function loadRandomSnapshots(day: number, count: number, rng?: Rng, filter?: SnapshotFilter): GameSnapshot[] {
  const dir = snapshotDir(day)
  if (!existsSync(dir)) throw new Error(`Snapshot directory not found: ${dir}`)

  let files = readdirSync(dir).filter(f => f.endsWith('.json'))
  if (files.length === 0) throw new Error(`No snapshots found in ${dir}`)

  // フィルタ: メタデータを読んで条件に合うファイルだけ残す
  if (filter?.aliveRoles && filter.aliveRoles.length > 0) {
    const minAlive = filter.minAlive ?? 1
    const targetRoles = filter.aliveRoles
    files = files.filter(f => {
      try {
        const data: SerializedSnapshot = JSON.parse(readFileSync(`${dir}/${f}`, 'utf-8'))
        if (!data.aliveRoleCounts) return true  // メタデータなし（旧形式）は通す
        return checkAliveRoles(data.aliveRoleCounts, targetRoles, minAlive)
      } catch { return false }
    })
    if (files.length === 0) throw new Error(`No snapshots in ${dir} match filter (aliveRoles=${targetRoles.join(',')}, minAlive=${minAlive})`)
  }

  const r = rng ?? new Rng()
  const result: GameSnapshot[] = []
  for (let i = 0; i < count; i++) {
    const file = files[r.nextInt(files.length)]
    result.push(loadSnapshot(`${dir}/${file}`))
  }
  return result
}

/** ディレクトリ内のスナップショット数を返す */
export function countSnapshots(day: number): number {
  const dir = snapshotDir(day)
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter(f => f.endsWith('.json')).length
}

// ============================================================
// 生成
// ============================================================

export async function generateSnapshotsToDir(opts: {
  snapshotDay: number
  count: number
  trainingConfig: TrainingConfig
  startSeed: number
  /** 生存必須役職（指定時、これらが minAlive 席以上生存のスナップショットだけ保存） */
  aliveRoles?: string[]
  /** 最低生存席数 (デフォルト: 1) */
  minAlive?: number
}): Promise<{ generated: number, skipped: number, timeMs: number }> {
  const { snapshotDay, count, trainingConfig, startSeed, aliveRoles, minAlive = 1 } = opts
  const roles = new Map(Object.entries(trainingConfig.roles) as [SystemRole, number][])
  const dir = snapshotDir(snapshotDay)
  const existingCount = countSnapshots(snapshotDay)
  const t0 = performance.now()

  let generated = 0
  let skipped = 0
  let seed = startSeed

  while (generated < count) {
    const config: GameConfig = {
      roles,
      seed: seed++,
      hasFirstGhost: trainingConfig.hasFirstGhost,
      revoteConfig: trainingConfig.revoteConfig,
      rules: trainingConfig.rules,
      captureSnapshotDays: [snapshotDay],
    }

    const handlers = strategyAdapter({
      defaultStrategy: new HeuristicStrategy(),
      wolfTeamStrategy: new WolfTeamHeuristic(),
      masonTeamStrategy: new MasonTeamHeuristic(),
      enableRetar: trainingConfig.enableRetar,
      seed: seed,
      roles,
      rules: trainingConfig.rules,
    })

    const result = await runGame(config, handlers)
    const snapshot = result.snapshots?.get(snapshotDay)

    if (snapshot) {
      // 生存役職フィルタ
      if (aliveRoles && aliveRoles.length > 0) {
        const counts = computeAliveRoleCounts(snapshot)
        if (!checkAliveRoles(counts, aliveRoles, minAlive)) {
          skipped++
          continue
        }
      }
      saveSnapshot(snapshot, dir, existingCount + generated)
      generated++
      if (generated % 100 === 0) {
        process.stderr.write(`\r  ${generated}/${count} generated (${skipped} skipped)`)
      }
    } else {
      skipped++
    }
  }

  if (count >= 100) process.stderr.write('\r\x1b[K')

  return { generated, skipped, timeMs: performance.now() - t0 }
}
