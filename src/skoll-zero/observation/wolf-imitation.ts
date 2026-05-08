/**
 * Wolf imitation 用 virtual seer observation builder。
 *
 * 「もし wolfSeat が真 seer だったら」の仮想視点で SimState から observation を
 * 組み立てる。frozen village NN に投入することで、狼が「真占いだったらの行動」を
 * base policy として参照し、そこからの deviation だけを学習する設計の入力側。
 *
 * 実装の要点:
 * - viewerRole='seer' で encodeIndividualFromSimState を呼ぶ
 *   - private 情報の divineResults は wolfSeat に divineLog が無いため空 (= 占い 0
 *     日目相当)。frozen village NN は「結果なし状態の seer」として forward する。
 *   - wolfTeamSeats も viewerRole='seer' なので空。これは seer 視点として正しい。
 * - retar も seer 仮定で再計算 (recomputeRetarInRollout=true)
 *   - self retar は `runRetarOnVillageStatus(vs, setup, wolfSeat, 'seer')` で
 *     「seer は wolfSeat」固定の assumption で計算される。
 *   - global retar は assumption 無しなので狼視点と同じ (公開情報のみ)。
 */

import type { SystemRole } from '../../types/index.ts'
import type { SimState } from '../simulator/world-state.ts'
import { encodeIndividualFromSimState, type RolloutInvariants } from './from-sim-state.ts'

/** virtual viewer role の固定値 (今後 'medium' / 'bodyguard' 拡張も視野) */
const VIRTUAL_VIEWER_ROLE: SystemRole = 'seer'

/**
 * wolfSeat を真 seer と仮定した virtual observation (1029 dims) を構築。
 *
 * @param state rollout 中の SimState
 * @param wolfSeat 仮想 seer を担う狼の seat
 * @param invariants rollout 不変情報 (root snapshot)
 * @returns Float32Array(1029) — skoll-zero standard NN 入力フォーマット
 */
export function buildVirtualSeerObs(
  state: SimState,
  wolfSeat: number,
  invariants: RolloutInvariants,
): Float32Array {
  const virtualInv: RolloutInvariants = {
    ...invariants,
    recomputeRetarInRollout: true,
  }
  return encodeIndividualFromSimState(state, wolfSeat, VIRTUAL_VIEWER_ROLE, virtualInv)
}
