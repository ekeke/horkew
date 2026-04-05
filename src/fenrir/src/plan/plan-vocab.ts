/**
 * Plan token 語彙定義
 *
 * NN の plan token 出力のインデックスを定義する。
 * 語彙: seat(0-13), role(14-18), grayran(19), next(20), stop(21)
 */

import type { SystemRole } from '../../../types/index.ts'
import { SEATS, NUM_ROLE_TOKENS, CO_ROLES } from '../observation.ts'

// ============================================================
// Plan token vocabulary
// ============================================================

/** Pointer語彙のインデックス */
export const PLAN_VOCAB = {
  // 0-13: seat 1-14
  SEAT_START: 0,
  SEAT_END: SEATS,  // exclusive
  // 14-18: roles (seer, medium, bodyguard, mason, nekomata)
  ROLE_START: SEATS,
  ROLE_END: SEATS + NUM_ROLE_TOKENS,
  // 19-21: special
  GRAYRAN: SEATS + NUM_ROLE_TOKENS,      // 19
  NEXT: SEATS + NUM_ROLE_TOKENS + 1,     // 20
  STOP: SEATS + NUM_ROLE_TOKENS + 2,     // 21
  SIZE: SEATS + NUM_ROLE_TOKENS + 3,     // 22
} as const

/** Plan tokenの1日分のグループ */
export type PlanDayGroup = {
  /** 処刑対象のseat番号 or role名 or 'grayran' */
  targets: Array<{ type: 'seat', seat: number } | { type: 'role', role: SystemRole } | { type: 'grayran' }>
}

/**
 * Pointer logits列をargmax → 語彙index列に変換
 * @param logits [count * vocabSize] flat array
 * @param count トークン数
 * @param vocabSize 語彙サイズ
 */
export function argmaxPlanTokens(logits: Float32Array, count: number, vocabSize: number = PLAN_VOCAB.SIZE): number[] {
  const result: number[] = []
  for (let k = 0; k < count; k++) {
    const off = k * vocabSize
    let bestIdx = 0, bestVal = logits[off]
    for (let i = 1; i < vocabSize; i++) {
      if (logits[off + i] > bestVal) {
        bestVal = logits[off + i]
        bestIdx = i
      }
    }
    result.push(bestIdx)
  }
  return result
}

/**
 * 語彙index列を日ごとのグループに分割
 * nextで区切り、stopで終了
 */
export function parsePlanIndices(indices: number[]): PlanDayGroup[] {
  const groups: PlanDayGroup[] = []
  let current: PlanDayGroup = { targets: [] }

  for (const idx of indices) {
    if (idx === PLAN_VOCAB.STOP) break
    if (idx === PLAN_VOCAB.NEXT) {
      if (current.targets.length > 0) groups.push(current)
      current = { targets: [] }
      continue
    }
    if (idx >= PLAN_VOCAB.SEAT_START && idx < PLAN_VOCAB.SEAT_END) {
      current.targets.push({ type: 'seat', seat: idx + 1 })  // 1-indexed
    } else if (idx >= PLAN_VOCAB.ROLE_START && idx < PLAN_VOCAB.ROLE_END) {
      current.targets.push({ type: 'role', role: CO_ROLES[idx - PLAN_VOCAB.ROLE_START] })
    } else if (idx === PLAN_VOCAB.GRAYRAN) {
      current.targets.push({ type: 'grayran' })
    }
  }
  if (current.targets.length > 0) groups.push(current)

  return groups
}

/**
 * Raw plan token 列の先頭グループ（最初の NEXT or STOP まで）を削除し、
 * 残りを STOP パディングで元の長さに揃えて返す。
 *
 * grammar: group = (seat|role|grayran)+, separator = NEXT, terminator = STOP
 *
 * [seat3, NEXT, seat7, NEXT, grayran, STOP, STOP, STOP]
 * → [seat7, NEXT, grayran, STOP, STOP, STOP, STOP, STOP]
 */
/** Plan token index を人間が読める文字列に変換 */
export function describePlanIndex(idx: number): string {
  if (idx >= PLAN_VOCAB.SEAT_START && idx < PLAN_VOCAB.SEAT_END) return `seat${idx + 1}`
  if (idx >= PLAN_VOCAB.ROLE_START && idx < PLAN_VOCAB.ROLE_END) return CO_ROLES[idx - PLAN_VOCAB.ROLE_START]
  if (idx === PLAN_VOCAB.GRAYRAN) return 'grayran'
  if (idx === PLAN_VOCAB.NEXT) return 'NEXT'
  if (idx === PLAN_VOCAB.STOP) return 'STOP'
  return `?${idx}`
}

/** Plan token indices を人間が読める文字列に変換 */
export function describePlanIndices(indices: number[]): string {
  return indices.map(describePlanIndex).join(' ')
}

export function stripFirstPlanGroup(indices: number[], totalLength: number): number[] {
  let i = 0
  // 先頭グループのトークンをスキップ
  while (i < indices.length && indices[i] !== PLAN_VOCAB.NEXT && indices[i] !== PLAN_VOCAB.STOP) {
    i++
  }
  // NEXT の場合はセパレータ自体もスキップ
  if (i < indices.length && indices[i] === PLAN_VOCAB.NEXT) {
    i++
  }
  // STOP or 終端 → 全グループ消費済み
  if (i >= indices.length || indices[i] === PLAN_VOCAB.STOP) {
    return new Array(totalLength).fill(PLAN_VOCAB.STOP)
  }
  const remaining = indices.slice(i)
  // STOP パディングで固定長に揃える
  while (remaining.length < totalLength) {
    remaining.push(PLAN_VOCAB.STOP)
  }
  return remaining.slice(0, totalLength)
}
