/**
 * 単純再帰 skoll: 「今日 X 吊り + 今夜 seer が Y を占う + 今夜 wolf Z 襲撃 + 今夜 BG G 護衛
 * + 翌朝 skoll」の多日期待値計算。
 *
 * 設計
 * ----
 * 現状の `analyzeExecutionsByWorld` は per-world で X 吊り後の続きを抽象 minimax
 * (count abstraction) で推定する。 これは座標情報を捨てるため、 「占い師が
 * 戦略的に狐候補を狙う」「LW を残してグレー吊り」のような多日戦略は表現不可。
 *
 * 本ファイルは top 1 層を **具象 state** (world × alive bitmask) で展開し、
 * 翌朝 skoll (= 既存抽象 minimax) を leaf で呼び出す。 各 (X 吊り, Y 占い) ペア
 * に対し:
 *   1. 全 world を enumerate
 *   2. 内部に Z (wolf 襲撃) × G (BG 護衛) の MIN/MAX search を回す
 *      - bodyguard MAX over G of (wolf MIN over Z of score(X, Y, Z, G))
 *      - bodyguard-first 設定 (= 対 wolf の worst-case 想定で BG が最善 G を選ぶ)
 *   3. 各 (X, Y, Z, G) tuple で per-world simulation + obsKey group 化 + day-2 leaf 評価
 *   4. X が nekomata の world は curse 候補列挙して 1/N 加重平均
 *
 * Depth 拡張 (maxDepth >= 2)
 * --------------------------
 * `options.maxDepth = k` を指定すると、 各 obsKey group で「翌朝 skoll」を呼ぶ代わりに
 * 同 group worlds に対して `recursiveSkollCore(depth=k-1)` を再帰呼び出しする。
 * depth=2 なら「今日 + 今夜 + 翌日 X' 選択 + 翌夜 + 翌々日抽象 leaf」を表現。
 *
 * 既知の限界
 * ----------
 * - viewer 視点は consumer 側で possibilities を作るときに assumption を入れる
 *   (recursive.ts 自体は viewer-agnostic)
 * - mixed Nash equilibrium は計算せず pure strategy で maxmin (= V* の下界)
 * - depth >= 2 は Day 2-3 では cost 爆発する (alive ≈ 10 で hours オーダー)。
 *   Day 4+ または小 alive 盤面でのみ実用的
 */

import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import type { World } from '../hati/types.ts'
import {
  maskFromSeats, hasSeat, removeSeat, seatsFromMask, popCount32, getGuardSeat,
} from '../hati/types.ts'
import { cloneWorld } from '../hati/worlds.ts'
import { checkOutcome, applyExecution, simulateNight } from '../hati/simulate.ts'
import { computeScoresForWorld, FOX_WIN_PENALTY } from './world-analysis.ts'
import { enumerateCanonicalWorlds, computeEquivalenceClasses } from './canonical-worlds.ts'
import { DEFAULT_MAX_WORLDS } from './constants.ts'

export type RecursiveSkollOptions = {
  /** Y 占い候補の制限。 default = 全 alive (X 自身は除外される) */
  divineCandidates?: ReadonlySet<Seat>
  /** X 吊り候補の制限。 default = 全 alive */
  executeCandidates?: ReadonlySet<Seat>
  /** Z 襲撃候補の制限。 default = 全 alive (X 退場後の生存席) */
  attackCandidates?: ReadonlySet<Seat>
  /** G 護衛候補の制限。 default = null + 全 alive (X 退場後) */
  guardCandidates?: ReadonlySet<Seat | null>
  /** World 列挙の上限 (memory budget)。 default = DEFAULT_MAX_WORLDS */
  maxWorlds?: number
  /**
   * 再帰深さ。 default = 1 (今日 + 今夜 + 翌朝抽象 leaf)。
   * k >= 2 にすると group ごとに k-1 日分の追加 lookahead を行う (cost 爆発注意)。
   */
  maxDepth?: number
}

export type RecursivePerDivine = {
  divine: Seat
  /** maxmin 値 (= bodyguard が最善 G を選んだときの、 wolf 最悪 Z に対する村勝率) */
  winRate: number
  /** terminal world の割合 — debug 用 */
  terminalRatio: number
  /** equilibrium での wolf 襲撃手 */
  worstAttack: Seat | null
  /** equilibrium での BG 護衛手 */
  bestGuard: Seat | null
}

export type RecursivePerXResult = {
  executeToday: Seat
  /** 最良の Y 占いターゲット */
  bestDivineTonight: Seat | null
  /** bestDivineTonight 採用時の期待値 */
  expectedWinRate: number
  /** debug 用: 全 Y 候補の score */
  perDivine: RecursivePerDivine[]
}

export type RecursiveSkollResult = {
  totalWorlds: number
  truncated: boolean
  perX: RecursivePerXResult[]
}

/**
 * Top-level: per-X expected win rate を多日 lookahead で計算する。
 *
 * `options.maxDepth = k` で k 日分の lookahead (default k=1)。
 */
export function recursiveSkoll(
  possibilities: Possibilities,
  setup: Map<SystemRole, number>,
  vs: VillageStatus,
  options: RecursiveSkollOptions = {},
): RecursiveSkollResult {
  const maxDepth = options.maxDepth ?? 1
  if (maxDepth < 1) throw new Error('recursiveSkoll: maxDepth must be >= 1')

  const aliveSeats: Seat[] = []
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }
  const alive = maskFromSeats(aliveSeats)
  const maxWorlds = options.maxWorlds ?? DEFAULT_MAX_WORLDS

  // Canonical world enumeration: orbit 集約版。 同 possibility bitmask の seats を
  // 1 つの canonical world にまとめ、 orbit size を weight として持つ。
  // Day 2 オーダーで数千倍の世界数削減効果あり。
  const worlds: World[] = []
  const weights: number[] = []
  let totalWeight = 0
  let truncated = false
  enumerateCanonicalWorlds(possibilities, setup, (world, weight) => {
    if (totalWeight >= maxWorlds) {
      truncated = true
      return false
    }
    worlds.push(cloneWorld(world))
    weights.push(weight)
    totalWeight += weight
  })

  // Day-(d+1) leaf 評価で minimax cache を共有する (再帰の全 depth で共通)
  const leafCache = new Map<number, number>()

  // Equivalence classes は **元の possibilities** から derive する。
  // worlds[] からの derive は canonical 順序割当により偽の非対称が出るためバグる
  // (例: class {12,14} の multiset {wolf,fox} で必ず seat-12=wolf 固定 → 別 class 扱い)
  const classes = computeEquivalenceClasses(possibilities)
  const seatToClassIdx = new Map<number, number>()
  for (let i = 0; i < classes.length; i++) {
    for (const s of classes[i].seats) seatToClassIdx.set(s, i)
  }

  const perX = recursiveSkollCore(worlds, weights, alive, setup, maxDepth, leafCache, options, seatToClassIdx)

  return { totalWorlds: worlds.length, truncated, perX }
}

/**
 * 内部 core: 事前列挙された worlds[] + weights[] に対し、 depth 日分の lookahead を行う。
 *
 * - `depth >= 2` 時は obsKey group ごとに自身を `depth-1` で再帰呼び出し。
 * - `depth = 1` 時は leaf として `analyzeExecutionsFromWorlds` を呼ぶ (= 抽象 minimax)。
 * - Equivalence classes は worlds[] (= 公開 obs フィルタ後の subset) から re-derive する。
 *
 * 内部再帰時は candidate restrictions (executeCandidates 等) を継承しない (= 全 alive default)。
 */
function recursiveSkollCore(
  worlds: World[],
  weights: number[],
  alive: number,
  setup: Map<SystemRole, number>,
  depth: number,
  leafCache: Map<number, number>,
  options: RecursiveSkollOptions = {},
  /**
   * 親 (top-level) から渡される seat → class idx map。
   * top-level: 元 possibilities から `computeEquivalenceClasses` で derive (正しい)。
   * depth > 1 の inner 再帰でこの引数を省略すると、 worlds から derive する fallback
   * (近似、 canonical 順序固定で対称性が失われる既知バグあり)。
   */
  seatToClassIdxIn?: Map<number, number>,
): RecursivePerXResult[] {
  const aliveSeats = seatsFromMask(alive)
  if (aliveSeats.length === 0 || worlds.length === 0) return []

  // class derive: 親から渡されていれば使う、 なければ worlds fallback (depth>1 inner)
  const seatToClassIdx = seatToClassIdxIn ?? computeSeatToClassIdxFromWorlds(worlds, aliveSeats)

  const executeCandidates = options.executeCandidates ?? new Set(aliveSeats)
  const divineCandidates = options.divineCandidates ?? new Set(aliveSeats)
  const attackCandidatesOption = options.attackCandidates
  const guardCandidatesOption = options.guardCandidates

  const perX: RecursivePerXResult[] = []
  for (const X of aliveSeats) {
    if (!executeCandidates.has(X)) continue

    // X 退場後の alive
    const aliveAfterExec = applyExecution(alive, X)
    const aliveSeatsAfterExec = seatsFromMask(aliveAfterExec)

    // Z, G 候補を絞る (option で override 可能)
    const zCandidates: Seat[] = attackCandidatesOption
      ? aliveSeatsAfterExec.filter(s => attackCandidatesOption.has(s))
      : aliveSeatsAfterExec
    const gCandidates: (Seat | null)[] = guardCandidatesOption
      ? [...guardCandidatesOption].filter(g => g === null || (hasSeat(aliveAfterExec, g)))
      : [null, ...aliveSeatsAfterExec]

    const perDivine: RecursivePerDivine[] = []

    for (const Y of aliveSeats) {
      if (Y === X) continue
      if (!divineCandidates.has(Y)) continue

      // BG MAX over G of (wolf MIN over Z of score(X, Y, Z, G))
      let bestVillageValue = -Infinity
      let bestG: Seat | null = null
      let bestZ: Seat | null = null
      let bestTerminalRatio = 0

      for (const G of gCandidates) {
        let minZValue = Infinity
        let argMinZ: Seat | null = null
        let argTerminalRatio = 0

        for (const Z of zCandidates) {
          const r = evaluateXYZG(
            worlds, weights, alive, X, Y, Z, G,
            leafCache, seatToClassIdx, depth, setup,
          )
          if (r.winRate < minZValue) {
            minZValue = r.winRate
            argMinZ = Z
            argTerminalRatio = r.terminalRatio
          }
        }

        if (minZValue > bestVillageValue) {
          bestVillageValue = minZValue
          bestG = G
          bestZ = argMinZ
          bestTerminalRatio = argTerminalRatio
        }
      }

      perDivine.push({
        divine: Y,
        winRate: bestVillageValue === -Infinity ? 0 : bestVillageValue,
        terminalRatio: bestTerminalRatio,
        worstAttack: bestZ,
        bestGuard: bestG,
      })
    }

    let bestY: Seat | null = null
    let bestRate = -Infinity
    for (const d of perDivine) {
      if (d.winRate > bestRate) {
        bestRate = d.winRate
        bestY = d.divine
      }
    }

    perX.push({
      executeToday: X,
      bestDivineTonight: bestY,
      expectedWinRate: bestY === null ? 0 : bestRate,
      perDivine,
    })
  }

  // Class uniformity post-process: 同 class の seats は per-X 期待値が必ず同一になる
  // (対称性論)。 canonical world 経由だと per-X 計算が canonical 役職割当に依存して
  // 非対称になるため、 class 内の expectedWinRate を平均で uniformly に上書きする。
  // perDivine も同様に class 内で平均化。
  const perXByClass = new Map<number, RecursivePerXResult[]>()
  for (const r of perX) {
    const cls = seatToClassIdx.get(r.executeToday) ?? -r.executeToday
    let arr = perXByClass.get(cls)
    if (arr === undefined) { arr = []; perXByClass.set(cls, arr) }
    arr.push(r)
  }
  for (const arr of perXByClass.values()) {
    if (arr.length <= 1) continue
    // expectedWinRate 平均
    let sumRate = 0
    for (const r of arr) sumRate += r.expectedWinRate
    const avgRate = sumRate / arr.length
    // perDivine も Y 単位で平均
    const numDivines = arr[0].perDivine.length
    for (let di = 0; di < numDivines; di++) {
      let sumD = 0
      let sumT = 0
      for (const r of arr) {
        sumD += r.perDivine[di].winRate
        sumT += r.perDivine[di].terminalRatio
      }
      const avgD = sumD / arr.length
      const avgT = sumT / arr.length
      for (const r of arr) {
        r.perDivine[di].winRate = avgD
        r.perDivine[di].terminalRatio = avgT
      }
    }
    // 平均化後の perDivine から bestY を再選択
    for (const r of arr) {
      r.expectedWinRate = avgRate
      let bestY: Seat | null = null
      let bestRate = -Infinity
      for (const d of r.perDivine) {
        if (d.winRate > bestRate) {
          bestRate = d.winRate
          bestY = d.divine
        }
      }
      r.bestDivineTonight = bestY
      r.expectedWinRate = bestRate
    }
  }

  return perX
}

/**
 * worlds[] の alive seats に対し、 per-seat possibility mask (= OR of role bits) で
 * equivalence classes を構築し、 seat → class index map を返す。
 *
 * **既知バグ**: canonical world enumeration は同 class 内で role を deterministic
 * 順序 (seat ASC × role bit ASC) で割当てるため、 worlds[] からの OR では同 class
 * の seats が異なる role になる (例: class {12,14} multiset {wolf,fox} で常に
 * seat-12=wolf 固定 → seat-12={wolf}, seat-14={fox} と誤認識)。
 *
 * 結果として「真の (公開観測上の) 等価 class」を取りこぼし、 class uniformity
 * post-process が効かず非対称な per-X 値が出る。
 *
 * 正しくは元 `possibilities` から `computeEquivalenceClasses` で derive すべき。
 * top-level は `recursiveSkoll` 側で正しく derive して `recursiveSkollCore` に渡す。
 * inner 再帰 (depth > 1) でこの関数を fallback として呼ぶが、 上記制限あり。
 */
function computeSeatToClassIdxFromWorlds(worlds: World[], aliveSeats: Seat[]): Map<Seat, number> {
  const seatPoss = new Map<Seat, number>()
  for (const seat of aliveSeats) seatPoss.set(seat, 0)
  for (const w of worlds) {
    for (const seat of aliveSeats) {
      seatPoss.set(seat, seatPoss.get(seat)! | (1 << w.roleIds[seat]))
    }
  }
  // group seats by identical possibility mask
  const possToClass = new Map<number, number>()
  const seatToClassIdx = new Map<Seat, number>()
  // determinism: assign class idx in order of seats ASC (= aliveSeats already sorted)
  const sortedAlive = [...aliveSeats].sort((a, b) => a - b)
  let nextClass = 0
  for (const seat of sortedAlive) {
    const poss = seatPoss.get(seat)!
    let cls = possToClass.get(poss)
    if (cls === undefined) {
      cls = nextClass++
      possToClass.set(poss, cls)
    }
    seatToClassIdx.set(seat, cls)
  }
  return seatToClassIdx
}

/**
 * (X 吊り, Y 占い, Z 襲撃, G 護衛) 1 ペアの per-world 評価 + day-(d+1) leaf/再帰 集約。
 *
 * Nekomata X 処理: X が nekomata の world では curse 候補を 1/N 加重で分岐。
 *
 * `depth` パラメータ:
 *  - depth = 1: 各 obsKey group で `analyzeExecutionsFromWorlds` (抽象 minimax leaf)
 *  - depth > 1: 各 obsKey group で `recursiveSkollCore(depth-1)` を再帰呼び出し
 *               (= 翌日 X' 選択 + 翌夜 + 翌々日 leaf を 1 段深く)
 */
function evaluateXYZG(
  worlds: World[],
  weights: number[],
  alive: number,
  X: Seat,
  Y: Seat,
  Z: Seat,
  G: Seat | null,
  leafCache: Map<number, number>,
  seatToClassIdx: Map<number, number>,
  depth: number,
  setup: Map<SystemRole, number>,
): { winRate: number, terminalRatio: number } {
  // group key: obsKey (deathMask + seerResult) + nextAlive + curseTarget
  // → 同じ key の world は同一の公開観測を生む
  // GroupValue.weights: per-world weight (canonical orbit size × nekomata branch fraction)
  type GroupValue = { worlds: World[], weights: number[], nextAlive: number, totalWeight: number }
  const groups = new Map<number, GroupValue>()

  let terminalScore = 0
  let terminalWeight = 0

  const aliveAfterExec = applyExecution(alive, X)

  for (let wi = 0; wi < worlds.length; wi++) {
    const world = worlds[wi]
    const worldWeight = weights[wi]
    const isNekoX = (world.curseOnExecutedMask & (1 << X)) !== 0

    if (isNekoX) {
      // Curse 候補列挙
      const curseCandidates = seatsFromMask(aliveAfterExec)
      if (curseCandidates.length === 0) {
        // Curse 対象なし: X 単独退場
        processBranch(world, aliveAfterExec, worldWeight, -1)
      } else {
        const branchWeight = worldWeight / curseCandidates.length
        for (const C of curseCandidates) {
          const aliveAfterCurse = removeSeat(aliveAfterExec, C)
          processBranch(world, aliveAfterCurse, branchWeight, C)
        }
      }
    } else {
      processBranch(world, aliveAfterExec, worldWeight, -1)
    }
  }

  function processBranch(
    world: World,
    aliveAfterDay: number,
    branchWeight: number,
    curseTarget: Seat,
  ): void {
    // 処刑直後 (+ curse) の終局判定
    const outcomeAfterDay = checkOutcome(world, aliveAfterDay)
    if (outcomeAfterDay !== 'ongoing') {
      terminalScore += branchWeight * terminalValue(outcomeAfterDay)
      terminalWeight += branchWeight
      return
    }

    // 夜 sim
    const safeAttack = hasSeat(aliveAfterDay, Z) ? Z : -1
    const safeGuard = G !== null && hasSeat(aliveAfterDay, G) ? G : null
    const nightResult = simulateNight(world, aliveAfterDay, safeAttack, safeGuard, [Y])
    const nextAlive = nightResult.nextAlive

    const outcomeAfterNight = checkOutcome(world, nextAlive)
    if (outcomeAfterNight !== 'ongoing') {
      terminalScore += branchWeight * terminalValue(outcomeAfterNight)
      terminalWeight += branchWeight
      return
    }

    // Group key: obsKey + nextAlive + curseTarget
    // curseTarget は curse 由来の分岐を区別するため key に含める
    // (同じ obsKey でも curse 違いだと公開観測 (= 退場席) が異なるため)
    const curseBits = curseTarget < 0 ? 0 : (1 << 14) | curseTarget  // sentinel + curse seat
    const key = (nightResult.obsKey * 0x100000) + (nextAlive & 0xFFFF) * 0x40 + curseBits
    let g = groups.get(key)
    if (g === undefined) {
      g = { worlds: [], weights: [], nextAlive, totalWeight: 0 }
      groups.set(key, g)
    }
    g.worlds.push(world)
    g.weights.push(branchWeight)
    g.totalWeight += branchWeight
  }

  // 各 group で day-(d+1) 評価 (weighted + class-aware uniformity)
  // depth = 1: 抽象 minimax leaf を呼ぶ
  // depth > 1: 自身を depth-1 で再帰呼び出し、 perX[].expectedWinRate の最大 (= 村の day-2 best)
  let nonTerminalScore = 0
  let nonTerminalWeight = 0
  for (const g of groups.values()) {
    const day2AliveSeats = seatsFromMask(g.nextAlive)
    if (day2AliveSeats.length === 0) continue
    let groupValue: number
    if (depth > 1) {
      const innerPerX = recursiveSkollCore(
        g.worlds, g.weights, g.nextAlive, setup, depth - 1, leafCache,
      )
      let bestInner = -Infinity
      for (const r of innerPerX) {
        if (r.expectedWinRate > bestInner) bestInner = r.expectedWinRate
      }
      groupValue = bestInner === -Infinity ? 0 : bestInner
    } else {
      const day2 = analyzeExecutionsFromWorlds(
        g.worlds, day2AliveSeats, g.nextAlive, leafCache, g.weights, seatToClassIdx,
      )
      groupValue = day2.overallWinRate
    }
    nonTerminalScore += g.totalWeight * groupValue
    nonTerminalWeight += g.totalWeight
  }

  const denom = terminalWeight + nonTerminalWeight
  if (denom === 0) return { winRate: 0, terminalRatio: 0 }

  return {
    winRate: (terminalScore + nonTerminalScore) / denom,
    terminalRatio: terminalWeight / denom,
  }
}

/**
 * 事前列挙された worlds 配列に対して `analyzeExecutionsByWorld` 相当を実行。
 * `enumerateWorlds` を介さない点が違うだけで、 計算式は同じ。
 *
 * `weights` を指定した場合は weighted average (= canonical world orbit size 集約)。
 * 省略時は各 world weight=1 (= unweighted 平均)。
 *
 * `seatToClassIdx` を指定した場合は class-aware uniformity を強制 (= 同 class
 * aliveSeats の per-X 値が同じになる、 対称性論)。 canonical world 経由の場合は
 * これを渡さないと per-X score が canonical 役職割当に依存して非対称になる。
 */
export function analyzeExecutionsFromWorlds(
  worlds: World[],
  aliveSeats: Seat[],
  alive: number,
  cache?: Map<number, number>,
  weights?: number[],
  seatToClassIdx?: Map<number, number>,
): { totalWorlds: number, executions: { seat: Seat, winRate: number }[], bestExecution: Seat, overallWinRate: number } {
  if (aliveSeats.length === 0 || worlds.length === 0) {
    return {
      totalWorlds: worlds.length,
      executions: aliveSeats.map(seat => ({ seat, winRate: 0 })),
      bestExecution: aliveSeats[0] ?? 0,
      overallWinRate: 0,
    }
  }

  const minimaxCache = cache ?? new Map<number, number>()
  const winScores = new Float64Array(aliveSeats.length)
  let totalWeight = 0

  // class index → alive seats のうちその class に属する index (uniformity 用)
  // seatToClassIdx 省略時は per-seat 個別 (各 seat が自分自身の class)
  const classToAliveIndices = new Map<number, number[]>()
  if (seatToClassIdx) {
    for (let i = 0; i < aliveSeats.length; i++) {
      const cls = seatToClassIdx.get(aliveSeats[i]) ?? -aliveSeats[i]  // fallback: 自分自身
      let arr = classToAliveIndices.get(cls)
      if (arr === undefined) { arr = []; classToAliveIndices.set(cls, arr) }
      arr.push(i)
    }
  }

  // signature cache (world-analysis.ts と同パターン)
  const sigCache = new Map<number, Map<number, Float64Array>>()

  for (let wi = 0; wi < worlds.length; wi++) {
    const world = worlds[wi]
    const w = weights ? weights[wi] : 1
    totalWeight += w

    const key1 = world.attackCapableMask | (world.dieWhenDivinedMask << 15)
    const key2 = world.divineCapableMask
      + world.mediumshipMask * 0x8000
      + world.curseOnExecutedMask * 0x40000000
      + (getGuardSeat(world) + 2) * 0x200000000000
    let inner = sigCache.get(key1)
    if (inner === undefined) {
      inner = new Map()
      sigCache.set(key1, inner)
    }
    let scores = inner.get(key2)
    if (scores === undefined) {
      scores = computeScoresForWorld(world, aliveSeats, alive, minimaxCache)
      inner.set(key2, scores)
    }
    if (seatToClassIdx) {
      // class 内で uniformly: 各 class で sum/count を計算し、 全 alive seat に
      // contribution を加算
      for (const indices of classToAliveIndices.values()) {
        let sum = 0
        for (const idx of indices) sum += scores[idx]
        const avg = sum / indices.length
        const contribution = w * avg
        for (const idx of indices) winScores[idx] += contribution
      }
    } else {
      for (let i = 0; i < aliveSeats.length; i++) {
        winScores[i] += w * scores[i]
      }
    }
  }

  const total = totalWeight
  const executions: { seat: Seat, winRate: number }[] = []
  let bestSeat = aliveSeats[0]
  let bestRate = -Infinity
  for (let i = 0; i < aliveSeats.length; i++) {
    const winRate = winScores[i] / total
    executions.push({ seat: aliveSeats[i], winRate })
    if (winRate > bestRate) {
      bestRate = winRate
      bestSeat = aliveSeats[i]
    }
  }

  return {
    totalWorlds: total,
    executions,
    bestExecution: bestSeat,
    overallWinRate: bestRate,
  }
}

function terminalValue(outcome: 'village_win' | 'wolf_win' | 'hamster_win'): number {
  if (outcome === 'village_win') return 1.0
  if (outcome === 'hamster_win') return FOX_WIN_PENALTY
  return 0.0
}

// re-export for downstream tooling
export const _internals = { popCount32 }
