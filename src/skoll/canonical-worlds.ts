/**
 * Canonical world enumeration: 身分同一性 (= 同 possibility bitmask) の seats を
 * orbit に集約し、 multiset 列挙で代表 world + 順列重みを emit する。
 *
 * 目的
 * ----
 * `enumerateWorlds` (hati/worlds.ts) は seat ごとに role を 1 つずつ assign する
 * 完全置換列挙。 Day 2 のような情報量が少ない局面では grays の置換だけで
 * worlds 数が膨張する (Day 2 で 248K worlds の大半が「8 グレーの置換」由来)。
 *
 * 本ファイルは retar の `solver.ts` 同様、 同 possibility bitmask の seat group を
 * equivalence class と認識し、 各 class 内では role の **multiset 列挙** で済ます。
 * これで世界数は orbit size 分削減される (Day 2 で 100x オーダー期待)。
 *
 * 重み
 * ----
 * 各 canonical world は orbit size = Π over class of multinomial(class_size, role counts)
 * の weight を持つ。 集約時に weight を掛けて normalize すれば、 全置換列挙と同等の
 * per-X 期待値が得られる。
 *
 * Per-X 出力の対称性
 * ------------------
 * 同 class の alive seats は per-X 出力で **完全に同値** (= symmetry argument)。
 * `analyzeExecutionsByWorldCanonical` は class 単位で per-X を集約し、 class 内
 * uniformly に分配する。 これは元の `analyzeExecutionsByWorld` と数学的に等価。
 */

import type { SystemRole, Seat, VillageStatus } from '../types/index.ts'
import type { Possibilities, RolePossibility } from '../retar/possibilities.ts'
import type { World } from '../hati/types.ts'
import { maskFromSeats } from '../hati/types.ts'
import {
  RoleBitIndex, RoleSignatureBitsReverseMap, ROLE_COUNT,
  bitIndicesFromMask, combinationWithReplacementBit,
} from '../retar/possibilities.ts'
import { computeScoresForWorld } from './world-analysis.ts'
import type { WorldExecutionAnalysis } from './world-analysis.ts'
import { DEFAULT_MAX_WORLDS } from './constants.ts'

/** Equivalence class: 同 possibility bitmask の seat group */
export type EquivClass = {
  /** seats, ASC sort 済 (canonical な role 割当順序の基準) */
  seats: Seat[]
  /** 全 seats 共通の possibility bitmask */
  possibility: RolePossibility
}

/**
 * Possibilities から equivalence class を計算する。
 * 2 つの seat が同 class iff 同 possibility bitmask を持つ。
 */
export function computeEquivalenceClasses(possibilities: Possibilities): EquivClass[] {
  const groups = new Map<number, Seat[]>()
  for (let seat = 1; seat < possibilities.possibilities.length; seat++) {
    const possibility = possibilities.possibilities[seat]
    if (possibility === 0) continue
    let group = groups.get(possibility)
    if (group === undefined) {
      group = []
      groups.set(possibility, group)
    }
    group.push(seat)
  }
  const classes: EquivClass[] = []
  for (const [possibility, seats] of groups) {
    classes.push({ seats: seats.slice().sort((a, b) => a - b), possibility })
  }
  // determinism: class を最小 seat で昇順
  classes.sort((a, b) => a.seats[0] - b.seats[0])
  return classes
}

/** Multinomial coefficient: k! / (Π count_i!) */
function multinomial(k: number, counts: number[]): number {
  let num = 1
  for (let i = 2; i <= k; i++) num *= i
  let denom = 1
  for (const c of counts) {
    for (let i = 2; i <= c; i++) denom *= i
  }
  return num / denom
}

type MasksSnapshot = {
  wolfMask: number
  hamsterMask: number
  immoralistMask: number
  seerMask: number
  mediumMask: number
  nekomataMask: number
  bodyguardSeat: number
}

function snapshotMasks(world: World): MasksSnapshot {
  return {
    wolfMask: world.wolfMask,
    hamsterMask: world.hamsterMask,
    immoralistMask: world.immoralistMask,
    seerMask: world.seerMask,
    mediumMask: world.mediumMask,
    nekomataMask: world.nekomataMask,
    bodyguardSeat: world.bodyguardSeat,
  }
}

function restoreMasks(world: World, snap: MasksSnapshot): void {
  world.wolfMask = snap.wolfMask
  world.hamsterMask = snap.hamsterMask
  world.immoralistMask = snap.immoralistMask
  world.seerMask = snap.seerMask
  world.mediumMask = snap.mediumMask
  world.nekomataMask = snap.nekomataMask
  world.bodyguardSeat = snap.bodyguardSeat
}

/**
 * Canonical world enumeration. 各 class で role multiset を列挙し、 canonical
 * (= seat ASC × role bit ASC) な role 割当を持つ world + orbit weight を emit。
 *
 * emit の戻り値が false なら列挙打ち切り (enumerateWorlds と同 contract)。
 * world は共有バッファ — 保持する場合は cloneWorld を呼ぶこと。
 */
export function enumerateCanonicalWorlds(
  possibilities: Possibilities,
  setup: Map<SystemRole, number>,
  emit: (world: World, weight: number) => boolean | void,
): void {
  const classes = computeEquivalenceClasses(possibilities)

  const roleCount = new Uint8Array(ROLE_COUNT)
  for (const [role, count] of setup) {
    roleCount[RoleBitIndex[role]] = count
  }

  // World buffer size: max seat across all classes
  let maxSeat = 0
  for (const c of classes) {
    for (const s of c.seats) if (s > maxSeat) maxSeat = s
  }

  const rolesArr: SystemRole[] = new Array(maxSeat + 1)
  const roleIds = new Uint8Array(maxSeat + 1)
  const world: World = {
    roles: rolesArr,
    roleIds,
    wolfMask: 0,
    hamsterMask: 0,
    immoralistMask: 0,
    seerMask: 0,
    mediumMask: 0,
    nekomataMask: 0,
    bodyguardSeat: -1,
  }

  let stopped = false

  function backtrack(classIdx: number, weight: number): void {
    if (stopped) return
    if (classIdx === classes.length) {
      // すべての class 割当済み — 役職を全部使い切ったか確認
      for (let i = 0; i < ROLE_COUNT; i++) {
        if (roleCount[i] !== 0) return
      }
      if (emit(world, weight) === false) stopped = true
      return
    }

    const cls = classes[classIdx]
    const k = cls.seats.length
    const indices = bitIndicesFromMask(cls.possibility)

    // multiset 列挙: v[bitIdx] = この class に割り当てる役職 bitIdx の数
    for (const v of combinationWithReplacementBit(indices, k, roleCount)) {
      // v は共有バッファ — recurse 前にスナップ
      const localCounts: { bitIdx: number, count: number }[] = []
      let totalV = 0
      for (const bitIdx of indices) {
        const cnt = v[bitIdx]
        if (cnt > 0) {
          localCounts.push({ bitIdx, count: cnt })
          totalV += cnt
        }
      }
      if (totalV !== k) continue

      const mn = multinomial(k, localCounts.map(lc => lc.count))

      // Apply: 役職 budget 減算 + canonical (seat ASC, role bit ASC) で割当
      for (const lc of localCounts) roleCount[lc.bitIdx] -= lc.count
      const snap = snapshotMasks(world)
      let seatIdx = 0
      for (const lc of localCounts) {
        const role = RoleSignatureBitsReverseMap.get(1 << lc.bitIdx)!
        for (let i = 0; i < lc.count; i++) {
          const seat = cls.seats[seatIdx++]
          const bit = 1 << seat
          rolesArr[seat] = role
          roleIds[seat] = lc.bitIdx
          switch (lc.bitIdx) {
            case RoleBitIndex.werewolf: world.wolfMask |= bit; break
            case RoleBitIndex.werehamster: world.hamsterMask |= bit; break
            case RoleBitIndex.immoralist: world.immoralistMask |= bit; break
            case RoleBitIndex.seer: world.seerMask |= bit; break
            case RoleBitIndex.medium: world.mediumMask |= bit; break
            case RoleBitIndex.nekomata: world.nekomataMask |= bit; break
            case RoleBitIndex.bodyguard: world.bodyguardSeat = seat; break
            // villager / possessed / fanatic は mask に乗らない
          }
        }
      }

      backtrack(classIdx + 1, weight * mn)

      // Restore
      restoreMasks(world, snap)
      for (const lc of localCounts) roleCount[lc.bitIdx] += lc.count
    }
  }

  backtrack(0, 1)
}

/**
 * Canonical 集約版の per-X 期待値計算。
 *
 * `analyzeExecutionsByWorld` (world-analysis.ts) と数学的に等価だが、
 * 同 class の置換重複を multiset weight で表現するため大幅に高速。
 *
 * 戻り値の `totalWorlds` は orbit 集約後の重み合計 (= 元の全置換 worlds 数)。
 */
export function analyzeExecutionsByWorldCanonical(
  possibilities: Possibilities,
  setup: Map<SystemRole, number>,
  vs: VillageStatus,
  maxWorlds: number = DEFAULT_MAX_WORLDS,
): WorldExecutionAnalysis {
  const aliveSeats: Seat[] = []
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }
  const alive = maskFromSeats(aliveSeats)

  if (aliveSeats.length === 0) {
    return {
      totalWorlds: 0,
      truncated: false,
      executions: [],
      bestExecution: 0,
      overallWinRate: 0,
    }
  }

  // seat → equivalence class index
  const classes = computeEquivalenceClasses(possibilities)
  const seatToClassIdx = new Map<number, number>()
  for (let i = 0; i < classes.length; i++) {
    for (const s of classes[i].seats) seatToClassIdx.set(s, i)
  }

  // 各 alive seat の class index (i は aliveSeats の index)
  const aliveClassIdx = new Int32Array(aliveSeats.length)
  for (let i = 0; i < aliveSeats.length; i++) {
    aliveClassIdx[i] = seatToClassIdx.get(aliveSeats[i]) ?? -1
  }

  // class index → alive seats のうちその class に属する index (集約用)
  const classToAliveIndices = new Map<number, number[]>()
  for (let i = 0; i < aliveSeats.length; i++) {
    const cls = aliveClassIdx[i]
    let arr = classToAliveIndices.get(cls)
    if (arr === undefined) { arr = []; classToAliveIndices.set(cls, arr) }
    arr.push(i)
  }

  const winScores = new Float64Array(aliveSeats.length)
  let totalWeight = 0
  let truncated = false

  const cache = new Map<number, number>()
  const sigCache = new Map<number, Map<number, Float64Array>>()

  enumerateCanonicalWorlds(possibilities, setup, (world, weight) => {
    if (totalWeight >= maxWorlds) {
      truncated = true
      return false
    }
    totalWeight += weight

    // signature cache
    const key1 = world.wolfMask | (world.hamsterMask << 15)
    const key2 = world.seerMask
      + world.mediumMask * 0x8000
      + world.nekomataMask * 0x40000000
      + (world.bodyguardSeat + 2) * 0x200000000000
    let inner = sigCache.get(key1)
    if (inner === undefined) { inner = new Map(); sigCache.set(key1, inner) }
    let scores = inner.get(key2)
    if (scores === undefined) {
      scores = computeScoresForWorld(world, aliveSeats, alive, cache)
      inner.set(key2, scores)
    }

    // 各 class 内で平均を取り、 class 内全 alive seat に uniformly 加算
    // (per-X 出力は class 内で必ず同一であるため、 average で representative score を作る)
    for (const indices of classToAliveIndices.values()) {
      let sum = 0
      for (const idx of indices) sum += scores[idx]
      const avg = sum / indices.length
      const contribution = weight * avg
      for (const idx of indices) winScores[idx] += contribution
    }
  })

  const executions: { seat: Seat, winRate: number }[] = []
  let bestSeat = aliveSeats[0]
  let bestRate = -Infinity
  for (let i = 0; i < aliveSeats.length; i++) {
    const winRate = totalWeight > 0 ? winScores[i] / totalWeight : 0
    executions.push({ seat: aliveSeats[i], winRate })
    if (winRate > bestRate) {
      bestRate = winRate
      bestSeat = aliveSeats[i]
    }
  }

  return {
    totalWorlds: totalWeight,
    truncated,
    executions,
    bestExecution: bestSeat,
    overallWinRate: bestRate,
  }
}
