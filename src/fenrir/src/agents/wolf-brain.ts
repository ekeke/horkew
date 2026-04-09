/**
 * Wolf Brain Agent for Brain Battle
 *
 * 狼チーム全体の戦略を一括決定する Brain Battle 専用エージェント。
 * 出力: formation（騙り配置）、fake result（偽結果）、vote（処刑先）、attack（襲撃）
 * GRU/plan token は使わない。
 */

import type { TeamDecisionContext, WolfNightAction } from './agent.ts'
import type { AnyNetwork, ForwardResult } from '../ml/nn.ts'
import type { NeuralAgentConfig } from './neural-agent.ts'
import { encodeCollectiveWolfObservation } from '../observation.ts'
import { maskAttackTarget, maskAttacker, decodeWolfNightAction } from '../action.ts'
import { SEATS } from '../observation.ts'
import { CollectiveAgentBase } from './team-base.ts'
import { FORMATION_SIZE } from '../training.ts'
import { MAX_WOLVES } from '../action.ts'

// ============================================================
// Types
// ============================================================

const FORMATION_ROLES = ['seer', 'medium', 'bodyguard', 'nekomata', 'lurk', 'villager_co'] as const
export type FormationRole = typeof FORMATION_ROLES[number]

export type WolfFormationEntry = {
  wolfSlot: number       // 0, 1, 2
  wolfSeat: number       // actual seat number
  claimRole: FormationRole
  fakeTarget: number     // seat (1-based), 0 if lurk/villager_co
  fakeResult: 'human' | 'wolf'  // meaningless if lurk/villager_co
}

export type WolfFormation = {
  wolves: WolfFormationEntry[]
}

// ============================================================
// Masking
// ============================================================

/** Formation mask: dead wolf → all masked */
function maskFormation(ctx: TeamDecisionContext, wolfSlot: number): Float32Array {
  const mask = new Float32Array(FORMATION_SIZE).fill(-Infinity)
  const aliveSet = new Set(ctx.alivePlayers)
  if (wolfSlot < ctx.teamSeats.length && aliveSet.has(ctx.teamSeats[wolfSlot])) {
    // Alive wolf: all formation options available
    mask.fill(0)
  }
  return mask
}

/** Fake target mask: exclude dead, own team, and self */
function maskFakeTarget(ctx: TeamDecisionContext, wolfSlot: number): Float32Array {
  const mask = new Float32Array(SEATS).fill(-Infinity)
  const aliveSet = new Set(ctx.alivePlayers)
  const teamSet = new Set(ctx.teamSeats)

  if (wolfSlot >= ctx.teamSeats.length || !aliveSet.has(ctx.teamSeats[wolfSlot])) {
    return mask  // dead wolf: all masked
  }

  for (let s = 1; s <= SEATS; s++) {
    if (aliveSet.has(s) && !teamSet.has(s)) {
      mask[s - 1] = 0
    }
  }
  return mask
}

/** Fake result mask: 2 options (white=0, black=1), masked if wolf is dead */
function maskFakeResult(ctx: TeamDecisionContext, wolfSlot: number): Float32Array {
  const mask = new Float32Array(2).fill(-Infinity)
  const aliveSet = new Set(ctx.alivePlayers)
  if (wolfSlot < ctx.teamSeats.length && aliveSet.has(ctx.teamSeats[wolfSlot])) {
    mask[0] = 0  // white
    mask[1] = 0  // black
  }
  return mask
}

// ============================================================
// WolfBrainAgent
// ============================================================

export class WolfBrainAgent extends CollectiveAgentBase {
  constructor(network: AnyNetwork, config?: Partial<NeuralAgentConfig>) {
    super(network, config)
  }

  protected override infer(ctx: TeamDecisionContext): ForwardResult {
    const t = performance.now()
    // No frozen village NN injection for now (168 dims = 0)
    const obs = encodeCollectiveWolfObservation(ctx, undefined)
    this.lastObs = obs
    const result = this.network.forward(obs)
    this.inferMs += performance.now() - t
    this.inferCount++
    return result
  }

  /**
   * Decide formation for all wolves.
   * Returns formation + fake target/result for each wolf.
   * Called once per day by BrainBattleAdapter.
   */
  getFormation(ctx: TeamDecisionContext): WolfFormation {
    const result = this.getOrInfer(ctx)
    const wolves: WolfFormationEntry[] = []
    const primarySeat = ctx.teamSeats[0]

    for (let slot = 0; slot < Math.min(ctx.teamSeats.length, MAX_WOLVES); slot++) {
      const wolfSeat = ctx.teamSeats[slot]

      // Formation
      const formLogits = result.policies.get(`formation_${slot}`)!
      const formMask = maskFormation(ctx, slot)
      const { action: formIdx, logProb: formLogProb } = this.selectAction(formLogits, formMask)
      this.record(`formation_${slot}`, formIdx, formLogProb, result.value, 0, primarySeat)

      // Fake target
      const ftLogits = result.policies.get(`fake_target_${slot}`)!
      const ftMask = maskFakeTarget(ctx, slot)
      const { action: ftIdx, logProb: ftLogProb } = this.selectAction(ftLogits, ftMask)
      this.record(`fake_target_${slot}`, ftIdx, ftLogProb, result.value, 0, primarySeat)

      // Fake result (white/black)
      const frLogits = result.policies.get(`fake_result_${slot}`)!
      const frMask = maskFakeResult(ctx, slot)
      const { action: frIdx, logProb: frLogProb } = this.selectAction(frLogits, frMask)
      this.record(`fake_result_${slot}`, frIdx, frLogProb, result.value, 0, primarySeat)

      wolves.push({
        wolfSlot: slot,
        wolfSeat,
        claimRole: FORMATION_ROLES[formIdx],
        fakeTarget: ftIdx + 1,  // 0-indexed → 1-indexed seat
        fakeResult: frIdx === 0 ? 'human' : 'wolf',
      })
    }

    return { wolves }
  }

  /**
   * Decide execution target (wolf's turn).
   * Returns seat number (1-based).
   */
  decideExecution(ctx: TeamDecisionContext): number {
    const result = this.getOrInfer(ctx)
    const logits = result.policies.get('vote')!
    // Mask: alive non-wolf seats
    const mask = new Float32Array(SEATS).fill(-Infinity)
    const teamSet = new Set(ctx.teamSeats)
    for (const seat of ctx.alivePlayers) {
      if (!teamSet.has(seat) && seat <= SEATS) {
        mask[seat - 1] = 0
      }
    }
    const primarySeat = ctx.teamSeats[0]
    const { action, logProb } = this.selectAction(logits, mask)
    this.record('vote', action, logProb, result.value, 0, primarySeat)
    return action + 1  // 0-indexed → 1-indexed seat
  }

  /**
   * Decide night action (attack target + attacker).
   */
  decideNightAction(ctx: TeamDecisionContext): WolfNightAction {
    const result = this.getOrInfer(ctx)

    const attackLogits = result.policies.get('attack_target')!
    const attackMask = maskAttackTarget(ctx)
    const { action: attackIdx, logProb: attackLogProb } = this.selectAction(attackLogits, attackMask)
    const primarySeat = ctx.teamSeats[0]
    this.record('attack_target', attackIdx, attackLogProb, result.value, 0, primarySeat)

    const attackerLogits = result.policies.get('attacker')!
    const attackerMask = maskAttacker(ctx)
    const { action: attackerIdx, logProb: attackerLogProb } = this.selectAction(attackerLogits, attackerMask)
    this.record('attacker', attackerIdx, attackerLogProb, result.value, 0, primarySeat)

    return decodeWolfNightAction(attackIdx, attackerIdx, ctx.teamSeats)
  }
}
