/**
 * ProxiedMasonZeroNN: worker thread 内で動く MasonZeroNN proxy 実装。
 *
 * - `forward` (per-sample、root expand 用、頻度低): inner Pure JS NN に委譲
 * - `forwardBatch` (rollout batch、頻度高): SAB encode → signal → Atomics.wait → decode
 *
 * Atomics.wait で blocking sync 化することで、MasonZeroNN.forwardBatch の sync API を維持。
 * 結果として ISMCTS / BaseSkollZeroModule / Agent interface はすべて無修正で動作する。
 */

import { parentPort } from 'node:worker_threads'

import type { HeadName, MasonZeroNN, NNOutput, RootObservation } from '../mcts/nn.ts'
import type { SimState } from '../simulator/world-state.ts'
import { encodeRequest, decodeResponse } from './forward-codec.ts'
import {
  SIGNAL_IDLE,
  SIGNAL_REQUEST_PENDING,
  SIGNAL_RESPONSE_READY,
  SIGNAL_ERROR,
  type ForwardRequestMessage,
} from './forward-types.ts'
import type { ForwardSlotName } from './types.ts'

export class ProxiedMasonZeroNN implements MasonZeroNN {
  private readonly slotName: ForwardSlotName
  private readonly innerNN: MasonZeroNN
  private readonly requestSAB: SharedArrayBuffer
  private readonly responseSAB: SharedArrayBuffer
  private readonly workerId: number
  private readonly signalView: Int32Array

  constructor(
    slotName: ForwardSlotName,
    innerNN: MasonZeroNN,
    signalSAB: SharedArrayBuffer,
    requestSAB: SharedArrayBuffer,
    responseSAB: SharedArrayBuffer,
    workerId: number,
  ) {
    this.slotName = slotName
    this.innerNN = innerNN
    this.requestSAB = requestSAB
    this.responseSAB = responseSAB
    this.workerId = workerId
    this.signalView = new Int32Array(signalSAB)
  }

  forward(rootObs: RootObservation, state: SimState, masonSeat: number, headName: HeadName = 'execute'): NNOutput {
    // root expand 用、頻度が低いので worker 内 Pure JS forward で足りる
    return this.innerNN.forward(rootObs, state, masonSeat, headName)
  }

  forwardBatch(
    rootObsList: RootObservation[],
    states: SimState[],
    actorSeats: number[],
    headName: HeadName = 'execute',
  ): NNOutput[] {
    const N = rootObsList.length
    if (N === 0) return []
    if (!parentPort) throw new Error('ProxiedMasonZeroNN.forwardBatch must be called from worker thread')

    // 1. SAB に request encode
    const alives = states.map(s => s.alive)
    encodeRequest(this.requestSAB, this.slotName, headName, rootObsList, actorSeats, alives)

    // 2. signal を REQUEST_PENDING にして main に通知
    Atomics.store(this.signalView, 0, SIGNAL_REQUEST_PENDING)
    parentPort.postMessage({
      type: 'forward_request',
      workerId: this.workerId,
    } satisfies ForwardRequestMessage)

    // 3. main の処理完了を待つ (signal が REQUEST_PENDING のままなら sleep)
    const waitResult = Atomics.wait(this.signalView, 0, SIGNAL_REQUEST_PENDING)
    if (waitResult === 'timed-out') {
      throw new Error('ProxiedMasonZeroNN.forwardBatch: forward request timed out')
    }

    // 4. signal を確認 → response 取得
    const finalSignal = Atomics.load(this.signalView, 0)
    if (finalSignal === SIGNAL_ERROR) {
      Atomics.store(this.signalView, 0, SIGNAL_IDLE)
      throw new Error('ProxiedMasonZeroNN.forwardBatch: forward server returned error')
    }
    if (finalSignal !== SIGNAL_RESPONSE_READY) {
      throw new Error(`ProxiedMasonZeroNN.forwardBatch: unexpected signal state ${finalSignal}`)
    }

    const outputs = decodeResponse(this.responseSAB)

    // 5. signal を IDLE にリセット (次の request に備えて)
    Atomics.store(this.signalView, 0, SIGNAL_IDLE)

    return outputs
  }
}
