import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { VillageRetar } from '../retar/index.ts'
import type { TsumiResult, SearchOptions, SimState } from './types.ts'
import { DEFAULT_SEARCH_OPTIONS } from './types.ts'
import { enumerateWorlds } from './worlds.ts'
import { searchTsumi as runSearch } from './search.ts'

export type { TsumiResult, SearchOptions } from './types.ts'
export type { StrategyNode, World, VillageAction } from './types.ts'

/**
 * 詰み進行探索のメインエントリポイント。
 *
 * VillageStatus（現在のゲーム状態）と配役セットアップを受け取り、
 * 村が必ず勝てる戦略が存在するかを探索する。
 *
 * @param vs - 現在の村の状態
 * @param setup - 配役（各役職の人数）
 * @param analyzeOptions - Retar解析オプション
 * @param searchOptions - 探索オプション（深度制限など）
 * @returns 詰み判定結果と勝利戦略
 */
export function searchTsumi(
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
  analyzeOptions: AnalyzeOptions,
  searchOptions: SearchOptions = DEFAULT_SEARCH_OPTIONS,
): TsumiResult {
  const t0 = performance.now()

  // 1. Retar解析で可能性を取得
  const retar = new VillageRetar(vs, setup, analyzeOptions)
  retar.analyze()
  const t1 = performance.now()

  // 2. Retarの内部Possibilitiesからワールド列挙
  const worlds = enumerateWorlds(retar.conclusions, setup)
  const t2 = performance.now()

  if (worlds.length === 0) {
    return {
      isTsumi: false,
      strategy: null,
      stats: {
        worldsTotal: 0, nodesVisited: 0, maxDepth: 0,
        elapsed: t2 - t0, retarElapsed: t1 - t0, enumerateElapsed: t2 - t1, searchElapsed: 0,
      },
    }
  }

  // 3. 初期状態の構築
  let alive = 0
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) alive |= (1 << seat)
  }

  const initialState: SimState = { alive, day: vs.day }

  // 4. 探索実行
  const { result, nodesVisited, maxDepthReached } = runSearch(worlds, initialState, searchOptions)
  const t3 = performance.now()

  return {
    isTsumi: result !== null,
    strategy: result,
    stats: {
      worldsTotal: worlds.length, nodesVisited, maxDepth: maxDepthReached,
      elapsed: t3 - t0, retarElapsed: t1 - t0, enumerateElapsed: t2 - t1, searchElapsed: t3 - t2,
    },
  }
}

/**
 * 簡易版: ワールドと生存者集合を直接指定して探索。
 * テストやデバッグ用。
 */
export function searchTsumiDirect(
  worlds: import('./types.ts').World[],
  alive: number | Set<Seat>,
  searchOptions: SearchOptions = DEFAULT_SEARCH_OPTIONS,
): TsumiResult {
  const t0 = performance.now()
  const aliveMask = typeof alive === 'number' ? alive : (() => { let m = 0; for (const s of alive) m |= (1 << s); return m })()
  const initialState: SimState = { alive: aliveMask, day: 1 }
  const { result, nodesVisited, maxDepthReached } = runSearch(worlds, initialState, searchOptions)
  const searchElapsed = performance.now() - t0

  return {
    isTsumi: result !== null,
    strategy: result,
    stats: {
      worldsTotal: worlds.length, nodesVisited, maxDepth: maxDepthReached,
      elapsed: searchElapsed, retarElapsed: 0, enumerateElapsed: 0, searchElapsed,
    },
  }
}
