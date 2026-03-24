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
  const startTime = performance.now()

  // 1. Retar解析で可能性を取得
  const retar = new VillageRetar(vs, setup, analyzeOptions)
  retar.analyze()

  // 2. Retarの内部Possibilitiesからワールド列挙
  const worlds = enumerateWorlds(retar.conclusions, setup)

  if (worlds.length === 0) {
    return {
      isTsumi: false,
      strategy: null,
      stats: {
        worldsTotal: 0,
        nodesVisited: 0,
        elapsed: performance.now() - startTime,
        maxDepth: 0,
      },
    }
  }

  // 3. 初期状態の構築
  const alive = new Set<Seat>()
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) alive.add(seat)
  }

  const initialState: SimState = {
    alive,
    day: vs.day,
  }

  // 4. 探索実行
  const { result, nodesVisited, maxDepthReached } = runSearch(worlds, initialState, searchOptions)

  return {
    isTsumi: result !== null,
    strategy: result,
    stats: {
      worldsTotal: worlds.length,
      nodesVisited,
      elapsed: performance.now() - startTime,
      maxDepth: maxDepthReached,
    },
  }
}

/**
 * 簡易版: ワールドと生存者集合を直接指定して探索。
 * テストやデバッグ用。
 */
export function searchTsumiDirect(
  worlds: import('./types.ts').World[],
  alive: Set<Seat>,
  searchOptions: SearchOptions = DEFAULT_SEARCH_OPTIONS,
): TsumiResult {
  const startTime = performance.now()

  const initialState: SimState = { alive, day: 1 }
  const { result, nodesVisited, maxDepthReached } = runSearch(worlds, initialState, searchOptions)

  return {
    isTsumi: result !== null,
    strategy: result,
    stats: {
      worldsTotal: worlds.length,
      nodesVisited,
      elapsed: performance.now() - startTime,
      maxDepth: maxDepthReached,
    },
  }
}
