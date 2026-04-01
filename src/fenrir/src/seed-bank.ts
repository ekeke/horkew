/**
 * Seed Bank — 中盤スナップショットの事前生成とディスク管理
 *
 * オフライン:  npm run generate-snapshots -- --day 3 --count 1000 --alive village --min-alive 3
 * 学習時:      loadRandomSnapshots() でランダムに読み込み
 *
 * ディレクトリ構造:
 *   tmp/snapshots/day3/village-3/
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
  }
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
// ディレクトリ命名
// ============================================================

/** ソート済み役職名 + 最低生存数 → ディレクトリ名 (例: "village-3") */
export function filterDirName(aliveRoles: string[], minAlive: number): string {
  // 既知グループ名にマッチすれば短縮
  const sorted = [...aliveRoles].sort()
  const KNOWN_GROUPS: Record<string, string[]> = {
    village: ['bodyguard', 'medium', 'nekomata', 'seer', 'villager'],
    wolf: ['werewolf'],
  }
  for (const [name, roles] of Object.entries(KNOWN_GROUPS)) {
    if (sorted.length === roles.length && sorted.every((r, i) => r === roles[i])) {
      return `${name}-${minAlive}`
    }
  }
  return `${sorted.join('+')}-${minAlive}`
}

function snapshotDir(day: number, aliveRoles?: string[], minAlive?: number): string {
  if (aliveRoles && aliveRoles.length > 0 && minAlive && minAlive > 0) {
    return `tmp/snapshots/day${day}/${filterDirName(aliveRoles, minAlive)}`
  }
  return `tmp/snapshots/day${day}/any`
}

// ============================================================
// ディスク I/O
// ============================================================

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

/** ディレクトリからランダムに count 個のスナップショットを読み込む（フィルタ不要、ディレクトリで条件確定済み） */
export function loadRandomSnapshots(day: number, count: number, rng?: Rng, filter?: SnapshotFilter): GameSnapshot[] {
  const dir = snapshotDir(day, filter?.aliveRoles, filter?.minAlive)
  if (!existsSync(dir)) throw new Error(`Snapshot directory not found: ${dir}`)

  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  if (files.length === 0) throw new Error(`No snapshots found in ${dir}`)

  const r = rng ?? new Rng()
  const result: GameSnapshot[] = []
  for (let i = 0; i < count; i++) {
    const file = files[r.nextInt(files.length)]
    result.push(loadSnapshot(`${dir}/${file}`))
  }
  return result
}

/** ディレクトリ内のスナップショット数を返す */
export function countSnapshots(day: number, aliveRoles?: string[], minAlive?: number): number {
  const dir = snapshotDir(day, aliveRoles, minAlive)
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter(f => f.endsWith('.json')).length
}

// ============================================================
// 生成
// ============================================================

function countAliveRoles(snap: GameSnapshot, targetRoles: string[]): number {
  const targetSet = new Set(targetRoles)
  return snap.state.players.filter(p => p.alive && targetSet.has(p.role)).length
}

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
  const dir = snapshotDir(snapshotDay, aliveRoles, minAlive)
  const existingCount = countSnapshots(snapshotDay, aliveRoles, minAlive)
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
      if (aliveRoles && aliveRoles.length > 0 && countAliveRoles(snapshot, aliveRoles) < minAlive) {
        skipped++
        continue
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
