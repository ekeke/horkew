import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { VillageRetar } from '../retar/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import type { TsumiResult, SearchOptions, SimState } from './types.ts'
import { DEFAULT_SEARCH_OPTIONS, popCount32 } from './types.ts'
import { collectWorlds } from './worlds.ts'
import { searchTsumi as runSearch, threatExceedsNawa } from './search.ts'
import { canResolveFox } from './foxResolver.ts'
import { RoleSignatureBits, RoleBitIndex } from '../retar/possibilities.ts'

export type { TsumiResult, SearchOptions } from './types.ts'
export type { StrategyNode, World, VillageAction } from './types.ts'

/**
 * Retar解析を実行し Possibilities を返す関数の型。
 * DI により WASM 版・JS 版を切り替え可能。
 */
export type RunRetar = (
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
  options: AnalyzeOptions,
) => Possibilities

function defaultRunRetar(vs: VillageStatus, setup: Map<SystemRole, number>, options: AnalyzeOptions): Possibilities {
  const retar = new VillageRetar(vs, setup, options)
  retar.analyze()
  return retar.conclusions
}

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
  runRetar: RunRetar = defaultRunRetar,
): TsumiResult {
  const t0 = performance.now()

  // 1. Retar解析で可能性を取得
  const conclusions = runRetar(vs, setup, analyzeOptions)
  const t1 = performance.now()

  // 2. 狼/狐候補数による早期枝刈り（Retarから直接取得、ワールド列挙前）
  let alive = 0
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) alive |= (1 << seat)
  }
  const aliveCount = popCount32(alive)

  const wolfBit = RoleSignatureBits.werewolf
  const hamsterBit = RoleSignatureBits.werehamster
  const nekomataBit = RoleSignatureBits.nekomata
  const whiteNVBits = RoleSignatureBits.fanatic | RoleSignatureBits.possessed
  let foxOnly = 0
  let foxAndWolf = 0
  let wolfOnly = 0
  let confirmedWolves = 0
  let whiteNVCandidates = 0
  let hasAliveHamster = false
  let hasNonWolfNekomata = false
  for (let seat = 1; seat < conclusions.possibilities.length; seat++) {
    if (!(alive & (1 << seat))) continue
    const p = conclusions.possibilities[seat]
    const isFox = (p & hamsterBit) !== 0
    const isWolf = (p & wolfBit) !== 0
    if (isFox && isWolf) foxAndWolf++
    else if (isFox) foxOnly++
    else if (isWolf) {
      wolfOnly++
      if (p === wolfBit) confirmedWolves++
    } else if (p & whiteNVBits) {
      // 狼でも狐でもないが白人外(狂信/狂人)の可能性がある席
      whiteNVCandidates++
    }
    if (isFox) hasAliveHamster = true
    if ((p & nekomataBit) && p !== wolfBit) hasNonWolfNekomata = true
  }
  // 白人外の脅威数: 候補数と setup 上の白人外人数の小さい方
  const setupWhiteNV = (setup.get('fanatic' as SystemRole) ?? 0)
    + (setup.get('possessed' as SystemRole) ?? 0)
  const whiteNVThreat = Math.min(whiteNVCandidates, setupWhiteNV)
  const nawa = (aliveCount - 1 - (hasAliveHamster ? 1 : 0)) >> 1
  // 猫又パリティ枝刈り: 非狼の猫又が生存し、(alive - hamster) が奇数の場合、
  // 狼が猫又を噛むと alive が2減り、奇→奇のシフトで nawa が通常より1多く減る。
  // このとき threat == nawa でも実効的に threat > nawa となるため枝刈り可能。
  const nekoParityShift = hasNonWolfNekomata
    && ((aliveCount - (hasAliveHamster ? 1 : 0)) & 1) === 1
  // 狐生存時は確定狼を引かない: 狼を先に処刑すると狐勝ちになるため、
  // 確定狼の処刑は「コスト0」にならず、狐解決と合わせた全体の縄数計算が必要。
  const threat = foxOnly + Math.min(foxAndWolf, 1) + wolfOnly
    - (hasAliveHamster ? 0 : confirmedWolves)
    + whiteNVThreat
  if (foxAndWolf + wolfOnly > nawa
    || threat > nawa
    || (nekoParityShift && threat === nawa)) {
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
  const worlds = collectWorlds(conclusions, setup)
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

  // 3.5a. 狐+白人外パリティ枝刈り: 処刑で狼+狐+白人外を全処理するのに必要な
  // 最低回数が nawa を超えるなら詰みは不可能。白人外（狂信・狂人）の処刑は
  // 狼を減らさず縄だけ消費する。狐生存時は狐解決にも1回必要。
  {
    const fanaticId = RoleBitIndex.fanatic
    const possessedId = RoleBitIndex.possessed
    let allInsufficient = true
    for (const w of worlds) {
      const aliveWolves = popCount32(w.wolfMask & alive)
      const hasHamsterAlive = (w.hamsterMask & alive) !== 0
      // 白人外の生存数: 全生存席をスキャンし狂信・狂人を数える
      let whiteNonVillagers = 0
      let m = alive
      while (m !== 0) {
        const bit = m & (-m); m ^= bit
        const seat = 31 - Math.clz32(bit)
        const rid = w.roleIds[seat]
        if (rid === fanaticId || rid === possessedId) whiteNonVillagers++
      }
      // 必要処刑数: 狼全員 + 狐(生存時) + 白人外
      const requiredExecs = aliveWolves + (hasHamsterAlive ? 1 : 0) + whiteNonVillagers
      if (requiredExecs <= nawa) { allInsufficient = false; break }
    }
    if (allInsufficient) {
      const t3 = performance.now()
      return {
        isTsumi: false,
        strategy: null,
        stats: {
          worldsTotal: worlds.length, nodesVisited: 0, maxDepth: 0,
          elapsed: t3 - t0, retarElapsed: t1 - t0, enumerateElapsed: t2 - t1, searchElapsed: t3 - t2,
        },
      }
    }
  }

  // 3.5b. 狐排除探索: 狐が生存している場合、排除可能か判定
  // maxTurns = aliveCount: wolf_win チェックが自然な終了条件になるため、
  // 人工的な縄数制限は不要。alive は毎ターン最低1減るので探索は有界。
  if (!searchOptions.disableHamsterPruning && hasAliveHamster) {
    if (!canResolveFox(worlds, alive, aliveCount)) {
      const t3 = performance.now()
      return {
        isTsumi: false,
        strategy: null,
        stats: {
          worldsTotal: worlds.length, nodesVisited: 0, maxDepth: 0,
          elapsed: t3 - t0, retarElapsed: t1 - t0, enumerateElapsed: t2 - t1, searchElapsed: t3 - t2,
        },
      }
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
