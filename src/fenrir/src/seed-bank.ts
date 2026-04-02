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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import type { SystemRole } from '../../types/index.ts'
import type { GameSnapshot, GameState, GameEvent } from '../../lupa/types.ts'
import type { GameConfig } from '../../lupa/handlers.ts'
import { runGame } from '../../lupa/engine.ts'
import { fullAdapter } from './lupaAdapters/full-adapter.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from './heuristic.ts'
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

function serializeSnapshot(snap: GameSnapshot<any>): SerializedSnapshot {
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

const SNAPSHOT_BASE = 'tmp/snapshots'
const SNAPSHOT_EVAL_BASE = 'tmp/snapshots-eval'

/** 保存用: 条件に対応する単一ディレクトリ */
function snapshotDirExact(day: number, aliveRoles?: string[], minAlive?: number, base = SNAPSHOT_BASE): string {
  if (aliveRoles && aliveRoles.length > 0 && minAlive && minAlive > 0) {
    return `${base}/day${day}/${filterDirName(aliveRoles, minAlive)}`
  }
  return `${base}/day${day}/any`
}

/** 読み込み用: minAlive 以上の条件を満たすディレクトリを全て返す */
function snapshotDirsCompatible(day: number, aliveRoles?: string[], minAlive?: number, baseDir = SNAPSHOT_BASE): string[] {
  const base = `${baseDir}/day${day}`
  if (!existsSync(base)) return []
  if (!aliveRoles || aliveRoles.length === 0) {
    // フィルタなし → 全サブディレクトリ
    return readdirSync(base).map(d => `${base}/${d}`).filter(d => existsSync(d))
  }
  const sorted = [...aliveRoles].sort()
  // 既知グループ名を検出
  const KNOWN_GROUPS: Record<string, string[]> = {
    village: ['bodyguard', 'medium', 'nekomata', 'seer', 'villager'],
    wolf: ['werewolf'],
  }
  let prefix = sorted.join('+')
  for (const [name, roles] of Object.entries(KNOWN_GROUPS)) {
    if (sorted.length === roles.length && sorted.every((r, i) => r === roles[i])) {
      prefix = name
      break
    }
  }
  // prefix-N のうち N >= minAlive のディレクトリを返す
  const target = minAlive ?? 1
  const dirs: string[] = []
  for (const d of readdirSync(base)) {
    const m = d.match(new RegExp(`^${prefix}-(\\d+)$`))
    if (m && parseInt(m[1]) >= target) {
      dirs.push(`${base}/${d}`)
    }
  }
  return dirs
}

// ============================================================
// ディスク I/O
// ============================================================

export function saveSnapshot(snap: GameSnapshot<any>, dir: string, index: number): void {
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
  /** eval 専用ディレクトリから読み込む */
  forEval?: boolean
}

/** ディレクトリからランダムに count 個のスナップショットを読み込む */
export function loadRandomSnapshots(day: number, count: number, rng?: Rng, filter?: SnapshotFilter): GameSnapshot[] {
  const base = filter?.forEval ? SNAPSHOT_EVAL_BASE : SNAPSHOT_BASE
  const dirs = snapshotDirsCompatible(day, filter?.aliveRoles, filter?.minAlive, base)
  const r = rng ?? new Rng()

  function scanFiles(): string[] {
    const files: string[] = []
    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.json')) files.push(`${dir}/${f}`)
      }
    }
    return files
  }

  let allFiles = scanFiles()
  if (allFiles.length === 0) {
    const dirName = filter?.aliveRoles ? filterDirName(filter.aliveRoles, filter.minAlive ?? 1) : 'any'
    throw new Error(`No snapshots found for day${day}/${dirName}`)
  }

  const result: GameSnapshot[] = []
  let retries = 0
  const MAX_RETRIES = 3
  for (let i = 0; i < count; i++) {
    const file = allFiles[r.nextInt(allFiles.length)]
    try {
      result.push(loadSnapshot(file))
      retries = 0
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e
      // ファイルが削除された → リスキャン
      retries++
      if (retries > MAX_RETRIES) {
        allFiles = scanFiles()
        if (allFiles.length === 0) throw new Error(`All snapshots removed during loading`)
        retries = 0
      }
      i--  // リトライ
    }
  }
  return result
}

/** 互換ディレクトリ内の合計スナップショット数を返す */
export function countSnapshots(day: number, aliveRoles?: string[], minAlive?: number, forEval?: boolean): number {
  const base = forEval ? SNAPSHOT_EVAL_BASE : SNAPSHOT_BASE
  const dirs = snapshotDirsCompatible(day, aliveRoles, minAlive, base)
  let total = 0
  for (const dir of dirs) {
    total += readdirSync(dir).filter(f => f.endsWith('.json')).length
  }
  return total
}

/** 古いスナップショットを削除（ファイル名ソートで先頭から n 個） */
export function retireSnapshots(day: number, n: number, aliveRoles?: string[], minAlive?: number, forEval?: boolean): number {
  const dir = snapshotDirExact(day, aliveRoles, minAlive, forEval ? SNAPSHOT_EVAL_BASE : SNAPSHOT_BASE)
  if (!existsSync(dir)) return 0
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort()
  const toDelete = files.slice(0, n)
  for (const f of toDelete) unlinkSync(`${dir}/${f}`)
  return toDelete.length
}

// ============================================================
// 生成
// ============================================================

function countAliveRoles(snap: GameSnapshot<any>, targetRoles: string[]): number {
  const targetSet = new Set(targetRoles)
  return snap.state.players.filter(p => p.alive && targetSet.has(p.role)).length
}

export async function generateSnapshotsToDir(opts: {
  /** スナップショットを取得する Day（複数指定で1ゲームから複数 Day 分を同時取得） */
  snapshotDays: number[]
  count: number
  trainingConfig: TrainingConfig
  startSeed: number
  /** 生存必須役職（指定時、これらが minAlive 席以上生存のスナップショットだけ保存） */
  aliveRoles?: string[]
  /** 最低生存席数 (デフォルト: 1) */
  minAlive?: number
  /** eval 専用ディレクトリに保存 */
  forEval?: boolean
}): Promise<{ generated: Map<number, number>, skipped: number, timeMs: number }> {
  const { snapshotDays, count, trainingConfig, startSeed, aliveRoles, minAlive = 1, forEval } = opts
  const base = forEval ? SNAPSHOT_EVAL_BASE : SNAPSHOT_BASE
  const roles = new Map(Object.entries(trainingConfig.roles) as [SystemRole, number][])
  const t0 = performance.now()

  // Day ごとの既存数と生成数を追跡
  const existing = new Map<number, number>()
  const generated = new Map<number, number>()
  for (const day of snapshotDays) {
    existing.set(day, countSnapshots(day, aliveRoles, minAlive, forEval))
    generated.set(day, 0)
  }

  let skipped = 0
  let seed = startSeed
  let totalGames = 0

  // 全 Day が count に達するまで
  while (snapshotDays.some(d => generated.get(d)! < count)) {
    const config: GameConfig = {
      roles,
      seed: seed++,
      hasFirstGhost: trainingConfig.hasFirstGhost,
      revoteConfig: trainingConfig.revoteConfig,
      rules: trainingConfig.rules,
      captureSnapshotDays: snapshotDays,
    }

    const handlers = fullAdapter({
      defaultStrategy: new HeuristicStrategy(),
      wolfTeamStrategy: new WolfTeamHeuristic(),
      masonTeamStrategy: new MasonTeamHeuristic(),
      enableRetar: trainingConfig.enableRetar,
      seed: seed,
      roles,
      rules: trainingConfig.rules,
    })

    const result = await runGame(config, handlers)
    totalGames++

    let savedAny = false
    for (const day of snapshotDays) {
      if (generated.get(day)! >= count) continue
      const snapshot = result.snapshots?.get(day)
      if (!snapshot) continue
      if (aliveRoles && aliveRoles.length > 0 && countAliveRoles(snapshot, aliveRoles) < minAlive) continue

      const dir = snapshotDirExact(day, aliveRoles, minAlive, base)
      saveSnapshot(snapshot, dir, existing.get(day)! + generated.get(day)!)
      generated.set(day, generated.get(day)! + 1)
      savedAny = true
    }
    if (!savedAny) skipped++

    const totalGenerated = [...generated.values()].reduce((a, b) => a + b, 0)
    if (totalGenerated % 100 === 0 && totalGenerated > 0) {
      const progress = snapshotDays.map(d => `day${d}:${generated.get(d)}/${count}`).join(' ')
      process.stderr.write(`\r  ${progress} (${skipped} skipped)`)
    }
  }

  const totalGenerated = [...generated.values()].reduce((a, b) => a + b, 0)
  if (totalGenerated >= 100) process.stderr.write('\r\x1b[K')

  return { generated, skipped, timeMs: performance.now() - t0 }
}
