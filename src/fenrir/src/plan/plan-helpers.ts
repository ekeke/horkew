/**
 * Plan ヘルパー — plan tokens からゲーム行動への変換、状態管理
 */

import type { NightAction, DayClaim } from '../../../lupa/types.ts'
import type { CommunicationAction } from '../communication.ts'
import type { Proposal, LeadershipResponse } from '../leadership.ts'
import type { DecisionContext } from '../agents/agent.ts'
import type { PlanDayGroup } from './plan-vocab.ts'
import { parsePlanIndices } from './plan-vocab.ts'
import { resolvePlanGroup } from './plan-resolve.ts'

// ============================================================
// PlanState 型 — GameState.ext に格納される plan 状態
// ============================================================

export type PlanState = {
  /** forward plan の日グループ */
  forwardGroups: PlanDayGroup[]
  /** endgame plan の日グループ */
  endgameGroups: PlanDayGroup[]
  /** 現在消化中の forward グループインデックス */
  dayIndex: number
  /** ML mason の seat（引き継ぎ追跡用） */
  mlMasonSeat: number | null
  /** mason 引き継ぎ完了フラグ */
  masonTakeoverDone: boolean
}

/** PlanState の初期値 */
export function createPlanState(): PlanState {
  return {
    forwardGroups: [],
    endgameGroups: [],
    dayIndex: 0,
    mlMasonSeat: null,
    masonTakeoverDone: false,
  }
}

// ============================================================
// Plan → Game Action 変換
// ============================================================

/**
 * endgame groups から保護対象席を抽出
 *
 * endgame plan = 「最終日に処刑する対象」= 最終日まで生かすリスト。
 * forward plan や grayran で投票してはならない席を返す。
 *
 * - seat: 直接追加
 * - role: CO 者を解決して追加
 * - grayran: 対象不定のためスキップ
 */
function collectEndgameProtectedSeats(
  egGroups: PlanDayGroup[],
  aliveSeats: number[],
  events: readonly any[],
): Set<number> {
  const protected_ = new Set<number>()
  const aliveSet = new Set(aliveSeats)

  // CO者を収集（role 解決用）
  const coClaimed = new Map<string, number[]>()
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

  for (const group of egGroups) {
    for (const target of group.targets) {
      if (target.type === 'seat') {
        if (aliveSet.has(target.seat)) protected_.add(target.seat)
      } else if (target.type === 'role') {
        const claimers = coClaimed.get(target.role) ?? []
        for (const s of claimers) {
          if (aliveSet.has(s)) protected_.add(s)
        }
      }
      // grayran: 対象不定 → スキップ
    }
  }
  return protected_
}

/**
 * plan tokens から今日の投票先 seat を決定
 *
 * 生存者数で endgame に切り替え:
 *   ≤4人: 最終日 → endgame groups[0]
 *   ≤6人: 最終日前日 → endgame groups[1] or groups[0]
 *   それ以外: forward の先頭グループ（endgame 保護席を除外）
 */
export function planToVote(
  forwardActions: number[],
  ctx: DecisionContext,
  endgameActions?: number[] | null,
): number | null {
  const alive = ctx.alivePlayers.length
  const egGroups = (endgameActions && endgameActions.length > 0)
    ? parsePlanIndices(endgameActions)
    : []

  // Endgame切り替え判定
  if (egGroups.length > 0) {
    if (alive <= 4 && egGroups.length >= 1) {
      const seat = resolvePlanGroup(egGroups[0], ctx.alivePlayers, ctx.publicEvents, { excludeSeat: ctx.mySeat, rng: ctx.rng })
      if (seat) return seat
    } else if (alive <= 6 && egGroups.length >= 2) {
      const seat = resolvePlanGroup(egGroups[1], ctx.alivePlayers, ctx.publicEvents, { excludeSeat: ctx.mySeat, rng: ctx.rng })
      if (seat) return seat
    }
  }

  // Forward plan（endgame 保護席を除外）
  const groups = parsePlanIndices(forwardActions)
  if (groups.length === 0) return null

  const today = groups[0]
  if (today.targets.length === 0) return null

  const endgameProtected = egGroups.length > 0
    ? collectEndgameProtectedSeats(egGroups, ctx.alivePlayers, ctx.publicEvents)
    : undefined

  return resolvePlanGroup(today, ctx.alivePlayers, ctx.publicEvents, {
    excludeSeat: ctx.mySeat,
    excludeSeats: endgameProtected,
    rng: ctx.rng,
  })
}

// ============================================================
// Strategy-only 固定行動（adapter が使用）
// ============================================================

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
 * planの対象にvote_intent
 */
export function communication(
  forwardActions: number[] | null,
  ctx: DecisionContext,
): CommunicationAction {
  if (forwardActions) {
    const voteSeat = planToVote(forwardActions, ctx)
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
  forwardActions: number[] | null,
  ctx: DecisionContext,
): Proposal | null {
  if (ctx.commander !== ctx.mySeat) return null

  if (forwardActions) {
    const voteSeat = planToVote(forwardActions, ctx)
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
