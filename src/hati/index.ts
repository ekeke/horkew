import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { AnalyzeOptions, AnalyzeResult } from '../retar/index.ts'
import { VillageRetar } from '../retar/index.ts'
import { Possibilities, possibilityFromRoles } from '../retar/possibilities.ts'
import type { TsumiResult, TsumiJudgment, ThreatProfile, SearchOptions, SimState, World } from './types.ts'
import { DEFAULT_SEARCH_OPTIONS, popCount32 } from './types.ts'
import { collectWorlds } from './worlds.ts'
import { searchTsumi as runSearch } from './search.ts'
import { simulateFoxElimination } from './foxResolver.ts'
import { RoleBitIndex, RoleSignatureBits } from '../retar/possibilities.ts'

export type { TsumiResult, TsumiJudgment, ThreatProfile, SearchOptions } from './types.ts'
export type { StrategyNode, World, VillageAction } from './types.ts'
export { evaluateWolfRisk } from './wolfRisk.ts'
export type { WolfRiskResult } from './wolfRisk.ts'

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
  const result = retar.analyze()
  return resultToPossibilitiesInternal(result, setup)
}

/** AnalyzeResult → Possibilities 変換（hati内部用） */
function resultToPossibilitiesInternal(result: AnalyzeResult, setup: Map<SystemRole, number>): Possibilities {
  const p = new Possibilities(setup)
  for (const [seat, roles] of result.result) {
    p.possibilities[seat] = possibilityFromRoles(roles)
  }
  p.maxSurvivingNV = result.maxSurvivingNV
  return p
}

// ---------------------------------------------------------------------------
// 狐排除可能性の計算
// ---------------------------------------------------------------------------

export type FoxResolvability = {
  /** 配役の占い師数 */
  setupSeerCount: number
  /** 死亡した占い師候補数 */
  deadSeerCandidates: number
  /** 生存占い師候補数 */
  aliveSeerCandidates: number
  /** 生存占い師候補が占うだけで全占い師候補の占い結果が出そろう生存者数 */
  coverableAlive: number
  /** 生存狐候補の数 */
  aliveFoxCandidates: number
  /** 生存占い師候補が占える生存狐候補の数（占い師自身を除く） */
  divinableFoxCandidates: number
  /** 狐排除可能と判断するか */
  resolvable: boolean
}

/**
 * 狐排除に関わる占い師カバレッジを計算し、排除可能かを判定する。
 */
export function computeFoxResolvability(
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
  conclusions: Possibilities,
  alive: number,
): FoxResolvability {
  const setupSeerCount = setup.get('seer' as SystemRole) ?? 0
  const seerClaimants = vs.claims.get('seer' as SystemRole) ?? []

  const deadSeers: number[] = []
  const aliveSeers: number[] = []
  for (const seat of seerClaimants) {
    const status = vs.statuses.get(seat)
    if (!status) continue
    if (status.surviving) aliveSeers.push(seat)
    else deadSeers.push(seat)
  }

  // 各占い師候補の占い履歴（assertions + forecasts）
  const seerTargets = new Map<number, Set<number>>()
  for (const seat of [...deadSeers, ...aliveSeers]) {
    const status = vs.statuses.get(seat)!
    const targets = new Set<number>()
    for (const [, assertion] of status.assertions) {
      targets.add(assertion.target)
    }
    for (const [, target] of status.forecasts) {
      targets.add(target)
    }
    seerTargets.set(seat, targets)
  }

  // 生存狐候補
  const aliveFoxSeats: number[] = []
  for (let seat = 1; seat < conclusions.possibilities.length; seat++) {
    if (!(alive & (1 << seat))) continue
    if (conclusions.hasRole(seat, 'werehamster' as SystemRole)) {
      aliveFoxSeats.push(seat)
    }
  }

  // 狩人確定生存チェック: possibilitiesでbodyguardが唯一の役職の生存席
  let bodyguardConfirmed = false
  for (let seat = 1; seat < conclusions.possibilities.length; seat++) {
    if (!(alive & (1 << seat))) continue
    if (conclusions.isActualRole(seat, 'bodyguard' as SystemRole)) {
      bodyguardConfirmed = true
      break
    }
  }

  // 占いターン数: 1（今夜）+ 狩人確定なら+1（護衛で占い師が生き残る）
  const turns = aliveSeers.length > 0 ? 1 + (bodyguardConfirmed ? 1 : 0) : 0

  // 各狐候補について、解決に必要な占い回数を計算
  // 狐候補から除外する条件: すべての占い師候補に占われて溶けていない
  // → 死亡占い師は既に占い済みが必須
  // → 生存占い師は既占いか今後占えるか（自分自身は占えない）
  const resolvableFoxes: number[] = []  // 占いで解決可能な狐候補
  const unresolvableFoxes: number[] = [] // 占いでは解決不能な狐候補

  for (const foxSeat of aliveFoxSeats) {
    // 死亡占い師が全員占い済みか
    let blockedByDead = false
    for (const seerSeat of deadSeers) {
      if (!seerTargets.get(seerSeat)!.has(foxSeat)) {
        blockedByDead = true
        break
      }
    }
    if (blockedByDead) {
      unresolvableFoxes.push(foxSeat)
      continue
    }

    // 占い師自身が狐候補の場合、自分を占えない
    let blockedBySelf = false
    for (const seerSeat of aliveSeers) {
      if (seerSeat === foxSeat && !seerTargets.get(seerSeat)!.has(foxSeat)) {
        blockedBySelf = true
        break
      }
    }
    if (blockedBySelf) {
      unresolvableFoxes.push(foxSeat)
      continue
    }

    resolvableFoxes.push(foxSeat)
  }

  // 生存占い師の占い回数制限チェック
  // 各生存占い師が未占いの解決可能狐候補をターン内に占いきれるか
  // ボトルネック: 最も多く占う必要がある占い師
  // 生存占い師がいなければ占いで狐を排除できない
  let maxResolvable = aliveSeers.length === 0 ? 0 : resolvableFoxes.length
  for (const seerSeat of aliveSeers) {
    const divined = seerTargets.get(seerSeat)!
    let needToDivine = 0
    for (const foxSeat of resolvableFoxes) {
      if (!divined.has(foxSeat)) needToDivine++
    }
    const overflow = Math.max(0, needToDivine - turns)
    maxResolvable = Math.min(maxResolvable, resolvableFoxes.length - overflow)
  }

  const divinableFoxCandidates = maxResolvable
  const resolvable = aliveFoxSeats.length === 0 || divinableFoxCandidates >= aliveFoxSeats.length

  return {
    setupSeerCount,
    deadSeerCandidates: deadSeers.length,
    aliveSeerCandidates: aliveSeers.length,
    coverableAlive: 0,
    aliveFoxCandidates: aliveFoxSeats.length,
    divinableFoxCandidates,
    resolvable,
  }
}

// ---------------------------------------------------------------------------
// 脅威プロファイル構築
// ---------------------------------------------------------------------------

/**
 * 生存者の役職候補を分類し、縄数・脅威指標を算出する。
 * 判定ロジックは含まない。学習特徴量としても利用可能。
 */
export function buildThreatProfile(
  conclusions: Possibilities,
  alive: number,
  aliveCount: number,
  setup: Map<SystemRole, number>,
): ThreatProfile {
  // 生存者の役職可能性を分類
  let foxCandidates = 0
  let foxWolfCandidates = 0
  let wolfCandidates = 0
  let wolfConfirmedCount = 0
  let nekoWolfCandidates = 0
  let whiteNVCandidates = 0
  let immoralistCandidates = 0
  let possibleSurvivingHamster = false
  let possibleSurvivingNekomata = false

  for (let seat = 1; seat < conclusions.possibilities.length; seat++) {
    if (!(alive & (1 << seat))) continue
    const foxCandidate = conclusions.hasRole(seat, 'werehamster' as SystemRole)
    const wolfCandidate = conclusions.hasRole(seat, 'werewolf' as SystemRole)
    const wolfConfirmed = conclusions.isActualRole(seat, 'werewolf' as SystemRole)
    if (foxCandidate && wolfCandidate) foxWolfCandidates++
    else if (foxCandidate) foxCandidates++
    else if (wolfCandidate) {
      wolfCandidates++
      if (wolfConfirmed) wolfConfirmedCount++
      if (conclusions.hasRole(seat, 'nekomata' as SystemRole)) nekoWolfCandidates++
    } else if (conclusions.hasRole(seat, 'fanatic' as SystemRole) || conclusions.hasRole(seat, 'possessed' as SystemRole)) {
      whiteNVCandidates++
    }
    if (foxCandidate) possibleSurvivingHamster = true
    if (conclusions.hasRole(seat, 'nekomata' as SystemRole)) possibleSurvivingNekomata = true
    if (conclusions.hasRole(seat, 'immoralist' as SystemRole)) immoralistCandidates++
  }

  const setupWhiteNV = (setup.get('fanatic' as SystemRole) ?? 0)
    + (setup.get('possessed' as SystemRole) ?? 0)
  const whiteNVThreat = Math.min(whiteNVCandidates, setupWhiteNV)
  const nawa = (aliveCount - 1) / 2
  const effectiveNawa = (aliveCount - 1 - (possibleSurvivingHamster ? 1 : 0)) / 2
  const nawaInt = effectiveNawa | 0
  const threat = conclusions.maxSurvivingNV
  // 狐生存時は確定狼を引かない（狼先処刑 → 狐勝ちのリスク）
  const requiredExecs = foxCandidates + Math.min(foxWolfCandidates, 1) + wolfCandidates
    - (possibleSurvivingHamster ? 0 : wolfConfirmedCount)
    + whiteNVThreat
  // 猫又パリティシフト:
  // effectiveNawa に .5 の余裕がないとき、狼が猫又を噛むと道連れで
  // 生存者が2人減り、縄が想定より1本減る。
  const nekoParityShift = possibleSurvivingNekomata && effectiveNawa % 1 === 0
  // 猫又処刑リスク: 猫又兼狼候補を処刑して猫又だった場合、
  // 道連れで生存者が追加死亡し実効縄が 0.5 減る。
  const nekoExecRisk = Math.min(nekoWolfCandidates, setup.get('nekomata' as SystemRole) ?? 0)

  return {
    foxCandidates, foxWolfCandidates, wolfCandidates, wolfConfirmedCount,
    whiteNVCandidates, whiteNVThreat,
    possibleSurvivingHamster, possibleSurvivingNekomata,
    nawa, effectiveNawa, nawaInt, threat,
    requiredExecs, nekoParityShift, nekoWolfCandidates, nekoExecRisk,
    immoralistCandidates,
  }
}

// ---------------------------------------------------------------------------
// 判定条件
// ---------------------------------------------------------------------------

/**
 * ThreatProfileから詰み不可能かを判定する。
 *
 * 不可能条件:
 * - 狼+狐狼兼候補数が縄数を超える
 * - 必要処刑数が縄数を超える
 * - 猫又パリティシフトにより必要処刑数 == 縄数でも実質超過
 */
export function isThreatExceeded(p: ThreatProfile): boolean {
  return p.threat > p.nawa
    || p.foxWolfCandidates + p.wolfCandidates > p.nawaInt
    || p.requiredExecs > p.nawaInt
    || (p.nekoParityShift && p.requiredExecs === p.nawaInt)
    // 猫又兼狼候補の処刑リスク: 猫又処刑の道連れで 0.5 nawa 損失
    || (p.nekoExecRisk > 0
      && p.requiredExecs + p.nekoExecRisk * 0.5
         > p.effectiveNawa - (p.possibleSurvivingHamster ? 0 : p.wolfConfirmedCount))
}

// ---------------------------------------------------------------------------
// 判定フェーズ
// ---------------------------------------------------------------------------

/**
 * 詰み判定: Retarの可能性からThreatProfileを構築し、詰み不可能かを判定する。
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
  const profile = buildThreatProfile(conclusions, alive, aliveCount, setup)

  if (isThreatExceeded(profile)) {
    return { alive, profile, impossible: true }
  }

  // 狐候補が存在する場合、占いで解決可能な分を差し引いて再判定
  if (profile.possibleSurvivingHamster) {
    const fr = computeFoxResolvability(vs, setup, conclusions, alive)
    if (!fr.resolvable) {
      return { alive, profile, impossible: true }
    }

    // 占いで解決可能な狐候補を引いてプロファイルを調整
    // 解決可能な狐候補: foxWolfCandidates → wolfCandidates に移行
    //                    foxCandidates → 消滅
    const resolved = fr.divinableFoxCandidates
    const unresolved = fr.aliveFoxCandidates - resolved
    // foxWolfCandidates と foxCandidates から解決分を引く
    // まず foxCandidates（純狐候補）から引き、余りを foxWolfCandidates から引く
    const resolvedFromFox = Math.min(resolved, profile.foxCandidates)
    const resolvedFromFoxWolf = resolved - resolvedFromFox
    const adjFoxCandidates = profile.foxCandidates - resolvedFromFox
    const adjFoxWolfCandidates = profile.foxWolfCandidates - resolvedFromFoxWolf
    const adjWolfCandidates = profile.wolfCandidates + resolvedFromFoxWolf
    const adjPossibleHamster = unresolved > 0
    // 背徳者道連れ: 全狐解決時、背徳者が後追いで死亡し alive が減少
    const immoralistFollowDeaths = adjPossibleHamster ? 0
      : Math.min(profile.immoralistCandidates, setup.get('immoralist' as SystemRole) ?? 0)
    const adjEffectiveNawa = (aliveCount - 1 - (adjPossibleHamster ? 1 : 0) - immoralistFollowDeaths) / 2
    const adjNawaInt = adjEffectiveNawa | 0
    const adjRequiredExecs = adjFoxCandidates + Math.min(adjFoxWolfCandidates, 1) + adjWolfCandidates
      - (adjPossibleHamster ? 0 : profile.wolfConfirmedCount)
      + profile.whiteNVThreat
    const adjNekoShift = profile.possibleSurvivingNekomata && adjEffectiveNawa % 1 === 0
    const adjusted: ThreatProfile = {
      ...profile,
      foxCandidates: adjFoxCandidates,
      foxWolfCandidates: adjFoxWolfCandidates,
      wolfCandidates: adjWolfCandidates,
      possibleSurvivingHamster: adjPossibleHamster,
      effectiveNawa: adjEffectiveNawa,
      nawaInt: adjNawaInt,
      requiredExecs: adjRequiredExecs,
      nekoParityShift: adjNekoShift,
    }
    if (isThreatExceeded(adjusted)) {
      return { alive, profile: adjusted, impossible: true }
    }
  }

  return { alive, profile, impossible: false }
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
  const { alive, profile: { nawaInt, possibleSurvivingHamster } } = judgment

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
  if (!searchOptions.disableHamsterPruning && possibleSurvivingHamster) {
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
  const dbg = searchOptions.debug
  const t0 = performance.now()

  // 1. Retar解析
  const conclusions = runRetar(vs, setup, analyzeOptions)
  const t1 = performance.now()

  if (dbg) {
    const aliveSeats: string[] = []
    for (const [seat, status] of vs.statuses) {
      if (!status.surviving) continue
      const mask = conclusions.possibilities[seat]
      const roles: string[] = []
      for (const [role, bit] of Object.entries(RoleSignatureBits)) {
        if (mask & (bit as number)) roles.push(role)
      }
      aliveSeats.push(`${status.name ?? seat}(${seat})=[${roles}]`)
    }
    console.log(`[hati:debug] day=${vs.day} retar=${(t1 - t0).toFixed(1)}ms maxSurvNV=${conclusions.maxSurvivingNV}`)
    console.log(`[hati:debug]   alive: ${aliveSeats.join(' ')}`)
  }

  // 2. 判定フェーズ
  const judgment = judgeTsumi(conclusions, vs, setup)
  const isTsumi = !judgment.impossible
  const t2 = performance.now()

  if (dbg) {
    const p = judgment.profile
    console.log(`[hati:debug]   judgment: impossible=${judgment.impossible} nawa=${p.nawa} effNawa=${p.effectiveNawa} nawaInt=${p.nawaInt}`)
    console.log(`[hati:debug]   wolf=${p.wolfCandidates}(conf=${p.wolfConfirmedCount}) fox=${p.foxCandidates} foxWolf=${p.foxWolfCandidates} whiteNV=${p.whiteNVCandidates}(threat=${p.whiteNVThreat})`)
    console.log(`[hati:debug]   requiredExecs=${p.requiredExecs} hamster=${p.possibleSurvivingHamster} neko=${p.possibleSurvivingNekomata} nekoShift=${p.nekoParityShift} nekoWolfOverlap=${p.nekoWolfCandidates} nekoExecRisk=${p.nekoExecRisk}`)
    console.log(`[hati:debug]   isThreatExceeded: foxWolf+wolf(${p.foxWolfCandidates + p.wolfCandidates})>nawaInt(${p.nawaInt})=${p.foxWolfCandidates + p.wolfCandidates > p.nawaInt} || reqExecs(${p.requiredExecs})>nawaInt=${p.requiredExecs > p.nawaInt} || nekoShift&&req==nawa=${p.nekoParityShift && p.requiredExecs === p.nawaInt}`)

    if (p.possibleSurvivingHamster) {
      const fr = computeFoxResolvability(vs, setup, conclusions, judgment.alive)
      console.log(`[hati:debug]   foxResolvability: setupSeers=${fr.setupSeerCount} deadSeerCand=${fr.deadSeerCandidates} aliveSeerCand=${fr.aliveSeerCandidates} coverable=${fr.coverableAlive} foxCand=${fr.aliveFoxCandidates} divinable=${fr.divinableFoxCandidates} resolvable=${fr.resolvable}`)
    }
  }

  // 戦略構築が不要、または詰み不可能なら探索をスキップ
  if (!isTsumi || searchOptions.buildStrategy === false) {
    if (dbg) console.log(`[hati:debug]   → skip search (isTsumi=${isTsumi} buildStrategy=${searchOptions.buildStrategy})`)
    return {
      isTsumi, strategy: null, judgment,
      stats: {
        worldsTotal: 0, nodesVisited: 0, maxDepth: 0,
        elapsed: t2 - t0, retarElapsed: t1 - t0, enumerateElapsed: 0, searchElapsed: 0,
      },
    }
  }

  // 3. 戦略探索（手順の構築）
  const sr = searchTsumiStrategy(conclusions, judgment, setup, vs.day, searchOptions)
  const elapsed = performance.now() - t0

  if (dbg) {
    console.log(`[hati:debug]   → search: isTsumi=${sr.isTsumi} worlds=${sr.worldsTotal} nodes=${sr.nodesVisited} maxDepth=${sr.maxDepth} search=${sr.searchElapsed.toFixed(1)}ms`)
    console.log(`[hati:debug]   → final: isTsumi=true (hardcoded) strategy=${sr.strategy ? 'yes' : 'null'} total=${elapsed.toFixed(1)}ms`)
  }

  // !! 変更不可: 詰みの可否は判定フェーズ (judgeTsumi) が決定する。
  // !! 探索 (searchTsumiStrategy) は手順構築のみ。探索結果で isTsumi を変えてはならない。
  return {
    isTsumi: true, // This must be true, since searchTsumi() never use deep tree search. THIS IS BY DESIGN.
    strategy: sr.strategy, judgment,
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

  const dummyProfile: ThreatProfile = {
    foxCandidates: 0, foxWolfCandidates: 0, wolfCandidates: 0, wolfConfirmedCount: 0,
    whiteNVCandidates: 0, whiteNVThreat: 0,
    possibleSurvivingHamster: false, possibleSurvivingNekomata: false,
    nawa: 0, effectiveNawa: 0, nawaInt: 0, threat: 0,
    requiredExecs: 0, nekoParityShift: false, nekoWolfCandidates: 0, nekoExecRisk: 0, immoralistCandidates: 0,
  }

  return {
    isTsumi: result !== null,
    strategy: result,
    judgment: { alive: aliveMask, profile: dummyProfile, impossible: result === null },
    stats: {
      worldsTotal: worlds.length, nodesVisited, maxDepth: maxDepthReached,
      elapsed: searchElapsed, retarElapsed: 0, enumerateElapsed: 0, searchElapsed,
    },
  }
}
