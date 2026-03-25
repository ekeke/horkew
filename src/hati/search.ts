import type { Seat, EnumSpecies } from '../types/index.ts'
import type {
  World, SimState, StrategyNode,
  ObservationKey, SearchOptions,
} from './types.ts'
import { hasSeat, removeSeat, forEachSeat, popCount32 } from './types.ts'
import {
  checkOutcome, allWorldsVillageWin, anyWorldVillageLoss,
  applyExecution, simulateNight, validBiteTargetsMask,
  obsKeyToString, executionObsKeyToString,
  getMediumResult,
} from './simulate.ts'
import { RoleBitIndex } from '../retar/possibilities.ts'

/** 村人側role IDセット（数値判定用） */
const VILLAGER_ROLE_IDS: Set<number> = new Set([
  RoleBitIndex.villager, RoleBitIndex.seer, RoleBitIndex.medium,
  RoleBitIndex.bodyguard, RoleBitIndex.mason, RoleBitIndex.nekomata,
])
const NEKOMATA_ROLE_ID = RoleBitIndex.nekomata

/** 6人以下のエンドゲームテーブル（正規形キー → 詰み可否） */
const endgameTable = new Map<string, boolean>()

/** エンドゲームテーブルのヒット数 */
let endgameHits = 0

/** 統計リセット */
export function resetEndgameStats(): void { endgameHits = 0 }
export function getEndgameStats(): { size: number, hits: number } {
  return { size: endgameTable.size, hits: endgameHits }
}

const ENDGAME_THRESHOLD = 6

type SearchState = {
  nodesVisited: number
  maxDepthReached: number
  options: SearchOptions
  memo: Map<string, StrategyNode | null>
}

/**
 * AND-OR探索の本体。
 */
export function searchTsumi(
  worlds: World[],
  state: SimState,
  options: SearchOptions,
): { result: StrategyNode | null, nodesVisited: number, maxDepthReached: number } {
  const searchState: SearchState = {
    nodesVisited: 0,
    maxDepthReached: 0,
    options,
    memo: new Map(),
  }

  const result = isTsumi(worlds, state, 0, searchState)
  return {
    result,
    nodesVisited: searchState.nodesVisited,
    maxDepthReached: searchState.maxDepthReached,
  }
}

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
  if (worlds.length === 0) return { type: 'win' }
  if (allWorldsVillageWin(worlds, state.alive)) return { type: 'win' }
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
      // テーブルは詰み可否のみ保持。詰みなら再計算して戦略木を返す（高速）
      if (!cached) return null
      // 詰みの場合はフォールスルーして戦略木を構築
    }
  }

  // メモ化チェック（seat番号依存、同一探索内キャッシュ）
  const key = memoKey(worlds, state.alive)
  if (ss.memo.has(key)) return ss.memo.get(key)!

  // 自明な詰み: 生存者中の狼候補が1人だけなら即処刑で勝ち
  const trivial = findTrivialTsumi(worlds, state.alive)
  if (trivial !== null) {
    const result: StrategyNode = {
      type: 'action',
      action: { execute: trivial, bodyguardTarget: null, seerTarget: null },
      branches: { 'win': { type: 'win' } },
    }
    ss.memo.set(key, result)
    return result
  }

  // パリティ事前チェック
  if (!canPossiblyWin(worlds, state.alive)) {
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
function collapseBranches(branches: Record<ObservationKey, StrategyNode>): StrategyNode | null {
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

  return {
    type: 'action',
    action: { execute: commonTarget!, bodyguardTarget: null, seerTarget: null },
    branches: { 'win': { type: 'win' } },
  }
}

/**
 * 自明な詰み判定。
 */
function findTrivialTsumi(worlds: World[], alive: number): Seat | null {
  let wolfUnion = 0
  for (const w of worlds) {
    wolfUnion |= (w.wolfMask & alive)
    if (w.hamsterSeat !== -1 && hasSeat(alive, w.hamsterSeat)) return null
  }
  if (popCount32(wolfUnion) !== 1) return null
  return 31 - Math.clz32(wolfUnion)
}

/**
 * パリティの事前チェック。
 */
function canPossiblyWin(worlds: World[], alive: number): boolean {
  const aliveCount = popCount32(alive)
  for (const w of worlds) {
    const wolfCount = popCount32(w.wolfMask & alive)
    let nonWolfNonHamster = aliveCount - wolfCount
    if (w.hamsterSeat !== -1 && hasSeat(alive, w.hamsterSeat)) nonWolfNonHamster--
    if (wolfCount >= nonWolfNonHamster) return false
  }
  return true
}

/**
 * 処刑候補の列挙（枝刈り込み）
 * #4: isConfirmedVillagerInAllWorlds を数値ID版で判定
 * #7: roleIds で等価クラスハッシュ
 */
function getExecutionCandidates(worlds: World[], alive: number): Seat[] {
  const candidates: Seat[] = []
  const seen = new Set<number>()

  forEachSeat(alive, seat => {
    // #4: 数値IDで村人確定判定（Set再生成不要）
    let isVillager = true
    for (const w of worlds) {
      if (!VILLAGER_ROLE_IDS.has(w.roleIds[seat])) { isVillager = false; break }
    }
    if (isVillager) return

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
  const sortedExecObs = [...obsGroups.entries()]
    .sort((a, b) => b[1].worlds.length - a[1].worlds.length)

  const branches = {} as Record<ObservationKey, StrategyNode>

  for (const [obsKey, group] of sortedExecObs) {
    const { worlds: groupWorlds, alive: groupAlive } = group

    if (allWorldsVillageWin(groupWorlds, groupAlive)) {
      branches[obsKey] = { type: 'win' }
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
    action: { execute: target, bodyguardTarget: null, seerTarget: null },
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

  return result
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

  for (const bgTarget of bodyguardCandidates) {
    for (const seerTarget of seerCandidates) {
      const result = tryNightAction(worlds, alive, day, bgTarget, seerTarget, depth, ss)
      if (result !== null) return result
    }
  }

  return null
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
  const hasAliveSeer = worlds.some(w => w.seerSeat !== -1 && hasSeat(alive, w.seerSeat))
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
  seerTarget: Seat | null,
  depth: number,
  ss: SearchState,
): StrategyNode | null {
  // 数値キーでグルーピング（高速）
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

      const { nextAlive, obsKey: numKey } = simulateNight(
        world, alive, biteTarget, bodyguardTarget, seerTarget,
      )
      // 早期打ち切り: この噛み先で村が負ける → この夜行動は詰みでない
      const outcome = checkOutcome(world, nextAlive)
      if (outcome === 'wolf_win' || outcome === 'hamster_win') return null

      const group = possibleByObs.get(numKey)
      if (group) {
        // #5: 配列 + indexOf で重複回避（Setの代わり）
        if (!group.worlds.includes(world)) group.worlds.push(world)
      } else {
        possibleByObs.set(numKey, { worlds: [world], alive: nextAlive })
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
    branches[obsKeyToString(numKey)] = result
  }

  // 全分岐が同じ trivial win に帰着する場合、夜分岐を圧縮
  const collapsed = collapseBranches(branches)
  if (collapsed) return collapsed

  return {
    type: 'action',
    action: { execute: -1, bodyguardTarget, seerTarget },
    branches,
  }
}
