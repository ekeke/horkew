import type { SystemRole } from '../src/types/index.ts'

export type SeatResult = {
  seat: number
  roles: SystemRole[]
}

export type WorkerResponse =
  | { type: 'result'; seats: SeatResult[]; elapsed: number }
  | { type: 'aborted' }
  | { type: 'error'; message: string }

export type AnalysisStats = {
  workers: number
  minElapsed: number
  maxElapsed: number
}

export type AnalysisResult =
  | { type: 'result'; seats: SeatResult[]; stats: AnalysisStats }
  | { type: 'error'; message: string }

export type SchedulerCallback = (result: AnalysisResult) => void

export interface WorkerLike {
  postMessage(data: any): void
  onmessage: ((e: { data: any }) => void) | null
  onerror: ((e: { message?: string }) => void) | null
  terminate(): void
}

export type SchedulerOptions = {
  poolSize: number
  createWorker: () => WorkerLike
  signal: Int32Array | null
}

export class AnalysisScheduler {
  private pool: WorkerLike[] | null = null
  private state: 'idle' | 'running' = 'idle'
  private pending: any | null = null
  private currentCallback: SchedulerCallback | null = null
  private options: SchedulerOptions

  constructor(options: SchedulerOptions) {
    this.options = options
  }

  getState() { return this.state }

  private ensurePool(): WorkerLike[] {
    if (this.pool) return this.pool
    this.pool = []
    for (let i = 0; i < this.options.poolSize; i++) {
      this.pool.push(this.options.createWorker())
    }
    return this.pool
  }

  request(payload: any, callback: SchedulerCallback): void {
    if (this.state === 'idle') {
      this.dispatch(payload, callback)
    } else {
      this.pending = payload
      this.currentCallback = callback
      if (this.options.signal) {
        Atomics.store(this.options.signal, 0, 1)
      }
      // No SAB: can't abort, but onAllDone will dispatch pending when current run finishes
    }
  }

  private dispatch(payload: any, callback: SchedulerCallback): void {
    this.state = 'running'
    this.pending = null
    this.currentCallback = callback

    const { signal } = this.options
    if (signal) Atomics.store(signal, 0, 0)

    const workers = this.ensurePool()
    const numWorkers = workers.length
    const results: SeatResult[][] = []
    const elapsedTimes: number[] = []
    let completed = 0
    let failed = false
    let errorMessage = ''

    const onAllDone = () => {
      if (this.pending) {
        const nextPayload = this.pending
        const nextCallback = this.currentCallback!
        this.dispatch(nextPayload, nextCallback)
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

    const finishWith = (result: AnalysisResult) => {
      this.state = 'idle'
      const cb = this.currentCallback
      this.currentCallback = null
      cb?.(result)
    }

    for (let i = 0; i < numWorkers; i++) {
      const worker = workers[i]

      worker.onmessage = (e: { data: any }) => {
        const data = e.data as WorkerResponse
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

      worker.onerror = (e: { message?: string }) => {
        if (!failed) { failed = true; errorMessage = `Worker error: ${e.message}` }
        completed++
        if (completed === numWorkers) onAllDone()
      }

      worker.postMessage({ ...payload, batches: numWorkers, batch: i })
    }
  }
}

export function mergeResults(batches: SeatResult[][]): SeatResult[] {
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
