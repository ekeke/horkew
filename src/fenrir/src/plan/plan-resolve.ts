/**
 * Plan group 解決 — PlanDayGroup を具体的な seat に変換
 *
 * resolveGroup (旧 rule-action.ts 内部) と resolvePlanGroupSimple を統合。
 */

import type { Rng } from '../../../lupa/random.ts'
import type { PlanDayGroup } from './plan-vocab.ts'

export type ResolvePlanOptions = {
  /** 自分を除外（投票時） */
  excludeSeat?: number
  /** grayran のランダム選択（なければ先頭） */
  rng?: Rng
}

/**
 * PlanDayGroup から投票先 seat を解決
 *
 * targets を順に試行し、最初に有効な seat を返す。
 * - seat: 生存かつ excludeSeat でなければ採用
 * - role: CO している生存者を探す
 * - grayran: CO していない生存者からランダム（rng なければ先頭）
 *
 * @returns 投票先seat (1-indexed) or null
 */
export function resolvePlanGroup(
  group: PlanDayGroup,
  aliveSeats: number[],
  events: readonly any[] = [],
  opts?: ResolvePlanOptions,
): number | null {
  const aliveSet = new Set(aliveSeats)
  const excludeSeat = opts?.excludeSeat
  const rng = opts?.rng

  // CO者を収集（role 解決・grayran 除外用）
  const coClaimed = new Map<string, number[]>()  // role → seats
  const allCOSeats = new Set<number>()
  for (const e of events) {
    if ('actor' in e && typeof e.type === 'string') {
      for (const prefix of ['seer_claim', 'medium_claim', 'bodyguard_claim', 'mason_claim', 'nekomata_claim']) {
        if (e.type.startsWith(prefix)) {
          const role = prefix.replace('_claim', '')
          if (!coClaimed.has(role)) coClaimed.set(role, [])
          coClaimed.get(role)!.push(e.actor)
          allCOSeats.add(e.actor)
        }
      }
    }
  }

  for (const target of group.targets) {
    if (target.type === 'seat') {
      if (aliveSet.has(target.seat) && target.seat !== excludeSeat) return target.seat
    } else if (target.type === 'role') {
      const claimers = coClaimed.get(target.role) ?? []
      const alive = claimers.filter(s => aliveSet.has(s) && s !== excludeSeat)
      if (alive.length > 0) {
        return rng ? alive[Math.floor(rng.next() * alive.length)] : alive[0]
      }
    } else if (target.type === 'grayran') {
      const grays = aliveSeats.filter(s => s !== excludeSeat && !allCOSeats.has(s))
      if (grays.length > 0) {
        return rng ? grays[Math.floor(rng.next() * grays.length)] : grays[0]
      }
      // グレーがいなければ全生存者から
      const fallback = aliveSeats.filter(s => s !== excludeSeat)
      if (fallback.length > 0) {
        return rng ? fallback[Math.floor(rng.next() * fallback.length)] : fallback[0]
      }
    }
  }
  return null
}
