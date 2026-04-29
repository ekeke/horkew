/**
 * Stage 2: requestSAB / responseSAB の encode / decode helpers。
 *
 * encodeRequest/decodeRequest は worker → main の forward 入力データ転送用。
 * encodeResponse/decodeResponse は main → worker の forward 出力データ転送用。
 *
 * Int32Array view と Float32Array view を同じ SAB で取り、offset で住み分ける。
 */

import type { HeadName, NNOutput } from '../mcts/nn.ts'
import {
  HEAD_NAMES,
  SLOT_NAMES,
  HEAD_NAME_TO_INDEX,
  SLOT_NAME_TO_INDEX,
  REQUEST_ACTOR_SEATS_OFFSET_WORDS,
  REQUEST_ALIVES_OFFSET_WORDS,
  REQUEST_OBS_OFFSET_WORDS,
  RESPONSE_ENTRY_COUNTS_OFFSET_WORDS,
  RESPONSE_POLICY_SEATS_OFFSET_WORDS,
  RESPONSE_POLICY_PROBS_OFFSET_WORDS,
  RESPONSE_OUTCOME_DIST_OFFSET_WORDS,
  MAX_BATCH,
  MAX_OBS_DIMS,
  MAX_POLICY_ENTRIES,
  OUTCOME_DIST_DIMS,
} from './forward-types.ts'
import type { SlotName } from './types.ts'

// ============================================================
// Request encode / decode
// ============================================================

export function encodeRequest(
  requestSAB: SharedArrayBuffer,
  slotName: SlotName,
  headName: HeadName,
  obsList: Float32Array[],
  actorSeats: number[],
  alives: number[],
): void {
  const N = obsList.length
  if (N === 0) throw new Error('encodeRequest: empty batch')
  if (N > MAX_BATCH) throw new Error(`encodeRequest: batch ${N} exceeds MAX_BATCH=${MAX_BATCH}`)

  const obsDims = obsList[0].length
  if (obsDims > MAX_OBS_DIMS) {
    throw new Error(`encodeRequest: obsDims ${obsDims} exceeds MAX_OBS_DIMS=${MAX_OBS_DIMS}`)
  }

  const headIndex = HEAD_NAME_TO_INDEX.get(headName)
  if (headIndex === undefined) throw new Error(`encodeRequest: unknown headName '${headName}'`)
  const slotIndex = SLOT_NAME_TO_INDEX.get(slotName)
  if (slotIndex === undefined) throw new Error(`encodeRequest: unknown slotName '${slotName}'`)

  const i32 = new Int32Array(requestSAB)
  i32[0] = N
  i32[1] = headIndex
  i32[2] = slotIndex
  i32[3] = obsDims
  i32[4] = 0  // reserved

  for (let i = 0; i < N; i++) {
    i32[REQUEST_ACTOR_SEATS_OFFSET_WORDS + i] = actorSeats[i]
    i32[REQUEST_ALIVES_OFFSET_WORDS + i] = alives[i]
  }

  const f32 = new Float32Array(requestSAB)
  for (let i = 0; i < N; i++) {
    if (obsList[i].length !== obsDims) {
      throw new Error(`encodeRequest: obs[${i}] dims mismatch (got ${obsList[i].length}, expected ${obsDims})`)
    }
    f32.set(obsList[i], REQUEST_OBS_OFFSET_WORDS + i * MAX_OBS_DIMS)
  }
}

export type DecodedRequest = {
  batchSize: number
  headName: HeadName
  slotName: SlotName
  obsDims: number
  actorSeats: number[]
  /** 各 sample の SimState.alive bitmask。main 側で per-seat softmax mask に使う */
  alives: number[]
  /** obsList: 各 sample の Float32Array view (SAB 内、コピーなし、main の forwardBatch に渡す) */
  obsList: Float32Array[]
}

export function decodeRequest(requestSAB: SharedArrayBuffer): DecodedRequest {
  const i32 = new Int32Array(requestSAB)
  const batchSize = i32[0]
  const headIndex = i32[1]
  const slotIndex = i32[2]
  const obsDims = i32[3]

  if (batchSize <= 0 || batchSize > MAX_BATCH) {
    throw new Error(`decodeRequest: invalid batch_size=${batchSize}`)
  }
  const headName = HEAD_NAMES[headIndex]
  if (!headName) throw new Error(`decodeRequest: invalid head_index=${headIndex}`)
  const slotName = SLOT_NAMES[slotIndex]
  if (!slotName) throw new Error(`decodeRequest: invalid slot_index=${slotIndex}`)

  const actorSeats: number[] = new Array(batchSize)
  const alives: number[] = new Array(batchSize)
  for (let i = 0; i < batchSize; i++) {
    actorSeats[i] = i32[REQUEST_ACTOR_SEATS_OFFSET_WORDS + i]
    alives[i] = i32[REQUEST_ALIVES_OFFSET_WORDS + i]
  }

  // obs view (SAB 上の slice、コピーしない)
  const obsList: Float32Array[] = new Array(batchSize)
  const obsByteOffset = REQUEST_OBS_OFFSET_WORDS * 4
  for (let i = 0; i < batchSize; i++) {
    obsList[i] = new Float32Array(
      requestSAB,
      obsByteOffset + i * MAX_OBS_DIMS * 4,
      obsDims,
    )
  }

  return { batchSize, headName, slotName, obsDims, actorSeats, alives, obsList }
}

// ============================================================
// Response encode / decode
// ============================================================

export function encodeResponse(
  responseSAB: SharedArrayBuffer,
  outputs: NNOutput[],
): void {
  const N = outputs.length
  if (N > MAX_BATCH) {
    throw new Error(`encodeResponse: batch ${N} exceeds MAX_BATCH=${MAX_BATCH}`)
  }

  const i32 = new Int32Array(responseSAB)
  const f32 = new Float32Array(responseSAB)

  i32[0] = N

  for (let i = 0; i < N; i++) {
    const out = outputs[i]
    const entries = [...out.policy.entries()]
    const count = entries.length
    if (count > MAX_POLICY_ENTRIES) {
      throw new Error(`encodeResponse: policy entries ${count} > MAX_POLICY_ENTRIES=${MAX_POLICY_ENTRIES} at sample ${i}`)
    }
    i32[RESPONSE_ENTRY_COUNTS_OFFSET_WORDS + i] = count

    for (let k = 0; k < count; k++) {
      const [seat, prob] = entries[k]
      i32[RESPONSE_POLICY_SEATS_OFFSET_WORDS + i * MAX_POLICY_ENTRIES + k] = seat
      f32[RESPONSE_POLICY_PROBS_OFFSET_WORDS + i * MAX_POLICY_ENTRIES + k] = prob
    }

    if (out.outcomeDist.length !== OUTCOME_DIST_DIMS) {
      throw new Error(`encodeResponse: outcomeDist length ${out.outcomeDist.length} != ${OUTCOME_DIST_DIMS}`)
    }
    f32.set(out.outcomeDist, RESPONSE_OUTCOME_DIST_OFFSET_WORDS + i * OUTCOME_DIST_DIMS)
  }
}

export function decodeResponse(responseSAB: SharedArrayBuffer): NNOutput[] {
  const i32 = new Int32Array(responseSAB)
  const f32 = new Float32Array(responseSAB)

  const N = i32[0]
  if (N <= 0 || N > MAX_BATCH) {
    throw new Error(`decodeResponse: invalid batch_size=${N}`)
  }

  const outputs: NNOutput[] = new Array(N)
  for (let i = 0; i < N; i++) {
    const count = i32[RESPONSE_ENTRY_COUNTS_OFFSET_WORDS + i]
    const policy = new Map<number, number>()
    for (let k = 0; k < count; k++) {
      const seat = i32[RESPONSE_POLICY_SEATS_OFFSET_WORDS + i * MAX_POLICY_ENTRIES + k]
      const prob = f32[RESPONSE_POLICY_PROBS_OFFSET_WORDS + i * MAX_POLICY_ENTRIES + k]
      policy.set(seat, prob)
    }
    // outcomeDist は SAB 内の slice ではなく、コピーを返す (consumer が変更しても SAB に影響しないように)
    const outcomeDist = new Float32Array(OUTCOME_DIST_DIMS)
    for (let j = 0; j < OUTCOME_DIST_DIMS; j++) {
      outcomeDist[j] = f32[RESPONSE_OUTCOME_DIST_OFFSET_WORDS + i * OUTCOME_DIST_DIMS + j]
    }
    outputs[i] = { policy, outcomeDist }
  }

  return outputs
}
