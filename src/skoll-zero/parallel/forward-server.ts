/**
 * Stage 3: main thread 側の forward server (worker 跨ぎ batch 集約版)。
 *
 * 各 worker から `forward_request` メッセージを受け取ると:
 *   1. requestSAB から (obsList, actorSeats, alives, headName, slotName) を decode
 *   2. **即時処理せず queue に追加**、最初の request 受信から T ms (SKOLLZ_FORWARD_BATCH_WAIT_MS、default 2)
 *      の wait timer を起動
 *   3. timer 満了で flush:
 *      - queue 内の request を (slot, headName) で group 化
 *      - 各 group: 全 worker の obsList を concat → 1 GPU forwardBatch (batch ~140 まで拡大)
 *      - 結果を per-worker / per-leaf で分解 → 各 responseSAB に encode + Atomics.notify
 *
 * 例外時は該当 worker の signal を SIGNAL_ERROR にして notify、worker は throw する。
 *
 * Stage 2 (即時処理) との違い: 1 forward あたり最大 T ms の wait が入るが、複数 worker 跨ぎで
 * batch を拡大できるので GPU 利用率が向上、結果として全体スループットが上がる。
 */

import type { Worker } from 'node:worker_threads'

import type { SimState } from '../simulator/world-state.ts'
import type { TfMasonZeroNetwork } from '../network/tf-mason-zero.ts'
import type { HeadName, NNOutput } from '../mcts/nn.ts'
import { decodeRequest, encodeResponse, type DecodedRequest } from './forward-codec.ts'
import {
  SIGNAL_RESPONSE_READY,
  SIGNAL_ERROR,
} from './forward-types.ts'
import type { SlotName } from './types.ts'

export type WorkerSABBundle = {
  signalSAB: SharedArrayBuffer
  requestSAB: SharedArrayBuffer
  responseSAB: SharedArrayBuffer
}

/** slot 名 → TfMasonZeroNetwork。GPU 推論担当 */
export type ForwardServerSlots = Partial<Record<SlotName, TfMasonZeroNetwork>>

/** queue に保持する pending request (decode 済み + workerId) */
type PendingRequest = DecodedRequest & {
  workerId: number
}

/** デフォルトの wait time (ms)。SKOLLZ_FORWARD_BATCH_WAIT_MS env で override */
const DEFAULT_FORWARD_BATCH_WAIT_MS = 2

function readWaitMsFromEnv(): number {
  const raw = process.env.SKOLLZ_FORWARD_BATCH_WAIT_MS
  if (!raw) return DEFAULT_FORWARD_BATCH_WAIT_MS
  const n = parseFloat(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_FORWARD_BATCH_WAIT_MS
  return n
}

/**
 * 各 worker に対して `forward_request` listener を attach し、forwardBatch を main GPU で処理する。
 *
 * 内部で queue + timer 機構を持ち、複数 worker からの request を T ms 集約してから 1 batch で処理する。
 */
export class ForwardServer {
  private readonly slots: ForwardServerSlots
  private readonly workerSABs: WorkerSABBundle[]
  private readonly signalViews: Int32Array[]
  private readonly waitMs: number

  private queue: PendingRequest[] = []
  private flushTimer: NodeJS.Timeout | null = null

  constructor(slots: ForwardServerSlots, workerSABs: WorkerSABBundle[]) {
    this.slots = slots
    this.workerSABs = workerSABs
    this.signalViews = workerSABs.map(b => new Int32Array(b.signalSAB))
    this.waitMs = readWaitMsFromEnv()
  }

  /**
   * worker からのメッセージのうち `forward_request` のみ処理する handler を返す。
   * 既存の `self_play_result` / `self_play_error` listener と共存可能。
   */
  makeMessageHandler(workerId: number): (msg: { type: string }) => void {
    return (msg) => {
      if (msg.type !== 'forward_request') return
      this.handleForward(workerId)
    }
  }

  private handleForward(workerId: number): void {
    try {
      const req = decodeRequest(this.workerSABs[workerId].requestSAB)
      this.queue.push({ ...req, workerId })
    } catch (err) {
      this.respondErrorSingle(workerId, err)
      return
    }
    // 最初の request で timer を起動。以降の request は同 timer に乗る。
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), this.waitMs)
    }
  }

  private flush(): void {
    this.flushTimer = null
    const pending = this.queue
    this.queue = []
    if (pending.length === 0) return

    // (slot, headName) で group 化
    const groups = new Map<string, PendingRequest[]>()
    for (const req of pending) {
      const key = `${req.slotName}/${req.headName}`
      let arr = groups.get(key)
      if (!arr) {
        arr = []
        groups.set(key, arr)
      }
      arr.push(req)
    }

    for (const reqs of groups.values()) {
      this.processGroup(reqs)
    }
  }

  private processGroup(reqs: PendingRequest[]): void {
    const slotName = reqs[0].slotName
    const headName: HeadName = reqs[0].headName
    const tfNet = this.slots[slotName]
    if (!tfNet) {
      this.respondErrorMany(reqs, new Error(
        `forward-server: no slot '${slotName}' (slot list: [${Object.keys(this.slots).join(',')}])`,
      ))
      return
    }

    // 全 worker request の obs/seat/alive を 1 配列に concat
    const allObs: Float32Array[] = []
    const allSeats: number[] = []
    const allAlives: number[] = []
    for (const req of reqs) {
      for (const o of req.obsList) allObs.push(o)
      for (const s of req.actorSeats) allSeats.push(s)
      for (const a of req.alives) allAlives.push(a)
    }

    const fakeStates: SimState[] = allAlives.map(
      a => ({ alive: a } as unknown as SimState),
    )

    let outputs: NNOutput[]
    try {
      outputs = tfNet.forwardBatch(allObs, fakeStates, allSeats, headName)
    } catch (err) {
      this.respondErrorMany(reqs, err)
      return
    }

    // outputs を per-worker に分解 → 各 responseSAB に encode + notify
    let offset = 0
    for (const req of reqs) {
      const slice = outputs.slice(offset, offset + req.batchSize)
      offset += req.batchSize
      try {
        encodeResponse(this.workerSABs[req.workerId].responseSAB, slice)
        Atomics.store(this.signalViews[req.workerId], 0, SIGNAL_RESPONSE_READY)
        Atomics.notify(this.signalViews[req.workerId], 0)
      } catch (err) {
        this.respondErrorSingle(req.workerId, err)
      }
    }
  }

  private respondErrorSingle(workerId: number, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[forward-server] worker ${workerId} forward error: ${msg}\n`)
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n')
    }
    Atomics.store(this.signalViews[workerId], 0, SIGNAL_ERROR)
    Atomics.notify(this.signalViews[workerId], 0)
  }

  private respondErrorMany(reqs: PendingRequest[], err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[forward-server] group forward error: ${msg}\n`)
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n')
    }
    for (const req of reqs) {
      Atomics.store(this.signalViews[req.workerId], 0, SIGNAL_ERROR)
      Atomics.notify(this.signalViews[req.workerId], 0)
    }
  }
}

/** worker × forward server の listener attach helper */
export function attachForwardServer(
  worker: Worker,
  workerId: number,
  server: ForwardServer,
): (msg: { type: string }) => void {
  const handler = server.makeMessageHandler(workerId)
  worker.on('message', handler)
  return handler
}
