/**
 * ルールベース行動層
 *
 * 戦略NNの構造化出力（plan tokens, co_policy, trust, predict）を
 * ゲーム行動に変換する。Step 1 bootstrap用。
 *
 * 戦略NNがプランと推理を出力し、この層が機械的に実行する。
 */

import type { SystemRole } from '../../types/index.ts'
import type { NightAction, DayClaim } from '../../lupa/types.ts'
import type { CommunicationAction } from '../../lupa/communication.ts'
import type { Proposal, LeadershipResponse } from '../../lupa/leadership.ts'
import type { DecisionContext } from '../../lupa/strategy.ts'
import { SEATS, NUM_ROLE_TOKENS, CO_ROLES } from './observation.ts'

// ============================================================
// Plan token vocabulary
// ============================================================

/** Pointer語彙のインデックス */
export const PLAN_VOCAB = {
  // 0-13: seat 1-14
  SEAT_START: 0,
  SEAT_END: SEATS,  // exclusive
  // 14-18: roles (seer, medium, bodyguard, mason, nekomata)
  ROLE_START: SEATS,
  ROLE_END: SEATS + NUM_ROLE_TOKENS,
  // 19-21: special
  GRAYRAN: SEATS + NUM_ROLE_TOKENS,      // 19
  NEXT: SEATS + NUM_ROLE_TOKENS + 1,     // 20
  STOP: SEATS + NUM_ROLE_TOKENS + 2,     // 21
  SIZE: SEATS + NUM_ROLE_TOKENS + 3,     // 22
} as const

/** Plan tokenの1日分のグループ */
export type PlanDayGroup = {
  /** 処刑対象のseat番号 or role名 or 'grayran' */
  targets: Array<{ type: 'seat', seat: number } | { type: 'role', role: SystemRole } | { type: 'grayran' }>
}

/**
 * Pointer logits列をargmax → 語彙index列に変換
 * @param logits [count * vocabSize] flat array
 * @param count トークン数
 * @param vocabSize 語彙サイズ
 */
export function argmaxPlanTokens(logits: Float32Array, count: number, vocabSize: number = PLAN_VOCAB.SIZE): number[] {
  const result: number[] = []
  for (let k = 0; k < count; k++) {
    const off = k * vocabSize
    let bestIdx = 0, bestVal = logits[off]
    for (let i = 1; i < vocabSize; i++) {
      if (logits[off + i] > bestVal) {
        bestVal = logits[off + i]
        bestIdx = i
      }
    }
    result.push(bestIdx)
  }
  return result
}

/**
 * 語彙index列を日ごとのグループに分割
 * nextで区切り、stopで終了
 */
export function parsePlanIndices(indices: number[]): PlanDayGroup[] {
  const groups: PlanDayGroup[] = []
  let current: PlanDayGroup = { targets: [] }

  for (const idx of indices) {
    if (idx === PLAN_VOCAB.STOP) break
    if (idx === PLAN_VOCAB.NEXT) {
      if (current.targets.length > 0) groups.push(current)
      current = { targets: [] }
      continue
    }
    if (idx >= PLAN_VOCAB.SEAT_START && idx < PLAN_VOCAB.SEAT_END) {
      current.targets.push({ type: 'seat', seat: idx + 1 })  // 1-indexed
    } else if (idx >= PLAN_VOCAB.ROLE_START && idx < PLAN_VOCAB.ROLE_END) {
      current.targets.push({ type: 'role', role: CO_ROLES[idx - PLAN_VOCAB.ROLE_START] })
    } else if (idx === PLAN_VOCAB.GRAYRAN) {
      current.targets.push({ type: 'grayran' })
    }
  }
  if (current.targets.length > 0) groups.push(current)

  return groups
}

/**
 * Plan tokensのグループから投票先seatを解決
 * @returns 投票先seat (1-indexed) or null (解決不能)
 */
function resolveGroup(group: PlanDayGroup, ctx: DecisionContext): number | null {
  const aliveSet = new Set(ctx.alivePlayers)
  for (const target of group.targets) {
    if (target.type === 'seat') {
      if (aliveSet.has(target.seat) && target.seat !== ctx.mySeat) return target.seat
    } else if (target.type === 'role') {
      for (const event of ctx.publicEvents) {
        if ('actor' in event && event.type.startsWith(target.role === 'seer' ? 'seer_claim' :
          target.role === 'medium' ? 'medium_claim' :
          target.role === 'bodyguard' ? 'bodyguard_claim' :
          target.role === 'mason' ? 'mason_claim' :
          'nekomata_claim')) {
          const actor = (event as any).actor as number
          if (aliveSet.has(actor) && actor !== ctx.mySeat) return actor
        }
      }
    } else if (target.type === 'grayran') {
      const coClaimed = new Set<number>()
      for (const event of ctx.publicEvents) {
        if ('actor' in event && (
          event.type === 'seer_claim' || event.type === 'medium_claim' ||
          event.type === 'bodyguard_claim' || event.type === 'mason_claim' ||
          event.type === 'nekomata_claim'
        )) {
          coClaimed.add((event as any).actor as number)
        }
      }
      const grays = ctx.alivePlayers.filter((s: number) => s !== ctx.mySeat && !coClaimed.has(s))
      if (grays.length > 0) {
        return grays[Math.floor(ctx.rng.next() * grays.length)]
      }
    }
  }
  return null
}

/**
 * Forward/Endgame plan logitsから今日の処刑対象seatを決定
 *
 * 生存者数で endgame に切り替え:
 *   ≤4人: 最終日 → endgame groups[0] (右→左で先頭=最終日)
 *   ≤6人: 最終日前日 → endgame groups[1] があればそれ、なければ groups[0]
 *   それ以外: forward の先頭グループ
 *
 * @returns 投票先seat (1-indexed) or null (プランなし/解決不能)
 */
export function planToVote(
  forwardLogits: Float32Array,
  numForwardTokens: number,
  ctx: DecisionContext,
  endgameLogits?: Float32Array | null,
  numEndgameTokens?: number,
): number | null {
  const alive = ctx.alivePlayers.length

  // Endgame切り替え判定
  if (endgameLogits && numEndgameTokens) {
    const egIndices = argmaxPlanTokens(endgameLogits, numEndgameTokens)
    const egGroups = parsePlanIndices(egIndices)  // 右→左: groups[0]=最終日, groups[1]=前日

    if (alive <= 4 && egGroups.length >= 1) {
      // 最終日
      const seat = resolveGroup(egGroups[0], ctx)
      if (seat) return seat
    } else if (alive <= 6 && egGroups.length >= 1) {
      // 最終日前日: groups[1]があればそれ、なければgroups[0]
      const group = egGroups.length >= 2 ? egGroups[1] : egGroups[0]
      const seat = resolveGroup(group, ctx)
      if (seat) return seat
    }
  }

  // Forward plan
  const indices = argmaxPlanTokens(forwardLogits, numForwardTokens)
  const groups = parsePlanIndices(indices)
  if (groups.length === 0) return null

  const today = groups[0]
  if (today.targets.length === 0) return null

  return resolveGroup(today, ctx)
}

/**
 * 夜行動のルールベース決定
 * 占い師: 未占い生存者からランダム、護衛: 指揮者 or ランダム
 */
export function nightAction(ctx: DecisionContext): NightAction {
  switch (ctx.myRole) {
    case 'seer': {
      const targets = ctx.alivePlayers.filter((s: number) => s !== ctx.mySeat)
      if (targets.length === 0) return { type: 'none' }
      return { type: 'divine', target: targets[Math.floor(ctx.rng.next() * targets.length)] }
    }
    case 'bodyguard': {
      const targets = ctx.alivePlayers.filter((s: number) => s !== ctx.mySeat)
      if (targets.length === 0) return { type: 'none' }
      // 指揮者がいれば優先護衛
      if (ctx.commander && targets.includes(ctx.commander)) {
        return { type: 'guard', target: ctx.commander }
      }
      return { type: 'guard', target: targets[Math.floor(ctx.rng.next() * targets.length)] }
    }
    default:
      return { type: 'none' }
  }
}

/**
 * CO行動のルールベース決定
 * 真役職ならCO、人外は潜伏
 */
export function dayClaim(ctx: DecisionContext): DayClaim {
  // 初日(day 1)のみCO
  if (ctx.day > 1) return { type: 'none' }

  switch (ctx.myRole) {
    case 'seer':
      return { type: 'seer_co', results: [] }
    case 'medium':
      return { type: 'medium_co' }
    case 'mason':
      return ctx.masonPartner
        ? { type: 'mason_co', partner: ctx.masonPartner }
        : { type: 'none' }
    default:
      return { type: 'none' }
  }
}

/**
 * シグナルのルールベース決定
 * 最小限のシグナル: planの対象にvote_intent
 */
export function communication(
  forwardLogits: Float32Array | null,
  numForwardTokens: number,
  ctx: DecisionContext,
): CommunicationAction {
  // planの投票先にvote_intent
  if (forwardLogits) {
    const voteSeat = planToVote(forwardLogits, numForwardTokens, ctx)
    if (voteSeat) {
      return {
        signal: { type: 'vote_intent', target: voteSeat },
        proposals: [],
      }
    }
  }
  return {
    signal: { type: 'no_signal' },
    proposals: [],
  }
}

/**
 * 指揮者提案のルールベース決定
 * plan の今日の対象をexecute_orderとして提案
 */
export function proposal(
  forwardLogits: Float32Array | null,
  numForwardTokens: number,
  ctx: DecisionContext,
): Proposal | null {
  if (ctx.commander !== ctx.mySeat) return null

  if (forwardLogits) {
    const voteSeat = planToVote(forwardLogits, numForwardTokens, ctx)
    if (voteSeat) return { type: 'execute_order', target: voteSeat }
  }
  return null
}

/**
 * 指揮者応答のルールベース
 * 常にfollow
 */
export function leadershipResponse(): LeadershipResponse {
  return 'follow'
}

/**
 * PlanDayGroup から投票先 seat を解決（mason死亡後のキャッシュ解決用）
 * @param group 1日分のplan group
 * @param aliveSeats 生存席一覧
 * @param events ゲームイベント（role解決・CO者除外用、省略時は簡易解決）
 * @returns 投票先seat (1-indexed) or null
 */
export function resolvePlanGroupSimple(group: PlanDayGroup, aliveSeats: number[], events?: readonly any[]): number | null {
  const aliveSet = new Set(aliveSeats)
  // CO者を収集（grayran・role解決用）
  const coClaimed = new Map<string, number[]>()  // claimType → seats
  if (events) {
    for (const e of events) {
      if ('actor' in e && typeof e.type === 'string') {
        for (const prefix of ['seer_claim', 'medium_claim', 'bodyguard_claim', 'mason_claim', 'nekomata_claim']) {
          if (e.type.startsWith(prefix)) {
            const role = prefix.replace('_claim', '')
            if (!coClaimed.has(role)) coClaimed.set(role, [])
            coClaimed.get(role)!.push(e.actor)
          }
        }
      }
    }
  }
  const allCOSeats = new Set<number>()
  for (const seats of coClaimed.values()) for (const s of seats) allCOSeats.add(s)

  for (const target of group.targets) {
    if (target.type === 'seat') {
      if (aliveSet.has(target.seat)) return target.seat
    } else if (target.type === 'role') {
      // role CO している生存席を探す
      const claimers = coClaimed.get(target.role) ?? []
      for (const seat of claimers) {
        if (aliveSet.has(seat)) return seat
      }
    } else if (target.type === 'grayran') {
      // CO していない生存者
      const grays = aliveSeats.filter(s => !allCOSeats.has(s))
      if (grays.length > 0) return grays[0]
      // グレーがいなければ全生存者から
      if (aliveSeats.length > 0) return aliveSeats[0]
    }
  }
  return null
}
