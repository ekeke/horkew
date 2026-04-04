/**
 * Strategy-Only Adapter — 後方互換ファクトリ
 *
 * MasonTrainingAdapter をインスタンス化して返す。
 * 呼び出し元の移行が完了したら削除予定。
 */

import type { GameHandlers } from '../../../lupa/handlers.ts'
import type { FenrirExt } from '../ext.ts'
import type { FenrirExtEvent } from '../events.ts'
import type { StrategyOnlyAdapterConfig, CapturedObservation } from './adapter-types.ts'
import { MasonTrainingAdapter } from './mason-training-adapter.ts'

export function strategyOnlyAdapter(
  config: StrategyOnlyAdapterConfig,
): GameHandlers<FenrirExtEvent, FenrirExt> & { getCapturedObservations?: () => CapturedObservation[] } {
  return new MasonTrainingAdapter(config)
}
