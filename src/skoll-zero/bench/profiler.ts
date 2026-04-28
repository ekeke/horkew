/**
 * skoll-zero ベンチマーク用プロファイラ。
 *
 * SKOLLZ_BENCH=1 で有効化。MCTS rollout 内の hot path に start/end を仕込み、
 * 1 game 完走時に category 別 ms / 呼び出し回数 / p50/p95/p99 を JSON dump する。
 *
 * 性能影響を最小化するため、ガードは import-time に解決される `BENCH_ENABLED`
 * const で行う:
 *
 *   const t0 = BENCH_ENABLED ? performance.now() : 0
 *   // ... work ...
 *   if (BENCH_ENABLED) benchEnd('category', t0)
 *
 * BENCH_ENABLED が false の時は performance.now() 呼び出しも benchEnd 呼び出しも
 * skip されるため、ゼロに近いオーバーヘッドで dead code になる。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const BENCH_ENABLED: boolean = process.env.SKOLLZ_BENCH === '1'

type CategoryStats = {
  callCount: number
  totalMs: number
  samples: number[]
}

const stats = new Map<string, CategoryStats>()

/** category ごとの sample 上限。memory blow up を防ぐため打ち切る (集計値は累積継続) */
const MAX_SAMPLES_PER_CATEGORY = 10000

/**
 * 計測終了。startMs は呼び出し側で `BENCH_ENABLED ? performance.now() : 0` で取得した値。
 */
export function benchEnd(category: string, startMs: number): void {
  const elapsed = performance.now() - startMs
  let s = stats.get(category)
  if (!s) {
    s = { callCount: 0, totalMs: 0, samples: [] }
    stats.set(category, s)
  }
  s.callCount += 1
  s.totalMs += elapsed
  if (s.samples.length < MAX_SAMPLES_PER_CATEGORY) {
    s.samples.push(elapsed)
  }
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q))
  return sorted[idx]
}

/**
 * 全 category の集計結果を JSON で書き出す。
 * 出力後の reset は呼び出し側の責任 (benchReset を別途呼ぶ)。
 */
export function benchDump(filePath: string): void {
  const out: Record<string, {
    callCount: number
    totalMs: number
    avgMs: number
    p50: number
    p95: number
    p99: number
    sampleCount: number
  }> = {}
  for (const [cat, s] of stats) {
    const sorted = s.samples.slice().sort((a, b) => a - b)
    out[cat] = {
      callCount: s.callCount,
      totalMs: s.totalMs,
      avgMs: s.callCount > 0 ? s.totalMs / s.callCount : 0,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      sampleCount: s.samples.length,
    }
  }
  const dir = dirname(filePath)
  if (dir) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify({
    timestamp: new Date().toISOString(),
    categories: out,
  }, null, 2))
}

export function benchReset(): void {
  stats.clear()
}

/**
 * dump 出力先のデフォルト path 生成。
 * 環境変数 SKOLLZ_BENCH_DIR (default: tmp/bench-skollz) + タイムスタンプ + seed。
 */
export function benchDumpPath(seed: number): string {
  const baseDir = process.env.SKOLLZ_BENCH_DIR ?? 'tmp/bench-skollz'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${baseDir}/${stamp}-seed${seed}.json`
}
