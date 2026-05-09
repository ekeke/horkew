/**
 * Wolf imitation 用 virtual viewer observation builder。
 *
 * 「もし wolfSeat が真の {seer / medium / bodyguard / nekomata} だったら」の仮想視点で
 * SimState から observation を組み立てる。frozen village NN に投入することで、狼が
 * 「真役職だったらの行動」を base policy として参照し、そこからの deviation だけを
 * 学習する設計の入力側。
 *
 * 実装の要点:
 * - viewerRole で encodeIndividualFromSimState を呼ぶ
 *   - private 情報 (divineLog / guardLog / mediumLog 等) は wolfSeat にそれらが無いため
 *     空 (= 該当役職の 0 日目相当)。frozen village NN は「結果なし状態の各役職」として
 *     forward し、claim_true (=「今 CO すべきか」) や役職別 head (divine / guard) を出す。
 * - retar も viewer 仮定で再計算 (recomputeRetarInRollout=true)
 *   - self retar は `runRetarOnVillageStatus(vs, setup, wolfSeat, viewerRole)` で
 *     「viewerRole は wolfSeat」固定の assumption で計算される。
 *   - global retar は assumption 無しなので狼視点と同じ (公開情報のみ)。
 *
 * 用途別 viewer role:
 * - claim_seer_fake / morning  → 'seer'
 * - claim_medium_fake          → 'medium'
 * - claim_bg_fake              → 'bodyguard'
 * - claim_nekomata_fake        → 'nekomata'
 */

import type { SystemRole } from '../../types/index.ts'
import type { Phase } from '../simulator/world-state.ts'
import type { RootActionMode } from '../mcts/ISMCTS.ts'
import type { SimState } from '../simulator/world-state.ts'
import { encodeIndividualFromSimState, type RolloutInvariants } from './from-sim-state.ts'

/**
 * wolfSeat を viewerRole の真役職と仮定した virtual observation (1029 dims) を構築。
 *
 * @param state rollout 中の SimState
 * @param wolfSeat 仮想 viewer を担う狼の seat
 * @param viewerRole 仮想視点の役職 ('seer' | 'medium' | 'bodyguard' | 'nekomata')
 * @param invariants rollout 不変情報 (root snapshot)
 * @returns Float32Array(1029) — skoll-zero standard NN 入力フォーマット
 */
export function buildVirtualViewerObs(
  state: SimState,
  wolfSeat: number,
  viewerRole: SystemRole,
  invariants: RolloutInvariants,
): Float32Array {
  const virtualInv: RolloutInvariants = {
    ...invariants,
    recomputeRetarInRollout: true,
  }
  return encodeIndividualFromSimState(state, wolfSeat, viewerRole, virtualInv)
}

/**
 * 偽 CO / morning 系の Phase に対応する virtual viewer role を返す。
 *
 * - claim_*_fake → 偽る役職そのもの
 * - morning      → 'seer' (morning は seer 占い結果のみ)
 * - その他       → null (mix 不要)
 */
export function viewerRoleForFakeClaimPhase(phase: Phase): SystemRole | null {
  switch (phase) {
    case 'claim_seer_fake': return 'seer'
    case 'claim_medium_fake': return 'medium'
    case 'claim_bg_fake': return 'bodyguard'
    case 'claim_nekomata_fake': return 'nekomata'
    case 'morning': return 'seer'
    default: return null
  }
}

/**
 * 偽 CO / morning 系の RootActionMode に対応する virtual viewer role を返す。
 * augmentRecord 経路 (record 蓄積時) で使う。
 */
export function viewerRoleForFakeClaimMode(mode: RootActionMode): SystemRole | null {
  switch (mode) {
    case 'claim_seer_fake': return 'seer'
    case 'claim_medium_fake': return 'medium'
    case 'claim_bg_fake': return 'bodyguard'
    case 'claim_nekomata_fake': return 'nekomata'
    case 'morning': return 'seer'
    default: return null
  }
}
