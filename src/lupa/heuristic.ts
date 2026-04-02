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
import { searchTsumiFromEvents, checkRetarConsistency } from './retar-bridge.ts'
import type { VillageAction } from '../hati/types.ts'
import { forceTrueRoleCO } from './engine-utils.ts'

// ============================================================
// 定数
// ============================================================

// 疑惑スコア重み
const W = {
  BLACK_RESULT: 25,
  BLACK_RESULT_ROLLER: 12,    // ローラー中（占い複数CO）の黒出し
  WHITE_RESULT: -15,
  RETAR_WOLF_POSSIBLE: 5,
  RETAR_WOLF_IMPOSSIBLE: -200, // 論理的確実: 絶対に上書きされない
  RETAR_CONFIRMED: -200,       // 論理的確実: 役職確定
  MULTI_SEER_CLAIMER: 10,
  ACCUSE_WOLF_TARGET: 8,
  TRUST_FROM_CONFIRMED: -20,
  VILLAGE_ROLE_CO: -30,
  CO_BUSTED: 200,             // CO役職がRetarで否定 = 破綻
}

// 指揮者追従率
const FOLLOW_RATES: Record<string, number> = {
  werewolf: 0.2, fanatic: 0.25, werehamster: 0.6, immoralist: 0.7,
}
const DEFAULT_FOLLOW_RATE = 1.0

// CO役職の処刑優先度（高い=吊りやすい、低い=吊りにくい）
const CO_EXECUTION_SCORE: Record<string, number> = {
  mason: 10,       // 共有: 吊って良い（確定白なので本来吊らないが、偽共有は吊る）
  medium: 5,       // 霊能
  seer: 0,         // 占い
  bodyguard: 0,    // 狩人
  nekomata: -30,   // 猫又: なるべく後に（道連れリスク）
}


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
// 防御CO判定
// ============================================================

const VILLAGE_POWER_ROLES: ReadonlySet<SystemRole> = new Set(['seer', 'medium', 'bodyguard', 'mason', 'nekomata'])

export function isVillagePowerRole(role: SystemRole): boolean {
  return VILLAGE_POWER_ROLES.has(role)
}

export function isDefensiveCONeeded(ctx: DecisionContext): boolean {
  // 1. 指揮者の処刑指示が自分を対象
  for (const e of ctx.publicEvents) {
    if (e.type === 'proposal' && e.proposal.type === 'execute_order' && e.proposal.target === ctx.mySeat) return true
  }

  // 2. 処刑提案で自分が対象にされた割合が高い
  let myProposals = 0
  let totalProposals = 0
  for (const e of ctx.publicEvents) {
    if (e.type === 'execute_proposals') {
      totalProposals++
      if (e.targets.includes(ctx.mySeat)) myProposals++
    }
  }
  if (totalProposals > 0 && myProposals * 3 >= totalProposals) return true

  // 3. シグナルで狼告発を多数受けている (accuse_wolfが3件以上)
  let accuseCount = 0
  for (const e of ctx.publicEvents) {
    if (e.type === 'signal' && 'target' in e.signal && e.signal.target === ctx.mySeat) {
      if (e.signal.type === 'accuse_wolf') accuseCount++
    }
  }
  if (accuseCount >= 3) return true

  return false
}

// ============================================================
// 縄数計算・決め打ち判定
// ============================================================

type RopeInfo = { rope: number, remainingWolves: number, margin: number }

function calcRopeInfo(ctx: DecisionContext): RopeInfo {
  const aliveCount = ctx.alivePlayers.length
  const totalWolves = ctx.gameState.players.filter(p => p.role === 'werewolf').length
  let confirmedDeadWolves = 0
  for (const e of ctx.publicEvents) {
    if (e.type === 'medium_result' && e.result === 'wolf') confirmedDeadWolves++
  }
  const remainingWolves = Math.max(totalWolves - confirmedDeadWolves, 0)
  const rope = Math.floor((aliveCount - 1) / 2)
  return { rope, remainingWolves, margin: rope - remainingWolves }
}

function findConfirmedWolves(retar: Map<number, Set<SystemRole>> | null, alivePlayers: number[]): number[] {
  if (!retar) return []
  const result: number[] = []
  for (const seat of alivePlayers) {
    const roles = retar.get(seat)
    if (roles && roles.size === 1 && roles.has('werewolf')) result.push(seat)
  }
  return result
}

function filterSafeCandidates(candidates: number[], retar: Map<number, Set<SystemRole>> | null): number[] {
  if (!retar) return candidates
  const filtered = candidates.filter(s => {
    const roles = retar.get(s)
    return !roles || roles.has('werewolf')
  })
  return filtered.length > 0 ? filtered : candidates
}

// ============================================================
// 段階的CO判定（狩人・猫又）
// ============================================================

/** 自分が占い結果の対象になったことがあるか */
function hasBeenDivined(ctx: DecisionContext): boolean {
  for (const e of ctx.publicEvents) {
    if (e.type === 'seer_claim') {
      for (const r of e.results) { if (r.target === ctx.mySeat) return true }
    } else if (e.type === 'seer_result') {
      if (e.target === ctx.mySeat) return true
    }
  }
  return false
}

/** 日数と占い状況に応じたCO確率 */
function gradualCORate(ctx: DecisionContext): number {
  if (ctx.day <= 1) return 0
  let rate = Math.min(0.1 * (ctx.day - 1), 0.5)
  if (!hasBeenDivined(ctx)) rate *= 1.5
  return rate
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

  // 破綻検出: CO役職がRetarの可能性に含まれていない = 破綻
  const bustedCOs = new Set<number>()
  if (retarPossibilities) {
    for (const [seat, claimedRole] of claims) {
      if (!aliveSet.has(seat)) continue
      const roles = retarPossibilities.get(seat)
      if (roles && !roles.has(claimedRole)) bustedCOs.add(seat)
    }
  }

  for (const seat of aliveSeatList) {
    if (seat === mySeat) continue
    let score = 0

    // 黒出し/白出し（ローラー中は信頼度半減）
    if (blacks.has(seat)) score += seerClaimers.size >= 2 ? W.BLACK_RESULT_ROLLER : W.BLACK_RESULT
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

    // CO破綻（RetarでCO役職の可能性が消えている）
    if (bustedCOs.has(seat)) score += W.CO_BUSTED

    // CO役職の処刑優先度（猫又COは後回し等）
    const claimed = claims.get(seat)
    if (claimed && claimed in CO_EXECUTION_SCORE) {
      score += CO_EXECUTION_SCORE[claimed]
    }

    // 複数占いCO
    if (seerClaimers.has(seat) && seerClaimers.size >= 2) score += W.MULTI_SEER_CLAIMER

    // 村役職CO（対抗なし）は疑惑を下げる
    if (claimed && (claimed === 'bodyguard' || claimed === 'nekomata' || claimed === 'medium' || claimed === 'mason')) {
      const claimerCount = countRoleClaimers(events, claimed, aliveSet)
      if (claimerCount === 1) score += W.VILLAGE_ROLE_CO
    }

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

  /**
   * executionPlans / proposals から処刑対象を解決。
   * executionPlans の designated を優先し、なければ proposals の execute_order。
   */
  private resolveExecutionPlanTarget(ctx: DecisionContext): number | null {
    // executionPlans の designated（mason の plan）
    if (ctx.executionPlans.length > 0) {
      const designated = ctx.executionPlans.find(p => p.type === 'designated')
      const plan = designated ?? ctx.executionPlans[0]
      const target = plan.targets.find(t => ctx.alivePlayers.includes(t))
      if (target != null) return target
    }
    // proposals の execute_order（指揮者指示）
    const executeOrder = ctx.proposals.findLast(p => p.type === 'execute_order')
    if (executeOrder && ctx.alivePlayers.includes(executeOrder.target)) {
      return executeOrder.target
    }
    return null
  }

  decideVote(ctx: DecisionContext): number {
    // 1. Hati詰み（村側、最優先）
    if (!isWerewolfAligned(ctx.myRole) && ctx.myRole !== 'werehamster' && ctx.myRole !== 'immoralist') {
      const tsumiTarget = tryTsumi(ctx)
      if (tsumiTarget && ctx.alivePlayers.includes(tsumiTarget)) return tsumiTarget
    }

    // 2. 共有者の処刑指示（executionPlans / proposals の execute_order）
    const planTarget = this.resolveExecutionPlanTarget(ctx)
    if (planTarget) {
      if (ctx.myRole === 'immoralist' && planTarget === ctx.knownHamster) {
        // 背徳者: 妖狐処刑指示には従わない
      } else {
        return planTarget
      }
    }

    // 3. 役職別投票
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
    if (ctx.myRole === 'immoralist') {
      const exec = ctx.proposals.find(p => p.type === 'execute_order')
      if (exec && exec.target === ctx.knownHamster) return 'defy'
    }
    return 'follow'
  }

  decideDefensiveClaim(ctx: DecisionContext): DayClaim {
    if (ctx.myPlayer.claimedRole !== null) return { type: 'none' }

    // 村能力者共通: 処刑対象なら必ずCO（グレランでない＝自分への提案が集中している）
    if (isVillagePowerRole(ctx.myRole) && isDefensiveCONeeded(ctx)) {
      return forceTrueRoleCO(ctx.gameState, ctx.myPlayer, ctx.day, ctx.lastExecutedSeat)
    }

    switch (ctx.myRole) {
      case 'bodyguard': {
        // GJ後は高確率CO
        const hasGJ = ctx.publicEvents.some(e => e.type === 'peace')
        if (hasGJ && ctx.rng.next() < 0.7) {
          return forceTrueRoleCO(ctx.gameState, ctx.myPlayer, ctx.day, ctx.lastExecutedSeat)
        }
        // 脅威がある場合は即CO
        if (isDefensiveCONeeded(ctx)) {
          return forceTrueRoleCO(ctx.gameState, ctx.myPlayer, ctx.day, ctx.lastExecutedSeat)
        }
        // 段階的CO（シグナルを見てから判断）
        if (ctx.rng.next() < gradualCORate(ctx)) {
          return forceTrueRoleCO(ctx.gameState, ctx.myPlayer, ctx.day, ctx.lastExecutedSeat)
        }
        return { type: 'none' }
      }
      case 'nekomata': {
        // 脅威がある場合は即CO
        if (isDefensiveCONeeded(ctx)) return { type: 'nekomata_co' }
        // 段階的CO（シグナルを見てから判断）
        if (ctx.rng.next() < gradualCORate(ctx)) return { type: 'nekomata_co' }
        return { type: 'none' }
      }
      default:
        return { type: 'none' }
    }
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

  // 指揮者に処刑指定されたら CO して回避
  const executeOrder = ctx.proposals.find(p => p.type === 'execute_order')
  if (executeOrder && executeOrder.target === ctx.mySeat) {
    return { type: 'nekomata_co' }
  }

  // 単独黒（自分だけが黒出しされている）→ CO して処刑回避
  const blacks = collectBlackTargets(ctx.publicEvents)
  if (blacks.has(ctx.mySeat)) {
    // 自分以外に黒出しされている生存者がいなければ「単独黒」
    const otherBlacks = [...blacks].filter(s => s !== ctx.mySeat && aliveSet.has(s))
    if (otherBlacks.length === 0) return { type: 'nekomata_co' }
  }

  // Day 1はCOしない（単独黒以外）
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
  let candidates = ctx.alivePlayers.filter(s => s !== ctx.mySeat)

  // 再投票候補制限（自分を除外）
  if (ctx.revoteCandidates && ctx.revoteCandidates.length > 0) {
    const revoteCands = ctx.revoteCandidates.filter(s => s !== ctx.mySeat)
    if (revoteCands.length > 0) return pickHighestSuspicion(scores, revoteCands, ctx.rng)
  }

  // Retar確定狼がいる → 最優先処刑
  const confirmedWolves = findConfirmedWolves(ctx.retarPossibilities, candidates)
  if (confirmedWolves.length > 0) {
    return pickHighestSuspicion(scores, confirmedWolves, ctx.rng)
  }

  // 確定村を候補から除外（全モード共通）
  candidates = filterSafeCandidates(candidates, ctx.retarPossibilities)

  // 縄数に基づく判断
  const { margin } = calcRopeInfo(ctx)
  const claims = collectClaimsFromEvents(ctx.publicEvents)
  const aliveSet = new Set(ctx.alivePlayers)

  if (margin <= 0) {
    // 決め打ちモード: 狼可能性がある候補のみ
    if (ctx.retarPossibilities) {
      const wolfPossible = candidates.filter(s => {
        const roles = ctx.retarPossibilities!.get(s)
        return roles && roles.has('werewolf')
      })
      if (wolfPossible.length > 0) return pickHighestSuspicion(scores, wolfPossible, ctx.rng)
    }
  }

  // CO済み怪しい候補を優先（ローラー対象、黒出し先）→ グレー無駄吊り防止
  const suspects: number[] = []
  if (isRollerSituation(ctx.publicEvents, 'seer', aliveSet)) {
    for (const [seat, role] of claims) {
      if (role === 'seer' && candidates.includes(seat)) suspects.push(seat)
    }
  }
  const blacks = collectBlackTargets(ctx.publicEvents)
  for (const seat of candidates) {
    if (blacks.has(seat) && !suspects.includes(seat)) suspects.push(seat)
  }
  if (suspects.length > 0) return pickHighestSuspicion(scores, suspects, ctx.rng)

  return pickHighestSuspicion(scores, candidates, ctx.rng)
}

/**
 * 指揮者推薦: Retar確定村陣営のみ自薦する。それ以外は推薦しない。
 * 指揮者不在のときだけ発動。
 */
function shouldNominateSelf(ctx: DecisionContext): boolean {
  if (ctx.commander !== null) return false
  if (!ctx.retarPossibilities) return false

  // 既にnominate_commanderが出ていればスキップ（publicEventsとsignals両方を確認）
  for (const e of ctx.publicEvents) {
    if (e.type === 'signal' && e.signal.type === 'nominate_commander') return false
  }
  if (ctx.signals) {
    for (const s of ctx.signals) {
      if (s.signal.type === 'nominate_commander') return false
    }
  }

  // 自分がRetar確定村陣営か
  const myRoles = ctx.retarPossibilities.get(ctx.mySeat)
  if (!myRoles || myRoles.size !== 1) return false
  const villageRoles: Set<SystemRole> = new Set(['seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'villager'])
  return villageRoles.has([...myRoles][0])
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

  // 指揮者自薦（確定村陣営のみ、指揮者不在時）
  if (shouldNominateSelf(ctx)) {
    return { signal: { type: 'nominate_commander', target: ctx.mySeat }, proposals }
  }

  // 自分が指揮者 → リーダー行動
  if (shouldActAsLeader(ctx)) {
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
    const scores = buildSuspicionScore(publicEvents, ctx.retarPossibilities, alive, mySeat)
    const target = pickHighestSuspicion(scores, others, rng)
    proposals.push(target)
    return { signal: { type: 'vote_intent', target }, proposals }
  }

  // 処刑提案: 疑惑スコア最大の1人に絞る（票分散防止）
  const scores = buildSuspicionScore(publicEvents, ctx.retarPossibilities, alive, mySeat)
  const mostSuspicious = pickHighestSuspicion(scores, others, rng)
  proposals.push(mostSuspicious)

  // demand_wolf_co (Day 3+)
  if (ctx.day > 3 && rng.next() < 0.1) {
    return { signal: { type: 'demand_wolf_co' }, proposals }
  }

  // accuse_wolf (最疑惑が黒出し先なら)
  const blacks = collectBlackTargets(publicEvents)
  if (blacks.has(mostSuspicious) && rng.next() < 0.3) {
    return { signal: { type: 'accuse_wolf', target: mostSuspicious }, proposals }
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

/** 襲撃先選択: COベースで優先度判定（狼は真の役職を知らない） */
function pickAttackTarget(candidates: PlayerState[], rng: Rng): number {
  // 優先: 占いCO > 霊能CO > 共有CO。猫又CO回避
  const priorities: SystemRole[] = ['seer', 'medium', 'mason']
  for (const role of priorities) {
    const targets = candidates.filter(p => p.claimedRole === role)
    if (targets.length > 0) return rng.pick(targets).seat
  }
  // 猫又CO以外
  const nonNekoCO = candidates.filter(p => p.claimedRole !== 'nekomata')
  if (nonNekoCO.length > 0) return rng.pick(nonNekoCO).seat
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
    return reportFakeMediumResult(lastExecutedSeat, rng, ctx)
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
      revalidateFakeDivineHistory(myPlayer, ctx)
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
    revalidateFakeDivineHistory(myPlayer, ctx)
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
  player.fakeDivineHistory.set(night, { target, result })

  // 安価な黒出し数チェック: 自分の黒出し先 + 自分が黒出ししていない死亡狼 > 狼数 → 矛盾
  const state = ctx.gameState
  const wolfTotal = state.players.filter(p => p.role === 'werewolf').length
  const myBlackTargets = new Set<number>()
  for (const [, d] of player.fakeDivineHistory) {
    if (d.result === 'wolf') myBlackTargets.add(d.target)
  }
  const deadWolvesNotInBlacks = state.players.filter(
    p => p.role === 'werewolf' && !p.alive && !myBlackTargets.has(p.seat)
  ).length
  if (myBlackTargets.size + deadWolvesNotInBlacks > wolfTotal) {
    player.fakeDivineHistory.delete(night)
    return false
  }

  // publicEventsに既出の自分のseer_resultターゲットを収集
  const publishedTargets = new Set<number>()
  for (const e of ctx.publicEvents) {
    if (e.type === 'seer_result' && e.actor === ctx.mySeat) publishedTargets.add(e.target)
  }

  // 未公開の過去偽結果 + 今回の結果をsimEventsに追加
  const simEvents: GameEvent[] = [...ctx.publicEvents]
  for (const [, d] of player.fakeDivineHistory) {
    if (!publishedTargets.has(d.target)) {
      simEvents.push({ type: 'seer_result' as const, actor: ctx.mySeat, target: d.target, result: d.result })
    }
  }

  // Retar整合性チェック（assumptions: 自分が真占い + 黒出し先がwerewolf）
  const assumptions = new Map<number, SystemRole>([[ ctx.mySeat, 'seer' ]])
  for (const [, d] of player.fakeDivineHistory) {
    if (d.result === 'wolf') assumptions.set(d.target, 'werewolf')
  }
  const roleCount = new Map<SystemRole, number>()
  for (const p of state.players) {
    roleCount.set(p.role, (roleCount.get(p.role) ?? 0) + 1)
  }
  const minimalConfig = { roles: roleCount, hasFirstGhost: state.players.some(p => !p.alive && p.seat > 0) }
  if (!checkRetarConsistency(simEvents, state, minimalConfig as any, assumptions)) {
    player.fakeDivineHistory.delete(night)
    return false
  }

  // 8人以下なら追加でHati詰みチェック
  if (ctx.alivePlayers.length <= 8) {
    const tsumi = tryTsumiWithEvents(simEvents, ctx)
    if (tsumi) {
      player.fakeDivineHistory.delete(night)
      return false
    }
  }
  return true
}

/**
 * CO時に過去の偽結果を現在のpublicEventsで再検証。
 * 当時は通ったが状況変化（共有CO等）で矛盾する結果を白に差し替える。
 */
function revalidateFakeDivineHistory(player: PlayerState, ctx: DecisionContext): void {
  const entries = Array.from(player.fakeDivineHistory.entries())
    .sort((a, b) => a[0] - b[0])
  // 一度クリアして順番に再追加
  player.fakeDivineHistory.clear()
  for (const [night, d] of entries) {
    if (!trySetFakeResult(player, night, d.target, d.result, ctx)) {
      // 矛盾 → 白に差し替え
      if (d.result === 'wolf') {
        if (!trySetFakeResult(player, night, d.target, 'human', ctx)) {
          // 白も矛盾 → チェックなしで白出し（フォールバック）
          player.fakeDivineHistory.set(night, { target: d.target, result: 'human' })
        }
      } else {
        // 白が矛盾 → チェックなしでそのまま（稀）
        player.fakeDivineHistory.set(night, { target: d.target, result: d.result })
      }
    }
  }
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
    // 対抗占いCO者（非狼）に黒出し優先
    const claims = collectClaimsFromEvents(ctx.publicEvents)
    const rivalSeers = nonWolves.filter(p => claims.get(p.seat) === 'seer')
    if (rivalSeers.length > 0 && rng.next() < 0.6) {
      if (trySetFakeResult(player, night, rng.pick(rivalSeers).seat, 'wolf', ctx)) return
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

function reportFakeMediumResult(lastExecutedSeat: number | null, rng: Rng, ctx: DecisionContext): DayClaim {
  if (lastExecutedSeat === null) return { type: 'none' }
  const preferred: EnumSpecies = rng.next() < 0.5 ? 'human' : 'wolf'

  // Retar整合性チェック
  const state = ctx.gameState
  const roleCount = new Map<SystemRole, number>()
  for (const p of state.players) {
    roleCount.set(p.role, (roleCount.get(p.role) ?? 0) + 1)
  }
  const minimalConfig = { roles: roleCount, hasFirstGhost: state.players.some(p => !p.alive && p.seat > 0) }
  const simEvents: GameEvent[] = [...ctx.publicEvents, {
    type: 'medium_result' as const,
    actor: ctx.mySeat,
    result: preferred,
  }]
  if (checkRetarConsistency(simEvents, state, minimalConfig as any)) {
    return { type: 'medium_result', result: preferred }
  }
  // 矛盾 → 逆の結果を試す
  const alt: EnumSpecies = preferred === 'wolf' ? 'human' : 'wolf'
  simEvents[simEvents.length - 1] = { type: 'medium_result' as const, actor: ctx.mySeat, result: alt }
  if (checkRetarConsistency(simEvents, state, minimalConfig as any)) {
    return { type: 'medium_result', result: alt }
  }
  // 両方矛盾 → フォールバック
  return { type: 'medium_result', result: preferred }
}

/**
 * 狼視点の飽和・狐判定
 * 飽和間近（あと1処刑で狼勝ちだが狐生存で狐勝ちになる）かを返す
 */
/**
 * 狼視点の飽和・狐判定
 *
 * 狼は狐の位置を知らない。Retarの可能性から狐候補を推測する。
 * 狐候補 = Retarで werehamster が可能性に残っている非狼の生存者。
 */
function detectFoxThreat(ctx: DecisionContext): {
  nearSaturation: boolean
  foxCandidates: number[]
} {
  const alive = ctx.alivePlayers
  const wolfSeats = new Set([ctx.mySeat, ...(ctx.wolfTeammates ?? [])])
  const aliveWolfCount = alive.filter(s => wolfSeats.has(s)).length

  // 狐候補: Retarでwerehamster可能性が残っている非狼
  const foxCandidates: number[] = []
  if (ctx.retarPossibilities) {
    for (const s of alive) {
      if (wolfSeats.has(s)) continue
      const roles = ctx.retarPossibilities.get(s)
      if (roles && roles.has('werehamster')) foxCandidates.push(s)
    }
  }

  // 飽和判定: 狐候補がいる & あと1処刑で飽和
  // 狐が何人いるかは不明なので、候補がいるかどうかで判断
  const hasFoxThreat = foxCandidates.length > 0
  const nonWolfCount = alive.length - aliveWolfCount
  const nearSaturation = aliveWolfCount >= nonWolfCount - 1 && hasFoxThreat

  return { nearSaturation, foxCandidates }
}

function decideWerewolfVote(ctx: DecisionContext): number {
  const { rng, alivePlayers: alive, mySeat } = ctx
  const wolfSeats = new Set([mySeat, ...(ctx.wolfTeammates ?? [])])
  const candidates = alive.filter(s => s !== mySeat && !wolfSeats.has(s))
  if (candidates.length === 0) return alive.find(s => s !== mySeat) ?? mySeat

  // 狐脅威判定: 飽和間近で狐候補(Retar推定)がいたら最優先処刑
  const { nearSaturation, foxCandidates } = detectFoxThreat(ctx)
  if (nearSaturation && foxCandidates.length > 0) {
    const aliveFox = foxCandidates.filter(s => candidates.includes(s))
    if (aliveFox.length > 0) return rng.pick(aliveFox.map(s => ({ seat: s }))).seat
  }

  // PP判定（生存奇数 & 狐非生存(Retar推定) & 狂信者が特定済み）
  const aliveWolfCount = alive.filter(s => wolfSeats.has(s)).length
  // 狐生存判定: Retarでwerehamster可能性が残る非狼がいるか
  const foxMaybeAlive = ctx.retarPossibilities && alive.some(s => {
    if (wolfSeats.has(s)) return false
    const roles = ctx.retarPossibilities!.get(s)
    return roles && roles.has('werehamster')
  })
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
  const nonWolfSide = alive.length - wolfSideCount
  if (alive.length % 2 === 1 && fanaticIdentified && wolfSideCount >= nonWolfSide && !foxMaybeAlive) {
    // PP: 非狼・非狂信を処刑
    if (candidates.length > 0) return rng.pick(candidates.map(s => ({ seat: s }))).seat
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
  const { rng, alivePlayers: alive, mySeat } = ctx
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

  // PP判定 → werewolf_co（狐非生存(Retar推定)のとき）
  const aliveWolfCount = alive.filter(s => wolfSeats.has(s)).length
  const foxMaybeAlive = ctx.retarPossibilities && alive.some(s => {
    if (wolfSeats.has(s)) return false
    const roles = ctx.retarPossibilities!.get(s)
    return roles && roles.has('werehamster')
  })
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
  const nonWolfSide = alive.length - wolfSideCount
  if (alive.length % 2 === 1 && fanaticIdentified && wolfSideCount >= nonWolfSide && !foxMaybeAlive && rng.next() < 0.9) {
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
    return reportFakeMediumResult(lastExecutedSeat, rng, ctx)
  }
  if (myPlayer.claimedRole !== null) return { type: 'none' }

  // CO率: 初日90%、二日目以降99%
  const coRate = day === 1 ? 0.9 : 0.99
  if (rng.next() >= coRate) return { type: 'none' }

  const r = rng.next()
  if (r < 0.50) {
    // 占い騙り (50%)
    for (let n = 0; n < day; n++) generateFanaticFakeResult(state, myPlayer, n, ctx)
    revalidateFakeDivineHistory(myPlayer, ctx)
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

  // 結果を操作（Retar整合性チェック付き）
  if (wolves.has(target)) {
    // 狼 → 白出し
    if (trySetFakeResult(player, night, target, 'human', ctx)) return
  } else {
    // 非狼 → 50%で黒出し
    const preferred: EnumSpecies = rng.next() < 0.5 ? 'wolf' : 'human'
    if (trySetFakeResult(player, night, target, preferred, ctx)) return
    // 矛盾 → 逆の結果を試す
    const alt: EnumSpecies = preferred === 'wolf' ? 'human' : 'wolf'
    if (trySetFakeResult(player, night, target, alt, ctx)) return
  }

  // 全候補で試す（フォールバック）
  const shuffled = [...candidates].filter(s => s !== target).sort(() => rng.next() - 0.5)
  for (const t of shuffled) {
    if (trySetFakeResult(player, night, t, 'human', ctx)) return
  }
  // 最終フォールバック（チェックなし）
  player.fakeDivineHistory.set(night, { target, result: 'human' })
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
    return reportFakeMediumResult(lastExecutedSeat, rng, ctx)
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
    revalidateFakeDivineHistory(myPlayer, ctx)
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
    return reportFakeMediumResult(lastExecutedSeat, rng, ctx)
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
    revalidateFakeDivineHistory(myPlayer, ctx)
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

  // 狐への結果（Retar整合性チェック付き）
  const hamsterCandidate = candidates.find(p => p.seat === hamsterSeat)
  if (hamsterCandidate) {
    if (trueSeerLikelyDead && rng.next() < 0.3) {
      // 真占い死亡 → 狐に黒出し（村が狼と誤認→他を先に吊る）
      if (trySetFakeResult(player, night, hamsterCandidate.seat, 'wolf', ctx)) return
    }
    // 基本: 狐に白出し（狐の疑惑を下げる）
    if (trySetFakeResult(player, night, hamsterCandidate.seat, 'human', ctx)) return
  }

  // 狐以外: ランダムに黒出し（自分の疑惑を上げ、破綻して先に吊られる）
  const nonHamster = candidates.filter(p => p.seat !== hamsterSeat)
  if (nonHamster.length > 0 && rng.next() < 0.5) {
    const t = rng.pick(nonHamster)
    if (trySetFakeResult(player, night, t.seat, 'wolf', ctx)) return
  }

  // 白出し
  if (nonHamster.length > 0) {
    const t = rng.pick(nonHamster)
    if (trySetFakeResult(player, night, t.seat, 'human', ctx)) return
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

  decideDefensiveClaim(ctx: TeamDecisionContext): DayClaim {
    return this.individual.decideDefensiveClaim(this.buildActorCtx(ctx))
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

  decideDefensiveClaim(ctx: TeamDecisionContext): DayClaim {
    return this.individual.decideDefensiveClaim(this.buildActorCtx(ctx))
  }

  private buildActorCtx(ctx: TeamDecisionContext): DecisionContext {
    const seat = ctx.currentActorSeat ?? ctx.teamSeats[0]
    const player = ctx.gameState.players.find(p => p.seat === seat)!
    const partner = ctx.teamSeats.find(s => s !== seat) ?? null
    return { ...ctx, mySeat: seat, myRole: player.role, myPlayer: player, masonPartner: partner }
  }
}

// ============================================================
// エンジン用ユーティリティ（engine-utils.ts に移動、後方互換 re-export）
// ============================================================

export { forceTrueRoleCO, resolveVotes } from './engine-utils.ts'
