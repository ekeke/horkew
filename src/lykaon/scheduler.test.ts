import { describe, test } from 'node:test'
import assert from 'node:assert'
import { AnalysisScheduler } from './scheduler.ts'
import type { WorkerLike, WorkerResponse, AnalysisResult } from './scheduler.ts'

// --- Mock Worker ---

type MockWorker = WorkerLike & {
  lastMessage: any
  respond(data: WorkerResponse): void
  triggerError(message: string): void
}

function createMockWorker(): MockWorker {
  const worker: MockWorker = {
    lastMessage: null,
    onmessage: null,
    onerror: null,
    postMessage(data: any) {
      this.lastMessage = data
    },
    terminate() {},
    respond(data: WorkerResponse) {
      this.onmessage?.({ data })
    },
    triggerError(message: string) {
      this.onerror?.({ message })
    },
  }
  return worker
}

// --- Helpers ---

function createScheduler(poolSize: number = 2, signal: Int32Array | null = null) {
  const workers: MockWorker[] = []
  const scheduler = new AnalysisScheduler({
    poolSize,
    createWorker: () => {
      const w = createMockWorker()
      workers.push(w)
      return w
    },
    signal,
  })
  return { scheduler, workers: () => workers }
}

function resultPayload(seats: { seat: number, roles: string[] }[] = [{ seat: 1, roles: ['villager'] }]): WorkerResponse {
  return { type: 'result', seats: seats as any, elapsed: 10 }
}

// --- Tests ---

describe('AnalysisScheduler', () => {
  describe('basic dispatch', () => {
    test('dispatches to all workers and returns merged result', () => {
      const { scheduler, workers } = createScheduler(2)
      const results: AnalysisResult[] = []

      scheduler.request({ data: 'test' }, (r) => results.push(r))

      const pool = workers()
      assert.strictEqual(pool.length, 2)
      assert.strictEqual(pool[0].lastMessage.batches, 2)
      assert.strictEqual(pool[0].lastMessage.batch, 0)
      assert.strictEqual(pool[1].lastMessage.batch, 1)

      // Both workers respond
      pool[0].respond({ type: 'result', seats: [{ seat: 1, roles: ['villager'] }], elapsed: 5 })
      pool[1].respond({ type: 'result', seats: [{ seat: 1, roles: ['werewolf'] }], elapsed: 8 })

      assert.strictEqual(results.length, 1)
      assert.strictEqual(results[0].type, 'result')
      const r = results[0] as Extract<AnalysisResult, { type: 'result' }>
      const roles = r.seats.find(s => s.seat === 1)!.roles.sort()
      assert.deepStrictEqual(roles, ['villager', 'werewolf'])
      assert.strictEqual(r.stats.workers, 2)
    })

    test('returns error when worker fails', () => {
      const { scheduler, workers } = createScheduler(1)
      const results: AnalysisResult[] = []

      scheduler.request({}, (r) => results.push(r))
      workers()[0].respond({ type: 'error', message: 'boom' })

      assert.strictEqual(results.length, 1)
      assert.strictEqual(results[0].type, 'error')
      assert.strictEqual((results[0] as any).message, 'boom')
    })

    test('returns error on worker onerror', () => {
      const { scheduler, workers } = createScheduler(1)
      const results: AnalysisResult[] = []

      scheduler.request({}, (r) => results.push(r))
      workers()[0].triggerError('crash')

      assert.strictEqual(results.length, 1)
      assert.strictEqual(results[0].type, 'error')
    })

    test('state transitions idle → running → idle', () => {
      const { scheduler, workers } = createScheduler(1)

      assert.strictEqual(scheduler.getState(), 'idle')
      scheduler.request({}, () => {})
      assert.strictEqual(scheduler.getState(), 'running')
      workers()[0].respond(resultPayload())
      assert.strictEqual(scheduler.getState(), 'idle')
    })
  })

  describe('pending without SAB', () => {
    test('second request while running is queued and dispatched after first completes', () => {
      const { scheduler, workers } = createScheduler(1, null)
      const results: AnalysisResult[] = []
      const payloads: string[] = []

      scheduler.request({ id: 'first' }, (r) => { results.push(r); payloads.push('first') })
      assert.strictEqual(scheduler.getState(), 'running')

      // Second request while first is running
      scheduler.request({ id: 'second' }, (r) => { results.push(r); payloads.push('second') })
      assert.strictEqual(scheduler.getState(), 'running')

      // First completes → should auto-dispatch pending
      workers()[0].respond(resultPayload())

      // Pending was dispatched, new worker message should be for 'second'
      assert.strictEqual(scheduler.getState(), 'running')
      assert.strictEqual(workers()[0].lastMessage.id, 'second')

      // Second completes
      workers()[0].respond(resultPayload())
      assert.strictEqual(scheduler.getState(), 'idle')
      // First result is never delivered (superseded by pending)
      assert.strictEqual(results.length, 1)
      assert.strictEqual(payloads[0], 'second')
    })

    test('latest of multiple pending requests wins', () => {
      const { scheduler, workers } = createScheduler(1, null)
      const results: AnalysisResult[] = []

      scheduler.request({ id: 'first' }, () => {})
      scheduler.request({ id: 'second' }, () => results.push({ type: 'error', message: 'wrong' }))
      scheduler.request({ id: 'third' }, (r) => results.push(r))

      // First completes → dispatches 'third' (latest pending)
      workers()[0].respond(resultPayload())
      assert.strictEqual(workers()[0].lastMessage.id, 'third')

      // Third completes
      workers()[0].respond(resultPayload())
      assert.strictEqual(results.length, 1)
      assert.strictEqual(scheduler.getState(), 'idle')
    })

    test('no deadlock: state returns to idle even with rapid requests', () => {
      const { scheduler, workers } = createScheduler(1, null)

      // Simulate rapid requests
      for (let i = 0; i < 10; i++) {
        scheduler.request({ id: `req${i}` }, () => {})
      }

      // Only one is running, rest are queued (latest wins)
      assert.strictEqual(scheduler.getState(), 'running')

      // Complete current → dispatches latest pending
      workers()[0].respond(resultPayload())
      assert.strictEqual(scheduler.getState(), 'running')
      assert.strictEqual(workers()[0].lastMessage.id, 'req9')

      // Complete pending → idle
      workers()[0].respond(resultPayload())
      assert.strictEqual(scheduler.getState(), 'idle')
    })
  })

  describe('abort with SAB', () => {
    test('sets abort signal when new request arrives while running', () => {
      const signal = new Int32Array(new SharedArrayBuffer(4))
      const { scheduler, workers: _workers } = createScheduler(1, signal)

      scheduler.request({ id: 'first' }, () => {})
      assert.strictEqual(signal[0], 0)

      scheduler.request({ id: 'second' }, () => {})
      assert.strictEqual(signal[0], 1, 'abort signal should be set')
    })

    test('resets abort signal on new dispatch', () => {
      const signal = new Int32Array(new SharedArrayBuffer(4))
      const { scheduler, workers } = createScheduler(1, signal)

      scheduler.request({ id: 'first' }, () => {})
      scheduler.request({ id: 'second' }, () => {})
      assert.strictEqual(signal[0], 1)

      // Worker responds with aborted → pending dispatched → signal reset
      workers()[0].respond({ type: 'aborted' })
      assert.strictEqual(signal[0], 0, 'signal should be reset on new dispatch')
      assert.strictEqual(workers()[0].lastMessage.id, 'second')
    })

    test('aborted workers trigger pending dispatch', () => {
      const signal = new Int32Array(new SharedArrayBuffer(4))
      const { scheduler, workers } = createScheduler(2, signal)
      const results: AnalysisResult[] = []

      scheduler.request({ id: 'first' }, () => {})
      scheduler.request({ id: 'second' }, (r) => results.push(r))

      // Both workers abort
      workers()[0].respond({ type: 'aborted' })
      workers()[1].respond({ type: 'aborted' })

      // Pending should be dispatched
      assert.strictEqual(scheduler.getState(), 'running')
      assert.strictEqual(workers()[0].lastMessage.id, 'second')

      // Complete second
      workers()[0].respond(resultPayload())
      workers()[1].respond(resultPayload())
      assert.strictEqual(results.length, 1)
      assert.strictEqual(scheduler.getState(), 'idle')
    })
  })

  describe('worker pool reuse', () => {
    test('reuses existing pool across requests', () => {
      const { scheduler, workers } = createScheduler(2)

      scheduler.request({}, () => {})
      const pool1 = [...workers()]
      assert.strictEqual(pool1.length, 2)

      pool1[0].respond(resultPayload())
      pool1[1].respond(resultPayload())

      scheduler.request({}, () => {})
      // No new workers created — pool reused
      assert.strictEqual(workers().length, 2)
    })
  })
})
