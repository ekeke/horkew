/**
 * 狐視点の day vote 分析。
 *
 * 各 vote 候補について、執行後の hamster_won 確率を計算する。
 * Q2=C 方針: hati の per-world simulate を用いて厳密 hamster winrate を算出。
 *
 * 出力:
 *   - 各 alive seat の hamsterWinRate
 *   - bestVote: 自席を除いた中で hamsterWinRate 最大の seat
 *
 * 自席除外: 狐は自分が吊られたら即敗北 (検証用に分かりやすくするため、bestVote では除外)
 *
 * 注意:
 *   - 自席が引数で渡される (mySeat)。これは agent が分かっている前提
 *   - immoralist (背徳者) が知ってる狐位置は本 analysis では使わない
 *     （背徳者用の analyzer は別途 immoralist-analysis.ts で wrap する）
 */

import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import type { World } from '../hati/types.ts'
import { popCount32, maskFromSeats, hasSeat, removeSeat, seatsFromMask } from '../hati/types.ts'
import { enumerateWorlds } from '../hati/worlds.ts'
import { checkOutcome, applyExecution } from '../hati/simulate.ts'
import { minimaxNightHamsterRate } from './hamsterWinrate.ts'
import { DEFAULT_MAX_WORLDS } from './constants.ts'

export type HamsterVoteCandidate = {
  seat: Seat
  hamsterWinRate: number
  /** mySeat と一致する候補 (自席) */
  isSelf: boolean
}

export type HamsterVoteAnalysis = {
  totalWorlds: number
  truncated: boolean
  candidates: HamsterVoteCandidate[]
  bestVote: Seat | null
  /** 全候補で重み付け平均した hamster 勝率（vote しない場合の参考値ではなく overall） */
  overallHamsterWinRate: number
}

/**
 * 狐視点の day vote 分析。
 *
 * @param mySeat - 狐自身の seat（vote 候補から除外）
 */
export function analyzeHamsterVotesByWorld(
  possibilities: Possibilities,
  setup: Map<SystemRole, number>,
  vs: VillageStatus,
  mySeat: Seat,
  maxWorlds: number = DEFAULT_MAX_WORLDS,
): HamsterVoteAnalysis {
  const aliveSeats: Seat[] = []
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }
  const alive = maskFromSeats(aliveSeats)

  const winScores = new Float64Array(aliveSeats.length)
  let totalWorlds = 0
  let truncated = false

  const cache = new Map<number, number>()

  // sigCache: 既存 world-analysis と同じ署名キャッシュ
  const sigCache = new Map<number, Map<number, Float64Array>>()

  enumerateWorlds(possibilities, setup, (world) => {
    totalWorlds++

    const key1 = world.wolfMask | (world.hamsterMask << 15)
    const key2 = world.seerMask
      + world.mediumMask * 0x8000
      + world.nekomataMask * 0x40000000
      + (world.bodyguardSeat + 2) * 0x200000000000
    let inner = sigCache.get(key1)
    if (inner === undefined) {
      inner = new Map()
      sigCache.set(key1, inner)
    }
    let scores = inner.get(key2)
    if (scores === undefined) {
      scores = computeHamsterScoresForWorld(world, aliveSeats, alive, cache)
      inner.set(key2, scores)
    }
    for (let i = 0; i < aliveSeats.length; i++) {
      winScores[i] += scores[i]
    }

    if (totalWorlds >= maxWorlds) {
      truncated = true
      return false
    }
  })

  if (totalWorlds === 0) {
    return {
      totalWorlds: 0,
      truncated: false,
      candidates: aliveSeats.map(seat => ({ seat, hamsterWinRate: 0, isSelf: seat === mySeat })),
      bestVote: null,
      overallHamsterWinRate: 0,
    }
  }

  const candidates: HamsterVoteCandidate[] = []
  let bestSeat: Seat | null = null
  let bestRate = -Infinity
  let overallRate = 0

  for (let i = 0; i < aliveSeats.length; i++) {
    const seat = aliveSeats[i]
    const rate = winScores[i] / totalWorlds
    const isSelf = seat === mySeat
    candidates.push({ seat, hamsterWinRate: rate, isSelf })
    overallRate += rate
    if (!isSelf && rate > bestRate) {
      bestRate = rate
      bestSeat = seat
    }
  }
  overallRate /= aliveSeats.length

  return {
    totalWorlds,
    truncated,
    candidates,
    bestVote: bestSeat,
    overallHamsterWinRate: overallRate,
  }
}

/** 1ワールド分の各 seat 処刑後の hamster_won 確率を計算 */
function computeHamsterScoresForWorld(
  world: World,
  aliveSeats: Seat[],
  alive: number,
  cache: Map<number, number>,
): Float64Array {
  const scores = new Float64Array(aliveSeats.length)
  for (let i = 0; i < aliveSeats.length; i++) {
    const target = aliveSeats[i]
    const afterExec = applyExecution(alive, target)

    if ((world.nekomataMask & (1 << target)) !== 0) {
      // 猫又処刑: ランダム1人道連れ
      const curseCandidates = seatsFromMask(afterExec)
      if (curseCandidates.length === 0) {
        scores[i] = scoreOutcome(world, afterExec, target, cache)
      } else {
        let cursedScore = 0
        for (const cursedSeat of curseCandidates) {
          const afterCurse = removeSeat(afterExec, cursedSeat)
          cursedScore += scoreOutcome(world, afterCurse, target, cache)
        }
        scores[i] = cursedScore / curseCandidates.length
      }
    } else {
      scores[i] = scoreOutcome(world, afterExec, target, cache)
    }
  }
  return scores
}

function scoreOutcome(world: World, afterExec: number, _executedSeat: Seat, cache: Map<number, number>): number {
  const outcome = checkOutcome(world, afterExec)
  if (outcome === 'hamster_win') return 1.0
  if (outcome === 'village_win' || outcome === 'wolf_win') return 0.0
  // ongoing: minimax で hamster_winrate を計算
  return estimateOngoingHamsterRate(world, afterExec, cache)
}

function estimateOngoingHamsterRate(
  world: World,
  aliveAfterExec: number,
  cache: Map<number, number>,
): number {
  const wolves = popCount32(world.wolfMask & aliveAfterExec)
  const foxes = popCount32(world.hamsterMask & aliveAfterExec)
  const nekomata = popCount32(world.nekomataMask & aliveAfterExec)
  const seerAlive = (world.seerMask & aliveAfterExec) !== 0
  const mediumAlive = (world.mediumMask & aliveAfterExec) !== 0
  const bodyguardAlive = world.bodyguardSeat >= 0 && hasSeat(aliveAfterExec, world.bodyguardSeat)
  const aliveTotal = popCount32(aliveAfterExec)
  const grays = aliveTotal - (seerAlive ? 1 : 0) - (mediumAlive ? 1 : 0) - (bodyguardAlive ? 1 : 0) - nekomata

  return minimaxNightHamsterRate(wolves, foxes, grays, 0, 0, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
}
