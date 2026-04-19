/**
 * Skoll-supervised pretrain 共通ユーティリティ
 */

import type { SystemRole, VillageStatus } from '../../../types/index.ts'
import type { GameEvent, LupaConfig } from '../../../lupa/types.ts'
import type { DecisionContext } from '../agents/agent.ts'
import { alivePlayers } from '../../../lupa/roles.ts'
import { Possibilities, possibilityFromRoles, RoleBitIndex } from '../../../retar/possibilities.ts'
import { analyzePerPlayer as retarAnalyzePerPlayer } from '../retar-bridge.ts'

export const VILLAGE_ROLES: ReadonlySet<SystemRole> = new Set<SystemRole>([
  'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
])

/**
 * Day/phase でキャッシュした VillageStatus + setup を返す。
 * full-adapter は ext.retarCache に書かないので、CapturingStrategy 側で再計算する用。
 */
export class RetarArtifactsCache {
  private cachedKey: number = -1
  private cachedArtifacts: { vs: VillageStatus; setup: Map<SystemRole, number> } | null = null

  get(ctx: DecisionContext, lupaConfig: LupaConfig): { vs: VillageStatus; setup: Map<SystemRole, number> } | null {
    const key = ctx.day * 4 + (ctx.phase === 'day' ? 1 : 0) + (ctx.revoteRound ?? 0) * 2
    if (this.cachedKey === key && this.cachedArtifacts) return this.cachedArtifacts

    const events = ctx.publicEvents as GameEvent[]
    const alives = alivePlayers(ctx.gameState)
    let ppResult
    try {
      ppResult = retarAnalyzePerPlayer(events, ctx.gameState, lupaConfig, alives)
    } catch {
      return null
    }
    if (!ppResult.vs || !ppResult.setup) return null

    this.cachedKey = key
    this.cachedArtifacts = { vs: ppResult.vs, setup: ppResult.setup }
    return this.cachedArtifacts
  }

  reset(): void {
    this.cachedKey = -1
    this.cachedArtifacts = null
  }
}

/**
 * globalRetarPossibilities + setup から Possibilities を構築する。
 * SkollAgent.decideVote と同じ手順。
 */
export function buildPossibilities(
  globalPoss: Map<number, Set<SystemRole>>,
  setup: Map<SystemRole, number>,
): Possibilities {
  let maxSeat = 0
  for (const seat of globalPoss.keys()) {
    if (seat > maxSeat) maxSeat = seat
  }
  const possibilities = new Possibilities(maxSeat)
  for (const [role, count] of setup) {
    const idx = RoleBitIndex[role]
    if (idx !== undefined) possibilities.setup[idx] = count
  }
  possibilities.setupOriginal = new Uint8Array(possibilities.setup)
  for (const [seat, roles] of globalPoss) {
    possibilities.possibilities[seat] = possibilityFromRoles(roles)
  }
  return possibilities
}
