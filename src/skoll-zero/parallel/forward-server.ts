/**
 * Stage 2: main thread 側の forward server。
 *
 * 各 worker から `forward_request` メッセージを受け取ると:
 *   1. requestSAB から (obsList, actorSeats, alives, headName, slotName) を decode
 *   2. 該当 slot の TfMasonZeroNetwork.forwardBatch を呼ぶ (GPU 推論)
 *   3. 結果を responseSAB に encode
 *   4. signal を SIGNAL_RESPONSE_READY にして Atomics.notify で worker を起こす
 *
 * 例外時は signal を SIGNAL_ERROR にして notify、worker は throw する。
 */

import type { Worker } from 'node:worker_threads'

import type { SimState } from '../simulator/world-state.ts'
import type { TfMasonZeroNetwork } from '../network/tf-mason-zero.ts'
import { decodeRequest, encodeResponse } from './forward-codec.ts'
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

/**
 * 各 worker に対して `forward_request` listener を attach し、forwardBatch を main GPU で処理する。
 *
 * worker pool を保持しないので、複数 worker は呼び出し側で iterate して attach する。
 */
export class ForwardServer {
  private readonly slots: ForwardServerSlots
  private readonly workerSABs: WorkerSABBundle[]
  private readonly signalViews: Int32Array[]

  constructor(slots: ForwardServerSlots, workerSABs: WorkerSABBundle[]) {
    this.slots = slots
    this.workerSABs = workerSABs
    this.signalViews = workerSABs.map(b => new Int32Array(b.signalSAB))
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
    const sabs = this.workerSABs[workerId]
    const signalView = this.signalViews[workerId]
    try {
      const req = decodeRequest(sabs.requestSAB)
      const tfNet = this.slots[req.slotName]
      if (!tfNet) {
        throw new Error(`forward-server: no slot '${req.slotName}' (slot list: [${Object.keys(this.slots).join(',')}])`)
      }

      // 仮の SimState: forwardBatch は state.alive と actorSeat だけ参照する (tf-mason-zero.ts:73)
      const fakeStates: SimState[] = req.alives.map(
        a => ({ alive: a } as unknown as SimState),
      )

      const outputs = tfNet.forwardBatch(req.obsList, fakeStates, req.actorSeats, req.headName)
      encodeResponse(sabs.responseSAB, outputs)

      Atomics.store(signalView, 0, SIGNAL_RESPONSE_READY)
      Atomics.notify(signalView, 0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[forward-server] worker ${workerId} forward error: ${msg}\n`)
      if (err instanceof Error && err.stack) {
        process.stderr.write(err.stack + '\n')
      }
      Atomics.store(signalView, 0, SIGNAL_ERROR)
      Atomics.notify(signalView, 0)
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
