import type { SystemRole } from '../types/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import { ROLE_COUNT, RoleBitIndex, bitIndicesFromMask } from '../retar/possibilities.ts'
import { DEFAULT_MAX_WORLDS } from './constants.ts'

export type RoleProbabilities = {
  totalWorlds: number
  /** 上限に達して打ち切った場合 true */
  truncated: boolean
  /**
   * seat × role の確率行列（フラット配列）。
   * probabilities[seat * ROLE_COUNT + roleBitIndex] = そのseatがその役職である確率。
   * seat 0 は未使用。
   */
  probabilities: Float64Array
}

/**
 * Retar の Possibilities から全ワールドを列挙し、
 * 各 seat × role の出現確率を計算する。
 *
 * World オブジェクトを生成せず、バックトラック中に直接カウントする。
 * maxWorlds を超えたら列挙を打ち切り、それまでの結果で近似する。
 */
export function computeRoleProbabilities(
  possibilities: Possibilities,
  setup: Map<SystemRole, number>,
  maxWorlds: number = DEFAULT_MAX_WORLDS,
): RoleProbabilities {
  const seats: number[] = []
  for (let i = 1; i < possibilities.possibilities.length; i++) {
    if (possibilities.possibilities[i] !== 0) {
      seats.push(i)
    }
  }

  const roleCount = new Uint8Array(ROLE_COUNT)
  for (const [role, count] of setup) {
    roleCount[RoleBitIndex[role]] = count
  }

  const seatCount = possibilities.seatCount()
  const counts = new Float64Array((seatCount + 1) * ROLE_COUNT)
  const assignment = new Uint8Array(seats.length)
  let totalWorlds = 0
  let truncated = false

  // 各 seat のビットインデックス配列を事前計算
  const seatBitIndices: number[][] = new Array(seats.length)
  for (let i = 0; i < seats.length; i++) {
    seatBitIndices[i] = bitIndicesFromMask(possibilities.possibilities[seats[i]])
  }

  function backtrack(idx: number): void {
    if (truncated) return

    if (idx === seats.length) {
      for (let i = 0; i < ROLE_COUNT; i++) {
        if (roleCount[i] !== 0) return
      }
      totalWorlds++
      for (let i = 0; i < seats.length; i++) {
        counts[seats[i] * ROLE_COUNT + assignment[i]]++
      }
      if (totalWorlds >= maxWorlds) {
        truncated = true
      }
      return
    }

    const indices = seatBitIndices[idx]
    for (const bitIdx of indices) {
      if (truncated) return
      if (roleCount[bitIdx] <= 0) continue
      roleCount[bitIdx]--
      assignment[idx] = bitIdx
      backtrack(idx + 1)
      roleCount[bitIdx]++
    }
  }

  backtrack(0)

  if (totalWorlds > 0) {
    for (let i = 0; i < counts.length; i++) {
      counts[i] /= totalWorlds
    }
  }

  return { totalWorlds, probabilities: counts, truncated }
}

/**
 * 特定 seat の特定 role の確率を取得する。
 */
export function getRoleProbability(
  rp: RoleProbabilities,
  seat: number,
  role: SystemRole,
): number {
  return rp.probabilities[seat * ROLE_COUNT + RoleBitIndex[role]]
}
