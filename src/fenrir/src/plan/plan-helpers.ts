/**
 * Plan ヘルパー — plan tokens からゲーム行動への変換、状態管理
 */

import type { NightAction, DayClaim } from '../../../lupa/types.ts'
import type { Rng } from '../../../lupa/random.ts'
import type { CommunicationAction } from '../communication.ts'
import type { Proposal, LeadershipResponse } from '../leadership.ts'
import type { DecisionContext } from '../agents/agent.ts'
import type { PlanSlot } from './plan-vocab.ts'
import { parseDualPlanSlots } from './plan-vocab.ts'
import { resolvePlanSlot } from './plan-resolve.ts'

// ============================================================
// PlanState 型 — GameState.ext に格納される plan 状態
// ============================================================

/** Endgame 切り替え閾値 (alive ≤ この値で endgame スロットを使用) */
export const ENDGAME_ALIVE_THRESHOLD = 6

export type PlanState = {
  /** パース済みスロット列（各スロット = 1回の処刑計画）— forward 部分 */
  slots: PlanSlot[]
  /** endgame スロット列: [0]=最終日, [1]=前日, ... */
  endgameSlots: PlanSlot[]
  /** Plan 生成時点の縄数（消費計算の基準） */
  initialNooseCount: number
  /** ML mason の seat（引き継ぎ追跡用） */
  mlMasonSeat: number | null
  /** mason 引き継ぎ完了フラグ */
  masonTakeoverDone: boolean
}

/** PlanState の初期値 */
export function createPlanState(): PlanState {
  return {
    slots: [],
    endgameSlots: [],
    initialNooseCount: 0,
    mlMasonSeat: null,
    masonTakeoverDone: false,
  }
}

/**
 * 縄数を計算
 * @param aliveCount 生存者数
 * @returns 残り処刑回数
 */
export function nooseCount(aliveCount: number): number {
  return Math.floor(aliveCount / 2)
}

// ============================================================
// Plan → Game Action 変換
// ============================================================

/**
 * plan tokens から今日の投票先 seat を決定（生存人数ベース）
 *
 * alive > 6:  forward slots[0]（先頭）
 * alive 5-6:  endgameSlots[1]（末尾から2つ目）, fallback [0]
 * alive ≤ 4:  endgameSlots[0]（末尾）
 */
export function planToVote(
  planActions: number[],
  ctx: DecisionContext,
  planState?: PlanState | null,
): number | null {
  const alive = ctx.alivePlayers.length
  const resolveOpts = { excludeSeat: ctx.mySeat, rng: ctx.rng }

  if (!planState || (planState.slots.length === 0 && planState.endgameSlots.length === 0)) {
    // planState がなければ on-the-fly パース（後方互換）
    const { forwardSlots, endgameSlots } = parseDualPlanSlots(planActions)
    return resolveByAlive(alive, forwardSlots, endgameSlots, ctx, resolveOpts)
  }

  return resolveByAlive(alive, planState.slots, planState.endgameSlots, ctx, resolveOpts)
}

/**
 * endgameSlots[0] の保護対象 seat を収集
 * （最終日用スロットの対象は最終日まで吊らない）
 */
function collectProtectedSeats(endgameSlot0: PlanSlot | undefined, ctx: DecisionContext, resolveOpts: { excludeSeat: number, rng: Rng }): Set<number> {
  const protected_ = new Set<number>()
  if (!endgameSlot0) return protected_
  // slot の全 target を仮解決して seat を収集
  for (const target of endgameSlot0.targets) {
    if (target.type === 'seat') {
      protected_.add(target.seat)
    } else if (target.type === 'role' || target.type === 'grayran') {
      const resolved = resolvePlanSlot({ targets: [target] }, ctx.alivePlayers, ctx.publicEvents, resolveOpts)
      if (resolved) protected_.add(resolved)
    }
  }
  return protected_
}

/** 生存人数に基づいて forward / endgame を選択し resolve */
function resolveByAlive(
  alive: number,
  forwardSlots: PlanSlot[],
  endgameSlots: PlanSlot[],
  ctx: DecisionContext,
  resolveOpts: { excludeSeat: number, rng: Rng },
): number | null {
  // 最終日 (alive ≤ 4): endgameSlots[0] を使用
  if (alive <= 4 && endgameSlots.length > 0) {
    const seat = resolvePlanSlot(endgameSlots[0], ctx.alivePlayers, ctx.publicEvents, resolveOpts)
    if (seat) return seat
  }

  // 最終日前 (alive 5-6): endgameSlots[1] → forward[0] → 保護対象除外ランダム
  if (alive <= ENDGAME_ALIVE_THRESHOLD && endgameSlots.length > 0) {
    // 1. endgameSlots[1]（最終日の1つ前）
    if (endgameSlots[1]) {
      const seat = resolvePlanSlot(endgameSlots[1], ctx.alivePlayers, ctx.publicEvents, resolveOpts)
      if (seat) return seat
    }
    // 2. forwardSlots[0] にフォールバック
    if (forwardSlots.length > 0) {
      const seat = resolvePlanSlot(forwardSlots[0], ctx.alivePlayers, ctx.publicEvents, resolveOpts)
      if (seat) return seat
    }
    // 3. endgameSlots[0] の保護対象を除外してランダム
    const protected_ = collectProtectedSeats(endgameSlots[0], ctx, resolveOpts)
    const candidates = ctx.alivePlayers.filter(s => s !== resolveOpts.excludeSeat && !protected_.has(s))
    if (candidates.length > 0) {
      return candidates[Math.floor(resolveOpts.rng.next() * candidates.length)]
    }
    // 保護対象を除外すると候補なし → 全員から（最終手段）
    const all = ctx.alivePlayers.filter(s => s !== resolveOpts.excludeSeat)
    if (all.length > 0) return all[Math.floor(resolveOpts.rng.next() * all.length)]
    return null
  }

  // 通常 (alive > 6): forward を使用
  if (forwardSlots.length === 0) return null
  return resolvePlanSlot(forwardSlots[0], ctx.alivePlayers, ctx.publicEvents, resolveOpts)
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
  planActions: number[] | null,
  ctx: DecisionContext,
  planState?: PlanState | null,
): CommunicationAction {
  if (planActions) {
    const voteSeat = planToVote(planActions, ctx, planState)
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
  planActions: number[] | null,
  ctx: DecisionContext,
  planState?: PlanState | null,
): Proposal | null {
  if (ctx.commander !== ctx.mySeat) return null

  if (planActions) {
    const voteSeat = planToVote(planActions, ctx, planState)
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
