/**
 * ParsedGame[] を iter バケットに集計する
 */

import type { ParsedGame, IterBucket, StatsJson } from './types.ts'
import { emptyFormation, emptyResults } from './types.ts'

/** iter 単位の集計。phase は oracle(iter) が返せば付与 */
export function aggregateByIter(
  gamesByIter: Map<number, ParsedGame[]>,
  checkpointBase: string,
  phaseOracle?: (iter: number) => string | undefined,
): StatsJson {
  const buckets: IterBucket[] = []
  const iters = [...gamesByIter.keys()].sort((a, b) => a - b)
  let total = 0

  for (const iter of iters) {
    const games = gamesByIter.get(iter)!
    const bucket: IterBucket = {
      iter,
      phase: phaseOracle?.(iter),
      games: games.length,
      results: emptyResults(),
      day1Formation: emptyFormation(),
    }
    for (const game of games) {
      bucket.results[game.result]++
      for (const entry of game.entries) {
        bucket.day1Formation[entry.role][entry.claim]++
      }
    }
    buckets.push(bucket)
    total += games.length
  }

  return {
    generatedAt: new Date().toISOString(),
    checkpointBase,
    totalGames: total,
    buckets,
  }
}

/** train-progress.json の evals から (iter → phase) oracle を作る */
export function buildPhaseOracle(progressJson: unknown): (iter: number) => string | undefined {
  const map = new Map<number, string>()
  if (progressJson && typeof progressJson === 'object' && 'evals' in progressJson) {
    const evals = (progressJson as { evals: Array<{ iter: number, model: string }> }).evals
    for (const e of evals ?? []) {
      if (map.has(e.iter)) continue
      const phase = extractPhase(e.model)
      if (phase) map.set(e.iter, phase)
    }
  }
  return (iter: number) => map.get(iter)
}

function extractPhase(model: string): string | undefined {
  // "BB_alternate" / "BB+1_mason_only" / "BB+5_alternate" / "bb_wolf_only" 等
  const m = model.match(/^(BB\+?\d*|bb)/)
  if (!m) return undefined
  // 小文字 bb は統一して BB にする
  return m[1] === 'bb' ? 'BB' : m[1]
}
