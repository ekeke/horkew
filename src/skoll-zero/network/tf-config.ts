/**
 * skoll-zero TF.js 版 factory (学習用、Node 専用)。
 *
 * browser では config.ts のみを import すること。training.ts 依存でここは TF.js を引く。
 */

import { TfTransformerNetwork } from '../../fenrir/src/ml/nn-tf-transformer.ts'
import { SKOLL_ZERO_NETWORK_CONFIG } from './config.ts'

/** TF.js (学習用)。Node 専用。 */
export function createSkollZeroTfNetwork(lr: number = 3e-4): TfTransformerNetwork {
  return new TfTransformerNetwork(SKOLL_ZERO_NETWORK_CONFIG, lr, 'mason_collective')
}
