/**
 * 狂信者視点の day vote 分析。
 *
 * fanatic は狼の位置を知るが (knownWolves)、狼ではないので投票時は
 * 自席含めて「狼陣営」として扱う:
 *   - 投票候補から自席と knownWolves を除外（仲間+自分への投票は損）
 *   - PP 計算に自分を含める（PP 条件は (wolf + fanatic) * 2 >= alive）
 *
 * 内部的には wolf-vote-analysis のラッパー。`wolfFaction = knownWolves ∪ {mySeat}` を
 * "狼陣営" として渡すことで vote 除外と PP shortcut の両方が一貫して動く。
 *
 * 注意:
 *   - 14d-neko の fanatic は 1 体のみなので「他 fanatic 位置」は気にしなくて良い
 *   - 複数 fanatic ルールでは別 fanatic を knownFanatics で渡せるよう拡張余地あり
 *   - fanatic 自身の生死は陣営勝敗に直接関係しない（fanatic は wolf_won を目指すが
 *     fanatic 死亡 = wolf 陣営敗北ではない）。ただし PP 数のカウントには寄与する。
 */

import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { Possibilities } from '../retar/possibilities.ts'
import { analyzeWolfVotesByWorld, type WolfVoteAnalysis } from './wolf-vote-analysis.ts'

export type FanaticVoteAnalysis = WolfVoteAnalysis

/**
 * 狂信者視点の day vote 分析。
 *
 * @param knownWolves - 狂信者が知っている狼の seat 集合（自席は含まない）
 * @param mySeat - 狂信者自身の seat
 */
export function analyzeFanaticVotesByWorld(
  possibilities: Possibilities,
  setup: Map<SystemRole, number>,
  vs: VillageStatus,
  knownWolves: ReadonlySet<number>,
  mySeat: Seat,
  maxWorlds?: number,
): FanaticVoteAnalysis {
  const wolfFaction = new Set<number>(knownWolves)
  wolfFaction.add(mySeat)

  return analyzeWolfVotesByWorld(possibilities, setup, vs, wolfFaction, maxWorlds)
}
