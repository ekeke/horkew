/**
 * skoll-zero worker pool 管理 + 並列 self-play dispatch。
 *
 * Stage 1: 永続 worker × N に self-play chunk を dispatch、Pure JS forward は worker 内で実行。
 *
 * フロー:
 *   1. phase 開始時に initSkollZeroWorkerPool(N)
 *   2. 各 round で runSelfPlayParallel(cfg, numGames):
 *      - 各 slot.nn から SharedWeights を pack (1 round 1 回)
 *      - seeds を interleaved で N 分割
 *      - SelfPlayChunkRequest を全 worker に postMessage
 *      - 全 worker の SelfPlayChunkResult を待ち、records を slot.buffer に merge
 *      - outcomes 集計を返す
 *   3. phase 終了時に terminateSkollZeroWorkerPool()
 */

import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { SystemRole } from '../../types/index.ts'
import { packWeights, type SharedWeights } from '../../fenrir/src/parallel.ts'
import type { AnyNetwork } from '../../fenrir/src/ml/nn.ts'
import type { MultiAgentSelfPlayConfig } from '../selfplay/multi-runner.ts'
import type {
  SelfPlayChunkRequest,
  WorkerToMainMessage,
  SerializedOutcomes,
  SerializableMCTSConfig,
  SlotName,
} from './types.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const WORKER_PATH = join(__dirname, 'skoll-zero-worker.ts')

let workerPool: Worker[] = []

export function initSkollZeroWorkerPool(numWorkers?: number): void {
  if (workerPool.length > 0) return
  const n = numWorkers ?? Math.max(1, (availableParallelism?.() ?? 4) - 1)
  for (let i = 0; i < n; i++) {
    const w = new Worker(WORKER_PATH, {
      execArgv: ['--experimental-strip-types'],
    })
    workerPool.push(w)
  }
  process.stderr.write(`[skoll-zero parallel] worker pool initialized: ${n} workers\n`)
}

export function terminateSkollZeroWorkerPool(): void {
  for (const w of workerPool) w.terminate()
  workerPool = []
}

export function skollZeroWorkerPoolSize(): number {
  return workerPool.length
}

export type ParallelSelfPlayConfig = Omit<MultiAgentSelfPlayConfig, 'mctsConfig' | 'collectGameRecord'> & {
  /** rngSeed は dispatch 時に各 worker の最初の game seed で上書きされる (worker 間 rng 独立性のため) */
  mctsConfig: Omit<SerializableMCTSConfig, 'rngSeed'>
  /** Stage 2+ で main 集約に使う想定。Stage 1 では worker に渡すだけ */
  batchInferSize?: number
}

/**
 * 並列 self-play。numGames を pool size で interleaved 分割し、各 worker に dispatch。
 *
 * 副作用: cfg.slots[*].buffer に finalize 済み TrainingRecord[] が `appendFinalized` 経由で push される
 * (sequential 経路と同じ semantics: 1 round 終了時点で finalize 済み records が累積)。
 *
 * 戻り値: 全 chunk の outcomes 集計。
 */
export function runSelfPlayParallel(
  cfg: ParallelSelfPlayConfig,
  numGames: number,
): Promise<{ outcomes: SerializedOutcomes }> {
  const n = workerPool.length
  if (n === 0) throw new Error('skoll-zero worker pool not initialized')

  // seeds を interleaved 分割
  const chunks: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < numGames; i++) {
    chunks[i % n].push(cfg.seed + i)
  }

  // SharedWeights を pack (slot ごとに 1 度のみ、全 worker 間で SharedArrayBuffer を共有)
  const weights: Partial<Record<SlotName, SharedWeights>> = {}
  for (const slotName of Object.keys(cfg.slots) as SlotName[]) {
    const slot = cfg.slots[slotName]
    if (!slot) continue
    // slot.nn は MasonZeroNN interface、実装は MasonZeroNetwork で .net: TransformerNetwork を持つ
    const net = (slot.nn as unknown as { net: AnyNetwork }).net
    weights[slotName] = packWeights(net)
  }

  // cfg.roles が undefined の場合は worker に渡さず、worker 側で DEFAULT_ROLES に
  // fallback させる (逐次経路 runMultiAgentSelfPlayGame の `cfg.roles ?? DEFAULT_ROLES` と一致)。
  const rolesEntries: Array<[SystemRole, number]> | undefined = cfg.roles
    ? [...cfg.roles.entries()]
    : undefined
  const selectionMode = cfg.selectionMode ?? 'sample'

  return new Promise((resolve, reject) => {
    const aggregated: SerializedOutcomes = {
      villagerWon: 0, werewolfWon: 0, werehamsterWon: 0, draw: 0,
    }
    let completed = 0
    let rejected = false

    const finalize = (): void => {
      if (rejected) return
      if (completed === n) resolve({ outcomes: aggregated })
    }

    for (let i = 0; i < n; i++) {
      const worker = workerPool[i]
      const seeds = chunks[i]
      if (seeds.length === 0) {
        completed++
        finalize()
        continue
      }

      const onMessage = (msg: WorkerToMainMessage): void => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        if (rejected) return
        if (msg.type === 'self_play_error') {
          rejected = true
          reject(new Error(`skoll-zero worker chunk failed: ${msg.message}\n${msg.stack ?? ''}`))
          return
        }
        // outcomes 集計
        aggregated.villagerWon += msg.outcomes.villagerWon
        aggregated.werewolfWon += msg.outcomes.werewolfWon
        aggregated.werehamsterWon += msg.outcomes.werehamsterWon
        aggregated.draw += msg.outcomes.draw
        // records を main slot buffer へ merge
        for (const slotName of Object.keys(msg.records) as SlotName[]) {
          const recs = msg.records[slotName]
          const slot = cfg.slots[slotName]
          if (!recs || !slot) continue
          slot.buffer.appendFinalized(recs)
        }
        completed++
        finalize()
      }

      const onError = (err: Error): void => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        if (rejected) return
        rejected = true
        reject(err)
      }

      worker.on('message', onMessage)
      worker.on('error', onError)
      const request: SelfPlayChunkRequest = {
        type: 'self_play_chunk',
        weights,
        rolesEntries,
        mctsConfig: { ...cfg.mctsConfig, rngSeed: seeds[0] },
        selectionMode,
        batchInferSize: cfg.batchInferSize ?? 1,
        seeds,
      }
      worker.postMessage(request)
    }
  })
}
