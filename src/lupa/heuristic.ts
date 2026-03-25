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

// ============================================================
// 定数
// ============================================================

const NEKOMATA_CO_RATE = 0.7
const FORECAST_RATE = 0.4
const FANATIC_SEER_RATE = 0.6
const FANATIC_MEDIUM_RATE = 0.2

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
    if (ctx.rng.next() >= FORECAST_RATE) return { type: 'none' }
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

function pickDivineTarget(ctx: DecisionContext): number | null {
  const { myPlayer, rng, alivePlayers: alive, retarPossibilities } = ctx
  const others = alive.filter(s => s !== ctx.mySeat)
  if (others.length === 0) return null

  // 予告先
  if (myPlayer.forecastTarget != null && others.includes(myPlayer.forecastTarget)) {
    return myPlayer.forecastTarget
  }

  // 占い済みを除外
  const divined = new Set(Array.from(myPlayer.divineHistory.values()).map(d => d.target))
  const undivined = others.filter(s => !divined.has(s))
  const candidates = undivined.length > 0 ? undivined : others

  // Retarで狼可能性が残っている & 役職確定していない席を優先
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
  const { myPlayer, rng, publicEvents, alivePlayers: alive } = ctx
  const others = alive.filter(s => s !== ctx.mySeat)
  if (others.length === 0) return { type: 'none' }

  // 連続護衛不可
  const lastNight = Math.max(...Array.from(myPlayer.guardHistory.keys()), -1)
  const lastTarget = myPlayer.guardHistory.get(lastNight)
  const eligible = lastTarget !== undefined ? others.filter(s => s !== lastTarget) : others
  const candidates = eligible.length > 0 ? eligible : others

  // 占いCO者を最優先護衛
  const claims = collectClaimsFromEvents(publicEvents)
  const aliveSet = new Set(alive)
  const seerClaimers = candidates.filter(s => claims.get(s) === 'seer' && aliveSet.has(s))
  if (seerClaimers.length === 1) return { type: 'guard', target: seerClaimers[0] }
  if (seerClaimers.length > 1) return { type: 'guard', target: rng.pick(seerClaimers.map(s => ({ seat: s }))).seat }

  // 霊能 > 共有指揮者
  const mediumClaimers = candidates.filter(s => claims.get(s) === 'medium')
  if (mediumClaimers.length === 1) return { type: 'guard', target: mediumClaimers[0] }

  if (ctx.commander && candidates.includes(ctx.commander)) {
    return { type: 'guard', target: ctx.commander }
  }

  return { type: 'guard', target: rng.pick(candidates.map(s => ({ seat: s }))).seat }
}

// ============================================================
// 村側: 昼CO
// ============================================================

function decideSeerClaim(ctx: DecisionContext): DayClaim {
  const { myPlayer, day } = ctx
  if (myPlayer.claimedRole === 'seer') {
    // 既にCO済み: 最新結果を報告
    const latest = myPlayer.divineHistory.get(day - 1)
    if (!latest) return { type: 'none' }
    return { type: 'seer_result', target: latest.target, result: latest.result }
  }
  // 初回CO: 全結果つき
  const results = Array.from(myPlayer.divineHistory.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ target: v.target, result: v.result }))
  return { type: 'seer_co', results }
}

function decideMediumClaim(ctx: DecisionContext): DayClaim {
  const { myPlayer, day, lastExecutedSeat, gameState: state } = ctx
  if (myPlayer.claimedRole === 'medium') {
    if (lastExecutedSeat !== null) {
      const target = state.players.find(p => p.seat === lastExecutedSeat)!
      return { type: 'medium_result', result: getMediumResult(target.role) }
    }
    return { type: 'none' }
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

function decideBodyguardClaim(_ctx: DecisionContext): DayClaim {
  // 潜伏（処刑時はforceTrueRoleCOで処理）
  return { type: 'none' }
}

function decideMasonClaim(ctx: DecisionContext): DayClaim {
  const { myPlayer, gameState: state } = ctx
  if (myPlayer.claimedRole) return { type: 'none' }
  const partner = state.players.find(p => p.seat !== ctx.mySeat && p.role === 'mason')
  if (!partner) return { type: 'none' }
  return { type: 'mason_co', partner: partner.seat }
}

function decideNekomataClam(ctx: DecisionContext): DayClaim {
  if (ctx.myPlayer.claimedRole) return { type: 'none' }
  // 対抗チェック: 既に猫又COがあれば強制CO
  const aliveSet = new Set(ctx.alivePlayers)
  if (isRollerSituation(ctx.publicEvents, 'nekomata', aliveSet)) {
    return { type: 'nekomata_co' }
  }
  if (ctx.rng.next() < NEKOMATA_CO_RATE) return { type: 'nekomata_co' }
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

function decideVillagerComm(ctx: DecisionContext): CommunicationAction {
  const { rng, publicEvents, alivePlayers: alive, mySeat } = ctx
  const others = alive.filter(s => s !== mySeat)
  const proposals: number[] = []

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

  // Hati詰み
  const tsumiTarget = tryTsumi(ctx)
  if (tsumiTarget && alive.includes(tsumiTarget)) {
    return { type: 'execute_order', target: tsumiTarget }
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

  // 既に占い騙り中: 結果報告
  if (myPlayer.claimedRole === 'seer') {
    return reportFakeSeerResult(state, myPlayer, day, ctx)
  }
  if (myPlayer.claimedRole === 'medium') {
    return reportFakeMediumResult(lastExecutedSeat, rng)
  }

  // 占い騙り担当か？
  if (isDesignatedFakeSeer(ctx) && myPlayer.claimedRole === null) {
    // 偽占い結果を生成してCO
    for (let n = 0; n < day; n++) {
      generateStrategicFakeResult(state, myPlayer, n, ctx)
    }
    const results = Array.from(myPlayer.fakeDivineHistory.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ target: v.target, result: v.result }))
    return { type: 'seer_co', results }
  }

  return { type: 'none' }
}

function generateStrategicFakeResult(
  state: GameState, player: PlayerState, night: number, ctx: DecisionContext,
): void {
  if (player.fakeDivineHistory.has(night)) return
  const divined = new Set(Array.from(player.fakeDivineHistory.values()).map(d => d.target))
  const wolfSeats = new Set([ctx.mySeat, ...(ctx.wolfTeammates ?? [])])
  const fanaticSeats = new Set(state.players.filter(p => p.role === 'fanatic').map(p => p.seat))
  const candidates = alivePlayersExcept(state, player.seat).filter(p => !divined.has(p.seat))
  if (candidates.length === 0) return

  const rng = ctx.rng

  // 仲間・狂信者に白出し (40%)
  if (rng.next() < 0.4) {
    const allies = candidates.filter(p => wolfSeats.has(p.seat) || fanaticSeats.has(p.seat))
    if (allies.length > 0) {
      const target = rng.pick(allies)
      player.fakeDivineHistory.set(night, { target: target.seat, result: 'human' })
      return
    }
  }

  // 村役職に黒出し — 真占いに黒が最優先
  const villagers = candidates.filter(p => !wolfSeats.has(p.seat) && !fanaticSeats.has(p.seat))
  if (villagers.length > 0) {
    // 真占いに黒出し優先
    const trueSeer = villagers.find(p => p.role === 'seer')
    if (trueSeer && rng.next() < 0.6) {
      player.fakeDivineHistory.set(night, { target: trueSeer.seat, result: 'wolf' })
      return
    }
    // 妖狐に黒出し (20%)
    const hamster = villagers.find(p => p.role === 'werehamster')
    if (hamster && rng.next() < 0.2) {
      player.fakeDivineHistory.set(night, { target: hamster.seat, result: 'wolf' })
      return
    }
    const target = rng.pick(villagers)
    player.fakeDivineHistory.set(night, { target: target.seat, result: 'wolf' })
    return
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

function decideWerewolfVote(ctx: DecisionContext): number {
  const { gameState: state, rng, alivePlayers: alive, mySeat } = ctx
  const wolfSeats = new Set([mySeat, ...(ctx.wolfTeammates ?? [])])
  const candidates = alive.filter(s => s !== mySeat && !wolfSeats.has(s))
  if (candidates.length === 0) return alive.find(s => s !== mySeat) ?? mySeat

  // PP判定
  const aliveWolfCount = alive.filter(s => wolfSeats.has(s)).length
  const fanaticCount = alivePlayers(state).filter(p => p.alive && p.role === 'fanatic').length
  const hamsterCount = alivePlayers(state).filter(p => p.alive && p.role === 'werehamster').length
  const nonWolfNonFox = alive.length - aliveWolfCount - hamsterCount
  if (aliveWolfCount + fanaticCount >= nonWolfNonFox) {
    // PP: 村人を処刑
    const villagers = candidates.filter(s => {
      const p = state.players.find(pp => pp.seat === s)!
      return !isWerewolfAligned(p.role) && p.role !== 'werehamster' && p.role !== 'immoralist'
    })
    if (villagers.length > 0) return rng.pick(villagers.map(s => ({ seat: s }))).seat
  }

  // 真占いCO者（非狼）を優先処刑
  const claims = collectClaimsFromEvents(ctx.publicEvents)
  const trueSeerClaimers = candidates.filter(s => claims.get(s) === 'seer')
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

  // PP判定 → werewolf_co
  const aliveWolfCount = alive.filter(s => wolfSeats.has(s)).length
  const fanaticCount = alivePlayers(state).filter(p => p.alive && p.role === 'fanatic').length
  const hamsterCount = alivePlayers(state).filter(p => p.alive && p.role === 'werehamster').length
  const nonWolfNonFox = alive.length - aliveWolfCount - hamsterCount
  if (aliveWolfCount + fanaticCount >= nonWolfNonFox && rng.next() < 0.9) {
    return { signal: { type: 'werewolf_co' }, proposals }
  }

  // 占い騙り中なら占いっぽく振る舞う
  if (ctx.myPlayer.claimedRole === 'seer') {
    const blacks = collectBlackTargets(ctx.publicEvents)
    const aliveBlacks = others.filter(s => blacks.has(s))
    if (aliveBlacks.length > 0) {
      for (const s of aliveBlacks) proposals.push(s)
      return { signal: { type: 'accuse_wolf', target: rng.pick(aliveBlacks.map(s => ({ seat: s }))).seat }, proposals }
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

  if (myPlayer.claimedRole === 'seer') {
    return reportFanaticSeerResult(state, myPlayer, day, ctx)
  }
  if (myPlayer.claimedRole === 'medium') {
    return reportFakeMediumResult(lastExecutedSeat, rng)
  }

  if (myPlayer.claimedRole !== null) return { type: 'none' }

  const r = rng.next()
  if (r < FANATIC_SEER_RATE) {
    // 占い騙り
    for (let n = 0; n < day; n++) {
      generateFanaticFakeResult(state, myPlayer, n, ctx)
    }
    const results = Array.from(myPlayer.fakeDivineHistory.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ target: v.target, result: v.result }))
    return { type: 'seer_co', results }
  } else if (r < FANATIC_SEER_RATE + FANATIC_MEDIUM_RATE) {
    // 霊能騙り
    const pastResults = collectFakeMediumResults(state, day, rng)
    return { type: 'medium_co', pastResults }
  }
  return { type: 'none' }
}

function generateFanaticFakeResult(
  state: GameState, player: PlayerState, night: number, ctx: DecisionContext,
): void {
  if (player.fakeDivineHistory.has(night)) return
  const divined = new Set(Array.from(player.fakeDivineHistory.values()).map(d => d.target))
  const wolves = new Set(ctx.knownWolves ?? [])
  const candidates = alivePlayersExcept(state, player.seat).filter(p => !divined.has(p.seat))
  if (candidates.length === 0) return

  const rng = ctx.rng

  // 狼に白出し
  if (rng.next() < 0.4) {
    const wolfCandidates = candidates.filter(p => wolves.has(p.seat))
    if (wolfCandidates.length > 0) {
      player.fakeDivineHistory.set(night, { target: rng.pick(wolfCandidates).seat, result: 'human' })
      return
    }
  }

  // 非狼に黒出し
  const nonWolves = candidates.filter(p => !wolves.has(p.seat))
  if (nonWolves.length > 0) {
    player.fakeDivineHistory.set(night, { target: rng.pick(nonWolves).seat, result: 'wolf' })
    return
  }
  player.fakeDivineHistory.set(night, { target: rng.pick(candidates).seat, result: 'human' })
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

function decideFanaticVote(ctx: DecisionContext): number {
  const { rng, alivePlayers: alive, mySeat } = ctx
  const wolves = new Set(ctx.knownWolves ?? [])
  const candidates = alive.filter(s => s !== mySeat && !wolves.has(s))
  if (candidates.length === 0) return alive.find(s => s !== mySeat) ?? mySeat

  // 真占いCO者を優先
  const claims = collectClaimsFromEvents(ctx.publicEvents)
  const seerClaimers = candidates.filter(s => claims.get(s) === 'seer' && !wolves.has(s))
  if (seerClaimers.length > 0 && rng.next() < 0.6) {
    return rng.pick(seerClaimers.map(s => ({ seat: s }))).seat
  }
  return rng.pick(candidates.map(s => ({ seat: s }))).seat
}

function decideFanaticComm(ctx: DecisionContext): CommunicationAction {
  // 狼と似た動き
  return decideWerewolfComm(ctx)
}

// ============================================================
// 人外: 妖狐 / 背徳者
// ============================================================

function decideHamsterClaim(ctx: DecisionContext): DayClaim {
  if (ctx.myPlayer.claimedRole !== null) {
    if (ctx.myPlayer.claimedRole === 'medium') {
      return reportFakeMediumResult(ctx.lastExecutedSeat, ctx.rng)
    }
    return { type: 'none' }
  }
  // 90%潜伏
  if (ctx.rng.next() < 0.9) return { type: 'none' }
  // 10%霊能騙り
  const pastResults = collectFakeMediumResults(ctx.gameState, ctx.day, ctx.rng)
  return { type: 'medium_co', pastResults }
}

function decideImmoralistClaim(ctx: DecisionContext): DayClaim {
  if (ctx.myPlayer.claimedRole !== null) {
    if (ctx.myPlayer.claimedRole === 'medium') {
      return reportFakeMediumResult(ctx.lastExecutedSeat, ctx.rng)
    }
    return { type: 'none' }
  }
  if (ctx.rng.next() < 0.8) return { type: 'none' }
  // 霊能騙り
  const pastResults = collectFakeMediumResults(ctx.gameState, ctx.day, ctx.rng)
  return { type: 'medium_co', pastResults }
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
