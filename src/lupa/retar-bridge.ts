/**
 * Retar統合ブリッジ
 *
 * Lupaエンジンの途中状態からRetarの論理推論を実行する。
 * verify.tsと同じパイプライン: GameEvents → formatHowl → parse → buildVillageStatus → VillageRetar
 *
 * 並列版 (analyzeFromEventsParallel) は worker_threads でバッチ分割実行する。
 */

import type { SystemRole } from '../types/index.ts'
import type { LupaConfig, GameState, GameEvent } from './types.ts'
import { formatHowl } from './format.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { searchTsumi } from '../hati/index.ts'
import type { TsumiResult } from '../hati/index.ts'
import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { RetarWorkerRequest, RetarWorkerResponse } from './retar-worker.ts'

const DEFAULT_RETAR_OPTIONS: AnalyzeOptions = {
  seerClaimingDueDate: 99,
  mediumClaimingDueDate: 99,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 99,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  hasFirstGhost: false,
  assumptions: new Map(),
  wolfPairDenyals: [],
  hocusPocus: new Map(),
  id: 0,
  batches: 1,
  batch: 0,
}

/**
 * 現在のイベント列からRetarの役職可能性を計算 (シングルスレッド)
 */
export function analyzeFromEvents(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
): Map<number, Set<SystemRole>> {
  const howl = formatHowl(events, state, config)
  const { meta, statements } = parse(howl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) {
    return new Map()
  }

  const { vs, setup } = buildVillageStatus(statements, meta)

  const options = config.hasFirstGhost
    ? { ...DEFAULT_RETAR_OPTIONS, hasFirstGhost: true }
    : DEFAULT_RETAR_OPTIONS

  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyzeSafe()

  if (result.error || !result.result) {
    return new Map()
  }

  return result.result
}

/**
 * Hati詰み探索をイベント列から実行
 *
 * analyzeFromEventsと同じHowl→parse→buildVillageStatusパイプラインを使い、
 * searchTsumiで村側の詰み進行を探索する。
 */
export function searchTsumiFromEvents(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
  maxDepth: number = 4,
): TsumiResult | null {
  const howl = formatHowl(events, state, config)
  const { meta, statements } = parse(howl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) return null

  const { vs, setup } = buildVillageStatus(statements, meta)
  const options: AnalyzeOptions = config.hasFirstGhost
    ? { ...DEFAULT_RETAR_OPTIONS, hasFirstGhost: true }
    : DEFAULT_RETAR_OPTIONS

  try {
    return searchTsumi(vs, setup, options, { maxDepth })
  } catch {
    return null
  }
}

// ============================================================
// Worker Pool (worker_threads)
// ============================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const WORKER_PATH = join(__dirname, 'retar-worker.ts')

let workerPool: Worker[] = []
let poolReady = false

/**
 * worker_threads プールを初期化
 * @param numWorkers ワーカー数 (default: CPU数 - 1)
 */
export function initRetarWorkerPool(numWorkers?: number): void {
  if (poolReady) return
  const n = numWorkers ?? Math.max(1, (availableParallelism?.() ?? 4) - 1)
  for (let i = 0; i < n; i++) {
    const w = new Worker(WORKER_PATH, {
      execArgv: ['--experimental-strip-types'],
    })
    w.setMaxListeners(100)
    workerPool.push(w)
  }
  poolReady = true
}

/** ワーカープールを終了 */
export function terminateRetarWorkerPool(): void {
  for (const w of workerPool) w.terminate()
  workerPool = []
  poolReady = false
}

function mergeResults(
  batches: Array<Array<{ seat: number, roles: SystemRole[] }>>,
): Map<number, Set<SystemRole>> {
  const merged = new Map<number, Set<SystemRole>>()
  for (const seats of batches) {
    for (const { seat, roles } of seats) {
      let set = merged.get(seat)
      if (!set) { set = new Set(); merged.set(seat, set) }
      for (const role of roles) set.add(role)
    }
  }
  return merged
}

/**
 * worker_threads で並列Retar分析
 *
 * Howlテキスト生成はメインスレッドで行い、Retar実行をN分割して並列実行。
 * プールが未初期化ならフォールバックでシングルスレッド実行。
 */
export function analyzeFromEventsParallel(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
): Promise<Map<number, Set<SystemRole>>> {
  // プール未初期化ならシングルスレッドにフォールバック
  if (!poolReady || workerPool.length === 0) {
    return Promise.resolve(analyzeFromEvents(events, state, config))
  }

  const howl = formatHowl(events, state, config)
  const numWorkers = workerPool.length

  return new Promise((resolve) => {
    const results: Array<Array<{ seat: number, roles: SystemRole[] }>> = []
    let completed = 0

    for (let i = 0; i < numWorkers; i++) {
      const worker = workerPool[i]
      const req: RetarWorkerRequest = {
        howl,
        hasFirstGhost: config.hasFirstGhost ?? false,
        batches: numWorkers,
        batch: i,
      }

      const handler = (resp: RetarWorkerResponse) => {
        worker.off('message', handler)
        if (resp.type === 'result') {
          results.push(resp.seats)
        }
        completed++
        if (completed === numWorkers) {
          resolve(results.length > 0 ? mergeResults(results) : new Map())
        }
      }

      worker.on('message', handler)
      worker.postMessage(req)
    }
  })
}

