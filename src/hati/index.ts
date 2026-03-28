import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { VillageRetar } from '../retar/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import type { TsumiResult, TsumiJudgment, SearchOptions, SimState, World } from './types.ts'
import { DEFAULT_SEARCH_OPTIONS, popCount32 } from './types.ts'
import { collectWorlds } from './worlds.ts'
import { searchTsumi as runSearch } from './search.ts'
import { simulateFoxElimination } from './foxResolver.ts'
import { RoleSignatureBits, RoleBitIndex } from '../retar/possibilities.ts'

export type { TsumiResult, TsumiJudgment, SearchOptions } from './types.ts'
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

// ---------------------------------------------------------------------------
// 判定条件
// ---------------------------------------------------------------------------

/**
 * 脅威ベースの詰み不可能判定。
 * 生存者の役職可能性スキャン結果から nawa/threat/tsumiCoeff を算出し、
 * 詰み不可能かどうかを判定する。
 *
 * 不可能条件:
 * - 狼+狐狼兼候補数が縄数を超える
 * - 脅威数が縄数を超える
 * - 猫又パリティシフトにより脅威数 == 縄数でも実質超過
 */
function isThreatExceeded(scan: {
  /** 生存者のうち、狐の可能性はあるが狼の可能性はない席の数 */
  foxOnly: number
  /** 生存者のうち、狐・狼どちらの可能性もある席の数 */
  foxAndWolf: number
  /** 生存者のうち、狼の可能性はあるが狐の可能性はない席の数 */
  wolfOnly: number
  /** 生存者のうち、狼であることが確定している席の数 */
  confirmedWolves: number
  /** 生存者のうち、白人外（狂信者・狂人）の可能性がある席の数 */
  whiteNVCandidates: number
  /** 狐が生存している可能性があるか */
  hasAliveHamster: boolean
  /** 非狼猫又が生存 & 生存者パリティが奇数（噛み死で縄が余分に1減る） */
  nekoParityShift: boolean
  /** 生存者数 */
  aliveCount: number
  /** 配役上の白人外の数 */
  setupWhiteNV: number
}): { impossible: boolean, tsumiCoeff: number, nawa: number, threat: number, nawaInt: number } {
  const {
    foxOnly, foxAndWolf, wolfOnly, confirmedWolves,
    whiteNVCandidates, hasAliveHamster, nekoParityShift,
    aliveCount, setupWhiteNV,
  } = scan

  const whiteNVThreat = Math.min(whiteNVCandidates, setupWhiteNV)
  const nawaInt = (aliveCount - 1 - (hasAliveHamster ? 1 : 0)) >> 1
  const nawa = (aliveCount - 1) / 2
  // 狐生存時は確定狼を引かない（狼先処刑 → 狐勝ちのリスク）
  const threat = foxOnly + Math.min(foxAndWolf, 1) + wolfOnly
    - (hasAliveHamster ? 0 : confirmedWolves)
    + whiteNVThreat
  const tsumiCoeff = nawa - threat

  const impossible = foxAndWolf + wolfOnly > nawaInt
    || threat > nawaInt
    || (nekoParityShift && threat === nawaInt)

  return { impossible, tsumiCoeff, nawa, threat, nawaInt }
}

// ---------------------------------------------------------------------------
// 判定フェーズ
// ---------------------------------------------------------------------------

/**
 * 詰み判定: Retarの可能性からnawa/threat/coeffを計算し、詰み不可能かを判定する。
 * ワールド列挙・AND-OR探索は行わない。
 */
export function judgeTsumi(
  conclusions: Possibilities,
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
): TsumiJudgment {
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
      whiteNVCandidates++
    }
    if (isFox) hasAliveHamster = true
    if ((p & nekomataBit) && p !== wolfBit) hasNonWolfNekomata = true
  }

  const setupWhiteNV = (setup.get('fanatic' as SystemRole) ?? 0)
    + (setup.get('possessed' as SystemRole) ?? 0)
  // 猫又パリティ: 非狼猫又生存 & (alive - hamster) が奇数 → 噛みで alive が2減り nawa が余分に1減る
  const nekoParityShift = hasNonWolfNekomata
    && ((aliveCount - (hasAliveHamster ? 1 : 0)) & 1) === 1

  const { impossible, tsumiCoeff, nawa, threat, nawaInt } = isThreatExceeded({
    foxOnly, foxAndWolf, wolfOnly, confirmedWolves,
    whiteNVCandidates, hasAliveHamster, nekoParityShift,
    aliveCount, setupWhiteNV,
  })

  return { tsumiCoeff, nawa, threat, nawaInt, alive, hasAliveHamster, impossible }
}

// ---------------------------------------------------------------------------
// 戦略探索
// ---------------------------------------------------------------------------

/**
 * 探索の枝刈り: 全ワールドで処刑回数不足か判定。
 * 各ワールドの具体的な役職配置から必要処刑数を正確に計算し、
 * 全ワールドで縄数を超えていれば探索不要。
 */
function isExecInsufficient(worlds: World[], alive: number, nawaInt: number): boolean {
  const fanaticId = RoleBitIndex.fanatic
  const possessedId = RoleBitIndex.possessed
  for (const w of worlds) {
    const aliveWolves = popCount32(w.wolfMask & alive)
    const hasHamsterAlive = (w.hamsterMask & alive) !== 0
    let whiteNonVillagers = 0
    let m = alive
    while (m !== 0) {
      const bit = m & (-m); m ^= bit
      const seat = 31 - Math.clz32(bit)
      const rid = w.roleIds[seat]
      if (rid === fanaticId || rid === possessedId) whiteNonVillagers++
    }
    const requiredExecs = aliveWolves + (hasHamsterAlive ? 1 : 0) + whiteNonVillagers
    if (requiredExecs <= nawaInt) return false
  }
  return true
}

/** searchTsumiStrategy の戻り値 */
type StrategySearchResult = {
  isTsumi: boolean
  strategy: import('./types.ts').StrategyNode | null
  worldsTotal: number
  nodesVisited: number
  maxDepth: number
  enumerateElapsed: number
  searchElapsed: number
}

/**
 * 戦略探索: ワールド列挙 → 実行可能性判定 → AND-OR木探索。
 * judgeTsumi で impossible=false の場合に呼ぶ。
 */
export function searchTsumiStrategy(
  conclusions: Possibilities,
  judgment: TsumiJudgment,
  setup: Map<SystemRole, number>,
  day: number,
  searchOptions: SearchOptions = DEFAULT_SEARCH_OPTIONS,
): StrategySearchResult {
  const { alive, nawaInt, hasAliveHamster } = judgment

  // ワールド列挙
  const t0 = performance.now()
  const worlds = collectWorlds(conclusions, setup)
  const t1 = performance.now()

  if (worlds === null || worlds.length === 0) {
    return {
      isTsumi: false, strategy: null, worldsTotal: 0,
      nodesVisited: 0, maxDepth: 0, enumerateElapsed: t1 - t0, searchElapsed: 0,
    }
  }

  // 全ワールドで処刑回数不足なら詰み不可能
  if (isExecInsufficient(worlds, alive, nawaInt)) {
    return {
      isTsumi: false, strategy: null, worldsTotal: worlds.length,
      nodesVisited: 0, maxDepth: 0, enumerateElapsed: t1 - t0, searchElapsed: performance.now() - t1,
    }
  }

  // 狐排除不能なら詰み不可能
  if (!searchOptions.disableHamsterPruning && hasAliveHamster) {
    const aliveCount = popCount32(alive)
    if (!simulateFoxElimination(worlds, alive, aliveCount, nawaInt)) {
      return {
        isTsumi: false, strategy: null, worldsTotal: worlds.length,
        nodesVisited: 0, maxDepth: 0, enumerateElapsed: t1 - t0, searchElapsed: performance.now() - t1,
      }
    }
  }

  // AND-OR木探索
  const initialState: SimState = { alive, day }
  const { result, nodesVisited, maxDepthReached } = runSearch(worlds, initialState, searchOptions)
  const t2 = performance.now()

  return {
    isTsumi: result !== null,
    strategy: result,
    worldsTotal: worlds.length,
    nodesVisited, maxDepth: maxDepthReached,
    enumerateElapsed: t1 - t0, searchElapsed: t2 - t1,
  }
}

// ---------------------------------------------------------------------------
// 公開API
// ---------------------------------------------------------------------------

/**
 * 詰み進行探索のメインエントリポイント。
 *
 * VillageStatus（現在のゲーム状態）と配役セットアップを受け取り、
 * 村が必ず勝てる戦略が存在するかを探索する。
 */
export function searchTsumi(
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
  analyzeOptions: AnalyzeOptions,
  searchOptions: SearchOptions = DEFAULT_SEARCH_OPTIONS,
  runRetar: RunRetar = defaultRunRetar,
): TsumiResult {
  const t0 = performance.now()

  // 1. Retar解析
  const conclusions = runRetar(vs, setup, analyzeOptions)
  const t1 = performance.now()

  // 2. 判定フェーズ
  const judgment = judgeTsumi(conclusions, vs, setup)
  const { tsumiCoeff, nawa, threat } = judgment

  const isTsumi = !judgment.impossible
  const t2 = performance.now()

  // 戦略構築が不要、または詰み不可能なら探索をスキップ
  if (!isTsumi || searchOptions.buildStrategy === false) {
    return {
      isTsumi, strategy: null,
      tsumiCoeff, nawa, threat,
      stats: {
        worldsTotal: 0, nodesVisited: 0, maxDepth: 0,
        elapsed: t2 - t0, retarElapsed: t1 - t0, enumerateElapsed: 0, searchElapsed: 0,
      },
    }
  }

  // 3. 戦略探索（手順の構築）
  const sr = searchTsumiStrategy(conclusions, judgment, setup, vs.day, searchOptions)
  const elapsed = performance.now() - t0

  return {
    isTsumi: true,
    strategy: sr.strategy,
    tsumiCoeff, nawa, threat,
    stats: {
      worldsTotal: sr.worldsTotal, nodesVisited: sr.nodesVisited, maxDepth: sr.maxDepth,
      elapsed, retarElapsed: t1 - t0,
      enumerateElapsed: sr.enumerateElapsed, searchElapsed: sr.searchElapsed,
    },
  }
}

/**
 * 簡易版: ワールドと生存者集合を直接指定して探索。
 * テストやデバッグ用。
 */
export function searchTsumiDirect(
  worlds: World[],
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
    tsumiCoeff: 0, nawa: 0, threat: 0,
    stats: {
      worldsTotal: worlds.length, nodesVisited, maxDepth: maxDepthReached,
      elapsed: searchElapsed, retarElapsed: 0, enumerateElapsed: 0, searchElapsed,
    },
  }
}
