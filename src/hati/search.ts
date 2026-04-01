import type { Seat, EnumSpecies } from '../types/index.ts'
import type {
  World, SimState, StrategyNode,
  ObservationKey, SearchOptions, PnDn,
} from './types.ts'
import { hasSeat, removeSeat, forEachSeat, popCount32, PN_INF } from './types.ts'
import {
  checkOutcome, allWorldsVillageWin, anyWorldVillageLoss,
  applyExecution, simulateNight, validBiteTargetsMask,
  obsKeyToString, executionObsKeyToString,
  getMediumResult, applyFollowDeaths,
} from './simulate.ts'
import { RoleBitIndex } from '../retar/possibilities.ts'

/** 村人側role IDセット（数値判定用） */
const VILLAGER_ROLE_IDS: Set<number> = new Set([
  RoleBitIndex.villager, RoleBitIndex.seer, RoleBitIndex.medium,
  RoleBitIndex.bodyguard, RoleBitIndex.mason, RoleBitIndex.nekomata,
])
const NEKOMATA_ROLE_ID = RoleBitIndex.nekomata

/** 戦略木省略時のセンチネル（詰みありを示す軽量値） */
const WIN: StrategyNode = { type: 'win' }

/** 6人以下のエンドゲームテーブル（正規形キー → 詰み可否） */
const endgameTable = new Map<string, boolean>()

/** エンドゲームテーブルのヒット数 */
let endgameHits = 0

/** 統計リセット（テーブルもクリア） */
export function resetEndgameStats(): void { endgameHits = 0; endgameTable.clear() }
export function getEndgameStats(): { size: number, hits: number } {
  return { size: endgameTable.size, hits: endgameHits }
}

const ENDGAME_THRESHOLD = 6

type SearchState = {
  nodesVisited: number
  maxDepthReached: number
  options: SearchOptions
  build: boolean
  memo: Map<string, StrategyNode | null>
}

// --- DFPN (Depth-First Proof Number Search) ---

type DfpnState = {
  nodesVisited: number
  maxDepthReached: number
  options: SearchOptions
  tt: Map<string, PnDn>
  /** 各OR節点で証明された最善手（戦略構築の高速化用） */
  bestMove: Map<string, Seat>
}

const PROVEN: PnDn = { pn: 0, dn: PN_INF }
const DISPROVEN: PnDn = { pn: PN_INF, dn: 0 }

function clampAdd(a: number, b: number): number {
  return a + b >= PN_INF ? PN_INF : a + b
}

/**
 * AND-OR探索の本体。
 * - buildStrategy=true（デフォルト）: DFSで戦略木を構築
 * - buildStrategy=false: DFPNで高速に詰み判定のみ（噛み等価クラス最適化あり）
 */
export function searchTsumi(
  worlds: World[],
  state: SimState,
  options: SearchOptions,
): { result: StrategyNode | null, nodesVisited: number, maxDepthReached: number } {
  if (options.buildStrategy === false) {
    // DFPN proof-only mode
    const ds: DfpnState = {
      nodesVisited: 0, maxDepthReached: 0, options,
      tt: new Map(), bestMove: new Map(),
    }
    const proof = mid(worlds, state, 0, PN_INF, PN_INF, ds)
    return {
      result: proof.pn === 0 ? WIN : null,
      nodesVisited: ds.nodesVisited,
      maxDepthReached: ds.maxDepthReached,
    }
  }

  // DFS strategy construction mode
  const ss: SearchState = {
    nodesVisited: 0, maxDepthReached: 0, options,
    build: true, memo: new Map(),
  }
  const result = isTsumi(worlds, state, 0, ss)
  return {
    result,
    nodesVisited: ss.nodesVisited,
    maxDepthReached: ss.maxDepthReached,
  }
}

// ---------------------------------------------------------------------------
// DFPN 探索関数
// ---------------------------------------------------------------------------

/**
 * DFPN OR節点: 処刑候補から最善手を選択。
 * MID (Multiple Iterative Deepening) ループで証明数が最小の候補を優先展開。
 */
function mid(
  worlds: World[],
  state: SimState,
  depth: number,
  pnThr: number,
  dnThr: number,
  ss: DfpnState,
): PnDn {
  ss.nodesVisited++
  if (depth > ss.maxDepthReached) ss.maxDepthReached = depth

  worlds = deduplicateWorlds(worlds, state.alive)

  // 終端チェック
  if (worlds.length === 0) return PROVEN
  if (allWorldsVillageWin(worlds, state.alive)) return PROVEN
  if (anyWorldVillageLoss(worlds, state.alive)) return DISPROVEN
  if (depth >= ss.options.maxDepth) return DISPROVEN

  // エンドゲームテーブル参照
  const aliveCount = popCount32(state.alive)
  let canonKey: string | undefined
  if (aliveCount <= ENDGAME_THRESHOLD) {
    canonKey = canonicalKey(worlds, state.alive)
    const cached = endgameTable.get(canonKey)
    if (cached !== undefined) {
      endgameHits++
      return cached ? PROVEN : DISPROVEN
    }
  }

  // TT参照
  const key = memoKey(worlds, state.alive)
  const ttEntry = ss.tt.get(key)
  if (ttEntry) {
    if (ttEntry.pn === 0 || ttEntry.dn === 0) return ttEntry
    if (ttEntry.pn >= pnThr || ttEntry.dn >= dnThr) return ttEntry
  }

  // 事前チェック
  const precheck = precheckWorlds(worlds, state.alive, ss.options.disableHamsterPruning)
  if (precheck >= 0) {
    ss.tt.set(key, PROVEN)
    if (canonKey !== undefined) endgameTable.set(canonKey, true)
    return PROVEN
  }
  if (precheck === PRECHECK_PRUNED) {
    ss.tt.set(key, DISPROVEN)
    if (canonKey !== undefined) endgameTable.set(canonKey, false)
    return DISPROVEN
  }

  // OR: 処刑候補
  const candidates = getExecutionCandidates(worlds, state.alive)
  if (candidates.length === 0) {
    ss.tt.set(key, DISPROVEN)
    if (canonKey !== undefined) endgameTable.set(canonKey, false)
    return DISPROVEN
  }

  // 狼カウントで初期ソート（証明しやすい候補を先に）
  const wolfCounts = new Uint16Array(32)
  for (const w of worlds) {
    let mask = w.wolfMask & state.alive
    while (mask !== 0) {
      const bit = mask & (-mask)
      wolfCounts[31 - Math.clz32(bit)]++
      mask ^= bit
    }
  }
  candidates.sort((a, b) => wolfCounts[b] - wolfCounts[a])

  const childPnDn: PnDn[] = new Array(candidates.length)
  for (let i = 0; i < candidates.length; i++) childPnDn[i] = { pn: 1, dn: 1 }

  // MID ループ
  while (true) {
    // OR集約: pn=min, dn=sum
    let bestIdx = 0
    let bestPn = childPnDn[0].pn
    let secondPn = PN_INF
    let nodeDn = 0

    for (let i = 0; i < candidates.length; i++) {
      const cpn = childPnDn[i].pn
      if (cpn < bestPn) {
        secondPn = bestPn
        bestPn = cpn
        bestIdx = i
      } else if (cpn < secondPn) {
        secondPn = cpn
      }
      nodeDn = clampAdd(nodeDn, childPnDn[i].dn)
    }

    // 閾値チェック
    if (bestPn >= pnThr || nodeDn >= dnThr) {
      const result: PnDn = { pn: bestPn, dn: nodeDn }
      ss.tt.set(key, result)
      if (bestPn === 0) {
        ss.bestMove.set(key, candidates[bestIdx])
        if (canonKey !== undefined) endgameTable.set(canonKey, true)
      }
      if (nodeDn === 0 && canonKey !== undefined) endgameTable.set(canonKey, false)
      return result
    }

    // 最善候補を展開
    const cPnThr = Math.min(pnThr, clampAdd(secondPn, 1))
    const cDnThr = clampAdd(dnThr - nodeDn, childPnDn[bestIdx].dn)

    childPnDn[bestIdx] = dfpnExecution(
      worlds, state, candidates[bestIdx], depth,
      cPnThr, cDnThr, ss,
    )
  }
}

/**
 * DFPN AND節点: 処刑後の観測分岐。
 * 全観測分岐で詰みを証明する必要がある。
 */
function dfpnExecution(
  worlds: World[],
  state: SimState,
  target: Seat,
  depth: number,
  pnThr: number,
  dnThr: number,
  ss: DfpnState,
): PnDn {
  const afterExecAlive = applyExecution(state.alive, target)
  const obsGroups = partitionWorldsByExecution(worlds, afterExecAlive, target)

  // 終端判定 & 非終端子ノード収集
  const children: { worlds: World[], alive: number }[] = []
  for (const [, group] of obsGroups) {
    if (allWorldsVillageWin(group.worlds, group.alive)) continue
    if (anyWorldVillageLoss(group.worlds, group.alive)) return DISPROVEN
    children.push(group)
  }
  if (children.length === 0) return PROVEN

  const childPnDn: PnDn[] = new Array(children.length)
  for (let i = 0; i < children.length; i++) childPnDn[i] = { pn: 1, dn: 1 }

  // AND MIDループ: pn=sum, dn=min
  while (true) {
    let bestIdx = 0
    let bestDn = childPnDn[0].dn
    let secondDn = PN_INF
    let nodePn = 0

    for (let i = 0; i < children.length; i++) {
      const cdn = childPnDn[i].dn
      if (cdn < bestDn) {
        secondDn = bestDn
        bestDn = cdn
        bestIdx = i
      } else if (cdn < secondDn) {
        secondDn = cdn
      }
      nodePn = clampAdd(nodePn, childPnDn[i].pn)
    }

    if (nodePn >= pnThr || bestDn >= dnThr) return { pn: nodePn, dn: bestDn }

    const cDnThr = Math.min(dnThr, clampAdd(secondDn, 1))
    const cPnThr = clampAdd(pnThr - nodePn, childPnDn[bestIdx].pn)
    const c = children[bestIdx]

    childPnDn[bestIdx] = dfpnNight(
      c.worlds, c.alive, state.day, depth,
      cPnThr, cDnThr, ss,
    )
  }
}

/**
 * DFPN OR節点: 夜行動（護衛先×占い先）の選択。
 */
function dfpnNight(
  worlds: World[],
  alive: number,
  day: number,
  depth: number,
  pnThr: number,
  dnThr: number,
  ss: DfpnState,
): PnDn {
  const bgCandidates = getBodyguardCandidates(worlds, alive)
  const seerCandidates = getSeerCandidates(worlds, alive)
  let maxSeerCount = 0
  for (const w of worlds) {
    const c = popCount32(w.seerMask & alive)
    if (c > maxSeerCount) maxSeerCount = c
  }

  // 全夜行動を列挙
  const actions: { bg: Seat | null, seerTargets: Seat[] }[] = []
  for (const bg of bgCandidates) {
    const combos = enumerateSeerTargetCombos(seerCandidates, maxSeerCount)
    for (const st of combos) actions.push({ bg, seerTargets: st })
  }
  if (actions.length === 0) return DISPROVEN

  const childPnDn: PnDn[] = new Array(actions.length)
  for (let i = 0; i < actions.length; i++) childPnDn[i] = { pn: 1, dn: 1 }

  // OR MIDループ
  while (true) {
    let bestIdx = 0
    let bestPn = childPnDn[0].pn
    let secondPn = PN_INF
    let nodeDn = 0

    for (let i = 0; i < actions.length; i++) {
      const cpn = childPnDn[i].pn
      if (cpn < bestPn) {
        secondPn = bestPn
        bestPn = cpn
        bestIdx = i
      } else if (cpn < secondPn) {
        secondPn = cpn
      }
      nodeDn = clampAdd(nodeDn, childPnDn[i].dn)
    }

    if (bestPn >= pnThr || nodeDn >= dnThr) return { pn: bestPn, dn: nodeDn }

    const cPnThr = Math.min(pnThr, clampAdd(secondPn, 1))
    const cDnThr = clampAdd(dnThr - nodeDn, childPnDn[bestIdx].dn)
    const a = actions[bestIdx]

    childPnDn[bestIdx] = dfpnNightAction(
      worlds, alive, day, a.bg, a.seerTargets, depth,
      cPnThr, cDnThr, ss,
    )
  }
}

/**
 * DFPN AND節点: 夜の観測分岐（狼の噛み先選択）。
 * 噛み先等価クラスで分岐を削減。
 */
function dfpnNightAction(
  worlds: World[],
  alive: number,
  day: number,
  bodyguardTarget: Seat | null,
  seerTargets: Seat[],
  depth: number,
  pnThr: number,
  dnThr: number,
  ss: DfpnState,
): PnDn {
  // 噛み先等価クラス
  const biteRepMask = computeBiteRepMask(worlds, alive)

  // 観測グループ構築
  const possibleByObs = new Map<number, { worlds: World[], alive: number }>()

  for (const world of worlds) {
    const biteMask = validBiteTargetsMask(world, alive) & biteRepMask
    if (biteMask === 0) {
      const group = possibleByObs.get(0)
      if (group) group.worlds.push(world)
      else possibleByObs.set(0, { worlds: [world], alive })
      continue
    }

    let remainBite = biteMask
    while (remainBite !== 0) {
      const biteBit = remainBite & (-remainBite)
      const biteTarget = 31 - Math.clz32(biteBit)
      remainBite ^= biteBit

      const { nextAlive: baseAlive, obsKey: baseKey } = simulateNight(
        world, alive, biteTarget, bodyguardTarget, seerTargets,
      )

      const isNekoBite = world.roleIds[biteTarget] === NEKOMATA_ROLE_ID
        && hasSeat(alive, biteTarget)
        && (bodyguardTarget !== biteTarget || !hasSeat(alive, world.bodyguardSeat))
      const curseWolfMask = isNekoBite ? (world.wolfMask & baseAlive) : 0

      if (curseWolfMask === 0) {
        const outcome = checkOutcome(world, baseAlive)
        if (outcome === 'wolf_win' || outcome === 'hamster_win') return DISPROVEN
        const group = possibleByObs.get(baseKey)
        if (group) { if (!group.worlds.includes(world)) group.worlds.push(world) }
        else possibleByObs.set(baseKey, { worlds: [world], alive: baseAlive })
      } else {
        const seerShift = popCount32(world.seerMask) * 2
        let wolfBits = curseWolfMask
        while (wolfBits !== 0) {
          const wolfBit = wolfBits & (-wolfBits)
          wolfBits ^= wolfBit
          const curseWolf = 31 - Math.clz32(wolfBit)
          const nextAlive = removeSeat(baseAlive, curseWolf)
          const numKey = baseKey | ((1 << curseWolf) << seerShift)
          const outcome = checkOutcome(world, nextAlive)
          if (outcome === 'wolf_win' || outcome === 'hamster_win') return DISPROVEN
          const group = possibleByObs.get(numKey)
          if (group) { if (!group.worlds.includes(world)) group.worlds.push(world) }
          else possibleByObs.set(numKey, { worlds: [world], alive: nextAlive })
        }
      }
    }
  }

  // 終端判定 & 非終端子ノード収集
  const children: { worlds: World[], alive: number }[] = []
  for (const [, group] of possibleByObs) {
    if (allWorldsVillageWin(group.worlds, group.alive)) continue
    if (anyWorldVillageLoss(group.worlds, group.alive)) return DISPROVEN
    children.push(group)
  }
  if (children.length === 0) return PROVEN

  const childPnDn: PnDn[] = new Array(children.length)
  for (let i = 0; i < children.length; i++) childPnDn[i] = { pn: 1, dn: 1 }

  // AND MIDループ
  while (true) {
    let bestIdx = 0
    let bestDn = childPnDn[0].dn
    let secondDn = PN_INF
    let nodePn = 0

    for (let i = 0; i < children.length; i++) {
      const cdn = childPnDn[i].dn
      if (cdn < bestDn) {
        secondDn = bestDn
        bestDn = cdn
        bestIdx = i
      } else if (cdn < secondDn) {
        secondDn = cdn
      }
      nodePn = clampAdd(nodePn, childPnDn[i].pn)
    }

    if (nodePn >= pnThr || bestDn >= dnThr) return { pn: nodePn, dn: bestDn }

    const cDnThr = Math.min(dnThr, clampAdd(secondDn, 1))
    const cPnThr = clampAdd(pnThr - nodePn, childPnDn[bestIdx].pn)
    const c = children[bestIdx]
    const nextState: SimState = { alive: c.alive, day: day + 1 }

    childPnDn[bestIdx] = mid(
      c.worlds, nextState, depth + 1,
      cPnThr, cDnThr, ss,
    )
  }
}

/**
 * 噛み先等価クラスの代表席マスクを計算。
 * 全ワールドで同じroleIdの席は同型の部分木を生むため、代表1つだけ残す。
 */
function computeBiteRepMask(worlds: World[], alive: number): number {
  let biteRepMask = 0
  const seen = new Set<number>()
  let mask = alive
  while (mask !== 0) {
    const bit = mask & (-mask)
    const seat = 31 - Math.clz32(bit)
    mask ^= bit
    let alwaysWolf = true
    for (let wi = 0; wi < worlds.length; wi++) {
      if (!hasSeat(worlds[wi].wolfMask, seat)) { alwaysWolf = false; break }
    }
    if (alwaysWolf) { biteRepMask |= bit; continue }
    let h = 0x811c9dc5
    for (let wi = 0; wi < worlds.length; wi++) {
      h ^= worlds[wi].roleIds[seat]
      h = Math.imul(h, 0x01000193)
    }
    h = h >>> 0
    if (!seen.has(h)) {
      seen.add(h)
      biteRepMask |= bit
    }
  }
  return biteRepMask
}

// ---------------------------------------------------------------------------
// 共有ヘルパー
// ---------------------------------------------------------------------------

/**
 * 数値ハッシュベースのメモ化キー。
 * alive はビットマスクそのまま、ワールドは役職IDハッシュの組み合わせ。
 * ワールドハッシュをソートして単一数値に畳み込み → `alive|hash` で文字列キー化。
 */
function memoKey(worlds: World[], alive: number): string {
  const worldHashes: number[] = new Array(worlds.length)
  for (let wi = 0; wi < worlds.length; wi++) {
    let h = 0x811c9dc5
    const ids = worlds[wi].roleIds
    let mask = alive
    while (mask !== 0) {
      const bit = mask & (-mask)
      const seat = 31 - Math.clz32(bit)
      h ^= ids[seat]
      h = Math.imul(h, 0x01000193)
      mask ^= bit
    }
    worldHashes[wi] = h >>> 0
  }
  worldHashes.sort()
  // ソート済みハッシュを単一数値に畳み込み
  let combined = 0x811c9dc5
  for (let i = 0; i < worldHashes.length; i++) {
    combined ^= worldHashes[i]
    combined = Math.imul(combined, 0x01000193)
  }
  return `${alive}|${combined >>> 0}`
}

/**
 * 再帰的なAND-OR探索
 */
function isTsumi(
  worlds: World[],
  state: SimState,
  depth: number,
  ss: SearchState,
): StrategyNode | null {
  ss.nodesVisited++
  if (depth > ss.maxDepthReached) ss.maxDepthReached = depth

  // ワールド縮約: 生存者の役職が同一のワールドを統合
  worlds = deduplicateWorlds(worlds, state.alive)

  // 終端チェック
  if (worlds.length === 0) return WIN
  if (allWorldsVillageWin(worlds, state.alive)) return WIN
  if (anyWorldVillageLoss(worlds, state.alive)) return null
  if (depth >= ss.options.maxDepth) return null

  // エンドゲームテーブル参照（≤6人: seat番号に依存しない正規形キーで検索）
  const aliveCount = popCount32(state.alive)
  let canonKey: string | undefined
  if (aliveCount <= ENDGAME_THRESHOLD) {
    canonKey = canonicalKey(worlds, state.alive)
    const cached = endgameTable.get(canonKey)
    if (cached !== undefined) {
      endgameHits++
      // テーブルは詰み可否のみ保持。不成功ならnull、成功ならフォールスルーして戦略構築。
      if (!cached) return null
    }
  }

  // メモ化チェック（seat番号依存、同一探索内キャッシュ）
  const key = memoKey(worlds, state.alive)
  if (ss.memo.has(key)) return ss.memo.get(key)!

  // 統合事前チェック: 自明詰み / パリティ / 狼候補数
  const precheck = precheckWorlds(worlds, state.alive, ss.options.disableHamsterPruning)
  if (precheck >= 0) {
    // 自明な詰み: seat = precheck を処刑して即勝ち
    const result: StrategyNode = {
      type: 'action',
      action: { execute: precheck, bodyguardTarget: null, seerTargets: [] },
      branches: { 'win': WIN },
    }
    ss.memo.set(key, result)
    return result
  }
  if (precheck === PRECHECK_PRUNED) {
    ss.memo.set(key, null)
    return null
  }

  // 各処刑候補を試す（OR節点）
  // ムーブオーダリング: 狼である可能性が高い候補を先に試す（●→即勝ちの確率UP）
  // #8: 一括で狼カウントを計算
  const candidates = getExecutionCandidates(worlds, state.alive)
  const wolfCounts = new Uint16Array(32)
  for (const w of worlds) {
    const wolvesAlive = w.wolfMask & state.alive
    let mask = wolvesAlive
    while (mask !== 0) {
      const bit = mask & (-mask)
      wolfCounts[31 - Math.clz32(bit)]++
      mask ^= bit
    }
  }
  candidates.sort((a, b) => wolfCounts[b] - wolfCounts[a])

  for (const target of candidates) {
    const result = tryExecution(worlds, state, target, depth, ss)
    if (result !== null) {
      ss.memo.set(key, result)
      if (canonKey !== undefined) endgameTable.set(canonKey, true)
      return result
    }
  }

  ss.memo.set(key, null)
  if (canonKey !== undefined) endgameTable.set(canonKey, false)
  return null
}

/**
 * 生存者の役職配置が同一のワールドを統合する。
 * 死亡者の役職は探索に影響しないため、生存者部分のみで等価判定。
 * #2: Set<number> を使用（文字列変換不要）
 */
function deduplicateWorlds(worlds: World[], alive: number): World[] {
  if (worlds.length <= 1) return worlds
  const seen = new Set<number>()
  const result: World[] = []
  for (const w of worlds) {
    // 生存者の役職IDのみでハッシュキーを構築
    let h = 0x811c9dc5
    const ids = w.roleIds
    let mask = alive
    while (mask !== 0) {
      const bit = mask & (-mask)
      const seat = 31 - Math.clz32(bit)
      h ^= ids[seat]
      h = Math.imul(h, 0x01000193)
      h ^= seat
      h = Math.imul(h, 0x01000193)
      mask ^= bit
    }
    const key = h >>> 0
    if (!seen.has(key)) {
      seen.add(key)
      result.push(w)
    }
  }
  return result
}

/**
 * エンドゲームテーブル用の正規形キー。
 * seat番号に依存せず、各ワールドの生存者役職パターン（ソート済み）で構成。
 * 重複ワールドは除去。
 * #3: 数値ID配列でソート → 数値パック化
 */
function canonicalKey(worlds: World[], alive: number): string {
  const aliveCount = popCount32(alive)
  const tuples: string[] = []
  // 再利用バッファ
  const buf = new Uint8Array(aliveCount)
  for (const w of worlds) {
    let idx = 0
    let mask = alive
    while (mask !== 0) {
      const bit = mask & (-mask)
      buf[idx++] = w.roleIds[31 - Math.clz32(bit)]
      mask ^= bit
    }
    buf.sort()
    // Uint8Array → 軽量文字列化
    let s = ''
    for (let i = 0; i < aliveCount; i++) {
      if (i > 0) s += ','
      s += buf[i]
    }
    tuples.push(s)
  }
  tuples.sort()
  return tuples.join('|')
}

/**
 * 全分岐が同じ trivial win に帰着する場合、夜分岐を圧縮。
 */
function collapseBranches(
  branches: Record<ObservationKey, StrategyNode>,
  bodyguardTarget: Seat | null,
  seerTargets: Seat[],
): StrategyNode | null {
  const values = Object.values(branches)
  if (values.length === 0) return null
  if (values.every(v => v.type === 'win')) return { type: 'win' }

  let commonTarget: Seat | undefined
  for (const v of values) {
    if (v.type !== 'action') return null
    const keys = Object.keys(v.branches)
    if (keys.length !== 1 || keys[0] !== 'win') return null
    if (v.action.execute === -1) return null
    if (commonTarget === undefined) {
      commonTarget = v.action.execute
    } else if (commonTarget !== v.action.execute) {
      return null
    }
  }

  // 夜行動（占い/護衛）がある場合は collapse しない
  // （呪殺がゲーム状態に影響し、検証で再現が必要なため）
  if (seerTargets.length > 0 || bodyguardTarget !== null) return null

  return {
    type: 'action',
    action: { execute: commonTarget!, bodyguardTarget: null, seerTargets: [] },
    branches: { 'win': { type: 'win' } },
  }
}

/**
 * 統合事前チェック: 自明詰み / パリティ / 狼候補数。
 * ワールドを1回だけ走査して3つの判定を行う。
 *
 * @returns >= 0: 自明詰みの処刑先seat, -1: 枝刈り(詰み不可能), -2: 探索続行
 */
/**
 * 狐枝刈り判定（共通ロジック）。
 *
 * 狐候補を村が処理しきれるかを判定する。
 * - 吊りcoverage: 狐候補かつ全ワールド非狼の席のみ安全に吊れる
 * - 占いcoverage: 占い師の確定・狩人生存で決まる保証占い回数
 *   - 占い確定 + 狩人生存: 2回（狼は狩人→占い師の順で噛む。呪殺は噛み前に発動するので占った夜は有効）
 *   - 占い確定 + 狩人なし: 1回（狼が占い師を噛むが、その夜の呪殺は有効）
 *   - 占い非確定: 0回（誰が占い師か不明なので保証できない）
 * - 消去法: +1
 *
 * @returns true なら狐候補が多すぎて詰みは不可能（枝刈りすべき）
 */
export function shouldPruneHamster(
  hamsterCandidates: number,
  wolfCandidates: number,
  safeToExecute: number,
  nawa: number,
  confirmedSeerAlive: boolean,
  bodyguardAlive: boolean,
): boolean {
  const executionCoverage = Math.min(safeToExecute, Math.max(0, nawa - wolfCandidates))
  const divinationCoverage = confirmedSeerAlive ? (bodyguardAlive ? 2 : 1) : 0
  const coverage = executionCoverage + divinationCoverage + 1
  return hamsterCandidates > coverage
}

const PRECHECK_PRUNED = -1
const PRECHECK_CONTINUE = -2

export function precheckWorlds(worlds: World[], alive: number, disableHamsterPruning?: boolean): number {
  const aliveCount = popCount32(alive)
  let wolfUnion = 0
  let wolfIntersection = 0
  let hamsterUnion = 0
  let hasAliveHamster = false

  for (let i = 0; i < worlds.length; i++) {
    const w = worlds[i]
    const wolvesAlive = w.wolfMask & alive
    wolfUnion |= wolvesAlive
    if (i === 0) wolfIntersection = wolvesAlive
    else wolfIntersection &= wolvesAlive
    const wolfCount = popCount32(wolvesAlive)
    let nonWolfNonHamster = aliveCount - wolfCount
    const aliveHamsters = w.hamsterMask & alive
    if (aliveHamsters !== 0) {
      nonWolfNonHamster -= popCount32(aliveHamsters)
      hasAliveHamster = true
      hamsterUnion |= aliveHamsters
    }
    // パリティチェック（per-world）
    if (wolfCount >= nonWolfNonHamster) return PRECHECK_PRUNED
  }

  // 自明な詰み: 狼候補が1人 & 妖狐なし → 即処刑で勝ち
  if (!hasAliveHamster && popCount32(wolfUnion) === 1) {
    return 31 - Math.clz32(wolfUnion)
  }

  // 枝刈り用縄数 = floor((alive - 1 - hamster) / 2)
  // 狼命中は縄を消費しない（gap±0）、空振りは縄-1（gap-2→処刑1回分）
  // よってwolfCountに依存せず、alive人数のみで決まる
  const nawaInt = (aliveCount - 1 - (hasAliveHamster ? 1 : 0)) >> 1
  // 基本チェック: 狼候補数 > 縄数（foxAndWolfが多い局面に有効）
  if (popCount32(wolfUnion) > nawaInt) return PRECHECK_PRUNED
  // 精緻チェック: 狐のみ/狐狼兼/狼のみに分解し、確定狼と狐最大1匹を考慮
  const confirmedWolves = popCount32(wolfIntersection)
  const foxOnly = popCount32(hamsterUnion & ~wolfUnion)
  const foxAndWolf = popCount32(hamsterUnion & wolfUnion)
  const wolfOnly = popCount32(wolfUnion & ~hamsterUnion)
  const threat = foxOnly + Math.min(foxAndWolf, 1) + wolfOnly - confirmedWolves
  if (threat > nawaInt) return PRECHECK_PRUNED

  return PRECHECK_CONTINUE
}

/**
 * 処刑候補の列挙（枝刈り込み）
 * #4: isConfirmedVillagerInAllWorlds を数値ID版で判定
 * #7: roleIds で等価クラスハッシュ
 */
function getExecutionCandidates(worlds: World[], alive: number): Seat[] {
  const candidates: Seat[] = []
  const seen = new Set<number>()

  // 狐生存時は確定村吊り（時間稼ぎ）が有効戦略になりうる
  const hasAliveHamster = worlds.some(w => (w.hamsterMask & alive) !== 0)
  let addedVillagerRep = false

  forEachSeat(alive, seat => {
    // #4: 数値IDで村人確定判定（Set再生成不要）
    let isVillager = true
    for (const w of worlds) {
      if (!VILLAGER_ROLE_IDS.has(w.roleIds[seat])) { isVillager = false; break }
    }
    if (isVillager) {
      if (!hasAliveHamster) return
      // 狐生存時: 確定村は等価なので代表1人だけ候補に追加
      if (addedVillagerRep) return
      addedVillagerRep = true
      candidates.push(seat)
      return
    }

    // 等価クラス: 全ワールドでの役職IDハッシュが同一なら1つだけ試す
    let h = 0x811c9dc5
    for (const w of worlds) {
      h ^= w.roleIds[seat]
      h = Math.imul(h, 0x01000193)
    }
    h = h >>> 0
    if (seen.has(h)) return
    seen.add(h)

    candidates.push(seat)
  })

  return candidates
}

/**
 * 特定のseatを処刑した場合の分岐探索
 */
function tryExecution(
  worlds: World[],
  state: SimState,
  target: Seat,
  depth: number,
  ss: SearchState,
): StrategyNode | null {
  const afterExecAlive = applyExecution(state.alive, target)

  const obsGroups = partitionWorldsByExecution(worlds, afterExecAlive, target)

  // ムーブオーダリング: ワールド数が多い分岐を先に（AND節点の早期打ち切り）
  // 注: この関数は戦略構築(build=true)専用。判定のみのパスはDFPNが担当。
  const sortedExecObs = [...obsGroups.entries()]
    .sort((a, b) => b[1].worlds.length - a[1].worlds.length)

  const branches = {} as Record<ObservationKey, StrategyNode>

  for (const [obsKey, group] of sortedExecObs) {
    const { worlds: groupWorlds, alive: groupAlive } = group

    if (allWorldsVillageWin(groupWorlds, groupAlive)) {
      branches[obsKey] = WIN
      continue
    }
    if (anyWorldVillageLoss(groupWorlds, groupAlive)) {
      return null
    }

    const nightResult = searchNight(groupWorlds, groupAlive, state.day, depth, ss)
    if (nightResult === null) return null
    branches[obsKey] = nightResult
  }

  return {
    type: 'action',
    action: { execute: target, bodyguardTarget: null, seerTargets: [] },
    branches,
  }
}

/**
 * ワールドを処刑後の観測で分割
 * #7: roleIds で猫又判定
 */
function partitionWorldsByExecution(
  worlds: World[],
  aliveAfterExec: number,
  target: Seat,
): Map<ObservationKey, { worlds: World[], alive: number }> {
  const byMedium = new Map<string, World[]>()
  for (const w of worlds) {
    const medium = getMediumResult(w.roles[target])
    const key = medium ?? 'null'
    if (!byMedium.has(key)) byMedium.set(key, [])
    byMedium.get(key)!.push(w)
  }

  const result = new Map<ObservationKey, { worlds: World[], alive: number }>()

  for (const [mediumKey, mediumWorlds] of byMedium) {
    const mediumResult = mediumKey === 'null' ? null : mediumKey as EnumSpecies

    const hasNekomata = mediumWorlds.some(w => w.roleIds[target] === NEKOMATA_ROLE_ID)
    const hasNonNekomata = mediumWorlds.some(w => w.roleIds[target] !== NEKOMATA_ROLE_ID)

    if (!hasNekomata) {
      const obsKey = executionObsKeyToString(mediumResult, null)
      addToPartition(result, obsKey, mediumWorlds, aliveAfterExec)
    } else if (!hasNonNekomata) {
      forEachSeat(aliveAfterExec, curseTarget => {
        const aliveAfterCurse = removeSeat(aliveAfterExec, curseTarget)
        const obsKey = executionObsKeyToString(mediumResult, curseTarget)
        addToPartition(result, obsKey, mediumWorlds, aliveAfterCurse)
      })
    } else {
      const nekoWorlds = mediumWorlds.filter(w => w.roleIds[target] === NEKOMATA_ROLE_ID)
      const nonNekoWorlds = mediumWorlds.filter(w => w.roleIds[target] !== NEKOMATA_ROLE_ID)

      const obsKey = executionObsKeyToString(mediumResult, null)
      addToPartition(result, obsKey, nonNekoWorlds, aliveAfterExec)

      forEachSeat(aliveAfterExec, curseTarget => {
        const aliveAfterCurse = removeSeat(aliveAfterExec, curseTarget)
        const nekoObsKey = executionObsKeyToString(mediumResult, curseTarget)
        addToPartition(result, nekoObsKey, nekoWorlds, aliveAfterCurse)
      })
    }
  }

  // 後追い死亡の適用: 狐処刑時に背徳者が死ぬ（観測可能）
  // 同じ霊能分岐内でも後追い有無で alive が異なるため、グループを分割する
  const finalResult = new Map<ObservationKey, { worlds: World[], alive: number }>()
  for (const [obsKey, group] of result) {
    const byAlive = new Map<number, World[]>()
    for (const w of group.worlds) {
      const a = applyFollowDeaths(group.alive, w)
      const existing = byAlive.get(a)
      if (existing) existing.push(w)
      else byAlive.set(a, [w])
    }
    if (byAlive.size === 1) {
      const [alive, worlds] = [...byAlive.entries()][0]
      finalResult.set(obsKey, { worlds, alive })
    } else {
      for (const [alive, worlds] of byAlive) {
        const followDead = group.alive & ~alive
        const suffix = followDead !== 0 ? `+f:${31 - Math.clz32(followDead & (-followDead))}` : ''
        finalResult.set((obsKey + suffix) as ObservationKey, { worlds, alive })
      }
    }
  }

  return finalResult
}

function addToPartition(
  partition: Map<ObservationKey, { worlds: World[], alive: number }>,
  obsKey: ObservationKey, worlds: World[], alive: number,
): void {
  const existing = partition.get(obsKey)
  if (existing) {
    existing.worlds.push(...worlds)
  } else {
    partition.set(obsKey, { worlds: [...worlds], alive })
  }
}

/**
 * 夜フェーズの探索。
 * 複数占い師がいる場合、N人分の占い先の組み合わせを試す。
 */
function searchNight(
  worlds: World[],
  alive: number,
  day: number,
  depth: number,
  ss: SearchState,
): StrategyNode | null {
  const bodyguardCandidates = getBodyguardCandidates(worlds, alive)
  const seerCandidates = getSeerCandidates(worlds, alive)

  // 占い師の最大人数（ワールド間の最大値）
  let maxSeerCount = 0
  for (const w of worlds) {
    const c = popCount32(w.seerMask & alive)
    if (c > maxSeerCount) maxSeerCount = c
  }

  for (const bgTarget of bodyguardCandidates) {
    // 占い先の組み合わせを列挙（N人分）
    const seerTargetCombos = enumerateSeerTargetCombos(seerCandidates, maxSeerCount)
    for (const seerTargets of seerTargetCombos) {
      const result = tryNightAction(worlds, alive, day, bgTarget, seerTargets, depth, ss)
      if (result !== null) return result
    }
  }

  return null
}

/**
 * 占い先の組み合わせを列挙。
 * seerTargets[i] は i 番目の占い師（seerMask低ビット順）の占い先。
 * candidates の null は「占い指示なし」を表す → seerTargets では含めない（配列が短くなる）。
 *
 * N=0: [[]] (占い師なし)
 * N=1: [[], [c1], [c2], ...] (null→[], seat→[seat])
 * N=2: [[], [c1], ..., [c1,c1], [c1,c2], ...] (直積)
 */
function enumerateSeerTargetCombos(candidates: (Seat | null)[], count: number): Seat[][] {
  if (count === 0) return [[]]
  const result: Seat[][] = []
  const current: Seat[] = new Array(count)

  function recurse(idx: number): void {
    if (idx === count) {
      result.push(current.slice())
      return
    }
    for (const c of candidates) {
      if (c === null) {
        // 指示なし: この占い師以降は全員占わない
        result.push(current.slice(0, idx))
        continue
      }
      current[idx] = c
      recurse(idx + 1)
    }
  }
  recurse(0)
  return result
}

/**
 * #7: roleIds で等価クラスハッシュ
 */
function getBodyguardCandidates(worlds: World[], alive: number): (Seat | null)[] {
  const hasAliveBodyguard = worlds.some(w => w.bodyguardSeat !== -1 && hasSeat(alive, w.bodyguardSeat))
  if (!hasAliveBodyguard) return [null]

  const candidates: (Seat | null)[] = [null]
  const seen = new Set<number>()
  forEachSeat(alive, seat => {
    // 全ワールドで狼確定の席は護衛しても無意味
    if (worlds.every(w => hasSeat(w.wolfMask, seat))) return
    // 等価クラス: 護衛先の役職IDパターンが同一なら1つだけ
    let h = 0x811c9dc5
    for (const w of worlds) {
      h ^= w.roleIds[seat]
      h = Math.imul(h, 0x01000193)
    }
    h = h >>> 0
    if (seen.has(h)) return
    seen.add(h)
    candidates.push(seat)
  })
  return candidates
}

/**
 * #7: roleIds で等価クラスハッシュ + 情報ゲイン判定
 */
function getSeerCandidates(worlds: World[], alive: number): (Seat | null)[] {
  const hasAliveSeer = worlds.some(w => (w.seerMask & alive) !== 0)
  if (!hasAliveSeer) return [null]

  const candidates: (Seat | null)[] = [null]
  const seen = new Set<number>()
  forEachSeat(alive, seat => {
    // 全ワールドで同じ役職 → 情報ゲインなし → スキップ
    if (worlds.length > 1) {
      const firstId = worlds[0].roleIds[seat]
      let allSame = true
      for (let i = 1; i < worlds.length; i++) {
        if (worlds[i].roleIds[seat] !== firstId) { allSame = false; break }
      }
      if (allSame) return
    }
    // 等価クラス
    let h = 0x811c9dc5
    for (const w of worlds) {
      h ^= w.roleIds[seat]
      h = Math.imul(h, 0x01000193)
    }
    h = h >>> 0
    if (seen.has(h)) return
    seen.add(h)
    candidates.push(seat)
  })
  return candidates
}

/**
 * 特定の護衛先・占い先での夜の探索。
 * #5: Set<World> → 配列 + includes重複チェック
 * #6: validBiteTargetsMask でビットマスク直接操作（配列alloc削減）
 */
function tryNightAction(
  worlds: World[],
  alive: number,
  day: number,
  bodyguardTarget: Seat | null,
  seerTargets: Seat[],
  depth: number,
  ss: SearchState,
): StrategyNode | null {
  // 数値キーでグルーピング（高速）
  // 注: この関数は戦略��築(build=true)専用。判定のみのパスはDFPNが担当。
  const possibleByObs = new Map<number, { worlds: World[], alive: number }>()

  for (const world of worlds) {
    // #6: ビットマスクで噛み先を列挙（配列alloc不要）
    const biteMask = validBiteTargetsMask(world, alive)
    if (biteMask === 0) {
      const numKey = 0
      const group = possibleByObs.get(numKey)
      if (group) {
        group.worlds.push(world)
      } else {
        possibleByObs.set(numKey, { worlds: [world], alive })
      }
      continue
    }

    let remainBite = biteMask
    while (remainBite !== 0) {
      const biteBit = remainBite & (-remainBite)
      const biteTarget = 31 - Math.clz32(biteBit)
      remainBite ^= biteBit

      const { nextAlive: baseAlive, obsKey: baseKey } = simulateNight(
        world, alive, biteTarget, bodyguardTarget, seerTargets,
      )

      // 猫又噛みチェック: 道連れ狼を全生存狼に対して分岐（AND節点）
      const isNekoBite = world.roleIds[biteTarget] === NEKOMATA_ROLE_ID
        && hasSeat(alive, biteTarget)
        && (bodyguardTarget !== biteTarget || !hasSeat(alive, world.bodyguardSeat))
      const curseWolfMask = isNekoBite ? (world.wolfMask & baseAlive) : 0

      if (curseWolfMask === 0) {
        // 通常噛み or 猫又以外 or 護衛成功 or 狼全滅
        const outcome = checkOutcome(world, baseAlive)
        if (outcome === 'wolf_win' || outcome === 'hamster_win') return null
        const group = possibleByObs.get(baseKey)
        if (group) {
          if (!group.worlds.includes(world)) group.worlds.push(world)
        } else {
          possibleByObs.set(baseKey, { worlds: [world], alive: baseAlive })
        }
      } else {
        // 猫又噛み: 各生存狼が道連れ対象（狼が選択するAND分岐）
        // obsKey に道連れ狼の死亡を反映: deathMask は seerCount*2 ビットシフトされている
        const seerShift = popCount32(world.seerMask) * 2
        let wolfBits = curseWolfMask
        while (wolfBits !== 0) {
          const wolfBit = wolfBits & (-wolfBits)
          wolfBits ^= wolfBit
          const curseWolf = 31 - Math.clz32(wolfBit)
          const nextAlive = removeSeat(baseAlive, curseWolf)
          const numKey = baseKey | ((1 << curseWolf) << seerShift)
          const outcome = checkOutcome(world, nextAlive)
          if (outcome === 'wolf_win' || outcome === 'hamster_win') return null
          const group = possibleByObs.get(numKey)
          if (group) {
            if (!group.worlds.includes(world)) group.worlds.push(world)
          } else {
            possibleByObs.set(numKey, { worlds: [world], alive: nextAlive })
          }
        }
      }
    }
  }

  // 全観測分岐で詰みか？（AND）
  // ムーブオーダリング: ワールド数が多い（難しい）分岐を先に試す → 失敗時の早期打ち切り
  const sortedObs = [...possibleByObs.entries()]
    .sort((a, b) => b[1].worlds.length - a[1].worlds.length)

  const branches = {} as Record<ObservationKey, StrategyNode>

  for (const [numKey, group] of sortedObs) {
    const nextState: SimState = { alive: group.alive, day: day + 1 }

    const result = isTsumi(group.worlds, nextState, depth + 1, ss)
    if (result === null) return null
    branches[obsKeyToString(numKey, seerTargets.length)] = result
  }

  // 全分岐が同じ trivial win に帰着する場合、夜分岐を圧縮
  const collapsed = collapseBranches(branches, bodyguardTarget, seerTargets)
  if (collapsed) return collapsed

  return {
    type: 'action',
    action: { execute: -1, bodyguardTarget, seerTargets },
    branches,
  }
}
