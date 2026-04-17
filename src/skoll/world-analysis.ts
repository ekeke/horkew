/**
 * ワールド列挙ベースの吊り分析。
 *
 * Hati の enumerateWorlds で全ワールドを列挙し、
 * 各ワールド × 各吊り候補の正確な勝率を計算する。
 *
 * CO分岐モデルと異なり、wolf/possessed 区別・死亡者の狼数が
 * 各ワールドで確定しているため正確な結果が出る。
 */

import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import type { World } from '../hati/types.ts'
import { popCount32, maskFromSeats } from '../hati/types.ts'
import { enumerateWorlds } from '../hati/worlds.ts'
import { checkOutcome, applyExecution } from '../hati/simulate.ts'
import { computeWinRate } from './winrate.ts'

export type WorldExecutionAnalysis = {
  totalWorlds: number
  truncated: boolean
  executions: { seat: Seat, winRate: number }[]
  bestExecution: Seat
  overallWinRate: number
}

const DEFAULT_MAX_WORLDS = 500_000

/**
 * ワールド列挙ベースで各吊り候補の村勝率を計算する。
 *
 * 各ワールドで各 seat を処刑した場合の結果を正確に計算し、
 * 全ワールドで平均を取る。ongoing の場合は computeWinRate で近似。
 */
export function analyzeExecutionsByWorld(
  possibilities: Possibilities,
  setup: Map<SystemRole, number>,
  vs: VillageStatus,
  maxWorlds: number = DEFAULT_MAX_WORLDS,
): WorldExecutionAnalysis {
  // 生存 seat と alive マスクを構築
  const aliveSeats: Seat[] = []
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }
  const alive = maskFromSeats(aliveSeats)

  // 各 seat の累積勝率スコア
  const winScores = new Float64Array(aliveSeats.length)
  let totalWorlds = 0
  let truncated = false

  const cache = new Map<number, number>()

  enumerateWorlds(possibilities, setup, (world) => {
    totalWorlds++

    for (let i = 0; i < aliveSeats.length; i++) {
      const target = aliveSeats[i]
      const nextAlive = applyExecution(alive, target)
      const outcome = checkOutcome(world, nextAlive)

      if (outcome === 'village_win') {
        winScores[i] += 1.0
      } else if (outcome === 'ongoing') {
        winScores[i] += estimateOngoingWinRate(world, nextAlive, cache)
      }
      // wolf_win, hamster_win → 0
    }

    if (totalWorlds >= maxWorlds) {
      truncated = true
      return false // 列挙打ち切り
    }
  })

  if (totalWorlds === 0) {
    return {
      totalWorlds: 0,
      truncated: false,
      executions: aliveSeats.map(seat => ({ seat, winRate: 0 })),
      bestExecution: aliveSeats[0] ?? 0,
      overallWinRate: 0,
    }
  }

  // 各 seat の勝率を計算
  const executions: { seat: Seat, winRate: number }[] = []
  let bestSeat = aliveSeats[0]
  let bestRate = -1

  for (let i = 0; i < aliveSeats.length; i++) {
    const winRate = winScores[i] / totalWorlds
    executions.push({ seat: aliveSeats[i], winRate })
    if (winRate > bestRate) {
      bestRate = winRate
      bestSeat = aliveSeats[i]
    }
  }

  // overallWinRate: 最善手の勝率
  const overallWinRate = bestRate

  return {
    totalWorlds,
    truncated,
    executions,
    bestExecution: bestSeat,
    overallWinRate,
  }
}

/**
 * ongoing ワールドの後続勝率を推定する。
 *
 * 処刑後の盤面から夜を1回通過させ、翌日の盤面を computeWinRate で評価する。
 *
 * 真役職の生存を考慮:
 * - 占い師: 夜の占い結果を確率的にモデリング（狼発見/白発見）
 * - 狩人: 護衛成功で噛みブロックの確率を考慮
 */
function estimateOngoingWinRate(
  world: World,
  aliveAfterExec: number,
  cache: Map<number, number>,
): number {
  const aliveWolves = popCount32(world.wolfMask & aliveAfterExec)
  const aliveTotal = popCount32(aliveAfterExec)
  const aliveNonWolves = aliveTotal - aliveWolves

  if (aliveWolves <= 0) return 1.0
  if (aliveNonWolves <= 0) return 0.0

  const seerAlive = (world.seerMask & aliveAfterExec) !== 0

  // 夜: 狼が非狼を1人噛む
  // NOTE: 狩人の護衛ブロックは未モデル化。
  // computeWinRate の「ランダム処刑」仮定では、護衛成功（alive 維持）が
  // グレー狼密度の低下を招き逆効果になるため、正しくモデル化できない。
  return estimateNextDay(aliveTotal - 1, aliveWolves, seerAlive, cache)
}

/**
 * 夜通過後の翌日勝率を推定する。
 * 占い師が生存していれば占い結果を織り込む。
 */
function estimateNextDay(
  nextAlive: number,
  wolves: number,
  seerAlive: boolean,
  cache: Map<number, number>,
): number {
  if (wolves * 2 >= nextAlive) return 0.0
  if (wolves <= 0) return 1.0
  if (nextAlive - wolves <= 0) return 0.0

  const grays = nextAlive // 全員グレー扱い（狼含む）

  // 占い師が生存 → 夜の占い結果を織り込む
  if (seerAlive && grays > 1) {
    const pWolfFound = wolves / grays

    // 狼発見 → 翌日確定吊り（wolves-1）
    const rateIfWolf = computeWinRate(grays - 1, wolves - 1, 0, nextAlive, cache)
    // 白発見 → グレー-1, 確定村+1
    const rateIfHuman = computeWinRate(grays - 1, wolves, 1, nextAlive, cache)

    return pWolfFound * rateIfWolf + (1 - pWolfFound) * rateIfHuman
  }

  return computeWinRate(grays, wolves, 0, nextAlive, cache)
}
