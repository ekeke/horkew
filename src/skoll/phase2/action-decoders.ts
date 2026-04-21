/**
 * Phase 2 head 出力 → action 型への逆変換。
 *
 * 最小実装: claim head の argmax を DayClaim の type にマップする。
 * target / result / partner 等の補助情報が必要な type は super fallback と
 * マージして最終的な DayClaim を構築する (`mergeClaimTypeWithSuper`)。
 */

import type { DayClaim } from '../../lupa/types.ts'
import { CLAIM } from '../../fenrir/src/action.ts'

/** claim head index → DayClaim type 文字列。FAKE_CO (8) など対応外は null。 */
export function claimTypeFromIdx(idx: number): DayClaim['type'] | null {
  switch (idx) {
    case CLAIM.SEER_CO: return 'seer_co'
    case CLAIM.MEDIUM_CO: return 'medium_co'
    case CLAIM.BODYGUARD_CO: return 'bodyguard_co'
    case CLAIM.MASON_CO: return 'mason_co'
    case CLAIM.NEKOMATA_CO: return 'nekomata_co'
    case CLAIM.SEER_RESULT: return 'seer_result'
    case CLAIM.MEDIUM_RESULT: return 'medium_result'
    case CLAIM.FORECAST: return 'forecast'
    case CLAIM.NONE: return 'none'
    default: return null  // FAKE_CO など phase2 では出力しない
  }
}

/** logits 配列から argmax index を返す (utility) */
export function argmaxIndex(logits: Float32Array | number[]): number {
  let bestIdx = 0
  let bestVal = -Infinity
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > bestVal) { bestVal = logits[i]; bestIdx = i }
  }
  return bestIdx
}

/**
 * Phase 2 claim head の argmax と super の decision をマージ。
 *
 * 戦略:
 * - NN type が null (未対応) or simple type (nekomata_co / none) → NN の type を採用
 * - bodyguard_co: targets=[] で default 構築
 * - それ以外 (target / result / partner 必要な type):
 *   super と type が一致 → super を採用、一致しない → super を採用 (補助情報が無いので fallback)
 *
 * 最小実装なので情報不足の type は super に倒す。より良い decode には
 * target head / result predictor を組み合わせる必要 (後段で拡張)。
 */
export function mergeClaimTypeWithSuper(
  nnArgmax: number,
  superDecision: DayClaim,
): DayClaim {
  const nnType = claimTypeFromIdx(nnArgmax)
  if (!nnType) return superDecision
  if (nnType === 'none') return { type: 'none' }
  if (nnType === 'nekomata_co') return { type: 'nekomata_co' }
  if (nnType === 'bodyguard_co') return { type: 'bodyguard_co', targets: [] }
  if (superDecision.type === nnType) return superDecision
  return superDecision
}
