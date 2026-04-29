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
 * 温度 τ:
 *   - τ=1 (default): 生 visits 比率で sampling = AlphaZero 標準
 *   - τ→0: argmax 寄り (best action 集中)
 *   - τ>1: uniform 寄り (exploration 強化)
 *   visits を `v^(1/τ)` に変換してから sampling する。
 *   τ=1 ならゼロ overhead (変換 skip)。
 */
export function sampleFromVisits(
  visits: Map<number, number>,
  rng: () => number = Math.random,
  temperature: number = 1.0,
): number {
  // τ=1 fast path: 既存挙動
  if (temperature === 1.0) {
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
    const last = [...visits.keys()].at(-1)
    return last ?? -1
  }
  // τ≠1: visits^(1/τ) で変換してから sampling
  const invT = 1.0 / temperature
  let total = 0
  const tempered: Array<[number, number]> = []
  for (const [a, v] of visits) {
    const w = Math.pow(v, invT)
    tempered.push([a, w])
    total += w
  }
  if (total === 0) {
    const first = visits.keys().next().value
    return first ?? -1
  }
  const r = rng() * total
  let acc = 0
  for (const [action, w] of tempered) {
    acc += w
    if (r < acc) return action
  }
  return tempered.at(-1)?.[0] ?? -1
}

/**
 * SKOLLZ_TEMP_SCHEDULE=alive で alive 数に応じた温度カーブを返す。
 * 序盤 (alive 多) で温度高 = 探索重視、終盤 (alive 少) で温度低 = best play。
 * 未指定なら τ=1 固定 (= 既存挙動)。
 *
 * 温度カーブ (現状 step 関数):
 *   alive >= 9 → 2.0  (序盤、policy ほぼ uniform で探索強化)
 *   alive 5-8 → 1.0  (中盤、AlphaZero 標準)
 *   alive <= 4 → 0.3  (終盤、argmax 寄りで best play)
 */
const TEMP_SCHEDULE_ENABLED: boolean = process.env.SKOLLZ_TEMP_SCHEDULE === 'alive'

export function temperatureForAlive(aliveCount: number): number {
  if (!TEMP_SCHEDULE_ENABLED) return 1.0
  if (aliveCount >= 9) return 2.0
  if (aliveCount >= 5) return 1.0
  return 0.3
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
