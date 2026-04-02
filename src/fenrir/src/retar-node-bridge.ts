/**
 * Retar統合ブリッジ (Node.js専用 — worker_threads 並列版)
 *
 * Howlテキスト生成はメインスレッドで行い、Retar実行をN分割して並列実行する。
 * ブラウザ互換のシングルスレッド版は retar-bridge.ts を参照。
 */

import type { SystemRole } from '../../types/index.ts'
import type { LupaConfig, GameState, GameEvent } from '../../lupa/types.ts'
import { formatHowl } from '../../lupa/format.ts'
import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { RetarWorkerRequest, RetarWorkerResponse } from './retar-worker.ts'
import { analyzeFromEvents } from './retar-bridge.ts'

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
