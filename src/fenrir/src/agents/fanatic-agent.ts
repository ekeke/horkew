/**
 * FanaticAgent: 狂信者用NN（frozen村NN注入対応）
 *
 * NeuralAgent を拡張し、infer時にfrozen村NNの出力を注入する。
 */

import type { DecisionContext } from './agent.ts'
import type { AnyNetwork, ForwardResult } from '../ml/nn.ts'
import { encodeObservation, encodeFanaticObservation, type VillageNNOutput } from '../observation.ts'
import { NeuralAgent } from './neural-agent.ts'

export class FanaticAgent extends NeuralAgent {
  /** frozen村NN（セットされていれば infer 時に自動で forward して村NN出力を注入） */
  frozenVillageNetwork: AnyNetwork | undefined = undefined

  protected override infer(ctx: DecisionContext): ForwardResult {
    const t = performance.now()
    let villageNNOutput: VillageNNOutput | undefined
    if (this.frozenVillageNetwork) {
      const villageObs = encodeObservation(ctx)
      const villageResult = this.frozenVillageNetwork.forward(villageObs)
      villageNNOutput = {
        predict: villageResult.policies.get('predict')!,
        trust: villageResult.policies.get('trust')!,
      }
    }
    const obs = encodeFanaticObservation(ctx, villageNNOutput)
    this.lastObs = obs
    const result = this.network.forward(obs)
    this.inferMs += performance.now() - t
    this.inferCount++
    return result
  }
}
