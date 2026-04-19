/**
 * 背徳者視点の day vote 分析。
 *
 * 背徳者は狐位置 (knownHamster) を知る。陣営目的は狐勝ち (P(hamster_won) 最大)。
 * 自分の生死は陣営勝敗に関係しない (背徳者死亡 ≠ 陣営敗北) ので、
 * 自席を vote 候補から除外する積極的理由はない。
 *
 * 実装: hamster-analysis を「狐の代理視点」で呼ぶラッパー。
 *   - mySeat = knownHamster として渡す → 狐席が bestVote から除外される
 *   - 結果型は HamsterVoteAnalysis をそのまま再利用
 */

import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import { analyzeHamsterVotesByWorld, type HamsterVoteAnalysis } from './hamster-analysis.ts'

export type ImmoralistVoteAnalysis = HamsterVoteAnalysis

/**
 * 背徳者視点の day vote 分析。
 *
 * @param knownHamsterSeat - 背徳者が知っている狐の seat
 *                           （死亡している場合は呼び出し前に判定。死亡狐ならこの analysis 不要）
 */
export function analyzeImmoralistVotesByWorld(
  possibilities: Possibilities,
  setup: Map<SystemRole, number>,
  vs: VillageStatus,
  knownHamsterSeat: Seat,
  maxWorlds?: number,
): ImmoralistVoteAnalysis {
  // hamster-analysis の mySeat = 狐席として呼ぶ。
  // 結果として bestVote は「狐席を除いた中で hamster_winRate 最大」になる。
  // candidates の isSelf は「狐席であるかどうか」を意味する（背徳者の自席ではない）
  return analyzeHamsterVotesByWorld(possibilities, setup, vs, knownHamsterSeat, maxWorlds)
}
