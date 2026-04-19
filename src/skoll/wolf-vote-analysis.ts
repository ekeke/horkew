/**
 * 狼視点の day vote 分析。
 *
 * 既存 `analyzeExecutionsByWorld` を流用し、村陣営勝率を反転して狼陣営の vote 評価を行う。
 *
 * 機能:
 *   - knownWolves による teammates 除外（仲間に投票して吊らせない）
 *   - PP shortcut (Q1=A 安全派): knownWolves と alive 状態から「既達 PP」「execution で PP 確定」を検出
 *   - 狼勝率近似: (1 - villageWinRate)
 *     ※ hamster 存在時は若干過大評価（hamster_win は wolf_win と区別されない）
 *     ※ 厳密 hamster handling は hamster-analysis.ts 側で扱う
 */

import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import { RoleBitIndex } from '../retar/possibilities.ts'
import { analyzeExecutionsByWorld } from './world-analysis.ts'

export type WolfVoteCandidate = {
  seat: Seat
  /** 1 - villageWinRate （hamster 存在時は近似） */
  wolfWinRate: number
  /** knownWolves に含まれる仲間 seat */
  isTeammate: boolean
}

export type WolfVoteAnalysis = {
  totalWorlds: number
  truncated: boolean
  candidates: WolfVoteCandidate[]
  /** 最善 vote 先（teammates 除外、wolfWinRate 最大、PP 確定 seat があればそれを優先） */
  bestVote: Seat | null
  /** PP 既達: vote 結果と無関係に狼陣営勝利が確定している */
  ppAlreadyAchieved: boolean
  /** この seat を吊れば PP 確定（teammates でない seat のみ） */
  ppByExecution: Seat[]
}

const HAMSTER_BIT = 1 << RoleBitIndex.werehamster
const WOLF_BIT = 1 << RoleBitIndex.werewolf
const FANATIC_BIT = 1 << RoleBitIndex.fanatic

/**
 * 狼陣営視点の day vote 分析。
 *
 * @param knownWolves - 狼エージェントが知っている仲間の seat 集合（自席含む）
 *                     fanatic も含めて wolf 陣営として扱う場合はここに含める
 */
export function analyzeWolfVotesByWorld(
  possibilities: Possibilities,
  setup: Map<SystemRole, number>,
  vs: VillageStatus,
  knownWolves: ReadonlySet<number>,
  maxWorlds?: number,
): WolfVoteAnalysis {
  const aliveSeats: Seat[] = []
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }

  // === PP shortcut (Q1=A 安全派) ===
  // 「PP 確定」= 2 * (確定 wolf 陣営) >= alive かつ hamster が確実に死んでいる
  //
  // wolf 陣営 = werewolf + fanatic
  // ただし fanatic 位置は private 情報がない場合 retar からは推定不可
  // → 「knownWolves が公開で確定した狼陣営の総数」と同等の前提でカウント
  //   (fanatic を含めたければ呼び出し側で knownWolves に追加する)

  const knownWolvesAlive = aliveSeats.filter(s => knownWolves.has(s)).length
  const aliveCount = aliveSeats.length

  // hamster 可能性: alive seats のいずれかに hamster bit が立っていれば「居る可能性あり」
  let hamsterPossiblyAlive = false
  for (const seat of aliveSeats) {
    if ((possibilities.possibilities[seat] & HAMSTER_BIT) !== 0) {
      hamsterPossiblyAlive = true
      break
    }
  }

  const ppAlreadyAchieved = (2 * knownWolvesAlive >= aliveCount) && !hamsterPossiblyAlive

  // 各 execution 後に PP 達成するか判定
  const ppByExecution: Seat[] = []
  for (const seat of aliveSeats) {
    if (knownWolves.has(seat)) continue  // teammate を吊るのは候補外

    // post-execution: alive -1、wolves はそのまま (teammate でないので)
    const postAlive = aliveCount - 1
    const postWolves = knownWolvesAlive

    // post hamster 可能性: 吊った seat 以外で hamster bit があるか
    let postHamsterPossible = false
    for (const s of aliveSeats) {
      if (s === seat) continue
      if ((possibilities.possibilities[s] & HAMSTER_BIT) !== 0) {
        postHamsterPossible = true
        break
      }
    }

    if (2 * postWolves >= postAlive && !postHamsterPossible) {
      ppByExecution.push(seat)
    }
  }

  // === 一般 vote 評価: 既存 village 分析を反転 ===
  const villageAnalysis = analyzeExecutionsByWorld(possibilities, setup, vs, maxWorlds)

  const candidates: WolfVoteCandidate[] = villageAnalysis.executions.map(e => ({
    seat: e.seat,
    wolfWinRate: 1 - e.winRate,
    isTeammate: knownWolves.has(e.seat),
  }))

  // bestVote: PP 確定 seat があればそれを優先、なければ teammate 除外で wolfWinRate 最大
  let bestVote: Seat | null = null
  if (ppByExecution.length > 0) {
    // PP 確定の中で最小 seat
    bestVote = ppByExecution.reduce((a, b) => a < b ? a : b)
  } else {
    let bestRate = -Infinity
    for (const c of candidates) {
      if (c.isTeammate) continue
      if (c.wolfWinRate > bestRate) {
        bestRate = c.wolfWinRate
        bestVote = c.seat
      }
    }
  }

  return {
    totalWorlds: villageAnalysis.totalWorlds,
    truncated: villageAnalysis.truncated,
    candidates,
    bestVote,
    ppAlreadyAchieved,
    ppByExecution,
  }
}

// 未使用の WOLF_BIT / FANATIC_BIT は将来の拡張用 (PP shortcut で fanatic 数を考慮する版)
void WOLF_BIT
void FANATIC_BIT
