/**
 * ワールド列挙ベースの狼襲撃先分析。
 *
 * analyzeExecutionsByWorld の狼版。
 * 各ワールドで各噛み候補を試し、狼の勝率を計算する。
 *
 * 勝率の扱い:
 * - terminal `wolf_win` → 1.0（狼勝ち）
 * - terminal `village_win` → 0.0（村に敗北）
 * - terminal `hamster_win` → `WOLF_FOX_WIN_PENALTY`（狐勝は狼にとっても敗北。
 *   ただし狼は狐を直接噛めないため、ペナルティは村側 (-0.5) より弱めの -0.1 デフォルト）
 * - ongoing → `1 - minimaxWinRate` で近似（`P(wolf_win) + P(hamster_win)` を
 *   含むため将来の狐勝分を過大評価する近似。狐リスクが高い盤面では要改善）
 */

import type { SystemRole, Seat } from '../types/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import type { World } from '../hati/types.ts'
import { popCount32, maskFromSeats, hasSeat, removeSeat, seatsFromMask } from '../hati/types.ts'
import { enumerateWorlds } from '../hati/worlds.ts'
import { checkOutcome, applyFollowDeaths, validBiteTargetsMask } from '../hati/simulate.ts'
import { minimaxWinRate } from './winrate.ts'
import { DEFAULT_MAX_WORLDS } from './constants.ts'

export type WorldAttackAnalysis = {
  totalWorlds: number
  truncated: boolean
  attacks: { seat: Seat, wolfWinRate: number }[]
  /** 最も狼勝率が高い噛み先 */
  bestAttack: Seat
}

/**
 * ワールド列挙ベースで各噛み候補の狼勝率を計算する。
 *
 * 各ワールドで各 seat を噛んだ場合の結果を計算し、
 * 有効な噛み先（validBiteTargetsMask）に限定して平均を取る。
 * ongoing の場合は minimaxWinRate（日フェーズ開始）で近似する。
 *
 * 猫又噛み: 猫又 + 噛んだ狼が道連れ退場。全生存狼を attackerとした平均を取る。
 * 妖狐噛み: 妖狐は噛まれても死なない。alive 変化なし。
 *
 * @param wolfSeats - 狼チームの seat 集合（噛み候補から除外）
 */
export function analyzeAttacksByWorld(
  possibilities: Possibilities,
  setup: Map<SystemRole, number>,
  aliveNowSeats: Seat[],
  wolfSeats: Set<number>,
  maxWorlds: number = DEFAULT_MAX_WORLDS,
): WorldAttackAnalysis {
  // `aliveNowSeats` は呼び出し側の現在の生存席リスト（vs.statuses は Retar 実行
  // 時点のスナップショットなので、当日の処刑が反映されない夜時点では使えない）
  const aliveSeats = aliveNowSeats
  const candidateSeats: Seat[] = aliveNowSeats.filter(s => !wolfSeats.has(s))
  const alive = maskFromSeats(aliveSeats)

  // 各 seat の累積狼勝率スコアと有効ワールド数
  const wolfWinScores = new Float64Array(candidateSeats.length)
  const worldCounts = new Uint32Array(candidateSeats.length)
  let totalWorlds = 0
  let truncated = false

  const cache = new Map<number, number>()

  enumerateWorlds(possibilities, setup, (world) => {
    totalWorlds++
    const validMask = validBiteTargetsMask(world, alive)

    for (let i = 0; i < candidateSeats.length; i++) {
      const target = candidateSeats[i]
      if (!hasSeat(validMask, target)) continue

      worldCounts[i]++

      if ((world.hamsterMask & (1 << target)) !== 0) {
        // 妖狐は噛まれても死なない → alive 変化なし
        const outcome = checkOutcome(world, alive)
        if (outcome === 'wolf_win') {
          wolfWinScores[i] += 1.0
        } else if (outcome === 'hamster_win') {
          wolfWinScores[i] += FOX_WIN_PENALTY
        } else if (outcome === 'ongoing') {
          wolfWinScores[i] += 1.0 - estimateOngoingAttackWinRate(world, alive, cache)
        }
        // village_win → 0
      } else if ((world.nekomataMask & (1 << target)) !== 0) {
        // 猫又噛み: 猫又 + 噛んだ狼が道連れ退場（全生存狼で平均）
        const aliveWolfSeats = seatsFromMask(world.wolfMask & alive)
        // LW は validBiteTargetsMask が猫又を除外するので aliveWolfSeats.length >= 2 のはず
        if (aliveWolfSeats.length === 0) continue
        const afterNekomata = removeSeat(alive, target)
        let score = 0
        for (const wolfSeat of aliveWolfSeats) {
          const afterBoth = removeSeat(afterNekomata, wolfSeat)
          const afterFollow = applyFollowDeaths(afterBoth, world)
          const outcome = checkOutcome(world, afterFollow)
          if (outcome === 'wolf_win') {
            score += 1.0
          } else if (outcome === 'hamster_win') {
            score += FOX_WIN_PENALTY
          } else if (outcome === 'ongoing') {
            score += 1.0 - estimateOngoingAttackWinRate(world, afterFollow, cache)
          }
          // village_win → 0
        }
        wolfWinScores[i] += score / aliveWolfSeats.length
      } else {
        // 通常の噛み
        const afterBite = removeSeat(alive, target)
        const afterFollow = applyFollowDeaths(afterBite, world)
        const outcome = checkOutcome(world, afterFollow)
        if (outcome === 'wolf_win') {
          wolfWinScores[i] += 1.0
        } else if (outcome === 'hamster_win') {
          wolfWinScores[i] += FOX_WIN_PENALTY
        } else if (outcome === 'ongoing') {
          wolfWinScores[i] += 1.0 - estimateOngoingAttackWinRate(world, afterFollow, cache)
        }
        // village_win → 0
      }
    }

    if (totalWorlds >= maxWorlds) {
      truncated = true
      return false
    }
  })

  if (totalWorlds === 0 || candidateSeats.length === 0) {
    return {
      totalWorlds: 0,
      truncated: false,
      attacks: candidateSeats.map(seat => ({ seat, wolfWinRate: 0 })),
      bestAttack: candidateSeats[0] ?? 0,
    }
  }

  const attacks: { seat: Seat, wolfWinRate: number }[] = []
  let bestSeat = candidateSeats[0]
  let bestRate = -1

  for (let i = 0; i < candidateSeats.length; i++) {
    const wolfWinRate = worldCounts[i] > 0 ? wolfWinScores[i] / worldCounts[i] : 0
    attacks.push({ seat: candidateSeats[i], wolfWinRate })
    if (wolfWinRate > bestRate && worldCounts[i] > 0) {
      bestRate = wolfWinRate
      bestSeat = candidateSeats[i]
    }
  }

  return { totalWorlds, truncated, attacks, bestAttack: bestSeat }
}

/**
 * 狐勝終端への狼側ペナルティ。
 *
 * 狼は狐を直接噛み殺せない（免疫）ため、村陣営の `FOX_WIN_PENALTY` (-0.5) ほど
 * 強く働かせても「terminal で狐勝になる攻撃を避ける」程度にしか影響せず、
 * かえって局所最適化を歪めるリスクがある。そのため狼側は `WOLF_FOX_WIN_PENALTY`
 * として独立パラメータにし、デフォルトを弱めの -0.1 に設定する。
 * 将来 ongoing 推定が狐勝率を分離できるようになった時点で再検討する。
 */
const FOX_WIN_PENALTY = Number(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['WOLF_FOX_WIN_PENALTY']
  ?? '-0.1',
)

/**
 * 噛み後の村勝率をミニマックスで推定する（日フェーズ開始）。
 *
 * 噛みが解決した後は昼（処刑フェーズ）から始まるため、
 * minimaxWinRate（日フェーズ開始）を使用する。
 * estimateOngoingWinRate（処刑後 → 夜開始）とは位相が異なる点に注意。
 * 当夜の占い呪殺は minimaxWinRate 内の将来夜として評価される（近似）。
 */
function estimateOngoingAttackWinRate(
  world: World,
  aliveAfterAttack: number,
  cache: Map<number, number>,
): number {
  const wolves = popCount32(world.wolfMask & aliveAfterAttack)
  const foxes = popCount32(world.hamsterMask & aliveAfterAttack)
  const nekomata = popCount32(world.nekomataMask & aliveAfterAttack)
  const seerAlive = (world.seerMask & aliveAfterAttack) !== 0
  const mediumAlive = (world.mediumMask & aliveAfterAttack) !== 0
  const bodyguardAlive = world.bodyguardSeat >= 0 && hasSeat(aliveAfterAttack, world.bodyguardSeat)
  const aliveTotal = popCount32(aliveAfterAttack)
  const grays = aliveTotal - (seerAlive ? 1 : 0) - (mediumAlive ? 1 : 0) - (bodyguardAlive ? 1 : 0) - nekomata

  return minimaxWinRate(wolves, foxes, grays, 0, 0, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
}
