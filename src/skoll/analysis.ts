/**
 * 吊り候補別の勝率分析。
 *
 * branches.ts の世界分岐と winrate.ts の再帰計算を組み合わせ、
 * 各生存 seat を処刑した場合の村勝率を算出する。
 */

import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { ExecutionAnalysis, ExecutionOutcome, Branch, SeatClassification } from './types.ts'
import { buildBranches, type SeatPossibilityMap } from './branches.ts'
import { computeWinRate } from './winrate.ts'

/**
 * 各吊り候補の村勝率を計算する。
 *
 * @param vs - 村の現在状態
 * @param setup - 役職構成
 * @param retarPossibilities - Retar の分析結果（省略時は均等重み）
 * @returns 吊り候補ごとの勝率 + 最善手
 */
export function analyzeExecutions(
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
  retarPossibilities?: SeatPossibilityMap,
): ExecutionAnalysis {
  const branches = buildBranches(vs, setup, retarPossibilities)
  const cache = new Map<number, number>()

  // 全体の勝率（現状評価、特定の吊りを指定せず）
  let overallWinRate = 0
  for (const branch of branches) {
    const cl = branch.classification
    const wr = computeWinRate(cl.grayCount, cl.wolvesInGray, cl.confirmedVillageCount, cl.totalAlive, cache)
    overallWinRate += wr * branch.weight
  }

  // 生存 seat の一覧
  const aliveSeats: Seat[] = []
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }

  // 各 seat の吊り勝率
  const executions: ExecutionOutcome[] = []
  for (const seat of aliveSeats) {
    let weightedWinRate = 0
    for (const branch of branches) {
      const wr = computeExecutionWinRateInBranch(branch, seat, cache)
      weightedWinRate += wr * branch.weight
    }
    executions.push({ seat, winRate: weightedWinRate })
  }

  // 最善手
  let bestExecution = aliveSeats[0]
  let bestWinRate = -1
  for (const ex of executions) {
    if (ex.winRate > bestWinRate) {
      bestWinRate = ex.winRate
      bestExecution = ex.seat
    }
  }

  const fallback = branches.length === 1 && branches[0].trueSeer === null
    && branches[0].fakeSeats.length === 0

  return { branches, overallWinRate, executions, bestExecution, fallback }
}

/**
 * 特定の分岐内で、seat を処刑した場合の村勝率を計算する。
 */
function computeExecutionWinRateInBranch(
  branch: Branch,
  executedSeat: Seat,
  cache: Map<number, number>,
): number {
  const cl = branch.classification
  const category = cl.categories.get(executedSeat)

  if (category === 'dead') return 0

  switch (category) {
    case 'confirmed_wolf':
      return winRateAfterExecutingWolf(cl, cache)
    case 'confirmed_village':
      return winRateAfterExecutingVillage(cl, cache)
    case 'gray':
      return winRateAfterExecutingGray(cl, cache)
    default:
      return 0
  }
}

/**
 * 確定狼を処刑した場合。
 * confirmedWolf は gray 外なので gray 数は変わらない。
 */
function winRateAfterExecutingWolf(
  cl: SeatClassification,
  cache: Map<number, number>,
): number {
  const totalWolves = cl.wolvesInGray + cl.confirmedWolfCount
  if (totalWolves <= 1) {
    // 最後の狼を処刑 → 即勝ち
    return 1.0
  }

  // 処刑後: alive-1, confirmedWolf-1。次は夜フェーズ。
  const nextAlive = cl.totalAlive - 1
  const nextConfirmedWolf = cl.confirmedWolfCount - 1
  const nextTotalWolves = cl.wolvesInGray + nextConfirmedWolf

  // PP チェック（処刑後、夜に入る前）
  if (nextTotalWolves * 2 >= nextAlive) return 0.0

  // 夜: 狼が1人噛む
  if (cl.confirmedVillageCount > 0) {
    return computeWinRate(
      cl.grayCount, cl.wolvesInGray, cl.confirmedVillageCount - 1, nextAlive - 1, cache,
    )
  } else if (cl.grayCount > 0) {
    return computeWinRate(
      cl.grayCount - 1, cl.wolvesInGray, 0, nextAlive - 1, cache,
    )
  }
  return 0
}

/**
 * 確定村を処刑した場合（ミス確定）。
 */
function winRateAfterExecutingVillage(
  cl: SeatClassification,
  cache: Map<number, number>,
): number {
  const nextAlive = cl.totalAlive - 1
  const totalWolves = cl.wolvesInGray + cl.confirmedWolfCount

  // PP チェック
  if (totalWolves * 2 >= nextAlive) return 0.0

  // 夜: 狼が噛む
  const nextConfirmed = cl.confirmedVillageCount - 1
  if (nextConfirmed > 0) {
    return computeWinRate(
      cl.grayCount, cl.wolvesInGray, nextConfirmed - 1, nextAlive - 1, cache,
    )
  } else if (cl.grayCount > 0) {
    return computeWinRate(
      cl.grayCount - 1, cl.wolvesInGray, 0, nextAlive - 1, cache,
    )
  }
  return 0
}

/**
 * グレーを処刑した場合。
 * 狼を引く確率 = wolvesInGray / grayCount
 */
function winRateAfterExecutingGray(
  cl: SeatClassification,
  cache: Map<number, number>,
): number {
  if (cl.grayCount <= 0) return 0
  const pHit = cl.wolvesInGray / cl.grayCount

  // 命中 → 狼が1匹減る
  let winIfHit: number
  const wolvesAfterHit = cl.wolvesInGray - 1
  const totalWolvesAfterHit = wolvesAfterHit + cl.confirmedWolfCount
  if (totalWolvesAfterHit <= 0) {
    winIfHit = 1.0
  } else {
    const nextAlive = cl.totalAlive - 1
    if (totalWolvesAfterHit * 2 >= nextAlive) {
      winIfHit = 0.0
    } else if (cl.confirmedVillageCount > 0) {
      winIfHit = computeWinRate(
        cl.grayCount - 1, wolvesAfterHit, cl.confirmedVillageCount - 1, nextAlive - 1, cache,
      )
    } else {
      winIfHit = computeWinRate(
        cl.grayCount - 2, wolvesAfterHit, 0, nextAlive - 1, cache,
      )
    }
  }

  // ハズレ → 村人グレーが1人減る
  let winIfMiss: number
  const nextAlive = cl.totalAlive - 1
  const totalWolves = cl.wolvesInGray + cl.confirmedWolfCount
  if (totalWolves * 2 >= nextAlive) {
    winIfMiss = 0.0
  } else if (cl.confirmedVillageCount > 0) {
    winIfMiss = computeWinRate(
      cl.grayCount - 1, cl.wolvesInGray, cl.confirmedVillageCount - 1, nextAlive - 1, cache,
    )
  } else {
    winIfMiss = computeWinRate(
      cl.grayCount - 2, cl.wolvesInGray, 0, nextAlive - 1, cache,
    )
  }

  return pHit * winIfHit + (1 - pHit) * winIfMiss
}
