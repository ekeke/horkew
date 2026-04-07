/**
 * Plan ヘルパー — plan tokens からゲーム行動への変換、状態管理
 */

import type { NightAction, DayClaim } from '../../../lupa/types.ts'
import type { CommunicationAction } from '../communication.ts'
import type { Proposal, LeadershipResponse } from '../leadership.ts'
import type { DecisionContext } from '../agents/agent.ts'
import type { PlanSlot } from './plan-vocab.ts'
import { parseDualPlanSlots } from './plan-vocab.ts'
import { resolvePlanSlot } from './plan-resolve.ts'

// ============================================================
// PlanState 型 — GameState.ext に格納される plan 状態
// ============================================================

/** Endgame 切り替え閾値 (noose count ≤ この値で endgame スロットを使用) */
export const ENDGAME_NOOSE_THRESHOLD = 3

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
 * plan tokens から今日の投票先 seat を決定（縄数ベース + endgame ルーティング）
 *
 * noose > ENDGAME_NOOSE_THRESHOLD: forward slots を noose 消化で参照
 * noose ≤ ENDGAME_NOOSE_THRESHOLD: endgame slots を参照
 *   noose=2 → endgameSlots[0] (最終日)
 *   noose=3 → endgameSlots[1] (前日) or [0]
 */
export function planToVote(
  planActions: number[],
  ctx: DecisionContext,
  planState?: PlanState | null,
): number | null {
  const currentNoose = nooseCount(ctx.alivePlayers.length)
  const resolveOpts = { excludeSeat: ctx.mySeat, rng: ctx.rng }

  if (!planState || (planState.slots.length === 0 && planState.endgameSlots.length === 0)) {
    // planState がなければ on-the-fly パース（後方互換）
    const { forwardSlots, endgameSlots } = parseDualPlanSlots(planActions)

    // Endgame routing
    if (currentNoose <= ENDGAME_NOOSE_THRESHOLD && endgameSlots.length > 0) {
      const egIndex = ENDGAME_NOOSE_THRESHOLD - currentNoose
      const slot = egIndex < endgameSlots.length ? endgameSlots[egIndex] : endgameSlots[0]
      const seat = resolvePlanSlot(slot, ctx.alivePlayers, ctx.publicEvents, resolveOpts)
      if (seat) return seat
    }

    if (forwardSlots.length === 0) return null
    return resolvePlanSlot(forwardSlots[0], ctx.alivePlayers, ctx.publicEvents, resolveOpts)
  }

  // Endgame routing with planState
  if (currentNoose <= ENDGAME_NOOSE_THRESHOLD && planState.endgameSlots.length > 0) {
    const egIndex = ENDGAME_NOOSE_THRESHOLD - currentNoose
    const slot = egIndex < planState.endgameSlots.length ? planState.endgameSlots[egIndex] : planState.endgameSlots[0]
    const seat = resolvePlanSlot(slot, ctx.alivePlayers, ctx.publicEvents, resolveOpts)
    if (seat) return seat
  }

  // Forward routing (noose-based slot consumption)
  const consumed = planState.initialNooseCount - currentNoose
  const slotIndex = Math.max(0, consumed)

  if (slotIndex >= planState.slots.length) return null  // スロット切れ → heuristic fallback

  return resolvePlanSlot(planState.slots[slotIndex], ctx.alivePlayers, ctx.publicEvents, resolveOpts)
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
