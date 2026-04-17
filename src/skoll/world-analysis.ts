/**
 * ワールド列挙ベースの吊り分析。
 *
 * Hati の enumerateWorlds で全ワールドを列挙し、
 * 各ワールド × 各吊り候補の正確な勝率を計算する。
 *
 * CO分岐モデルと異なり、wolf/possessed 区別・退場者の狼数が
 * 各ワールドで確定しているため正確な結果が出る。
 */

import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import type { World } from '../hati/types.ts'
import { popCount32, maskFromSeats, hasSeat } from '../hati/types.ts'
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
 * - 占い師: 夜の占い結果を確率的にモデリング（狼発見/白発見/呪殺）
 * - 狩人: 護衛成功で噛みブロックの確率を考慮
 * - 狐: 生存している場合、狼全滅でも狐勝ちになる。呪殺・処刑でのみ死ぬ。
 */
function estimateOngoingWinRate(
  world: World,
  aliveAfterExec: number,
  cache: Map<number, number>,
): number {
  const aliveWolves = popCount32(world.wolfMask & aliveAfterExec)
  const aliveFoxes = popCount32(world.hamsterMask & aliveAfterExec)
  const aliveTotal = popCount32(aliveAfterExec)
  // 非狼非狐の生存数（PP 判定で使う非狼陣営の母数）
  const aliveNonWolvesNonFoxes = aliveTotal - aliveWolves - aliveFoxes

  // 狼全滅: 狐が残っていれば狐勝ち、いなければ村勝ち
  if (aliveWolves <= 0) return aliveFoxes <= 0 ? 1.0 : 0.0
  // PP: 2w + f >= alive（checkOutcome の非狼非狐カウントに一致）
  if (2 * aliveWolves + aliveFoxes >= aliveTotal) return 0.0
  if (aliveNonWolvesNonFoxes <= 0) return 0.0

  const seerAlive = (world.seerMask & aliveAfterExec) !== 0
  const bodyguardAlive = world.bodyguardSeat >= 0
    && hasSeat(aliveAfterExec, world.bodyguardSeat)

  // 基本: 夜に狼が非狼非狐を1人噛む
  const rateNoGuard = estimateNextDay(aliveTotal - 1, aliveWolves, aliveFoxes, seerAlive, cache)

  if (bodyguardAlive && aliveTotal > 2) {
    // 狩人生存: 護衛成功なら噛みブロック（alive 維持）
    // GJ の価値はパリティ依存:
    //   aliveTotal が奇数 → GJ で偶数落ちを防ぎ +1 処刑機会（有効）
    //   aliveTotal が偶数 → GJ で密度希釈のみ（モデル上逆効果、実際は中立）
    // ランダム処刑モデルの限界で偶数時に負になるため、ボーナスを非負にクランプ。
    const pBlock = 1 / (aliveTotal - 1)
    const rateWithGuard = estimateNextDay(aliveTotal, aliveWolves, aliveFoxes, seerAlive, cache)
    const guardBonus = Math.max(0, rateWithGuard - rateNoGuard)
    return rateNoGuard + pBlock * guardBonus
  }

  return rateNoGuard
}

/**
 * 夜通過後の翌日勝率を推定する。
 * 占い師が生存していれば占い結果を織り込む（呪殺含む）。
 */
function estimateNextDay(
  nextAlive: number,
  wolves: number,
  foxes: number,
  seerAlive: boolean,
  cache: Map<number, number>,
): number {
  if (wolves <= 0) return foxes <= 0 ? 1.0 : 0.0
  if (2 * wolves + foxes >= nextAlive) return 0.0
  if (nextAlive - wolves - foxes <= 0) return 0.0

  const grays = nextAlive // 全員グレー扱い（狼・狐含む）

  // 占い師が生存 → 夜の占い結果を織り込む
  if (seerAlive && grays > 1) {
    const pWolf = wolves / grays
    const pFox = foxes / grays
    const pHuman = (grays - wolves - foxes) / grays

    // 狼発見 → 翌日確定吊り（wolves-1）
    const rateIfWolf = computeWinRate(grays - 1, wolves - 1, foxes, 0, nextAlive, cache)
    // 狐占い → 呪殺（狐退場）: foxes-1、alive-1 追加減少、占い結果は「人」で情報価値なし
    const rateIfFox = foxes > 0
      ? computeWinRate(grays - 1, wolves, foxes - 1, 0, nextAlive - 1, cache)
      : 0
    // 白発見 → グレー-1, 確定村+1（狐ではないことは保証されないが v1 は近似）
    const rateIfHuman = computeWinRate(grays - 1, wolves, foxes, 1, nextAlive, cache)

    return pWolf * rateIfWolf + pFox * rateIfFox + pHuman * rateIfHuman
  }

  return computeWinRate(grays, wolves, foxes, 0, nextAlive, cache)
}
