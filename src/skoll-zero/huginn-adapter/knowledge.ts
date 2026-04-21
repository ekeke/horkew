/**
 * knowledge — DecisionContext.retarPossibilities を huginn の
 * HuginnInput.knowledgeByOther (Set<RoleName>[]) に変換するヘルパー。
 *
 * 既存 StrategyBaseAdapter が per-viewer retar を計算して retarPossibilities に
 * 注入済みなので、adapter 側は変換するだけ。SystemRole と RoleName は完全一致
 * (11 役職、同じ文字列) なのでキャストで足りる。
 */

import type { RoleName } from '../../huginn/types.ts'
import { ROLE_VOCABULARY } from '../../huginn/types.ts'
import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'

const ALL_ROLES: readonly RoleName[] = ROLE_VOCABULARY

/**
 * participants (sorted seat list) の各 seat に対応する role 可能性集合を返す。
 *
 * - ctx.retarPossibilities が null → 全 seat 全役職可能で埋める
 * - retarPossibilities に含まれない seat → 全役職可能で埋める (死亡/未登録)
 */
export function buildKnowledgeByOther(
  ctx: DecisionContext,
  participants: number[],
): Set<RoleName>[] {
  return participants.map(seat => {
    if (ctx.retarPossibilities === null) return new Set<RoleName>(ALL_ROLES)
    const possible = ctx.retarPossibilities.get(seat)
    if (!possible) return new Set<RoleName>(ALL_ROLES)
    return new Set<RoleName>(possible as Set<RoleName>)
  })
}
