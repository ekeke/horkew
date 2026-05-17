/**
 * RandomAgent: 完全ランダム意思決定エージェント
 *
 * 訓練データ多様化のため、 heuristic と異なる戦略空間をカバーする。
 * 各 decide* で valid action からランダムに選ぶ。
 *
 * 制約 (正当ルール内のランダム):
 * - decideNightAction: 自分の role に応じた action target を alive から random
 * - decideVote: 自分以外の alive から random
 * - decideDayClaim: 確率で真 role を Day 1 に CO (シンプル化のため偽 CO はしない)
 *
 * 偽 CO や戦略的読み合いは含まない。 純粋にランダム探索。
 */

import type { NightAction, DayClaim } from '../../../lupa/types.ts'
import { AgentBase, type DecisionContext } from './agent.ts'
import { alivePlayersExcept } from '../../../lupa/roles.ts'

export class RandomAgent extends AgentBase {
  /** CO する確率 (Day 1 で trueRole に応じて CO する) */
  private coProb: number

  constructor(coProb: number = 0.5) {
    super()
    this.coProb = coProb
  }

  override decideNightAction(ctx: DecisionContext): NightAction {
    const role = ctx.myRole
    const others = alivePlayersExcept(ctx.gameState, ctx.mySeat).map(p => p.seat)
    if (others.length === 0) return { type: 'none' }

    switch (role) {
      case 'seer': {
        const target = pick(others, ctx.rng)
        return { type: 'divine', target }
      }
      case 'bodyguard': {
        const target = pick(others, ctx.rng)
        return { type: 'guard', target }
      }
      case 'werewolf': {
        // 狼は自分以外の非狼 alive を attack
        const wolves = new Set(ctx.wolfTeammates ?? [])
        const targets = others.filter(s => !wolves.has(s))
        if (targets.length === 0) return { type: 'none' }
        const target = pick(targets, ctx.rng)
        return { type: 'attack', target }
      }
      default:
        return { type: 'none' }
    }
  }

  override decideDayClaim(ctx: DecisionContext): DayClaim {
    // 確率 coProb で trueRole を Day 1 に CO (シンプル化、 偽 CO はしない)
    if (ctx.day !== 1) return { type: 'none' }
    if (ctx.rng.next() > this.coProb) return { type: 'none' }

    const role = ctx.myRole
    switch (role) {
      case 'seer': {
        // 0 夜の divine 結果を CO
        const first = ctx.myPlayer.divineHistory.values().next().value
        if (!first) return { type: 'none' }
        return {
          type: 'seer_co',
          results: [{ day: 0, target: first.target, result: first.result }],
        }
      }
      case 'medium':
        return { type: 'medium_co' }
      case 'bodyguard':
        return { type: 'bodyguard_co', targets: [] }
      case 'mason':
        return { type: 'mason_co', partner: ctx.masonPartner ?? ctx.mySeat }
      case 'nekomata':
        return { type: 'nekomata_co' }
      default:
        return { type: 'none' }
    }
  }

  override decideVote(ctx: DecisionContext): number {
    const others = ctx.alivePlayers.filter(s => s !== ctx.mySeat)
    if (others.length === 0) return ctx.alivePlayers[0]
    return pick(others, ctx.rng)
  }
}

function pick<T>(arr: T[], rng: { next(): number }): T {
  const idx = Math.floor(rng.next() * arr.length)
  return arr[Math.min(idx, arr.length - 1)]
}
