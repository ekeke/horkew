/**
 * wolfRisk — 人狼視点の襲撃リスク評価
 *
 * 各襲撃先候補について、夜の分岐（占い結果・霊媒結果・襲撃成否）を
 * 列挙し、翌朝に村が詰み進行可能な分岐の割合を算出する。
 */
import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import { Possibilities } from '../retar/possibilities.ts'
import { buildThreatProfile, isThreatExceeded } from './index.ts'
import { popCount32, forEachSeat, removeSeat } from './types.ts'

export type WolfRiskResult = {
  /** 襲撃成功時の詰み率 (0.0-1.0)。seat インデックス、0番未使用 */
  tsumiRateOnSuccess: Float32Array
  /** 襲撃失敗時の詰み率 (0.0-1.0)。seat インデックス、0番未使用 */
  tsumiRateOnFailure: Float32Array
}

/** 占い師の分岐情報 */
type SeerBranch = {
  seerSeat: Seat
  grayTargets: Seat[]
}

/**
 * 人狼の各襲撃先候補について、翌朝に村が詰み進行可能な分岐の割合を算出する。
 *
 * @param wolfPossibilities 人狼視点の Possibilities（仲間既知、分岐列挙用）
 * @param villagePossibilities 村視点の Possibilities（judgeTsumi評価用ベース）
 * @param vs 現在のゲーム状態
 * @param setup 配役
 * @param wolfMask 人狼座席ビットマスク
 */
export function evaluateWolfRisk(
  wolfPossibilities: Possibilities,
  villagePossibilities: Possibilities,
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
  wolfMask: number,
): WolfRiskResult {
  const seats = villagePossibilities.possibilities.length

  // --- Phase 0: 事前計算 ---

  // 生存者ビットマスク
  let alive = 0
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) alive |= (1 << seat)
  }
  const aliveCount = popCount32(alive)

  // 襲撃候補 = 生存中の非狼
  const attackTargets = alive & ~wolfMask

  // 今日の処刑者（霊媒分岐用）
  const executions = vs.executions.get(vs.day)
  const executedSeat: Seat | -1 = executions && executions.length > 0 ? executions[0] : -1

  // --- Phase 1: 分岐軸の特定 ---

  // 占い師分岐
  const seerBranches: SeerBranch[] = []
  const seerClaimants = vs.claims.get('seer' as SystemRole) ?? []
  for (const s of seerClaimants) {
    if (!(alive & (1 << s))) continue // 死亡済み
    if (!wolfPossibilities.hasRole(s, 'seer' as SystemRole)) continue // 仲間 or 真占い不可能

    // グレー候補: 生存中、未占い、占い師自身以外
    const divined = new Set<Seat>()
    const seerStatus = vs.statuses.get(s)
    if (seerStatus) {
      for (const [, assertion] of seerStatus.assertions) {
        divined.add(assertion.target)
      }
    }
    const grayTargets: Seat[] = []
    forEachSeat(alive, seat => {
      if (seat !== s && !divined.has(seat)) grayTargets.push(seat)
    })
    if (grayTargets.length > 0) {
      seerBranches.push({ seerSeat: s, grayTargets })
    }
  }

  // 霊媒分岐
  const mediumCandidates: Seat[] = []
  if (executedSeat >= 0) {
    const mediumClaimants = vs.claims.get('medium' as SystemRole) ?? []
    for (const m of mediumClaimants) {
      if (!(alive & (1 << m))) continue
      if (!wolfPossibilities.hasRole(m, 'medium' as SystemRole)) continue
      mediumCandidates.push(m)
    }
  }

  // 襲撃分岐要否
  let needAttackBranch = false
  forEachSeat(alive, seat => {
    if (needAttackBranch) return
    if (wolfPossibilities.hasRole(seat, 'bodyguard' as SystemRole)) needAttackBranch = true
    if (wolfPossibilities.hasRole(seat, 'werehamster' as SystemRole)) needAttackBranch = true
  })

  // --- 出力配列 ---
  const tsumiRateOnSuccess = new Float32Array(seats)
  const tsumiRateOnFailure = new Float32Array(seats)

  // --- スナップショット ---
  const basePoss = new Uint16Array(villagePossibilities.possibilities)
  const baseSetup = new Uint8Array(villagePossibilities.setup)
  const working = villagePossibilities.clone()

  // --- Phase 2: 各襲撃候補の評価 ---
  forEachSeat(attackTargets, target => {
    let successTsumi = 0, successTotal = 0
    let failureTsumi = 0, failureTotal = 0

    // 分岐列挙
    const seerIterations = seerBranches.length > 0 ? seerBranches : [null]
    for (const seerBranch of seerIterations) {
      const grayIterations = seerBranch ? seerBranch.grayTargets : [null]
      for (const grayTarget of grayIterations) {
        for (let seerResult = 0; seerResult < (grayTarget !== null ? 2 : 1); seerResult++) {
          // seerResult: 0=white, 1=black
          const mediumIterations = mediumCandidates.length > 0 ? mediumCandidates : [null]
          for (const _mediumCandidate of mediumIterations) {
            for (let mediumResult = 0; mediumResult < (_mediumCandidate !== null ? 2 : 1); mediumResult++) {
              // mediumResult: 0=white, 1=black
              const attackOutcomes = needAttackBranch ? 2 : 1
              for (let attackOutcome = 0; attackOutcome < attackOutcomes; attackOutcome++) {
                // attackOutcome: 0=success, 1=failure

                // スナップショット復元
                working.possibilities.set(basePoss)
                working.setup.set(baseSetup)

                // 占い結果適用
                if (grayTarget !== null) {
                  if (seerResult === 0) {
                    working.denyRole(grayTarget, 'werewolf' as SystemRole)
                  } else {
                    working.fixRole(grayTarget, 'werewolf' as SystemRole)
                  }
                }

                // 霊媒結果適用
                if (_mediumCandidate !== null && executedSeat >= 0) {
                  if (mediumResult === 0) {
                    working.denyRole(executedSeat, 'werewolf' as SystemRole)
                  } else {
                    working.fixRole(executedSeat, 'werewolf' as SystemRole)
                  }
                }

                // alive 更新
                const branchAlive = attackOutcome === 0
                  ? removeSeat(alive, target)
                  : alive
                const branchAliveCount = attackOutcome === 0
                  ? aliveCount - 1
                  : aliveCount

                // maxSurvivingNV 再計算
                working.computeMaxSurvivingNv(branchAlive)

                // 判定
                const profile = buildThreatProfile(working, branchAlive, branchAliveCount, setup)
                const impossible = isThreatExceeded(profile)

                // !impossible = 村が詰み進行可能 = 狼にとって危険
                if (attackOutcome === 0) {
                  successTotal++
                  if (!impossible) successTsumi++
                } else {
                  failureTotal++
                  if (!impossible) failureTsumi++
                }
              }
            }
          }
        }
      }
    }

    tsumiRateOnSuccess[target] = successTotal > 0 ? successTsumi / successTotal : 0
    tsumiRateOnFailure[target] = failureTotal > 0 ? failureTsumi / failureTotal : 0
  })

  // 襲撃分岐不要なら failure = success
  if (!needAttackBranch) {
    tsumiRateOnFailure.set(tsumiRateOnSuccess)
  }

  return { tsumiRateOnSuccess, tsumiRateOnFailure }
}
