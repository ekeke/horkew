/**
 * Plan token 語彙定義
 *
 * NN の plan token 出力のインデックスを定義する。
 * 語彙: seat(0-13), role(14-18), grayran(19), or(20), stop(21)
 *
 * Unified Plan: forward + endgame を統合した単一 12-token シーケンス。
 * OR は同スロット内の代替候補を区切る（target, OR, target = 1スロット2候補）。
 * スロット間の区切りは暗黙的（target 直後の target = 新スロット）。
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
  OR: SEATS + NUM_ROLE_TOKENS + 1,       // 20
  STOP: SEATS + NUM_ROLE_TOKENS + 2,     // 21
  SIZE: SEATS + NUM_ROLE_TOKENS + 3,     // 22
} as const

// ============================================================
// Dual-direction layout constants
// ============================================================

/** forward plan token 数 */
export const NUM_FORWARD_TOKENS = 8
/** endgame plan token 数 */
export const NUM_ENDGAME_TOKENS = 4

/** Plan token の1スロット（1回の処刑に対応する候補リスト） */
export type PlanSlot = {
  /** 処刑候補のseat番号 or role名 or 'grayran'（OR で区切られた代替候補） */
  targets: Array<{ type: 'seat', seat: number } | { type: 'role', role: SystemRole } | { type: 'grayran' }>
}

/** @deprecated PlanSlot に置換 */
export type PlanDayGroup = PlanSlot

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

/** token index が target (seat, role, grayran) かどうか */
function isTarget(idx: number): boolean {
  return (idx >= PLAN_VOCAB.SEAT_START && idx < PLAN_VOCAB.SEAT_END)
    || (idx >= PLAN_VOCAB.ROLE_START && idx < PLAN_VOCAB.ROLE_END)
    || idx === PLAN_VOCAB.GRAYRAN
}

/** target index を PlanSlot の target 要素に変換 */
function indexToTarget(idx: number): PlanSlot['targets'][number] {
  if (idx >= PLAN_VOCAB.SEAT_START && idx < PLAN_VOCAB.SEAT_END) {
    return { type: 'seat', seat: idx + 1 }  // 1-indexed
  }
  if (idx >= PLAN_VOCAB.ROLE_START && idx < PLAN_VOCAB.ROLE_END) {
    return { type: 'role', role: CO_ROLES[idx - PLAN_VOCAB.ROLE_START] }
  }
  return { type: 'grayran' }
}

/**
 * 語彙index列をスロットに分割（Unified Plan）
 *
 * 文法:
 *   plan ::= slot* STOP+
 *   slot ::= target (OR target)*
 *
 * - target 直後の target = 新スロット境界
 * - target 直後の OR = 同スロット継続
 * - OR 直後の target = 同スロット
 * - STOP = 終端
 */
export function parsePlanSlots(indices: number[]): PlanSlot[] {
  const slots: PlanSlot[] = []
  let current: PlanSlot | null = null

  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]

    if (idx === PLAN_VOCAB.STOP) break

    if (idx === PLAN_VOCAB.OR) {
      // OR: 同スロット継続（current がなければ無視）
      continue
    }

    if (!isTarget(idx)) continue  // unknown token — skip

    const prev = i > 0 ? indices[i - 1] : -1
    const isAlternative = prev === PLAN_VOCAB.OR

    if (isAlternative && current) {
      // OR の後 → 同スロットに追加
      current.targets.push(indexToTarget(idx))
    } else {
      // target の後 or 先頭 → 新スロット
      if (current && current.targets.length > 0) slots.push(current)
      current = { targets: [indexToTarget(idx)] }
    }
  }

  if (current && current.targets.length > 0) slots.push(current)
  return slots
}

/**
 * Dual-direction plan の12-token配列をパースする。
 *
 * - positions 0-7: forward (左→右にパース)
 * - positions 8-11: endgame (右→左にパース — position 11 = 最終日)
 *
 * endgameSlots[0] = 最終日のスロット (position 11)
 * endgameSlots[1] = 最終日前日のスロット (position 10) ...
 */
export function parseDualPlanSlots(indices: number[]): { forwardSlots: PlanSlot[], endgameSlots: PlanSlot[] } {
  // Forward: positions 0-7
  const forwardSlots = parsePlanSlots(indices.slice(0, NUM_FORWARD_TOKENS))

  // Endgame: positions 8-11, reversed (R→L)
  const egReversed: number[] = []
  for (let i = NUM_FORWARD_TOKENS + NUM_ENDGAME_TOKENS - 1; i >= NUM_FORWARD_TOKENS; i--) {
    egReversed.push(indices[i] ?? PLAN_VOCAB.STOP)
  }
  const endgameSlots = parsePlanSlots(egReversed)

  return { forwardSlots, endgameSlots }
}

/**
 * 語彙index列を日ごとのグループに分割（NEXT 区切り）
 * @deprecated parsePlanSlots() に置換
 */
export function parsePlanIndices(indices: number[]): PlanDayGroup[] {
  const groups: PlanDayGroup[] = []
  let current: PlanDayGroup = { targets: [] }

  for (const idx of indices) {
    if (idx === PLAN_VOCAB.STOP) break
    if (idx === PLAN_VOCAB.OR) {
      // legacy: OR (旧 NEXT) をグループ区切りとして扱う
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

/** Plan token index を人間が読める文字列に変換 */
export function describePlanIndex(idx: number): string {
  if (idx >= PLAN_VOCAB.SEAT_START && idx < PLAN_VOCAB.SEAT_END) return `seat${idx + 1}`
  if (idx >= PLAN_VOCAB.ROLE_START && idx < PLAN_VOCAB.ROLE_END) return CO_ROLES[idx - PLAN_VOCAB.ROLE_START]
  if (idx === PLAN_VOCAB.GRAYRAN) return 'grayran'
  if (idx === PLAN_VOCAB.OR) return 'OR'
  if (idx === PLAN_VOCAB.STOP) return 'STOP'
  return `?${idx}`
}

/** Plan token indices を人間が読める文字列に変換 */
export function describePlanIndices(indices: number[]): string {
  return indices.map(describePlanIndex).join(' ')
}
