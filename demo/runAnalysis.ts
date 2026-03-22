import type { RetarRequest, RetarResponse, SeatResult } from './analysis.worker.ts'
import type { SystemRole } from '../src/types/index.ts'
import AnalysisWorker from './analysis.worker.ts?worker'

type AnalysisPayload = Omit<RetarRequest, 'batches' | 'batch'>

export type AnalysisStats = {
  workers: number
  minElapsed: number
  maxElapsed: number
}

export type ParallelRetarResponse =
  | { type: 'result'; seats: SeatResult[]; stats: AnalysisStats }
  | { type: 'error'; message: string }

// --- Worker Pool ---

const poolSize = navigator.hardwareConcurrency || 4
const idle: any[] = []

function initPool() {
  for (let i = 0; i < poolSize; i++) {
    idle.push(new AnalysisWorker())
  }
}

function acquireAll(): any[] {
  if (idle.length === 0) initPool()
  return idle.splice(0)
}

function releaseAll(workers: any[]) {
  for (const w of workers) {
    w.onmessage = null
    w.onerror = null
    idle.push(w)
  }
}

// --- Parallel Analysis ---

export function runParallelAnalysis(payload: AnalysisPayload): {
  promise: Promise<ParallelRetarResponse>
  abort: () => void
} {
  const workers = acquireAll()
  const numWorkers = workers.length
  let aborted = false

  const promise = new Promise<ParallelRetarResponse>((resolve) => {
    const results: SeatResult[][] = []
    const elapsedTimes: number[] = []
    let completed = 0
    let failed = false

    function onDone() {
      if (!aborted) releaseAll(workers)
    }

    function onError(message: string) {
      if (failed) return
      failed = true
      onDone()
      resolve({ type: 'error', message })
    }

    for (let i = 0; i < numWorkers; i++) {
      const worker = workers[i]

      worker.onmessage = (e: any) => {
        if (failed || aborted) return
        const data = e.data as RetarResponse
        if (data.type === 'error') {
          onError(data.message)
          return
        }
        results.push(data.seats)
        elapsedTimes.push(data.elapsed)
        completed++
        if (completed === numWorkers) {
          onDone()
          resolve({
            type: 'result',
            seats: mergeResults(results),
            stats: {
              workers: numWorkers,
              minElapsed: Math.round(Math.min(...elapsedTimes)),
              maxElapsed: Math.round(Math.max(...elapsedTimes)),
            },
          })
        }
      }

      worker.onerror = (e: any) => {
        if (failed || aborted) return
        onError(`Worker error: ${e.message}`)
      }

      worker.postMessage({ ...payload, batches: numWorkers, batch: i })
    }
  })

  return {
    promise,
    abort() {
      aborted = true
      // Abort 時はワーカーを破棄して新しいプールを作り直す
      for (const w of workers) w.terminate()
    },
  }
}

function mergeResults(batches: SeatResult[][]): SeatResult[] {
  const merged = new Map<number, Set<SystemRole>>()

  for (const seats of batches) {
    for (const { seat, roles } of seats) {
      let set = merged.get(seat)
      if (!set) {
        set = new Set()
        merged.set(seat, set)
      }
      for (const role of roles) set.add(role)
    }
  }

  const result: SeatResult[] = []
  for (const [seat, roles] of merged) {
    result.push({ seat, roles: [...roles] })
  }
  return result
}
