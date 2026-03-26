/**
 * HeuristicStrategy: セオリーベースの人狼AIヒューリスティック
 *
 * 14D猫のセオリーに基づく意思決定。Retar（役職推理）とHati（詰み探索）を活用。
 *
 * 情報制約:
 * - 村側: publicEvents + retarPossibilities + 自分の秘密情報のみ
 * - 人外: gameState参照OK（ゲーム上正当な知識）
 */

import type { EnumSpecies, SystemRole } from '../types/index.ts'
import type { GameState, PlayerState, NightAction, DayClaim, GameEvent } from './types.ts'
import type { CommunicationAction } from './communication.ts'
import type { Proposal, LeadershipResponse } from './leadership.ts'
import type { Strategy, DecisionContext, TeamStrategy, TeamDecisionContext, WolfNightAction } from './strategy.ts'
import { alivePlayers, alivePlayersExcept, getMediumResult, isWerewolfAligned } from './roles.ts'
import type { Rng } from './random.ts'
import { searchTsumiFromEvents } from './retar-browser-bridge.ts'
import type { VillageAction } from '../hati/types.ts'

// ============================================================
// 定数
// ============================================================

// 疑惑スコア重み
const W = {
  BLACK_RESULT: 40,
  WHITE_RESULT: -15,
  RETAR_WOLF_POSSIBLE: 5,
  RETAR_WOLF_IMPOSSIBLE: -50,
  RETAR_CONFIRMED: -100,
  MULTI_SEER_CLAIMER: 10,
  ACCUSE_WOLF_TARGET: 10,
  TRUST_FROM_CONFIRMED: -20,
}

// 指揮者追従率
const FOLLOW_RATES: Record<string, number> = {
  werewolf: 0.2, fanatic: 0.25, werehamster: 0.6, immoralist: 0.7,
}
const DEFAULT_FOLLOW_RATE = 0.9

// ============================================================
// ユーティリティ: 公開情報抽出
// ============================================================

function collectClaimsFromEvents(events: GameEvent[]): Map<number, SystemRole> {
  const claims = new Map<number, SystemRole>()
  for (const e of events) {
    switch (e.type) {
      case 'seer_claim': claims.set(e.actor, 'seer'); break
      case 'medium_claim': claims.set(e.actor, 'medium'); break
      case 'bodyguard_claim': claims.set(e.actor, 'bodyguard'); break
      case 'mason_claim': claims.set(e.actor, 'mason'); break
      case 'nekomata_claim': claims.set(e.actor, 'nekomata'); break
      case 'wolf_claim': claims.set(e.actor, e.claimedRole); break
    }
  }
  return claims
}

function collectBlackTargets(events: GameEvent[]): Set<number> {
  const targets = new Set<number>()
  for (const e of events) {
    if (e.type === 'seer_claim') {
      for (const r of e.results) { if (r.result === 'wolf') targets.add(r.target) }
    } else if (e.type === 'seer_result') {
      if (e.result === 'wolf') targets.add(e.target)
    }
  }
  return targets
}

function collectWhiteTargets(events: GameEvent[]): Set<number> {
  const targets = new Set<number>()
  for (const e of events) {
    if (e.type === 'seer_claim') {
      for (const r of e.results) { if (r.result === 'human') targets.add(r.target) }
    } else if (e.type === 'seer_result') {
      if (e.result === 'human') targets.add(e.target)
    }
  }
  return targets
}

function countRoleClaimers(events: GameEvent[], role: SystemRole, aliveSeats: Set<number>): number {
  const claims = collectClaimsFromEvents(events)
  let count = 0
  for (const [seat, r] of claims) {
    if (r === role && aliveSeats.has(seat)) count++
  }
  return count
}

function isRollerSituation(events: GameEvent[], role: SystemRole, aliveSeats: Set<number>): boolean {
  return countRoleClaimers(events, role, aliveSeats) >= 2
}

// ============================================================
// 疑惑スコア（村側投票判断の核）
// ============================================================

function buildSuspicionScore(
  events: GameEvent[],
  retarPossibilities: Map<number, Set<SystemRole>> | null,
  aliveSeatList: number[],
  mySeat: number,
): Map<number, number> {
  const scores = new Map<number, number>()
  const aliveSet = new Set(aliveSeatList)
  const blacks = collectBlackTargets(events)
  const whites = collectWhiteTargets(events)
  const claims = collectClaimsFromEvents(events)

  // accuse_wolf / trust targets
  const accuseWolfTargets = new Map<number, number>()
  const trustTargets = new Map<number, number>()
  for (const e of events) {
    if (e.type === 'signal' && 'target' in e.signal) {
      if (e.signal.type === 'accuse_wolf') {
        accuseWolfTargets.set(e.signal.target, (accuseWolfTargets.get(e.signal.target) ?? 0) + 1)
      } else if (e.signal.type === 'trust') {
        trustTargets.set(e.signal.target, (trustTargets.get(e.signal.target) ?? 0) + 1)
      }
    }
  }

  // 占いCO者のseat一覧
  const seerClaimers = new Set<number>()
  for (const [seat, role] of claims) {
    if (role === 'seer' && aliveSet.has(seat)) seerClaimers.add(seat)
  }

  for (const seat of aliveSeatList) {
    if (seat === mySeat) continue
    let score = 0

    // 黒出し/白出し
    if (blacks.has(seat)) score += W.BLACK_RESULT
    if (whites.has(seat)) score += W.WHITE_RESULT

    // Retar分析
    if (retarPossibilities) {
      const roles = retarPossibilities.get(seat)
      if (roles) {
        if (roles.has('werewolf')) score += W.RETAR_WOLF_POSSIBLE
        else score += W.RETAR_WOLF_IMPOSSIBLE
        if (roles.size === 1) score += W.RETAR_CONFIRMED
      }
    }

    // 複数占いCO
    if (seerClaimers.has(seat) && seerClaimers.size >= 2) score += W.MULTI_SEER_CLAIMER

    // シグナル
    if (accuseWolfTargets.has(seat)) score += W.ACCUSE_WOLF_TARGET * (accuseWolfTargets.get(seat) ?? 0)
    if (trustTargets.has(seat)) score += W.TRUST_FROM_CONFIRMED * (trustTargets.get(seat) ?? 0)

    scores.set(seat, score)
  }

  return scores
}

function pickHighestSuspicion(
  scores: Map<number, number>, candidates: number[], rng: Rng,
): number {
  if (candidates.length === 0) return 1
  let maxScore = -Infinity
  const best: number[] = []
  for (const seat of candidates) {
    const s = scores.get(seat) ?? 0
    if (s > maxScore) { maxScore = s; best.length = 0; best.push(seat) }
    else if (s === maxScore) best.push(seat)
  }
  return rng.pick(best.map(s => ({ seat: s }))).seat
}

// ============================================================
// Hati統合ヘルパー
// ============================================================

function tryTsumiAction(ctx: DecisionContext): VillageAction | null {
  if (ctx.alivePlayers.length > 6) return null

  const state = ctx.gameState
  const roleCount = new Map<SystemRole, number>()
  for (const p of state.players) {
    roleCount.set(p.role, (roleCount.get(p.role) ?? 0) + 1)
  }
  const minimalConfig = { roles: roleCount, hasFirstGhost: state.players.some(p => !p.alive && p.seat > 0) }

  try {
    const result = searchTsumiFromEvents(ctx.publicEvents, state, minimalConfig as any, 4)
    if (!result || !result.isTsumi || !result.strategy) return null
    if (result.strategy.type === 'action') return result.strategy.action
  } catch { /* fallback */ }
  return null
}

function tryTsumiWithEvents(events: GameEvent[], ctx: DecisionContext): number | null {
  const state = ctx.gameState
  const roleCount = new Map<SystemRole, number>()
  for (const p of state.players) {
    roleCount.set(p.role, (roleCount.get(p.role) ?? 0) + 1)
  }
  const minimalConfig = { roles: roleCount, hasFirstGhost: state.players.some(p => !p.alive && p.seat > 0) }

  try {
    const result = searchTsumiFromEvents(events, state, minimalConfig as any, 4)
    if (!result || !result.isTsumi || !result.strategy) return null
    if (result.strategy.type === 'action' && result.strategy.action.execute > 0) {
      return result.strategy.action.execute
    }
  } catch {
    // Hati失敗時はフォールバック
  }
  return null
}

function tryTsumi(ctx: DecisionContext): number | null {
  if (ctx.alivePlayers.length > 6) return null

  // LupaConfigを最低限構築（formatHowlが必要とする）
  const state = ctx.gameState
  const roleCount = new Map<SystemRole, number>()
  for (const p of state.players) {
    roleCount.set(p.role, (roleCount.get(p.role) ?? 0) + 1)
  }
  const minimalConfig = { roles: roleCount, hasFirstGhost: state.players.some(p => !p.alive && p.seat > 0) }

  try {
    const result = searchTsumiFromEvents(ctx.publicEvents, state, minimalConfig as any, 4)
    if (!result || !result.isTsumi || !result.strategy) return null
    if (result.strategy.type === 'action' && result.strategy.action.execute > 0) {
      return result.strategy.action.execute
    }
  } catch {
    // Hati失敗時はフォールバック
  }
  return null
}

// ============================================================
// HeuristicStrategy
// ============================================================

export class HeuristicStrategy implements Strategy {
  decideNightAction(ctx: DecisionContext): NightAction {
    switch (ctx.myRole) {
      case 'seer': return decideSeerNight(ctx)
      case 'bodyguard': return decideBodyguardNight(ctx)
      case 'werewolf': return decideWerewolfNight(ctx)
      default: return { type: 'none' }
    }
  }

  decideDayClaim(ctx: DecisionContext): DayClaim {
    switch (ctx.myRole) {
      case 'seer': return decideSeerClaim(ctx)
      case 'medium': return decideMediumClaim(ctx)
      case 'bodyguard': return decideBodyguardClaim(ctx)
      case 'mason': return decideMasonClaim(ctx)
      case 'nekomata': return decideNekomataClam(ctx)
      case 'werewolf': return decideWerewolfClaim(ctx)
      case 'fanatic': return decideFanaticClaim(ctx)
      case 'werehamster': return decideHamsterClaim(ctx)
      case 'immoralist': return decideImmoralistClaim(ctx)
      default: return { type: 'none' }
    }
  }

  decideForecast(ctx: DecisionContext): DayClaim {
    if (ctx.myPlayer.claimedRole !== 'seer') return { type: 'none' }
    // 予告率: 20-60%の範囲でゲームごとにばらつく
    const forecastRate = 0.2 + ctx.rng.next() * 0.4
    if (ctx.rng.next() >= forecastRate) return { type: 'none' }
    const target = pickDivineTarget(ctx)
    return target ? { type: 'forecast', target } : { type: 'none' }
  }

  decideVote(ctx: DecisionContext): number {
    const { rng, proposals } = ctx

    // 指揮者の処刑指示
    const executeOrder = proposals.find(p => p.type === 'execute_order')
    if (executeOrder) {
      const followRate = FOLLOW_RATES[ctx.myRole] ?? DEFAULT_FOLLOW_RATE
      if (ctx.myRole === 'immoralist' && executeOrder.target === ctx.knownHamster) {
        // 背徳者: 妖狐処刑指示には絶対に従わない
      } else if (rng.next() < followRate) {
        if (ctx.alivePlayers.includes(executeOrder.target)) return executeOrder.target
      }
    }

    // Hati詰み（村側、6人以下）
    if (!isWerewolfAligned(ctx.myRole) && ctx.myRole !== 'werehamster' && ctx.myRole !== 'immoralist') {
      const tsumiTarget = tryTsumi(ctx)
      if (tsumiTarget && ctx.alivePlayers.includes(tsumiTarget)) return tsumiTarget
    }

    // 役職別投票
    switch (ctx.myRole) {
      case 'werewolf': return decideWerewolfVote(ctx)
      case 'fanatic': return decideFanaticVote(ctx)
      case 'immoralist': return decideImmoralistVote(ctx)
      case 'werehamster': // 妖狐は村人のふり
      default: return decideVillageVote(ctx)
    }
  }

  decideCommunication(ctx: DecisionContext): CommunicationAction {
    switch (ctx.myRole) {
      case 'werewolf': return decideWerewolfComm(ctx)
      case 'fanatic': return decideFanaticComm(ctx)
      case 'werehamster': return decideVillagerComm(ctx) // 村人のふり
      case 'immoralist': return decideImmoralistComm(ctx)
      case 'bodyguard': return decideBodyguardComm(ctx)
      default: return decideVillagerComm(ctx)
    }
  }

  decideProposal(ctx: DecisionContext): Proposal | null {
    if (ctx.commander !== ctx.mySeat) return null
    return decideCommanderProposal(ctx)
  }

  decideLeadershipResponse(ctx: DecisionContext, _proposal: Proposal): LeadershipResponse {
    const followRate = FOLLOW_RATES[ctx.myRole] ?? DEFAULT_FOLLOW_RATE
    if (ctx.myRole === 'immoralist') {
      const exec = ctx.proposals.find(p => p.type === 'execute_order')
      if (exec && exec.target === ctx.knownHamster) return 'defy'
    }
    return ctx.rng.next() < followRate ? 'follow' : 'defy'
  }
}

// ============================================================
// 村側: 夜行動
// ============================================================

function decideSeerNight(ctx: DecisionContext): NightAction {
  const target = pickDivineTarget(ctx)
  return target ? { type: 'divine', target } : { type: 'none' }
}

/** 占い先戦略 */
type DivineStrategy = 'gray' | 'fox' | 'verify_claimer'

function pickDivineTarget(ctx: DecisionContext): number | null {
  const { myPlayer, rng, alivePlayers: alive, retarPossibilities, publicEvents, proposals } = ctx
  const others = alive.filter(s => s !== ctx.mySeat)
  if (others.length === 0) return null

  // 占い済みを除外
  const divined = new Set(Array.from(myPlayer.divineHistory.values()).map(d => d.target))
  const undivined = others.filter(s => !divined.has(s))
  const candidates = undivined.length > 0 ? undivined : others

  // 最優先: 予告先
  if (myPlayer.forecastTarget != null && candidates.includes(myPlayer.forecastTarget)) {
    return myPlayer.forecastTarget
  }

  // 最優先: 指揮者の占い指示
  const investigateOrder = proposals.find(p => p.type === 'investigate_order')
  if (investigateOrder && candidates.includes(investigateOrder.target)) {
    return investigateOrder.target
  }

  // 次優先: 指揮者の処刑指示対象（未占いなら占って確認）
  const executeOrder = proposals.find(p => p.type === 'execute_order')
  if (executeOrder && candidates.includes(executeOrder.target)) {
    return executeOrder.target
  }

  // 毎日ランダムで戦略を選択
  const strategies: DivineStrategy[] = ['gray', 'fox', 'verify_claimer']
  const strategy = rng.pick(strategies.map(s => ({ s }))).s

  if (strategy === 'fox' && retarPossibilities) {
    // 狐狙い: Retarで妖狐可能性が残る席を優先
    const foxCandidates = candidates.filter(s => {
      const roles = retarPossibilities.get(s)
      return roles && roles.has('werehamster') && roles.size > 1
    })
    if (foxCandidates.length > 0) return rng.pick(foxCandidates.map(s => ({ seat: s }))).seat
  }

  if (strategy === 'verify_claimer') {
    // CO者検証: 占い/霊能の対抗CO者を占う
    const claims = collectClaimsFromEvents(publicEvents)
    const claimerCandidates = candidates.filter(s => {
      const role = claims.get(s)
      return role === 'seer' || role === 'medium'
    })
    if (claimerCandidates.length > 0) return rng.pick(claimerCandidates.map(s => ({ seat: s }))).seat
  }

  // グレー詰め（デフォルト / フォールバック）: Retarで狼可能性が残る不確定席
  if (retarPossibilities) {
    const uncertain = candidates.filter(s => {
      const roles = retarPossibilities.get(s)
      return roles && roles.has('werewolf') && roles.size > 1
    })
    if (uncertain.length > 0) return rng.pick(uncertain.map(s => ({ seat: s }))).seat
  }

  return rng.pick(candidates.map(s => ({ seat: s }))).seat
}

function decideBodyguardNight(ctx: DecisionContext): NightAction {
  const { rng, publicEvents, alivePlayers: alive, retarPossibilities, proposals } = ctx
  const others = alive.filter(s => s !== ctx.mySeat)
  if (others.length === 0) return { type: 'none' }

  // 最優先: 指揮者の護衛指示
  const protectOrder = proposals.find(p => p.type === 'protect_order')
  if (protectOrder && others.includes(protectOrder.target)) {
    return { type: 'guard', target: protectOrder.target }
  }

  const claims = collectClaimsFromEvents(publicEvents)
  const aliveSet = new Set(alive)

  // 占いCO者が1人（確定）なら鉄板護衛（70%）
  const seerClaimers = others.filter(s => claims.get(s) === 'seer' && aliveSet.has(s))
  if (seerClaimers.length === 1 && rng.next() < 0.7) {
    return { type: 'guard', target: seerClaimers[0] }
  }

  // 確定村陣営を優先（Retarで可能性が1つ & 村役職）
  const villageRoles: Set<SystemRole> = new Set(['seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'villager'])
  if (retarPossibilities) {
    const confirmedVillage = others.filter(s => {
      const roles = retarPossibilities.get(s)
      return roles && roles.size === 1 && villageRoles.has([...roles][0])
    })
    if (confirmedVillage.length > 0) {
      return { type: 'guard', target: rng.pick(confirmedVillage.map(s => ({ seat: s }))).seat }
    }
  }

  // CO者（霊能、共有、占い）を優先
  const coCandidates = others.filter(s => {
    const role = claims.get(s)
    return role === 'seer' || role === 'medium' || role === 'mason'
  })
  if (coCandidates.length > 0) {
    return { type: 'guard', target: rng.pick(coCandidates.map(s => ({ seat: s }))).seat }
  }

  // 指揮者
  if (ctx.commander && others.includes(ctx.commander)) {
    return { type: 'guard', target: ctx.commander }
  }

  return { type: 'guard', target: rng.pick(others.map(s => ({ seat: s }))).seat }
}

// ============================================================
// 村側: 昼CO
// ============================================================

function decideSeerClaim(ctx: DecisionContext): DayClaim {
  const { myPlayer, day, rng, publicEvents, alivePlayers: alive } = ctx
  if (myPlayer.claimedRole === 'seer') {
    // 既にCO済み: 最新結果を報告
    const latest = myPlayer.divineHistory.get(day - 1)
    if (!latest) return { type: 'none' }
    return { type: 'seer_result', target: latest.target, result: latest.result }
  }

  // 潜伏判定（Day 1のみ、14D猫では基本CO有利なので確率は低め）
  if (day === 1) {
    // 初日黒なら即CO（潜伏しない）
    const night0Result = myPlayer.divineHistory.get(0)
    if (night0Result && night0Result.result === 'wolf') {
      const results = Array.from(myPlayer.divineHistory.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ target: v.target, result: v.result }))
      return { type: 'seer_co', results }
    }

    const aliveSet = new Set(alive)
    const claims = collectClaimsFromEvents(publicEvents)
    const blacks = collectBlackTargets(publicEvents)

    // 条件1: 対抗占いが誰かに黒出し済み & 他に一切のCOがない → 15%潜伏
    const otherSeerClaimed = [...claims.entries()].some(
      ([seat, role]) => role === 'seer' && seat !== ctx.mySeat && aliveSet.has(seat)
    )
    const otherNonSeerClaimed = [...claims.entries()].some(
      ([seat, role]) => role !== 'seer' && seat !== ctx.mySeat
    )
    if (otherSeerClaimed && blacks.size > 0 && !otherNonSeerClaimed && rng.next() < 0.15) {
      return { type: 'none' }
    }

    // 条件2: 初日占い先が初日犠牲者（非狐: 死んでいるので結果が無駄） → 20%潜伏
    if (night0Result) {
      const targetAlive = aliveSet.has(night0Result.target)
      if (!targetAlive && rng.next() < 0.2) {
        return { type: 'none' }
      }

      // 条件3: 初日占い先が共有CO者 → 20%潜伏
      if (claims.get(night0Result.target) === 'mason' && rng.next() < 0.2) {
        return { type: 'none' }
      }
    }
  }

  // Day 2+で未COなら溜めた結果ごとCO
  // 初回CO: 全結果つき
  const results = Array.from(myPlayer.divineHistory.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ target: v.target, result: v.result }))
  return { type: 'seer_co', results }
}

function decideMediumClaim(ctx: DecisionContext): DayClaim {
  const { myPlayer, day, lastExecutedSeat, gameState: state, rng, publicEvents, alivePlayers: alive } = ctx
  if (myPlayer.claimedRole === 'medium') {
    if (lastExecutedSeat !== null) {
      const target = state.players.find(p => p.seat === lastExecutedSeat)!
      return { type: 'medium_result', result: getMediumResult(target.role) }
    }
    return { type: 'none' }
  }

  // 潜伏判定（Day 1のみ）
  if (day === 1) {
    const claims = collectClaimsFromEvents(publicEvents)
    const blacks = collectBlackTargets(publicEvents)
    const seerClaimed = [...claims.entries()].some(
      ([seat, role]) => role === 'seer' && new Set(alive).has(seat)
    )
    const otherNonSeerClaimed = [...claims.entries()].some(
      ([seat, role]) => role !== 'seer' && seat !== ctx.mySeat
    )
    // 占いが黒出し済み & 他に一切のCOがない → 30%潜伏
    if (seerClaimed && blacks.size > 0 && !otherNonSeerClaimed && rng.next() < 0.3) {
      return { type: 'none' }
    }
  }

  // 初回CO
  const pastResults = collectPastMediumResults(state, day)
  return { type: 'medium_co', pastResults }
}

function collectPastMediumResults(state: GameState, day: number): EnumSpecies[] {
  const results: EnumSpecies[] = []
  for (let d = 1; d < day; d++) {
    const seat = state.executionHistory.get(d)
    if (seat == null) continue
    const player = state.players.find(p => p.seat === seat)!
    results.push(getMediumResult(player.role))
  }
  return results
}

function decideBodyguardClaim(ctx: DecisionContext): DayClaim {
  if (ctx.myPlayer.claimedRole) return { type: 'none' }

  // Hati詰み: 自分がCOした後の盤面で詰みが生まれるか判定（8人以下）
  if (ctx.alivePlayers.length <= 8) {
    const targets = Array.from(ctx.myPlayer.guardHistory.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, seat]) => seat)

    // 狩人COイベントを仮追加した盤面でHati判定
    const simEvents: GameEvent[] = [...ctx.publicEvents, {
      type: 'bodyguard_claim' as const,
      actor: ctx.mySeat,
      targets,
    }]
    const tsumiTarget = tryTsumiWithEvents(simEvents, ctx)
    if (tsumiTarget) {
      return { type: 'bodyguard_co', targets }
    }
  }

  // 基本は潜伏（処刑時はforceTrueRoleCOで処理）
  return { type: 'none' }
}

function decideMasonClaim(ctx: DecisionContext): DayClaim {
  const { myPlayer, gameState: state, day, rng, publicEvents, alivePlayers: alive } = ctx
  if (myPlayer.claimedRole) return { type: 'none' }
  const partner = state.players.find(p => p.seat !== ctx.mySeat && p.role === 'mason')
  if (!partner) return { type: 'none' }

  // 相方が初日犠牲者なら即CO（1人共有を証明する必要がある）
  const aliveSet = new Set(alive)
  if (!aliveSet.has(partner.seat)) {
    return { type: 'mason_co', partner: partner.seat }
  }

  // 潜伏判定（Day 1のみ）: 霊媒と同じ条件
  if (day === 1) {
    const claims = collectClaimsFromEvents(publicEvents)
    const blacks = collectBlackTargets(publicEvents)
    const seerClaimed = [...claims.entries()].some(
      ([seat, role]) => role === 'seer' && aliveSet.has(seat)
    )
    const otherNonSeerClaimed = [...claims.entries()].some(
      ([seat, role]) => role !== 'seer' && seat !== ctx.mySeat
    )
    // 占いが黒出し済み & 他に一切のCOがない → 30%潜伏
    if (seerClaimed && blacks.size > 0 && !otherNonSeerClaimed && rng.next() < 0.3) {
      return { type: 'none' }
    }
  }

  return { type: 'mason_co', partner: partner.seat }
}

function decideNekomataClam(ctx: DecisionContext): DayClaim {
  if (ctx.myPlayer.claimedRole) return { type: 'none' }

  // 対抗チェック: 既に猫又COがあれば100%CO
  const aliveSet = new Set(ctx.alivePlayers)
  if (isRollerSituation(ctx.publicEvents, 'nekomata', aliveSet)) {
    return { type: 'nekomata_co' }
  }

  // Day 1はCOしない
  if (ctx.day === 1) return { type: 'none' }

  // 複数死体が出たらCO（襲撃+呪殺等で盤面が動いたタイミング）
  if (ctx.day > 1) {
    let nightDeaths = 0
    for (let i = ctx.publicEvents.length - 1; i >= 0; i--) {
      const e = ctx.publicEvents[i]
      if (e.type === 'night_kill' || e.type === 'fox_kill' || e.type === 'follow_kill') nightDeaths++
      if (e.type === 'execution' || e.type === 'game_over') break
    }
    if (nightDeaths >= 2) return { type: 'nekomata_co' }
  }

  // Hati詰み: COした後の盤面で詰むならCO（8人以下）
  if (ctx.alivePlayers.length <= 8) {
    const simEvents: GameEvent[] = [...ctx.publicEvents, {
      type: 'nekomata_claim' as const,
      actor: ctx.mySeat,
    }]
    const tsumiTarget = tryTsumiWithEvents(simEvents, ctx)
    if (tsumiTarget) return { type: 'nekomata_co' }
  }

  return { type: 'none' }
}

// ============================================================
// 村側: 投票・通信
// ============================================================

function decideVillageVote(ctx: DecisionContext): number {
  const scores = buildSuspicionScore(ctx.publicEvents, ctx.retarPossibilities, ctx.alivePlayers, ctx.mySeat)
  const candidates = ctx.alivePlayers.filter(s => s !== ctx.mySeat)

  // 再投票候補制限
  if (ctx.revoteCandidates && ctx.revoteCandidates.length > 0) {
    return pickHighestSuspicion(scores, ctx.revoteCandidates, ctx.rng)
  }

  return pickHighestSuspicion(scores, candidates, ctx.rng)
}

/** 共有が全滅していて自分が確定村陣営かを判定 */
function shouldActAsLeader(ctx: DecisionContext): boolean {
  const { publicEvents, alivePlayers: alive, retarPossibilities, mySeat } = ctx
  // 指揮者が既にいればそちらに任せる
  if (ctx.commander !== null) return false

  // 自分がRetarで確定村陣営か
  if (!retarPossibilities) return false
  const myRoles = retarPossibilities.get(mySeat)
  if (!myRoles || myRoles.size !== 1) return false
  const villageRoles: Set<SystemRole> = new Set(['seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'villager'])
  if (!villageRoles.has([...myRoles][0])) return false

  // 共有COしている生存者がいないか
  const claims = collectClaimsFromEvents(publicEvents)
  const aliveSet = new Set(alive)
  const aliveMasons = [...claims.entries()].filter(([seat, role]) => role === 'mason' && aliveSet.has(seat))
  return aliveMasons.length === 0
}

function decideVillagerComm(ctx: DecisionContext): CommunicationAction {
  const { rng, publicEvents, alivePlayers: alive, mySeat } = ctx
  const others = alive.filter(s => s !== mySeat)
  const proposals: number[] = []

  // 共有全滅 & 自分が確定村 → 指揮者的に振る舞う
  if (shouldActAsLeader(ctx)) {
    // Hati詰み（6人以下）
    const action = tryTsumiAction(ctx)
    if (action && action.execute > 0 && alive.includes(action.execute)) {
      proposals.push(action.execute)
      if (action.seerTarget && alive.includes(action.seerTarget)) {
        ctx.proposals.push({ type: 'investigate_order', target: action.seerTarget })
      }
      if (action.bodyguardTarget && alive.includes(action.bodyguardTarget)) {
        ctx.proposals.push({ type: 'protect_order', target: action.bodyguardTarget })
      }
      return { signal: { type: 'vote_intent', target: action.execute }, proposals }
    }

    // 疑惑スコアで指示
    const scores = buildSuspicionScore(publicEvents, ctx.retarPossibilities, alive, mySeat)
    const target = pickHighestSuspicion(scores, others, rng)
    proposals.push(target)
    return { signal: { type: 'vote_intent', target }, proposals }
  }

  // 処刑提案: 黒出し先
  const blacks = collectBlackTargets(publicEvents)
  const aliveBlacks = others.filter(s => blacks.has(s))
  for (const s of aliveBlacks) proposals.push(s)

  // ローラー提案
  const aliveSet = new Set(alive)
  if (isRollerSituation(publicEvents, 'seer', aliveSet)) {
    const claims = collectClaimsFromEvents(publicEvents)
    for (const [seat, role] of claims) {
      if (role === 'seer' && aliveSet.has(seat) && !proposals.includes(seat)) proposals.push(seat)
    }
  }

  // シグナル
  const scores = buildSuspicionScore(publicEvents, ctx.retarPossibilities, alive, mySeat)
  const mostSuspicious = pickHighestSuspicion(scores, others, rng)

  // demand_wolf_co (Day 3+)
  if (ctx.day > 3 && rng.next() < 0.1) {
    return { signal: { type: 'demand_wolf_co' }, proposals }
  }

  // accuse_wolf (黒先がいれば)
  if (aliveBlacks.length > 0 && rng.next() < 0.3) {
    return { signal: { type: 'accuse_wolf', target: rng.pick(aliveBlacks.map(s => ({ seat: s }))).seat }, proposals }
  }

  // suspicion (最疑惑)
  if (rng.next() < 0.4 && others.length > 0) {
    return { signal: { type: 'suspicion', target: mostSuspicious }, proposals }
  }

  return { signal: { type: 'no_signal' }, proposals }
}

function decideBodyguardComm(ctx: DecisionContext): CommunicationAction {
  // 狩人は目立たない
  const proposals: number[] = []
  const blacks = collectBlackTargets(ctx.publicEvents)
  const others = ctx.alivePlayers.filter(s => s !== ctx.mySeat)
  for (const s of others) { if (blacks.has(s)) proposals.push(s) }
  return { signal: { type: 'no_signal' }, proposals }
}

function decideCommanderProposal(ctx: DecisionContext): Proposal | null {
  const { publicEvents, rng, alivePlayers: alive, retarPossibilities } = ctx

  // Hati詰み: 処刑指示（+ 占い/護衛指示をproposalsに追加）
  const action = tryTsumiAction(ctx)
  if (action && action.execute > 0 && alive.includes(action.execute)) {
    // 占い/護衛指示もproposalsに積む（他プレイヤーが参照する）
    if (action.seerTarget && alive.includes(action.seerTarget)) {
      ctx.proposals.push({ type: 'investigate_order', target: action.seerTarget })
    }
    if (action.bodyguardTarget && alive.includes(action.bodyguardTarget)) {
      ctx.proposals.push({ type: 'protect_order', target: action.bodyguardTarget })
    }
    return { type: 'execute_order', target: action.execute }
  }

  const scores = buildSuspicionScore(publicEvents, retarPossibilities, alive, ctx.mySeat)
  const candidates = alive.filter(s => s !== ctx.mySeat)
  if (candidates.length === 0) return null
  return { type: 'execute_order', target: pickHighestSuspicion(scores, candidates, rng) }
}

// ============================================================
// 人外: 人狼
// ============================================================

function decideWerewolfNight(ctx: DecisionContext): NightAction {
  // 個人Strategy経由の場合: 最小seat狼のみattack
  const state = ctx.gameState
  const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
  if (aliveWolves[0]?.seat !== ctx.mySeat) return { type: 'none' }

  const wolfSeats = new Set(aliveWolves.map(w => w.seat))
  const candidates = alivePlayers(state).filter(p => !wolfSeats.has(p.seat))
  if (candidates.length === 0) return { type: 'none' }

  return { type: 'attack', target: pickAttackTarget(candidates, ctx.rng) }
}

function pickAttackTarget(candidates: PlayerState[], rng: Rng): number {
  // 優先: 占い > 霊能 > 共有 > 村人。猫又回避
  const priorities: SystemRole[] = ['seer', 'medium', 'mason']
  for (const role of priorities) {
    const targets = candidates.filter(p => p.role === role)
    if (targets.length > 0) return rng.pick(targets).seat
  }
  // 猫又以外
  const nonNeko = candidates.filter(p => p.role !== 'nekomata')
  if (nonNeko.length > 0) return rng.pick(nonNeko).seat
  return rng.pick(candidates).seat
}

function isDesignatedFakeSeer(ctx: DecisionContext): boolean {
  // 最小seatの生存狼が占い騙り担当
  if (!ctx.wolfTeammates) return false
  const allWolves = [ctx.mySeat, ...ctx.wolfTeammates].sort((a, b) => a - b)
  const aliveSet = new Set(ctx.alivePlayers)
  const firstAliveWolf = allWolves.find(s => aliveSet.has(s))
  return firstAliveWolf === ctx.mySeat
}

function decideWerewolfClaim(ctx: DecisionContext): DayClaim {
  const { myPlayer, day, gameState: state, rng, lastExecutedSeat } = ctx

  // 既にCO済み: 結果報告
  if (myPlayer.claimedRole === 'seer') {
    return reportFakeSeerResult(state, myPlayer, day, ctx)
  }
  if (myPlayer.claimedRole === 'medium') {
    return reportFakeMediumResult(lastExecutedSeat, rng)
  }
  if (myPlayer.claimedRole === 'mason') {
    return { type: 'none' }
  }
  if (myPlayer.claimedRole !== null) return { type: 'none' }

  // 相方狼が共有COしていたら、自分も共有COを返す（相互CO）
  if (ctx.wolfTeammates) {
    const claims = collectClaimsFromEvents(ctx.publicEvents)
    for (const teammate of ctx.wolfTeammates) {
      if (claims.get(teammate) === 'mason') {
        // 相方狼が共有COで自分をパートナーに指定しているか確認
        const masonEvent = ctx.publicEvents.find(
          e => e.type === 'mason_claim' && e.actor === teammate && e.partner === ctx.mySeat
        )
        if (masonEvent) return { type: 'mason_co', partner: teammate }
      }
    }
  }

  // 共有騙り (1%): 狼2匹でペアを組む
  if (rng.next() < 0.01 && ctx.wolfTeammates && ctx.wolfTeammates.length > 0) {
    const aliveSet = new Set(ctx.alivePlayers)
    const aliveTeammate = ctx.wolfTeammates.find(s => aliveSet.has(s))
    if (aliveTeammate) {
      return { type: 'mason_co', partner: aliveTeammate }
    }
  }

  // 担当狼: 騙り役職をランダム選択
  if (isDesignatedFakeSeer(ctx)) {
    const r = rng.next()
    if (r < 0.55) {
      // 占い騙り (55%)
      for (let n = 0; n < day; n++) generateStrategicFakeResult(state, myPlayer, n, ctx)
      const results = Array.from(myPlayer.fakeDivineHistory.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ target: v.target, result: v.result }))
      return { type: 'seer_co', results }
    } else if (r < 0.75) {
      // 霊能騙り (20%)
      const pastResults = collectFakeMediumResults(state, day, rng)
      return { type: 'medium_co', pastResults }
    } else if (r < 0.85) {
      // 猫又騙り (10%)
      return { type: 'nekomata_co' }
    } else if (r < 0.90) {
      // 狩人騙り (5%)
      const targets: number[] = []
      const alive = alivePlayersExcept(state, myPlayer.seat)
      for (let n = 0; n < day - 1; n++) { if (alive.length > 0) targets.push(rng.pick(alive).seat) }
      return { type: 'bodyguard_co', targets }
    } else {
      // 潜伏 (10%)
      return { type: 'none' }
    }
  }

  // 非担当狼: 15%でCO（占い騙り）
  if (rng.next() < 0.15) {
    for (let n = 0; n < day; n++) generateStrategicFakeResult(state, myPlayer, n, ctx)
    const results = Array.from(myPlayer.fakeDivineHistory.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ target: v.target, result: v.result }))
    return { type: 'seer_co', results }
  }

  return { type: 'none' }
}

/**
 * 偽結果をセットし、Hatiで詰まれないか検証。
 * 詰まれる場合はfalseを返して結果をロールバック。
 */
function trySetFakeResult(
  player: PlayerState, night: number, target: number, result: EnumSpecies, ctx: DecisionContext,
): boolean {
  // 8人超ならチェックなしで受理
  if (ctx.alivePlayers.length > 8) {
    player.fakeDivineHistory.set(night, { target, result })
    return true
  }
  // 仮セットしてHatiチェック
  player.fakeDivineHistory.set(night, { target, result })
  const simEvents: GameEvent[] = [...ctx.publicEvents, {
    type: 'seer_result' as const,
    actor: ctx.mySeat,
    target,
    result,
  }]
  const tsumi = tryTsumiWithEvents(simEvents, ctx)
  if (tsumi) {
    // 詰まれる → ロールバック
    player.fakeDivineHistory.delete(night)
    return false
  }
  return true
}

function generateStrategicFakeResult(
  state: GameState, player: PlayerState, night: number, ctx: DecisionContext,
): void {
  if (player.fakeDivineHistory.has(night)) return
  const divined = new Set(Array.from(player.fakeDivineHistory.values()).map(d => d.target))
  const wolfSeats = new Set([ctx.mySeat, ...(ctx.wolfTeammates ?? [])])
  const candidates = alivePlayersExcept(state, player.seat).filter(p => !divined.has(p.seat))
  if (candidates.length === 0) return

  const rng = ctx.rng

  // 仲間狼に白出し (40%)
  if (rng.next() < 0.4) {
    const wolfAllies = candidates.filter(p => wolfSeats.has(p.seat))
    if (wolfAllies.length > 0) {
      const target = rng.pick(wolfAllies)
      if (trySetFakeResult(player, night, target.seat, 'human', ctx)) return
    }
  }

  // 非狼に黒出し — 真占いに黒が最優先
  const nonWolves = candidates.filter(p => !wolfSeats.has(p.seat))
  if (nonWolves.length > 0) {
    const trueSeer = nonWolves.find(p => p.role === 'seer')
    if (trueSeer && rng.next() < 0.6) {
      if (trySetFakeResult(player, night, trueSeer.seat, 'wolf', ctx)) return
    }
    const hamster = nonWolves.find(p => p.role === 'werehamster')
    if (hamster && rng.next() < 0.2) {
      if (trySetFakeResult(player, night, hamster.seat, 'wolf', ctx)) return
    }
    // ランダム黒出し（詰まれないものを探す）
    const shuffled = [...nonWolves].sort(() => rng.next() - 0.5)
    for (const t of shuffled) {
      if (trySetFakeResult(player, night, t.seat, 'wolf', ctx)) return
    }
    // 全部詰まれるなら白出し
    for (const t of shuffled) {
      if (trySetFakeResult(player, night, t.seat, 'human', ctx)) return
    }
  }

  // フォールバック
  const target = rng.pick(candidates)
  player.fakeDivineHistory.set(night, { target: target.seat, result: 'human' })
}

function reportFakeSeerResult(
  state: GameState, player: PlayerState, day: number, ctx: DecisionContext,
): DayClaim {
  const night = day - 1
  generateStrategicFakeResult(state, player, night, ctx)
  const latest = player.fakeDivineHistory.get(night)
  if (!latest) return { type: 'none' }
  return { type: 'seer_result', target: latest.target, result: latest.result }
}

function reportFakeMediumResult(lastExecutedSeat: number | null, rng: Rng): DayClaim {
  if (lastExecutedSeat === null) return { type: 'none' }
  const result: EnumSpecies = rng.next() < 0.5 ? 'human' : 'wolf'
  return { type: 'medium_result', result }
}

/**
 * 狼視点の飽和・狐判定
 * 飽和間近（あと1処刑で狼勝ちだが狐生存で狐勝ちになる）かを返す
 */
function detectFoxThreat(ctx: DecisionContext): {
  nearSaturation: boolean
  foxCandidates: number[]
} {
  const state = ctx.gameState
  const alive = ctx.alivePlayers
  const wolfSeats = new Set([ctx.mySeat, ...(ctx.wolfTeammates ?? [])])
  const aliveWolfCount = alive.filter(s => wolfSeats.has(s)).length

  // 狐候補: 狼視点で狐の位置を知っている（gameState参照OK）
  const foxSeats = state.players
    .filter(p => p.alive && p.role === 'werehamster')
    .map(p => p.seat)

  // 飽和判定: 次の処刑で非狼が減ったとき狼数≧残りになるか
  // 現在の非狼非狐数
  const nonWolfNonFox = alive.length - aliveWolfCount - foxSeats.length
  // あと1人村人を処刑すると飽和: aliveWolfCount >= (nonWolfNonFox - 1)
  const nearSaturation = aliveWolfCount >= nonWolfNonFox - 1 && foxSeats.length > 0

  return { nearSaturation, foxCandidates: foxSeats }
}

function decideWerewolfVote(ctx: DecisionContext): number {
  const { gameState: state, rng, alivePlayers: alive, mySeat } = ctx
  const wolfSeats = new Set([mySeat, ...(ctx.wolfTeammates ?? [])])
  const candidates = alive.filter(s => s !== mySeat && !wolfSeats.has(s))
  if (candidates.length === 0) return alive.find(s => s !== mySeat) ?? mySeat

  // 狐脅威判定: 飽和間近で狐が生きていたら狐を最優先処刑
  const { nearSaturation, foxCandidates } = detectFoxThreat(ctx)
  if (nearSaturation && foxCandidates.length > 0) {
    const aliveFox = foxCandidates.filter(s => candidates.includes(s))
    if (aliveFox.length > 0) return rng.pick(aliveFox.map(s => ({ seat: s }))).seat
  }

  // PP判定（生存奇数 & 狐非生存 & 狂信者が特定済み）
  const aliveWolfCount = alive.filter(s => wolfSeats.has(s)).length
  const hamsterCount = alivePlayers(state).filter(p => p.alive && p.role === 'werehamster').length
  // 狂信者特定: fanatic_COシグナル or Retarで確定
  const fanaticCOed = ctx.publicEvents.some(e =>
    e.type === 'signal' && e.signal.type === 'fanatic_co' && alive.includes(e.actor)
  )
  const fanaticConfirmedByRetar = ctx.retarPossibilities && alive.some(s => {
    if (wolfSeats.has(s) || s === mySeat) return false
    const roles = ctx.retarPossibilities!.get(s)
    return roles && roles.size === 1 && roles.has('fanatic')
  })
  const fanaticIdentified = fanaticCOed || fanaticConfirmedByRetar
  const wolfSideCount = aliveWolfCount + (fanaticIdentified ? 1 : 0)
  const nonWolfSide = alive.length - wolfSideCount - hamsterCount
  if (alive.length % 2 === 1 && fanaticIdentified && wolfSideCount >= nonWolfSide && hamsterCount === 0) {
    const villagers = candidates.filter(s => {
      const p = state.players.find(pp => pp.seat === s)!
      return !isWerewolfAligned(p.role) && p.role !== 'werehamster' && p.role !== 'immoralist'
    })
    if (villagers.length > 0) return rng.pick(villagers.map(s => ({ seat: s }))).seat
  }

  // CO役職に応じた投票（自分の主張と一貫性を持たせる）
  const claimedRole = ctx.myPlayer.claimedRole
  if (claimedRole === 'seer') {
    const blacks = collectBlackTargets(ctx.publicEvents)
    const myBlacks = candidates.filter(s => blacks.has(s))
    if (myBlacks.length > 0 && rng.next() < 0.8) {
      return rng.pick(myBlacks.map(s => ({ seat: s }))).seat
    }
  }

  // 真占いCO者（非狼）を優先処刑
  const claims = collectClaimsFromEvents(ctx.publicEvents)
  const trueSeerClaimers = candidates.filter(s => claims.get(s) === 'seer' && !wolfSeats.has(s))
  if (trueSeerClaimers.length > 0 && rng.next() < 0.7) {
    return rng.pick(trueSeerClaimers.map(s => ({ seat: s }))).seat
  }

  return rng.pick(candidates.map(s => ({ seat: s }))).seat
}

function decideWerewolfComm(ctx: DecisionContext): CommunicationAction {
  const { gameState: state, rng, alivePlayers: alive, mySeat } = ctx
  const wolfSeats = new Set([mySeat, ...(ctx.wolfTeammates ?? [])])
  const others = alive.filter(s => s !== mySeat)
  const proposals: number[] = []

  // 狐脅威: 飽和間近で狐生存 → 狼COして狐処刑を訴える
  const { nearSaturation, foxCandidates } = detectFoxThreat(ctx)
  if (nearSaturation && foxCandidates.length > 0) {
    for (const s of foxCandidates) proposals.push(s)
    if (rng.next() < 0.8) {
      return { signal: { type: 'werewolf_co' }, proposals }
    }
    return { signal: { type: 'accuse_fox', target: rng.pick(foxCandidates.map(s => ({ seat: s }))).seat }, proposals }
  }

  // PP判定 → werewolf_co（狐がいないとき）
  const aliveWolfCount = alive.filter(s => wolfSeats.has(s)).length
  const hamsterCount = alivePlayers(state).filter(p => p.alive && p.role === 'werehamster').length
  const fanaticCOed = ctx.publicEvents.some(e =>
    e.type === 'signal' && e.signal.type === 'fanatic_co' && alive.includes(e.actor)
  )
  const fanaticConfirmedByRetar = ctx.retarPossibilities && alive.some(s => {
    if (wolfSeats.has(s) || s === mySeat) return false
    const roles = ctx.retarPossibilities!.get(s)
    return roles && roles.size === 1 && roles.has('fanatic')
  })
  const fanaticIdentified = fanaticCOed || fanaticConfirmedByRetar
  const wolfSideCount = aliveWolfCount + (fanaticIdentified ? 1 : 0)
  const nonWolfSide = alive.length - wolfSideCount - hamsterCount
  if (alive.length % 2 === 1 && fanaticIdentified && wolfSideCount >= nonWolfSide && hamsterCount === 0 && rng.next() < 0.9) {
    return { signal: { type: 'werewolf_co' }, proposals }
  }

  // CO役職に応じた振る舞い（Retarの可能性を使って矛盾しない行動を選ぶ）
  const claimedRole = ctx.myPlayer.claimedRole
  const retarP = ctx.retarPossibilities

  if (claimedRole === 'seer') {
    // 占い騙り: 自分の黒出し先を処刑提案 + accuse_wolf
    const blacks = collectBlackTargets(ctx.publicEvents)
    const aliveBlacks = others.filter(s => blacks.has(s))
    if (aliveBlacks.length > 0) {
      for (const s of aliveBlacks) proposals.push(s)
      return { signal: { type: 'accuse_wolf', target: rng.pick(aliveBlacks.map(s => ({ seat: s }))).seat }, proposals }
    }
    // 白出し先にtrust
    const whites = collectWhiteTargets(ctx.publicEvents)
    const aliveWhites = others.filter(s => whites.has(s) && !wolfSeats.has(s))
    if (aliveWhites.length > 0 && rng.next() < 0.3) {
      return { signal: { type: 'trust', target: rng.pick(aliveWhites.map(s => ({ seat: s }))).seat }, proposals }
    }
  } else if (claimedRole === 'medium') {
    // 霊能騙り: Retarで狼可能性が高い非狼を疑う（村人っぽく振る舞う）
    if (retarP) {
      const suspicious = others.filter(s => {
        const roles = retarP.get(s)
        return roles && roles.has('werewolf') && !wolfSeats.has(s)
      })
      if (suspicious.length > 0 && rng.next() < 0.4) {
        const t = rng.pick(suspicious.map(s => ({ seat: s }))).seat
        proposals.push(t)
        return { signal: { type: 'suspicion', target: t }, proposals }
      }
    }
  } else if (claimedRole === 'nekomata') {
    // 猫又騙り: おとなしく、非狼に軽い疑い程度
    if (rng.next() < 0.2 && others.length > 0) {
      const nonWolves = others.filter(s => !wolfSeats.has(s))
      if (nonWolves.length > 0) {
        return { signal: { type: 'suspicion', target: rng.pick(nonWolves.map(s => ({ seat: s }))).seat }, proposals }
      }
    }
    return { signal: { type: 'no_signal' }, proposals }
  } else if (claimedRole === 'bodyguard') {
    // 狩人騙り: 確定村っぽい人にtrust、非狼にsuspicion
    if (retarP) {
      const confirmed = others.filter(s => {
        const roles = retarP.get(s)
        return roles && roles.size === 1 && !wolfSeats.has(s)
      })
      if (confirmed.length > 0 && rng.next() < 0.3) {
        return { signal: { type: 'trust', target: rng.pick(confirmed.map(s => ({ seat: s }))).seat }, proposals }
      }
    }
  } else if (claimedRole === 'mason') {
    // 共有騙り: 相方狼にtrust、非狼にsuspicion
    const partner = ctx.wolfTeammates?.find(s => alive.includes(s))
    if (partner && rng.next() < 0.4) {
      return { signal: { type: 'trust', target: partner }, proposals }
    }
  }

  // 潜伏 or フォールバック: Retarで狼可能性が高い非狼に疑い
  if (retarP && rng.next() < 0.3) {
    const suspicious = others.filter(s => {
      const roles = retarP.get(s)
      return roles && roles.has('werewolf') && !wolfSeats.has(s)
    })
    if (suspicious.length > 0) {
      const t = rng.pick(suspicious.map(s => ({ seat: s }))).seat
      return { signal: { type: 'suspicion', target: t }, proposals }
    }
  }

  // 非狼に suspicion
  if (rng.next() < 0.3 && others.length > 0) {
    const nonWolves = others.filter(s => !wolfSeats.has(s))
    if (nonWolves.length > 0) {
      return { signal: { type: 'suspicion', target: rng.pick(nonWolves.map(s => ({ seat: s }))).seat }, proposals }
    }
  }

  return { signal: { type: 'no_signal' }, proposals }
}

// ============================================================
// 人外: 狂信者
// ============================================================

function decideFanaticClaim(ctx: DecisionContext): DayClaim {
  const { myPlayer, day, gameState: state, rng, lastExecutedSeat } = ctx

  // 既にCO済み: 結果報告
  if (myPlayer.claimedRole === 'seer') {
    return reportFanaticSeerResult(state, myPlayer, day, ctx)
  }
  if (myPlayer.claimedRole === 'medium') {
    return reportFakeMediumResult(lastExecutedSeat, rng)
  }
  if (myPlayer.claimedRole !== null) return { type: 'none' }

  // CO率: 初日90%、二日目以降99%
  const coRate = day === 1 ? 0.9 : 0.99
  if (rng.next() >= coRate) return { type: 'none' }

  const r = rng.next()
  if (r < 0.50) {
    // 占い騙り (50%)
    for (let n = 0; n < day; n++) generateFanaticFakeResult(state, myPlayer, n, ctx)
    const results = Array.from(myPlayer.fakeDivineHistory.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ target: v.target, result: v.result }))
    return { type: 'seer_co', results }
  } else if (r < 0.70) {
    // 霊能騙り (20%)
    const pastResults = collectFakeMediumResults(state, day, rng)
    return { type: 'medium_co', pastResults }
  } else if (r < 0.80) {
    // 猫又騙り (10%)
    return { type: 'nekomata_co' }
  } else if (r < 0.88) {
    // 狩人騙り (8%)
    const targets: number[] = []
    const alive = alivePlayersExcept(state, myPlayer.seat)
    for (let n = 0; n < day; n++) { if (alive.length > 0) targets.push(rng.pick(alive).seat) }
    return { type: 'bodyguard_co', targets }
  } else if (r < 0.93) {
    // 共有騙り (5%) — 適当な非狼をパートナーに
    const alive = alivePlayersExcept(state, myPlayer.seat)
    if (alive.length > 0) return { type: 'mason_co', partner: rng.pick(alive).seat }
  }
  // 潜伏 (7%)
  return { type: 'none' }
}

/**
 * 狂信者の偽占い結果生成
 *
 * 真占いと同じロジックで占い先を選び、結果だけ操作する:
 * - 占い先が狼 → 白出し（守る）
 * - 占い先が非狼 → 一定確率で黒出し（偽黒で混乱させる）
 */
function generateFanaticFakeResult(
  _state: GameState, player: PlayerState, night: number, ctx: DecisionContext,
): void {
  if (player.fakeDivineHistory.has(night)) return
  const divined = new Set(Array.from(player.fakeDivineHistory.values()).map(d => d.target))
  const wolves = new Set(ctx.knownWolves ?? [])
  const alive = ctx.alivePlayers
  const others = alive.filter(s => s !== ctx.mySeat)
  const candidates = others.filter(s => !divined.has(s))
  if (candidates.length === 0) return

  const rng = ctx.rng
  const retarP = ctx.retarPossibilities

  // 占い先を真占いと同じ方針で選択
  let target: number

  // 戦略ランダム選択（pickDivineTargetと同様）
  const strategies = ['gray', 'fox', 'verify'] as const
  const strategy = rng.pick(strategies.map(s => ({ s }))).s

  if (strategy === 'fox' && retarP) {
    const foxCands = candidates.filter(s => {
      const roles = retarP.get(s)
      return roles && roles.has('werehamster') && roles.size > 1
    })
    if (foxCands.length > 0) { target = rng.pick(foxCands.map(s => ({ seat: s }))).seat }
    else { target = pickFanaticDefaultTarget(candidates, retarP, rng) }
  } else if (strategy === 'verify') {
    const claims = collectClaimsFromEvents(ctx.publicEvents)
    const claimerCands = candidates.filter(s => {
      const role = claims.get(s)
      return role === 'seer' || role === 'medium'
    })
    if (claimerCands.length > 0) { target = rng.pick(claimerCands.map(s => ({ seat: s }))).seat }
    else { target = pickFanaticDefaultTarget(candidates, retarP, rng) }
  } else {
    target = pickFanaticDefaultTarget(candidates, retarP, rng)
  }

  // 結果を操作
  if (wolves.has(target)) {
    // 狼 → 白出し
    player.fakeDivineHistory.set(night, { target, result: 'human' })
  } else {
    // 非狼 → 50%で黒出し
    const result: EnumSpecies = rng.next() < 0.5 ? 'wolf' : 'human'
    player.fakeDivineHistory.set(night, { target, result })
  }
}

function pickFanaticDefaultTarget(
  candidates: number[],
  retarP: Map<number, Set<SystemRole>> | null,
  rng: Rng,
): number {
  // グレー詰め: Retarで狼可能性が残る不確定席
  if (retarP) {
    const uncertain = candidates.filter(s => {
      const roles = retarP.get(s)
      return roles && roles.has('werewolf') && roles.size > 1
    })
    if (uncertain.length > 0) return rng.pick(uncertain.map(s => ({ seat: s }))).seat
  }
  return rng.pick(candidates.map(s => ({ seat: s }))).seat
}

function reportFanaticSeerResult(
  state: GameState, player: PlayerState, day: number, ctx: DecisionContext,
): DayClaim {
  const night = day - 1
  generateFanaticFakeResult(state, player, night, ctx)
  const latest = player.fakeDivineHistory.get(night)
  if (!latest) return { type: 'none' }
  return { type: 'seer_result', target: latest.target, result: latest.result }
}

function collectFakeMediumResults(state: GameState, day: number, rng: Rng): EnumSpecies[] {
  const results: EnumSpecies[] = []
  for (let d = 1; d < day; d++) {
    if (!state.executionHistory.has(d)) continue
    results.push(rng.next() < 0.5 ? 'human' : 'wolf')
  }
  return results
}

/** 狂信者視点のPP判定: 生存奇数 & 狼+自分≧非狼 & 狐非生存 */
function detectFanaticPP(ctx: DecisionContext): boolean {
  const wolves = new Set(ctx.knownWolves ?? [])
  const alive = ctx.alivePlayers
  if (alive.length % 2 === 0) return false // 偶数ならPP不成立

  const aliveWolfCount = alive.filter(s => wolves.has(s)).length
  const wolfSideCount = aliveWolfCount + 1 // +自分(狂信者)
  const nonWolfSide = alive.length - wolfSideCount

  if (wolfSideCount < nonWolfSide) return false

  // 狐が生存していないか確認（Retarで狐可能性がある生存者がいなければ狐非生存と判断）
  const retarP = ctx.retarPossibilities
  if (retarP) {
    const foxPossible = alive.some(s => {
      if (s === ctx.mySeat || wolves.has(s)) return false
      const roles = retarP.get(s)
      return roles && roles.has('werehamster')
    })
    if (foxPossible) return false // 狐がいるかもしれない → PP危険
  }

  return true
}

function decideFanaticVote(ctx: DecisionContext): number {
  const { rng, alivePlayers: alive, mySeat } = ctx
  const wolves = new Set(ctx.knownWolves ?? [])
  const candidates = alive.filter(s => s !== mySeat && !wolves.has(s))
  if (candidates.length === 0) return alive.find(s => s !== mySeat) ?? mySeat

  // PP: 狐非生存で狼陣営過半数 → 村人を処刑
  if (detectFanaticPP(ctx)) {
    return rng.pick(candidates.map(s => ({ seat: s }))).seat
  }

  // 真占いCO者を優先
  const claims = collectClaimsFromEvents(ctx.publicEvents)
  const seerClaimers = candidates.filter(s => claims.get(s) === 'seer' && !wolves.has(s))
  if (seerClaimers.length > 0 && rng.next() < 0.6) {
    return rng.pick(seerClaimers.map(s => ({ seat: s }))).seat
  }
  return rng.pick(candidates.map(s => ({ seat: s }))).seat
}

function decideFanaticComm(ctx: DecisionContext): CommunicationAction {
  const { rng } = ctx

  // PP宣言: 狐非生存で狼陣営過半数 → fanatic_co
  if (detectFanaticPP(ctx) && rng.next() < 0.9) {
    return { signal: { type: 'fanatic_co' }, proposals: [] }
  }

  // それ以外は狼と似た動き
  return decideWerewolfComm(ctx)
}

// ============================================================
// 人外: 妖狐 / 背徳者
// ============================================================

function decideHamsterClaim(ctx: DecisionContext): DayClaim {
  const { myPlayer, day, rng, gameState: state, lastExecutedSeat } = ctx

  // 既にCO済み: 結果報告
  if (myPlayer.claimedRole === 'seer') {
    return reportHamsterSeerResult(state, myPlayer, day, ctx)
  }
  if (myPlayer.claimedRole === 'medium') {
    return reportFakeMediumResult(lastExecutedSeat, rng)
  }
  if (myPlayer.claimedRole !== null) return { type: 'none' }

  // CO率: 基本潜伏だが追い詰められたらCO
  // Day 1: 85%潜伏、Day 2+: 70%潜伏
  const stealthRate = day === 1 ? 0.85 : 0.70
  if (rng.next() < stealthRate) return { type: 'none' }

  const r = rng.next()
  if (r < 0.40) {
    // 占い騙り (40%) — 呪殺されない（自分が狐なので）利点を活かす
    for (let n = 0; n < day; n++) generateHamsterFakeResult(state, myPlayer, n, ctx)
    const results = Array.from(myPlayer.fakeDivineHistory.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ target: v.target, result: v.result }))
    return { type: 'seer_co', results }
  } else if (r < 0.70) {
    // 霊能騙り (30%)
    const pastResults = collectFakeMediumResults(state, day, rng)
    return { type: 'medium_co', pastResults }
  } else if (r < 0.85) {
    // 猫又騙り (15%) — 処刑抑止
    return { type: 'nekomata_co' }
  } else {
    // 狩人騙り (15%)
    const targets: number[] = []
    const alive = alivePlayersExcept(state, myPlayer.seat)
    for (let n = 0; n < day; n++) { if (alive.length > 0) targets.push(rng.pick(alive).seat) }
    return { type: 'bodyguard_co', targets }
  }
}

/**
 * 妖狐の偽占い結果: 真占いのように振る舞いつつ、詰み回避
 *
 * - 占い先は真占いと同じロジック（グレー詰め/狐狙い/CO者検証）
 * - 結果は黒30%/白70%（真っぽい比率）
 * - Hatiで詰まれる結果は回避（グレーを狭めすぎない）
 */
function generateHamsterFakeResult(
  _state: GameState, player: PlayerState, night: number, ctx: DecisionContext,
): void {
  if (player.fakeDivineHistory.has(night)) return
  const divined = new Set(Array.from(player.fakeDivineHistory.values()).map(d => d.target))
  const others = ctx.alivePlayers.filter(s => s !== ctx.mySeat)
  const candidates = others.filter(s => !divined.has(s))
  if (candidates.length === 0) return

  const rng = ctx.rng
  const retarP = ctx.retarPossibilities

  // 占い先を真占いと同じ方針で選択
  let target: number
  const strategies = ['gray', 'fox', 'verify'] as const
  const strategy = rng.pick(strategies.map(s => ({ s }))).s

  if (strategy === 'fox' && retarP) {
    // 狐狙い — ただし自分が狐なので自分以外
    const foxCands = candidates.filter(s => {
      const roles = retarP.get(s)
      return roles && roles.has('werehamster') && roles.size > 1
    })
    if (foxCands.length > 0) target = rng.pick(foxCands.map(s => ({ seat: s }))).seat
    else target = pickHamsterDefaultTarget(candidates, retarP, rng)
  } else if (strategy === 'verify') {
    const claims = collectClaimsFromEvents(ctx.publicEvents)
    const claimerCands = candidates.filter(s => {
      const role = claims.get(s)
      return role === 'seer' || role === 'medium'
    })
    if (claimerCands.length > 0) target = rng.pick(claimerCands.map(s => ({ seat: s }))).seat
    else target = pickHamsterDefaultTarget(candidates, retarP, rng)
  } else {
    target = pickHamsterDefaultTarget(candidates, retarP, rng)
  }

  // 結果を決定（黒30%/白70%）、Hati詰みチェック付き
  const preferredResult: EnumSpecies = rng.next() < 0.3 ? 'wolf' : 'human'
  if (trySetFakeResult(player, night, target, preferredResult, ctx)) return

  // 詰まれたら逆の結果を試す
  const altResult: EnumSpecies = preferredResult === 'wolf' ? 'human' : 'wolf'
  if (trySetFakeResult(player, night, target, altResult, ctx)) return

  // 別のターゲットでも試す
  const shuffled = [...candidates].filter(s => s !== target).sort(() => rng.next() - 0.5)
  for (const t of shuffled) {
    if (trySetFakeResult(player, night, t, 'human', ctx)) return
  }

  // フォールバック（チェックなし）
  player.fakeDivineHistory.set(night, { target, result: 'human' })
}

function pickHamsterDefaultTarget(
  candidates: number[],
  retarP: Map<number, Set<SystemRole>> | null,
  rng: Rng,
): number {
  if (retarP) {
    const uncertain = candidates.filter(s => {
      const roles = retarP.get(s)
      return roles && roles.has('werewolf') && roles.size > 1
    })
    if (uncertain.length > 0) return rng.pick(uncertain.map(s => ({ seat: s }))).seat
  }
  return rng.pick(candidates.map(s => ({ seat: s }))).seat
}

function reportHamsterSeerResult(
  state: GameState, player: PlayerState, day: number, ctx: DecisionContext,
): DayClaim {
  const night = day - 1
  generateHamsterFakeResult(state, player, night, ctx)
  const latest = player.fakeDivineHistory.get(night)
  if (!latest) return { type: 'none' }
  return { type: 'seer_result', target: latest.target, result: latest.result }
}

function decideImmoralistClaim(ctx: DecisionContext): DayClaim {
  const { myPlayer, day, rng, gameState: state, lastExecutedSeat } = ctx

  // 既にCO済み: 結果報告
  if (myPlayer.claimedRole === 'seer') {
    return reportImmoralistSeerResult(state, myPlayer, day, ctx)
  }
  if (myPlayer.claimedRole === 'medium') {
    return reportFakeMediumResult(lastExecutedSeat, rng)
  }
  if (myPlayer.claimedRole !== null) return { type: 'none' }

  // CO率: 初日80%、二日目以降99%
  const coRate = day === 1 ? 0.8 : 0.99
  if (rng.next() >= coRate) return { type: 'none' }

  // 占いCOを基本とする（狐を守る偽結果を出せる）
  const r = rng.next()
  if (r < 0.7) {
    // 占い騙り
    for (let n = 0; n < day; n++) {
      generateImmoralistFakeResult(state, myPlayer, n, ctx)
    }
    const results = Array.from(myPlayer.fakeDivineHistory.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ target: v.target, result: v.result }))
    return { type: 'seer_co', results }
  } else if (r < 0.85) {
    // 霊能騙り
    const pastResults = collectFakeMediumResults(state, day, rng)
    return { type: 'medium_co', pastResults }
  } else if (r < 0.93) {
    // 狩人騙り
    const targets: number[] = []
    const alive = alivePlayersExcept(state, myPlayer.seat)
    for (let n = 0; n < day; n++) {
      if (alive.length > 0) targets.push(rng.pick(alive).seat)
    }
    return { type: 'bodyguard_co', targets }
  } else {
    // 猫又騙り
    return { type: 'nekomata_co' }
  }
}

/** 背徳者の偽占い結果生成: 狐を守ることが目的 */
function generateImmoralistFakeResult(
  state: GameState, player: PlayerState, night: number, ctx: DecisionContext,
): void {
  if (player.fakeDivineHistory.has(night)) return
  const divined = new Set(Array.from(player.fakeDivineHistory.values()).map(d => d.target))
  const candidates = alivePlayersExcept(state, player.seat).filter(p => !divined.has(p.seat))
  if (candidates.length === 0) return

  const rng = ctx.rng
  const hamsterSeat = ctx.knownHamster

  // 真占いが死亡しているか確認
  const claims = collectClaimsFromEvents(ctx.publicEvents)
  const aliveSet = new Set(ctx.alivePlayers)
  const aliveSeerClaimers = [...claims.entries()].filter(
    ([seat, role]) => role === 'seer' && seat !== ctx.mySeat && aliveSet.has(seat)
  )
  const trueSeerLikelyDead = aliveSeerClaimers.length === 0

  // 狐への結果
  const hamsterCandidate = candidates.find(p => p.seat === hamsterSeat)
  if (hamsterCandidate) {
    if (trueSeerLikelyDead && rng.next() < 0.3) {
      // 真占い死亡 → 狐に黒出し（村が狼と誤認→他を先に吊る）
      player.fakeDivineHistory.set(night, { target: hamsterCandidate.seat, result: 'wolf' })
      return
    }
    // 基本: 狐に白出し（狐の疑惑を下げる）
    player.fakeDivineHistory.set(night, { target: hamsterCandidate.seat, result: 'human' })
    return
  }

  // 狐以外: ランダムに黒出し（自分の疑惑を上げ、破綻して先に吊られる）
  const nonHamster = candidates.filter(p => p.seat !== hamsterSeat)
  if (nonHamster.length > 0 && rng.next() < 0.5) {
    player.fakeDivineHistory.set(night, { target: rng.pick(nonHamster).seat, result: 'wolf' })
    return
  }

  // 白出し
  if (nonHamster.length > 0) {
    player.fakeDivineHistory.set(night, { target: rng.pick(nonHamster).seat, result: 'human' })
    return
  }
  player.fakeDivineHistory.set(night, { target: rng.pick(candidates).seat, result: 'human' })
}

function reportImmoralistSeerResult(
  state: GameState, player: PlayerState, day: number, ctx: DecisionContext,
): DayClaim {
  const night = day - 1
  generateImmoralistFakeResult(state, player, night, ctx)
  const latest = player.fakeDivineHistory.get(night)
  if (!latest) return { type: 'none' }
  return { type: 'seer_result', target: latest.target, result: latest.result }
}

function decideImmoralistVote(ctx: DecisionContext): number {
  const { rng, alivePlayers: alive, mySeat, knownHamster } = ctx
  const candidates = alive.filter(s => s !== mySeat && s !== knownHamster)
  if (candidates.length === 0) return alive.find(s => s !== mySeat) ?? mySeat

  // 村人のふり
  const scores = buildSuspicionScore(ctx.publicEvents, ctx.retarPossibilities, alive, mySeat)
  return pickHighestSuspicion(scores, candidates, rng)
}

function decideImmoralistComm(ctx: DecisionContext): CommunicationAction {
  const base = decideVillagerComm(ctx)

  // 妖狐が処刑提案されていたら除外
  if (ctx.knownHamster && base.proposals.includes(ctx.knownHamster)) {
    base.proposals = base.proposals.filter(s => s !== ctx.knownHamster)
  }

  // 妖狐へのaccuse_wolfをdisagreeで反応
  if (base.signal.type === 'accuse_wolf' && 'target' in base.signal && base.signal.target === ctx.knownHamster) {
    return { signal: { type: 'no_signal' }, proposals: base.proposals }
  }

  return base
}

// ============================================================
// 狼チームヒューリスティック
// ============================================================

export class WolfTeamHeuristic implements TeamStrategy {
  private individual = new HeuristicStrategy()

  decideNightAction(ctx: TeamDecisionContext): WolfNightAction {
    const state = ctx.gameState
    const aliveWolves = ctx.teamPlayers.filter(p => p.alive)
    if (aliveWolves.length === 0) return { target: 1, attacker: ctx.teamSeats[0] }

    const wolfSeats = new Set(ctx.teamSeats)
    const candidates = alivePlayers(state).filter(p => !wolfSeats.has(p.seat))
    if (candidates.length === 0) return { target: 1, attacker: aliveWolves[0].seat }

    const rng = ctx.rng
    const target = pickAttackTarget(candidates, rng)

    // 襲撃者: 占い騙り狼を避ける（道連れで騙りが崩れる）
    const fakeSeer = aliveWolves.find(p => p.claimedRole === 'seer')
    const nonFakeSeer = aliveWolves.filter(p => p.claimedRole !== 'seer')
    let attacker: number
    if (fakeSeer && nonFakeSeer.length > 0) {
      attacker = rng.pick(nonFakeSeer).seat
    } else {
      attacker = rng.pick(aliveWolves).seat
    }

    return { target, attacker }
  }

  decideDayClaim(ctx: TeamDecisionContext): DayClaim {
    return this.individual.decideDayClaim(this.buildActorCtx(ctx))
  }

  decideForecast(ctx: TeamDecisionContext): DayClaim {
    return this.individual.decideForecast(this.buildActorCtx(ctx))
  }

  decideVote(ctx: TeamDecisionContext): number {
    return this.individual.decideVote(this.buildActorCtx(ctx))
  }

  decideCommunication(ctx: TeamDecisionContext): CommunicationAction {
    return this.individual.decideCommunication(this.buildActorCtx(ctx))
  }

  decideProposal(ctx: TeamDecisionContext): Proposal | null {
    return this.individual.decideProposal(this.buildActorCtx(ctx))
  }

  decideLeadershipResponse(ctx: TeamDecisionContext, proposal: Proposal): LeadershipResponse {
    return this.individual.decideLeadershipResponse(this.buildActorCtx(ctx), proposal)
  }

  private buildActorCtx(ctx: TeamDecisionContext): DecisionContext {
    const seat = ctx.currentActorSeat ?? ctx.teamSeats[0]
    const player = ctx.gameState.players.find(p => p.seat === seat)!
    return { ...ctx, mySeat: seat, myRole: player.role, myPlayer: player, wolfTeammates: ctx.teamSeats.filter(s => s !== seat) }
  }
}

// ============================================================
// 共有者チームヒューリスティック
// ============================================================

export class MasonTeamHeuristic implements TeamStrategy {
  private individual = new HeuristicStrategy()

  decideNightAction(_ctx: TeamDecisionContext): NightAction {
    return { type: 'none' }
  }

  decideDayClaim(ctx: TeamDecisionContext): DayClaim {
    return this.individual.decideDayClaim(this.buildActorCtx(ctx))
  }

  decideForecast(ctx: TeamDecisionContext): DayClaim {
    return this.individual.decideForecast(this.buildActorCtx(ctx))
  }

  decideVote(ctx: TeamDecisionContext): number {
    return this.individual.decideVote(this.buildActorCtx(ctx))
  }

  decideCommunication(ctx: TeamDecisionContext): CommunicationAction {
    return this.individual.decideCommunication(this.buildActorCtx(ctx))
  }

  decideProposal(ctx: TeamDecisionContext): Proposal | null {
    return this.individual.decideProposal(this.buildActorCtx(ctx))
  }

  decideLeadershipResponse(ctx: TeamDecisionContext, proposal: Proposal): LeadershipResponse {
    return this.individual.decideLeadershipResponse(this.buildActorCtx(ctx), proposal)
  }

  private buildActorCtx(ctx: TeamDecisionContext): DecisionContext {
    const seat = ctx.currentActorSeat ?? ctx.teamSeats[0]
    const player = ctx.gameState.players.find(p => p.seat === seat)!
    const partner = ctx.teamSeats.find(s => s !== seat) ?? null
    return { ...ctx, mySeat: seat, myRole: player.role, myPlayer: player, masonPartner: partner }
  }
}

// ============================================================
// エンジン用ユーティリティ（維持）
// ============================================================

export function forceTrueRoleCO(
  state: GameState, player: PlayerState, _day: number,
  _lastExecutedSeat: number | null,
): DayClaim {
  switch (player.role) {
    case 'seer': {
      const results = Array.from(player.divineHistory.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ target: v.target, result: v.result }))
      return { type: 'seer_co', results }
    }
    case 'medium':
      return { type: 'medium_co' }
    case 'bodyguard': {
      const targets = Array.from(player.guardHistory.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, seat]) => seat)
      return { type: 'bodyguard_co', targets }
    }
    case 'mason': {
      const partner = state.players.find(p => p.seat !== player.seat && p.role === 'mason')
      if (!partner) return { type: 'none' }
      return { type: 'mason_co', partner: partner.seat }
    }
    case 'nekomata':
      return { type: 'nekomata_co' }
    default:
      return { type: 'none' }
  }
}

export function resolveVotes(votes: Map<number, number>): { decided: number } | { tied: number[] } {
  const counts = new Map<number, number>()
  for (const target of votes.values()) {
    counts.set(target, (counts.get(target) ?? 0) + 1)
  }
  let maxCount = 0
  let maxTargets: number[] = []
  for (const [target, count] of counts) {
    if (count > maxCount) { maxCount = count; maxTargets = [target] }
    else if (count === maxCount) maxTargets.push(target)
  }
  if (maxTargets.length === 1) return { decided: maxTargets[0] }
  return { tied: maxTargets.sort((a, b) => a - b) }
}
