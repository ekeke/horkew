import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { VillageRetar } from '../retar/index.ts'
import type { TsumiResult, SearchOptions, SimState } from './types.ts'
import { DEFAULT_SEARCH_OPTIONS, popCount32 } from './types.ts'
import { collectWorlds } from './worlds.ts'
import { searchTsumi as runSearch } from './search.ts'
import { RoleBitIndex, RoleSignatureBits } from '../retar/possibilities.ts'

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

  // 2. 狼候補数による早期枝刈り（Retarから直接取得、ワールド列挙前）
  // 縄数 = floor((alive - 1 - hamster) / 2): wolfCountに依存しない
  let alive = 0
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) alive |= (1 << seat)
  }
  const aliveCount = popCount32(alive)

  const wolfBit = RoleSignatureBits.werewolf
  const hamsterBit = RoleSignatureBits.werehamster
  let wolfCandidates = 0
  let hamsterCandidates = 0
  let hasAliveHamster = false
  for (let seat = 1; seat < retar.conclusions.possibilities.length; seat++) {
    if (!(alive & (1 << seat))) continue
    const p = retar.conclusions.possibilities[seat]
    if (p & wolfBit) wolfCandidates++
    if (p & hamsterBit) { hamsterCandidates++; hasAliveHamster = true }
  }
  const nawa = (aliveCount - 1 - (hasAliveHamster ? 1 : 0)) >> 1
  if (wolfCandidates > nawa || (hasAliveHamster && hamsterCandidates > 2 * nawa - wolfCandidates)) {
    const t2 = performance.now()
    return {
      isTsumi: false,
      strategy: null,
      stats: {
        worldsTotal: 0, nodesVisited: 0, maxDepth: 0,
        elapsed: t2 - t0, retarElapsed: t1 - t0, enumerateElapsed: 0, searchElapsed: 0,
      },
    }
  }

  // 3. Retarの内部Possibilitiesからワールド列挙
  const worlds = collectWorlds(retar.conclusions, setup)
  const t2 = performance.now()

  if (worlds === null || worlds.length === 0) {
    return {
      isTsumi: false,
      strategy: null,
      stats: {
        worldsTotal: 0, nodesVisited: 0, maxDepth: 0,
        elapsed: t2 - t0, retarElapsed: t1 - t0, enumerateElapsed: t2 - t1, searchElapsed: 0,
      },
    }
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
