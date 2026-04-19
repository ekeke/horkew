/**
 * MCTS visit 分布から policy target / action を抽出する utility。
 */

/** N(a) / Σ N(b) で正規化した π を返す */
export function normalizeVisits(visits: Map<number, number>): Map<number, number> {
  let total = 0
  for (const v of visits.values()) total += v
  const pi = new Map<number, number>()
  if (total === 0) return pi
  for (const [a, v] of visits) pi.set(a, v / total)
  return pi
}

/**
 * visit 分布から action を確率的にサンプル。
 * 全ての visit が 0 なら最初の action を返す（fallback）。
 *
 * 温度 τ は呼び出し側で visit を `N^(1/τ)` に変換してから渡す（M5 で実装予定、
 * 第一案では τ=1 固定なので生 visit をそのまま使う）。
 */
export function sampleFromVisits(
  visits: Map<number, number>,
  rng: () => number = Math.random,
): number {
  let total = 0
  for (const v of visits.values()) total += v
  if (total === 0) {
    const first = visits.keys().next().value
    return first ?? -1
  }
  const r = rng() * total
  let acc = 0
  for (const [action, v] of visits) {
    acc += v
    if (r < acc) return action
  }
  // numerical fallback
  const last = [...visits.keys()].at(-1)
  return last ?? -1
}

/** visit 分布から最大 visit の action を返す（greedy / eval 用） */
export function argmaxFromVisits(visits: Map<number, number>): number {
  let bestAction = -1
  let bestVisits = -1
  for (const [action, v] of visits) {
    if (v > bestVisits) {
      bestVisits = v
      bestAction = action
    }
  }
  return bestAction
}
