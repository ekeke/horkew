import type { RetarRequest, RetarResponse, SeatResult } from './analysis.worker.ts'
import type { SystemRole } from '../src/types/index.ts'
import AnalysisWorker from './analysis.worker.ts?worker'

type AnalysisPayload = Omit<RetarRequest, 'batches' | 'batch'>

export type AnalysisStats = {
  workers: number
  minElapsed: number
  maxElapsed: number
}

export type AnalysisResult =
  | { type: 'result'; seats: SeatResult[]; stats: AnalysisStats }
  | { type: 'error'; message: string }

// --- Worker Pool ---

const poolSize = navigator.hardwareConcurrency || 4
const hasSAB = typeof SharedArrayBuffer !== 'undefined'
const signal: Int32Array | null = hasSAB ? new Int32Array(new SharedArrayBuffer(4)) : null
let pool: any[] | null = null

function createWorker(): any {
  const w: any = new AnalysisWorker()
  if (signal) w.postMessage({ type: 'init', signal: signal.buffer })
  return w
}

function ensurePool(): any[] {
  if (pool) return pool
  pool = []
  for (let i = 0; i < poolSize; i++) {
    pool.push(createWorker())
  }
  return pool
}

function destroyPool(): void {
  if (!pool) return
  for (const w of pool) w.terminate()
  pool = null
}

// --- Scheduler ---

type SchedulerCallback = (result: AnalysisResult) => void

let state: 'idle' | 'running' = 'idle'
let pending: AnalysisPayload | null = null
let currentCallback: SchedulerCallback | null = null

export function requestAnalysis(payload: AnalysisPayload, callback: SchedulerCallback): void {
  if (state === 'idle') {
    dispatch(payload, callback)
  } else {
    pending = payload
    currentCallback = callback
    if (signal) {
      // SAB: cooperative abort — workers check signal and return early
      Atomics.store(signal, 0, 1)
    }
    // No SAB: can't abort, but onAllDone will dispatch pending when current run finishes
  }
}

function dispatch(payload: AnalysisPayload, callback: SchedulerCallback): void {
  state = 'running'
  pending = null
  currentCallback = callback

  if (signal) Atomics.store(signal, 0, 0)

  const workers = ensurePool()
  const numWorkers = workers.length
  const results: SeatResult[][] = []
  const elapsedTimes: number[] = []
  let completed = 0
  let failed = false
  let errorMessage = ''

  for (let i = 0; i < numWorkers; i++) {
    const worker = workers[i]

    worker.onmessage = (e: any) => {
      const data = e.data as RetarResponse
      if (data.type === 'aborted') {
        completed++
        if (completed === numWorkers) onAllDone()
        return
      }
      if (data.type === 'error') {
        if (!failed) { failed = true; errorMessage = data.message }
        completed++
        if (completed === numWorkers) onAllDone()
        return
      }
      results.push(data.seats)
      elapsedTimes.push(data.elapsed)
      completed++
      if (completed === numWorkers) onAllDone()
    }

    worker.onerror = (e: any) => {
      if (!failed) { failed = true; errorMessage = `Worker error: ${e.message}` }
      completed++
      if (completed === numWorkers) onAllDone()
    }

    worker.postMessage({ ...payload, batches: numWorkers, batch: i })
  }

  function onAllDone() {
    if (pending) {
      const nextPayload = pending
      const nextCallback = currentCallback!
      dispatch(nextPayload, nextCallback)
      return
    }
    if (failed || results.length === 0) {
      finishWith({ type: 'error', message: errorMessage || 'Analysis produced no results' })
      return
    }
    finishWith({
      type: 'result',
      seats: mergeResults(results),
      stats: {
        workers: numWorkers,
        minElapsed: Math.round(Math.min(...elapsedTimes)),
        maxElapsed: Math.round(Math.max(...elapsedTimes)),
      },
    })
  }

  function finishWith(result: AnalysisResult) {
    state = 'idle'
    const cb = currentCallback
    currentCallback = null
    cb?.(result)
  }
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
