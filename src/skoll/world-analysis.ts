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
import { popCount32, maskFromSeats, hasSeat, removeSeat, seatsFromMask, getGuardSeat } from '../hati/types.ts'
import { enumerateWorlds } from '../hati/worlds.ts'
import { checkOutcome, applyExecution } from '../hati/simulate.ts'
import { minimaxNightWinRate } from './winrate.ts'
import { DEFAULT_MAX_WORLDS } from './constants.ts'

export type WorldExecutionAnalysis = {
  totalWorlds: number
  truncated: boolean
  executions: { seat: Seat, winRate: number }[]
  bestExecution: Seat
  overallWinRate: number
}

/**
 * ワールド列挙ベースで各吊り候補の村勝率を計算する。
 *
 * 各ワールドで各 seat を処刑した場合の結果を正確に計算し、
 * 全ワールドで平均を取る。ongoing の場合は computeWinRate で近似。
 *
 * 霊媒が生存している場合は処刑者の黒/白結果でワールドをグループ化し、
 * 各グループ内で勝率を計算する（情報更新モデル）。
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

  // ワールドのスコアは (attackCapableMask, dieWhenDivinedMask, divineCapableMask, mediumshipMask, curseOnExecutedMask, guardSeat)
  // だけに依存する。villager/mason/fanatic/possessed/immoralist の配置違いでは同じスコアになる。
  // 同一シグネチャのワールドをまとめてキャッシュする。
  //
  // キーは 2 段の数値 Map:
  //   key1 = attackCapableMask | (dieWhenDivinedMask << 15)          (30bit, SMI)
  //   key2 = divineCapableMask + mediumshipMask*2^15 + curseOnExecutedMask*2^30 + (guardSeat+2)*2^45  (safe integer)
  // 文字列キー版より alloc/ハッシュコストが小さい。
  const sigCache = new Map<number, Map<number, Float64Array>>()

  enumerateWorlds(possibilities, setup, (world) => {
    totalWorlds++

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
      scores = computeScoresForWorld(world, aliveSeats, alive, cache)
      inner.set(key2, scores)
    }
    for (let i = 0; i < aliveSeats.length; i++) {
      winScores[i] += scores[i]
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
 * 1ワールド分の各 seat 処刑スコアを計算する。
 * 同一シグネチャのワールド間でキャッシュ可能な純関数。
 *
 * `recursiveSkoll` (src/skoll/recursive.ts) も day-2 leaf 評価で再利用する。
 */
export function computeScoresForWorld(
  world: World,
  aliveSeats: Seat[],
  alive: number,
  cache: Map<number, number>,
): Float64Array {
  const scores = new Float64Array(aliveSeats.length)
  for (let i = 0; i < aliveSeats.length; i++) {
    const target = aliveSeats[i]
    const afterExec = applyExecution(alive, target)

    if ((world.curseOnExecutedMask & (1 << target)) !== 0) {
      // 猫又処刑: ランダム1人道連れ退場 → 全候補で平均
      const curseCandidates = seatsFromMask(afterExec)
      if (curseCandidates.length === 0) {
        const outcome = checkOutcome(world, afterExec)
        if (outcome === 'village_win') scores[i] = 1.0
        else if (outcome === 'hamster_win') scores[i] = FOX_WIN_PENALTY
        else if (outcome === 'ongoing') scores[i] = estimateOngoingWinRate(world, target, afterExec, cache)
      } else {
        let cursedScore = 0
        for (const cursedSeat of curseCandidates) {
          const afterCurse = removeSeat(afterExec, cursedSeat)
          const outcome = checkOutcome(world, afterCurse)
          if (outcome === 'village_win') cursedScore += 1.0
          else if (outcome === 'hamster_win') cursedScore += FOX_WIN_PENALTY
          else if (outcome === 'ongoing') cursedScore += estimateOngoingWinRate(world, target, afterCurse, cache)
        }
        scores[i] = cursedScore / curseCandidates.length
      }
    } else {
      const outcome = checkOutcome(world, afterExec)
      if (outcome === 'village_win') scores[i] = 1.0
      else if (outcome === 'hamster_win') scores[i] = FOX_WIN_PENALTY
      else if (outcome === 'ongoing') scores[i] = estimateOngoingWinRate(world, target, afterExec, cache)
    }
  }
  return scores
}

/**
 * 処刑直後に狐勝ちが確定する（hamster_win）ワールドへのペナルティ。
 *
 * 通常 hamster_win は score += 0 だが、マイナスにすることで
 * 「狼を全滅させるが狐が残る」処刑先を積極的に忌避させる。
 * 環境変数 FOX_WIN_PENALTY で上書き可能（例: FOX_WIN_PENALTY=-1）。
 */
export const FOX_WIN_PENALTY = Number(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['FOX_WIN_PENALTY']
  ?? '-0.5',
)

/**
 * ongoing ワールドの後続勝率をミニマックスで推定する。
 *
 * 具体的ワールド（役職確定）の情報を抽象状態に変換し、
 * minimaxWinRate（村 MAX / 狼 MIN の完全ミニマックス）を呼ぶ。
 *
 * 抽象状態への変換:
 * - wolves/foxes/nekomata: ワールド確定値
 * - seer/medium/bodyguard: 生存フラグ
 * - grays: 役職不明プール = alive - 特殊役職
 * - confirmedVillage/confirmedWolves: 今後の占い確定の初期値（= 0）
 *
 * ミニマックスが担う処理（旧モデルからの改善点）:
 * - 狼が最善の噛み先を選ぶ（占い師・霊媒・狩人を優先的に狙う）
 * - 占い師の結果が複数夜にわたって蓄積する
 * - 確定狼は翌日確実に処刑される（발見即退場なし）
 * - 猫又噛みの道連れは minimax 内の選択肢として評価される
 */
function estimateOngoingWinRate(
  world: World,
  _executedSeat: Seat,
  aliveAfterExec: number,
  cache: Map<number, number>,
): number {
  const wolves = popCount32(world.attackCapableMask & aliveAfterExec)
  const foxes = popCount32(world.dieWhenDivinedMask & aliveAfterExec)
  const nekomata = popCount32(world.curseOnExecutedMask & aliveAfterExec)
  const seerAlive = (world.divineCapableMask & aliveAfterExec) !== 0
  const mediumAlive = (world.mediumshipMask & aliveAfterExec) !== 0
  const bodyguardSeat = getGuardSeat(world)
  const bodyguardAlive = bodyguardSeat >= 0 && hasSeat(aliveAfterExec, bodyguardSeat)
  const aliveTotal = popCount32(aliveAfterExec)
  // grays = 役職不明プール（狼・狐・村人の混在、特殊役職を除く）
  const grays = aliveTotal - (seerAlive ? 1 : 0) - (mediumAlive ? 1 : 0) - (bodyguardAlive ? 1 : 0) - nekomata

  return minimaxNightWinRate(wolves, foxes, grays, 0, 0, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
}
