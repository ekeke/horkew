/**
 * 狐排除探索（Phase 1）
 *
 * 狐生存時に、村が狐を確実に排除できるかを AND-OR 探索で判定する。
 * - OR節点: 村の選択（処刑先、占い先指示、護衛先）
 * - AND節点: 狼の最悪噛み（真占い師を狙う）
 *
 * 予告: 占い先が公開情報なので、占い師が死んでも呪殺の有無で狐候補を消去できる。
 * 占い師未確定でも占い先指示は有効（各ワールドの真占い師が実行）。
 */

import type { Seat } from '../types/index.ts'
import type { World } from './types.ts'
import { hasSeat, removeSeat, forEachSeat, popCount32 } from './types.ts'
import {
  checkOutcome, simulateNight,
  getMediumResult, applyFollowDeaths,
} from './simulate.ts'

/**
 * 全ワールドで狐を排除できる村の戦略が存在するか判定する。
 *
 * @param worlds - 可能なワールド（狐が生存しているものを含む）
 * @param alive - 生存者ビットマスク
 * @param maxTurns - 最大ターン数（1ターン = 処刑 + 夜）
 * @returns true なら狐排除可能（本探索に進む）、false なら不可能（枝刈り）
 */
export function canResolveFox(
  worlds: World[],
  alive: number,
  maxTurns: number,
): boolean {
  // 狐候補: いずれかのワールドで hamsterSeat が生存している席
  let foxMask = 0
  for (const w of worlds) {
    if (w.hamsterSeat !== -1 && hasSeat(alive, w.hamsterSeat)) {
      foxMask |= (1 << w.hamsterSeat)
    }
  }
  if (foxMask === 0) return true // 狐なし or 全ワールドで狐死亡

  if (maxTurns <= 0) return false

  // いずれかのワールドで村が既に負けているなら不可能
  for (const w of worlds) {
    const outcome = checkOutcome(w, alive)
    if (outcome === 'wolf_win' || outcome === 'hamster_win') return false
  }

  // 狐関連の状態分析
  let wolfUnion = 0
  let seerSeat = -1
  let confirmedSeer = true
  let bodyguardAlive = false
  let anySeerAlive = false
  for (const w of worlds) {
    wolfUnion |= (w.wolfMask & alive)
    if (w.seerSeat !== -1 && hasSeat(alive, w.seerSeat)) {
      anySeerAlive = true
      if (seerSeat === -1) seerSeat = w.seerSeat
      else if (seerSeat !== w.seerSeat) confirmedSeer = false
    } else {
      confirmedSeer = false
    }
    if (w.bodyguardSeat !== -1 && hasSeat(alive, w.bodyguardSeat)) {
      bodyguardAlive = true
    }
  }
  if (!confirmedSeer) seerSeat = -1

  // 高速カバレッジチェック: 処刑+占い+消去で狐候補数を賄えるか
  {
    const foxCount = popCount32(foxMask)
    const safeFoxCount = popCount32(foxMask & ~wolfUnion)
    const wolfCandidateCount = popCount32(wolfUnion)
    const aliveCount = popCount32(alive)
    const nawa = (aliveCount - 1 - 1) >> 1 // -1 for hamster (foxMask != 0)
    let executionCoverage = Math.min(safeFoxCount, Math.max(0, nawa - wolfCandidateCount))
    // 狐候補かつ狼候補の席: 狐でない狼候補が1人以上いれば、1席は安全に処刑できる
    // （霊能●なら狼確定で狐でない、霊能○なら狐かもしれないが他に狼が残る）
    const nonFoxWolfCount = popCount32(wolfUnion & ~foxMask & alive)
    if (nonFoxWolfCount >= 1) {
      const foxWolfOverlap = popCount32(foxMask & wolfUnion)
      executionCoverage += Math.min(1, foxWolfOverlap)
    }
    // 予告対応: 未確定でもいずれかのワールドに占い師がいれば占いは機能する
    // BG は確定占いの場合のみ護衛が効く（未確定では護衛先不明）
    const divinationCoverage = anySeerAlive
      ? (seerSeat !== -1 && bodyguardAlive ? 2 : 1)
      : 0
    const coverage = executionCoverage + divinationCoverage + 1
    if (foxCount > coverage) return false
  }

  // OR節点: 村の戦略を試す

  // 戦略A: 安全な狐候補を処刑（全ワールドで非狼）
  const safeFoxTargets = foxMask & ~wolfUnion
  let mask = safeFoxTargets
  while (mask !== 0) {
    const bit = mask & (-mask)
    const target = 31 - Math.clz32(bit)
    mask ^= bit
    if (tryExecuteThenNight(worlds, alive, target, foxMask, seerSeat, bodyguardAlive, anySeerAlive, maxTurns)) {
      return true
    }
  }

  // 戦略B: 狐候補かつ狼候補を処刑（霊能●/○で世界分割→狐候補を絞る）
  const foxWolfTargets = foxMask & wolfUnion
  mask = foxWolfTargets
  while (mask !== 0) {
    const bit = mask & (-mask)
    const target = 31 - Math.clz32(bit)
    mask ^= bit
    if (tryExecuteThenNight(worlds, alive, target, foxMask, seerSeat, bodyguardAlive, anySeerAlive, maxTurns)) {
      return true
    }
  }

  // 戦略C: 狐候補以外を処刑して夜を迎える（占いで狐候補を消去するため）
  const nonFoxAlive = alive & ~foxMask
  const seen = new Set<number>()
  let remaining = nonFoxAlive
  while (remaining !== 0) {
    const bit = remaining & (-remaining)
    const target = 31 - Math.clz32(bit)
    remaining ^= bit
    let h = 0x811c9dc5
    for (const w of worlds) {
      h ^= w.roleIds[target]
      h = Math.imul(h, 0x01000193)
    }
    h = h >>> 0
    if (seen.has(h)) continue
    seen.add(h)
    if (tryExecuteThenNight(worlds, alive, target, foxMask, seerSeat, bodyguardAlive, anySeerAlive, maxTurns)) {
      return true
    }
  }

  return false
}

/**
 * 特定の席を処刑した後、夜を経て狐を排除できるか探索する。
 */
function tryExecuteThenNight(
  worlds: World[],
  alive: number,
  executeTarget: Seat,
  foxMask: number,
  seerSeat: Seat,
  bodyguardAlive: boolean,
  anySeerAlive: boolean,
  maxTurns: number,
): boolean {
  const afterExec = removeSeat(alive, executeTarget)

  // 処刑後の敗北チェック（後追い込み）: いずれかのワールドで村が負けたら失敗
  for (const w of worlds) {
    const aliveW = applyFollowDeaths(afterExec, w)
    const outcome = checkOutcome(w, aliveW)
    if (outcome === 'wolf_win' || outcome === 'hamster_win') return false
  }

  // 処刑後のワールド分割（霊能結果 + 後追い有無で分岐）
  const byKey = new Map<string, { worlds: World[], alive: number }>()
  for (const w of worlds) {
    const result = getMediumResult(w.roles[executeTarget])
    const aliveW = applyFollowDeaths(afterExec, w)
    const followDead = afterExec & ~aliveW
    const followSuffix = followDead !== 0 ? `+f:${31 - Math.clz32(followDead & (-followDead))}` : ''
    const key = (result ?? 'null') + followSuffix
    const group = byKey.get(key)
    if (group) group.worlds.push(w)
    else byKey.set(key, { worlds: [w], alive: aliveW })
  }

  // 全分岐で狐排除可能か（AND: 全分岐で成功必要）
  for (const [, { worlds: branchWorlds, alive: branchAlive }] of byKey) {
    let branchFoxMask = 0
    for (const w of branchWorlds) {
      if (w.hamsterSeat !== -1 && hasSeat(branchAlive, w.hamsterSeat)) {
        branchFoxMask |= (1 << w.hamsterSeat)
      }
    }

    if (branchFoxMask === 0) continue // この分岐では狐解決済み

    if (!tryNightForFox(branchWorlds, branchAlive, branchFoxMask, seerSeat, bodyguardAlive, anySeerAlive, maxTurns)) {
      return false
    }
  }

  return true
}

/**
 * 夜フェーズで狐候補を消去できるか。
 * 占い先を指示し（OR）、狼の最悪噛みに対応する。
 * 予告: 占い師未確定でも占い先指示は有効（呪殺観測で狐候補を消去）。
 */
function tryNightForFox(
  worlds: World[],
  alive: number,
  foxMask: number,
  seerSeat: Seat,
  bodyguardAlive: boolean,
  anySeerAlive: boolean,
  maxTurns: number,
): boolean {
  // 護衛先: 確定占い師ならその席を護衛。未確定なら護衛なし。
  const guardTarget = (seerSeat !== -1 && hasSeat(alive, seerSeat) && bodyguardAlive)
    ? seerSeat : null

  // OR: 各狐候補を占い先として指示（予告）
  // 占い師が未確定でも、各ワールドの真占い師が実行する
  if (anySeerAlive) {
    let foxCandidateMask = foxMask
    while (foxCandidateMask !== 0) {
      const bit = foxCandidateMask & (-foxCandidateMask)
      const divineTarget = 31 - Math.clz32(bit)
      foxCandidateMask ^= bit
      if (simulateWorstCaseNight(worlds, alive, divineTarget, guardTarget, maxTurns)) {
        return true
      }
    }
  }

  // 占い先なし（全ワールドで占い師死亡の場合のフォールバック）
  if (simulateWorstCaseNight(worlds, alive, null, null, maxTurns)) {
    return true
  }

  return false
}

/**
 * ワールドごとに最悪の噛み先を算出する。
 * 狼は常に真占い師を狙う。護衛されていれば先にBGを噛む。
 */
function worstCaseBite(w: World, alive: number, guardTarget: Seat | null): Seat {
  const seer = w.seerSeat
  if (seer !== -1 && hasSeat(alive, seer)) {
    // BGが占い師を護衛中 → BGを噛んで護衛を剥がす
    if (guardTarget === seer && w.bodyguardSeat !== -1 && hasSeat(alive, w.bodyguardSeat)) {
      return w.bodyguardSeat
    }
    // 占い師を直接噛む
    return seer
  }
  // 占い師なし → 非狼の生存者を噛む（alive を減らす）
  const nonWolf = alive & ~w.wolfMask
  if (nonWolf === 0) return -1  // 噛み先なし
  return 31 - Math.clz32(nonWolf & (-nonWolf))
}

/**
 * 占い先・護衛先に対し、最悪噛みで狐排除が成立するか。
 * 旧 tryAllBitesForFox を置換: ワールドごとに1噛みのみ。
 */
function simulateWorstCaseNight(
  worlds: World[],
  alive: number,
  divineTarget: Seat | null,
  guardTarget: Seat | null,
  maxTurns: number,
): boolean {
  const byObs = new Map<number, { worlds: World[], alive: number }>()

  for (const w of worlds) {
    const bite = worstCaseBite(w, alive, guardTarget)
    if (bite === -1) {
      // 狼全滅（噛みなし）
      const group = byObs.get(0)
      if (group) group.worlds.push(w)
      else byObs.set(0, { worlds: [w], alive })
      continue
    }

    const { nextAlive, obsKey } = simulateNight(w, alive, bite, guardTarget, divineTarget)

    // 即負けチェック
    const outcome = checkOutcome(w, nextAlive)
    if (outcome === 'wolf_win' || outcome === 'hamster_win') return false

    const group = byObs.get(obsKey)
    if (group) group.worlds.push(w)
    else byObs.set(obsKey, { worlds: [w], alive: nextAlive })
  }

  // 全観測分岐で狐排除可能か（AND）
  for (const [, group] of byObs) {
    let branchFoxMask = 0
    for (const w of group.worlds) {
      if (w.hamsterSeat !== -1 && hasSeat(group.alive, w.hamsterSeat)) {
        branchFoxMask |= (1 << w.hamsterSeat)
      }
    }

    if (branchFoxMask === 0) continue // 狐解決済み

    if (!canResolveFox(group.worlds, group.alive, maxTurns - 1)) {
      return false
    }
  }

  return true
}
