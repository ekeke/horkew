/**
 * desire — MCTS policy + viewer teammate 情報から HuginnInput.desire を構築。
 *
 * 仕様:
 *   - MCTS 成功時: top-1 (visits argmax) = HIGH、teammate (self 含む) = LOW、残り = MID
 *   - MCTS 失敗時 (result=null): 全 alive seat 一律 MID の flat (primary 無し)
 *     → huginn NN は primary 不在の特殊 communication に対応 (memory: project_huginn_adapter_flat_desire_fallback)
 *   - top-1 が teammate のとき: teammate LOW が優先、primary 不在相当の扱い
 *
 * 定数は huginn/abstract-env.ts の内部 const と一致させる (import 境界のため複製)。
 */

import type { MCTSResult } from '../mcts/ismcts.ts'
import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import { DESIRE_HIGH_BASE } from '../../huginn/types.ts'

// huginn/abstract-env.ts と同期: LOW=0.00, MID=0.05, HIGH=DESIRE_HIGH_BASE=0.10
const DESIRE_LOW = 0.00
const DESIRE_MID = 0.05
const DESIRE_HIGH = DESIRE_HIGH_BASE

function collectTeammates(ctx: DecisionContext): Set<number> {
  const teammates = new Set<number>()
  teammates.add(ctx.mySeat)
  if (ctx.wolfTeammates) for (const s of ctx.wolfTeammates) teammates.add(s)
  if (ctx.knownWolves) for (const s of ctx.knownWolves) teammates.add(s)
  if (ctx.knownHamster !== null) teammates.add(ctx.knownHamster)
  if (ctx.masonPartner !== null) teammates.add(ctx.masonPartner)
  return teammates
}

function argmaxVisits(visits: Map<number, number>): number {
  let topSeat = -1
  let topVisits = -1
  for (const [action, v] of visits) {
    if (v > topVisits) {
      topVisits = v
      topSeat = action
    }
  }
  return topSeat
}

export function buildDesire(
  mctsResult: MCTSResult | null,
  ctx: DecisionContext,
  participants: number[],
): Float64Array {
  const desire = new Float64Array(participants.length)

  if (mctsResult === null || mctsResult.visits.size === 0) {
    // Flat MID fallback (primary 不在)
    for (let i = 0; i < participants.length; i++) desire[i] = DESIRE_MID
    return desire
  }

  const teammates = collectTeammates(ctx)
  const topSeat = argmaxVisits(mctsResult.visits)

  for (let i = 0; i < participants.length; i++) {
    const seat = participants[i]
    if (teammates.has(seat)) {
      desire[i] = DESIRE_LOW
      continue
    }
    desire[i] = (seat === topSeat) ? DESIRE_HIGH : DESIRE_MID
  }
  return desire
}
