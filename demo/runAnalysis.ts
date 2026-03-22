import type { RetarRequest, RetarResponse, SeatResult } from './analysis.worker.ts'
import type { SystemRole } from '../src/types/index.ts'
import { AnalysisScheduler, mergeResults } from './scheduler.ts'
import type { AnalysisResult, AnalysisStats, SchedulerCallback } from './scheduler.ts'
import AnalysisWorker from './analysis.worker.ts?worker'

export type { AnalysisResult, AnalysisStats, SeatResult }

type AnalysisPayload = Omit<RetarRequest, 'batches' | 'batch'>

// --- Worker Pool ---

const poolSize = navigator.hardwareConcurrency || 4
const hasSAB = typeof SharedArrayBuffer !== 'undefined'
const signal: Int32Array | null = hasSAB ? new Int32Array(new SharedArrayBuffer(4)) : null

function createWorker(): any {
  const w: any = new AnalysisWorker()
  if (signal) w.postMessage({ type: 'init', signal: signal.buffer })
  return w
}

const scheduler = new AnalysisScheduler({
  poolSize,
  createWorker,
  signal,
})

// --- Public API ---

export function requestAnalysis(payload: AnalysisPayload, callback: SchedulerCallback): void {
  scheduler.request(payload, callback)
}

// --- For PlayerDialog (independent, non-scheduled) ---

export function runParallelAnalysis(payload: AnalysisPayload): Promise<AnalysisResult> {
  return new Promise((resolve) => {
    const localWorkers: any[] = []
    const numWorkers = poolSize
    const results: SeatResult[][] = []
    const elapsedTimes: number[] = []
    let completed = 0
    let failed = false
    let errorMessage = ''

    for (let i = 0; i < numWorkers; i++) {
      localWorkers.push(createWorker())
    }

    function terminateAll() {
      for (const w of localWorkers) w.terminate()
    }

    for (let i = 0; i < numWorkers; i++) {
      const worker = localWorkers[i]

      worker.onmessage = (e: any) => {
        const data = e.data as RetarResponse
        if (data.type === 'error') {
          if (!failed) { failed = true; errorMessage = data.message }
          completed++
          if (completed === numWorkers) { terminateAll(); resolve({ type: 'error', message: errorMessage }) }
          return
        }
        if (data.type === 'aborted') {
          completed++
          if (completed === numWorkers) { terminateAll(); resolve({ type: 'error', message: 'Aborted' }) }
          return
        }
        results.push(data.seats)
        elapsedTimes.push(data.elapsed)
        completed++
        if (completed === numWorkers) {
          terminateAll()
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
        if (!failed) { failed = true; errorMessage = `Worker error: ${e.message}` }
        completed++
        if (completed === numWorkers) { terminateAll(); resolve({ type: 'error', message: errorMessage }) }
      }

      worker.postMessage({ ...payload, batches: numWorkers, batch: i })
    }
  })
}
