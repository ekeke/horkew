/**
 * skoll-zero の NN 構成。
 *
 * Phase 1 では fenrir の `MASON_BRAIN_TRANSFORMER_CONFIG` をそのまま流用する:
 * - Seat Transformer trunk (dModel=64, 3+2 layers, numPlanTokens=0)
 * - 14-dim per-seat `vote` head（= skoll-zero の policy head）
 * - scalar value head（= TransformerNetwork 標準、skoll-zero では zero init）
 *
 * trunk + vote head は skoll-supervised で事前学習済み (`tmp/skoll-mb-large-v2/...`)。
 * Phase 1 では warm start でこれを引き継ぐ。
 *
 * 将来 skoll-zero 固有の構成が必要になったら、ここで MASON_BRAIN と分岐させる。
 */

import { createMasonBrainNetwork, createMasonBrainTfNetwork } from '../../fenrir/src/training.ts'

export { createMasonBrainNetwork as createSkollZeroNetwork }
export { createMasonBrainTfNetwork as createSkollZeroTfNetwork }
