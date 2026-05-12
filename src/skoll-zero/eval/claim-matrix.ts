/**
 * 役職騙り回数 matrix。
 *
 * 行 = 真役職、列 = 自称役職 (claimedRole) + 'none' (CO 無し)。
 * 値 = seat 単位の出現回数 (= 100 ゲーム eval なら、各行の合計は 100 × 役職人数)。
 *
 * 例 (100 game eval、wolf 3 席):
 *   matrix['werewolf'] = { seer: 102, medium: 38, bodyguard: 9, nekomata: 6, none: 145 }
 *   = 300 (100 game × 3 wolf seat) のはず
 *
 * eval_log.jsonl の各行 (R75+) に `claimMatrix` フィールドとして書き出される。
 */

import type { SystemRole } from '../../types/index.ts'

/** Matrix の列キー: SystemRole 11 種 + 'none' (CO 無し) */
export type ClaimedRoleKey = SystemRole | 'none'

/** Sparse matrix: 出現しない (role, claimed) ペアは省略 */
export type ClaimMatrix = Partial<Record<SystemRole, Partial<Record<ClaimedRoleKey, number>>>>

export function createEmptyClaimMatrix(): ClaimMatrix {
  return {}
}

/** 1 seat 分の (真役職, 自称役職) を加算 */
export function addClaim(matrix: ClaimMatrix, role: SystemRole, claimedRole: SystemRole | null): void {
  const key: ClaimedRoleKey = claimedRole ?? 'none'
  const row = matrix[role] ?? (matrix[role] = {})
  row[key] = (row[key] ?? 0) + 1
}

/** src の matrix を target に加算 (worker → main 集約用) */
export function mergeClaimMatrix(target: ClaimMatrix, src: ClaimMatrix): void {
  for (const role of Object.keys(src) as SystemRole[]) {
    const srcRow = src[role]
    if (!srcRow) continue
    const targetRow = target[role] ?? (target[role] = {})
    for (const claimed of Object.keys(srcRow) as ClaimedRoleKey[]) {
      targetRow[claimed] = (targetRow[claimed] ?? 0) + (srcRow[claimed] ?? 0)
    }
  }
}

/**
 * 初日死亡回数 (役職別)。
 *
 * 「初日死亡」= Day 1 終了 (= 最初の処刑 execution) までに死亡した seat の役職を集計。
 * hasFirstGhost: true 設定では通常 1 件/game (= 合計 ~100/100 game)、
 * 稀に狐呪殺等で複数件のゲームもあり得る。
 */
export type DayOneDeathCounts = Partial<Record<SystemRole, number>>

export function createEmptyDayOneDeaths(): DayOneDeathCounts {
  return {}
}

export function addDayOneDeath(counts: DayOneDeathCounts, role: SystemRole): void {
  counts[role] = (counts[role] ?? 0) + 1
}

export function mergeDayOneDeaths(target: DayOneDeathCounts, src: DayOneDeathCounts): void {
  for (const role of Object.keys(src) as SystemRole[]) {
    target[role] = (target[role] ?? 0) + (src[role] ?? 0)
  }
}
