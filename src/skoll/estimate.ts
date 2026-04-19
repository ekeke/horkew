/**
 * 世界数の事前見積もり
 *
 * `analyzeExecutionsByWorld` 等の処理時間は列挙されるワールド数に比例する。
 * 実際の列挙を走らせる前に、上限と粗い見積もりを cheap に返す。
 *
 * 用途:
 *   - demo で「吊り分析」前に「~ 10K 世界 / ~ 30ms 程度」を表示する
 *   - 重そうな計算を skip する判断に使う
 */

import type { SystemRole } from '../types/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import { RoleBitIndex } from '../retar/possibilities.ts'

export type WorldEstimate = {
  /** 生存 seat 数 */
  aliveSeats: number
  /** 1 seat あたりの平均可能役職数 */
  avgPossibilities: number
  /** Π popcount(poss[seat]) — backtrack の最大ノード数（剪定無視で極端に loose） */
  naiveProduct: number
  /** Bregman-Minc 不等式による permanent 上限 / Π count_r!
   *  実 totalWorlds に対する典型的な上限。actual は通常これ以下、~1〜10x オーダー */
  upperBound: number
}

/**
 * 経験則ベースのスループット (ワールド/秒)。
 * sigCache 効きやすい中盤で 200K-500K worlds/s、序盤の重い盤面で 50K-100K worlds/s 程度。
 * 中央値で 200K worlds/s を仮定。
 */
export const ASSUMED_WORLDS_PER_SEC = 200_000

/** ln(n!) を素直に計算 */
function lnFactorial(n: number): number {
  if (n <= 1) return 0
  let s = 0
  for (let i = 2; i <= n; i++) s += Math.log(i)
  return s
}

/**
 * Bregman-Minc 不等式による permanent 上限を log で計算。
 *
 * 役職割当を「席 (n) × 役職スロット (n)」の 0-1 行列の perfect matching と捉える。
 * matrix M の row sum r_i = popcount(possibilities[seat_i])（席が持てる役職スロット数）
 * permanent(M) ≤ Π_i (r_i!)^(1/r_i)
 *
 * 同一役職内のスロットは入れ替え可なので、世界数 = permanent / Π count_r!
 */
export function estimateWorldCount(
  possibilities: Possibilities,
  setup: Map<SystemRole, number>,
): WorldEstimate {
  let naive = 1
  let alive = 0
  let totalPoss = 0
  let lnPermBound = 0

  for (let seat = 1; seat < possibilities.possibilities.length; seat++) {
    const mask = possibilities.possibilities[seat]
    if (mask === 0) continue

    // setup に含まれる役職だけを数える（possibilities が ROLE_COUNT bit 全部使ってる前提だが念のため）
    let k = 0
    for (const [role] of setup) {
      const idx = RoleBitIndex[role]
      if ((mask >>> idx) & 1) k++
    }
    if (k === 0) continue

    naive *= k
    alive++
    totalPoss += k
    lnPermBound += lnFactorial(k) / k
  }

  // 同一役職スロットの入れ替えで割り戻す
  let lnDenom = 0
  for (const [, count] of setup) {
    lnDenom += lnFactorial(count)
  }

  const upperBound = Math.exp(lnPermBound - lnDenom)

  return {
    aliveSeats: alive,
    avgPossibilities: alive > 0 ? totalPoss / alive : 0,
    naiveProduct: naive,
    upperBound,
  }
}

/** ms 単位の予想実行時間 */
export function estimateRuntimeMs(estimate: WorldEstimate, worldsPerSec = ASSUMED_WORLDS_PER_SEC): number {
  return (estimate.upperBound / worldsPerSec) * 1000
}
