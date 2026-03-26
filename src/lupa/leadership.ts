import type { GameState } from './types.ts'
import type { SystemRole } from '../types/index.ts'
import { alivePlayers } from './roles.ts'

export type Proposal =
  | { type: 'execute_order', target: number }
  | { type: 'investigate_order', target: number }
  | { type: 'protect_order', target: number }

export type LeadershipResponse = 'follow' | 'defy' | 'no_response'

/**
 * 指揮者を判定する
 *
 * 条件（優先度順）:
 * 1. 共有者ペア確認: AがBを共有相方と宣言 + BもAを宣言 → seat低い方
 * 2. 占い師確定: 占いCO者が1人のみ + 対抗なし + Retarで破綻していない
 *
 * @param retarPossibilities Retar分析結果（破綻チェック用、省略可）
 */
export function detectCommander(
  state: GameState,
  retarPossibilities?: Map<number, Set<SystemRole>> | null,
): number | null {
  const alive = alivePlayers(state)

  // CO破綻判定: CO役職がRetarの可能性に含まれていない
  const isBusted = (seat: number, claimedRole: SystemRole): boolean => {
    if (!retarPossibilities) return false
    const roles = retarPossibilities.get(seat)
    return roles !== undefined && !roles.has(claimedRole)
  }

  // 1. 共有者ペア確認（両方破綻していないこと）
  const masonClaimers = alive.filter(p => p.claimedRole === 'mason' && !isBusted(p.seat, 'mason'))
  for (const a of masonClaimers) {
    for (const b of masonClaimers) {
      if (a.seat >= b.seat) continue
      const aPartner = findMasonPartner(state, a.seat)
      const bPartner = findMasonPartner(state, b.seat)
      if (aPartner === b.seat && bPartner === a.seat) {
        return a.seat
      }
    }
  }

  // 2. 占い師確定: 破綻していない生存占いCO者が1人のみ
  const seerClaimers = alive.filter(p => p.claimedRole === 'seer' && !isBusted(p.seat, 'seer'))
  if (seerClaimers.length === 1) {
    return seerClaimers[0].seat
  }

  return null
}

/** GameEventからmason_claimのpartnerを取得 */
function findMasonPartner(state: GameState, seat: number): number | null {
  // PlayerStateには直接partnerが記録されていないため、
  // engine側でGameEventから取得する必要がある。
  // ここではGameStateに追加されるmasonPartnersマップを参照。
  return state.masonPartners?.get(seat) ?? null
}
