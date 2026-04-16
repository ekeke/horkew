/**
 * 解析的勝率計算（純粋数学）
 *
 * VillageStatus に依存せず、グレー数・狼数・確定村数・生存数の
 * 4整数から村の勝率を再帰的に計算する。
 *
 * 夜モデル（v1）: 狼は confirmed village を優先的に噛む。
 * confirmed がいなければ gray の非狼を噛む。
 */

/**
 * メモ化キー: 4整数を1つの number にパック。
 * 各値 0-31 を想定（14人村で十分）。
 */
function memoKey(grays: number, wolves: number, confirmed: number, alive: number): number {
  return (grays << 15) | (wolves << 10) | (confirmed << 5) | alive
}

/**
 * 村の勝率を再帰的に計算する。
 *
 * 前提:
 * - 村はグレーからランダムに1人を処刑する
 * - 狼は confirmed village を優先的に噛む（いなければ gray の非狼）
 * - 狐・護衛・占いの将来結果は v1 では考慮しない
 *
 * @param grays - グレー（未確定）の生存者数（狼含む）
 * @param wolves - グレー内の狼数
 * @param confirmed - 確定村の生存者数（狼でない確定者）
 * @param alive - 全生存者数（= grays + confirmed + confirmedWolves）
 * @param cache - メモ化キャッシュ（省略時は新規作成）
 */
export function computeWinRate(
  grays: number,
  wolves: number,
  confirmed: number,
  alive: number,
  cache?: Map<number, number>,
): number {
  const c = cache ?? new Map<number, number>()
  return computeWinRateInner(grays, wolves, confirmed, alive, c)
}

function computeWinRateInner(
  grays: number,
  wolves: number,
  confirmed: number,
  alive: number,
  cache: Map<number, number>,
): number {
  // 終端条件
  if (wolves <= 0) return 1.0
  if (wolves * 2 >= alive) return 0.0
  if (grays <= 0) return 1.0 // grays 0 で wolves > 0 は不正だが安全側に
  const rope = Math.floor((alive - 1) / 2)
  if (rope <= 0) return 0.0

  const key = memoKey(grays, wolves, confirmed, alive)
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const pHit = wolves / grays

  // 狼命中
  let winIfHit: number
  if (wolves === 1) {
    // 最後の狼 → 即村勝ち（夜フェーズなし）
    winIfHit = 1.0
  } else if (confirmed > 0) {
    // 夜: 狼が confirmed を噛む
    winIfHit = computeWinRateInner(grays - 1, wolves - 1, confirmed - 1, alive - 2, cache)
  } else {
    // 夜: 狼が gray の非狼を噛む
    winIfHit = computeWinRateInner(grays - 2, wolves - 1, 0, alive - 2, cache)
  }

  // 村吊り（ハズレ）
  let winIfMiss: number
  if (confirmed > 0) {
    // 夜: 狼が confirmed を噛む
    winIfMiss = computeWinRateInner(grays - 1, wolves, confirmed - 1, alive - 2, cache)
  } else {
    // 夜: 狼が gray の非狼を噛む
    winIfMiss = computeWinRateInner(grays - 2, wolves, 0, alive - 2, cache)
  }

  const result = pHit * winIfHit + (1 - pHit) * winIfMiss
  cache.set(key, result)
  return result
}
