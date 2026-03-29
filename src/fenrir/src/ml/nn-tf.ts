/**
 * tf.js-node-gpu ベースの NeuralNetwork 実装
 *
 * 既存の NeuralNetwork と同じインターフェースを維持しつつ、
 * 内部で tf.js の GPU 加速を使用する。
 */

// @ts-ignore — tf.js-node-gpu は CJS だが ESM から import 可能
import * as tf from '@tensorflow/tfjs-node-gpu'
import type { NetworkConfig, ForwardResult } from './nn.ts'

let _tfNNInstanceId = 0

export class TfNeuralNetwork {
  readonly config: NetworkConfig

  private trunkWeights: tf.Variable[]  // [w, b, w, b, ...]
  private headWeights: Map<string, [tf.Variable, tf.Variable]>        // softmax heads
  private sigmoidHeadWeights: Map<string, [tf.Variable, tf.Variable]> // sigmoid heads
  private valueWeights: [tf.Variable, tf.Variable]
  private allVariables: tf.Variable[]

  private optimizer: tf.AdamOptimizer

  constructor(config: NetworkConfig, lr: number = 3e-4) {
    const prefix = `nn${_tfNNInstanceId++}_`
    this.config = config
    this.trunkWeights = []
    this.headWeights = new Map()
    this.sigmoidHeadWeights = new Map()
    this.allVariables = []

    // Trunk layers
    let prevSize = config.inputSize
    for (const hiddenSize of config.hiddenSizes) {
      const w = tf.variable(
        tf.randomNormal([prevSize, hiddenSize], 0, Math.sqrt(2 / prevSize)),
        true, `${prefix}trunk_w_${this.trunkWeights.length / 2}`,
      )
      const b = tf.variable(
        tf.zeros([hiddenSize]),
        true, `${prefix}trunk_b_${this.trunkWeights.length / 2}`,
      )
      this.trunkWeights.push(w, b)
      this.allVariables.push(w, b)
      prevSize = hiddenSize
    }

    // Softmax policy heads
    for (const [name, outputSize] of Object.entries(config.heads)) {
      const w = tf.variable(
        tf.randomNormal([prevSize, outputSize], 0, Math.sqrt(2 / prevSize)),
        true, `${prefix}head_${name}_w`,
      )
      const b = tf.variable(tf.zeros([outputSize]), true, `${prefix}head_${name}_b`)
      this.headWeights.set(name, [w, b])
      this.allVariables.push(w, b)
    }

    // Sigmoid policy heads
    for (const [name, outputSize] of Object.entries(config.sigmoidHeads ?? {})) {
      const w = tf.variable(
        tf.randomNormal([prevSize, outputSize], 0, Math.sqrt(2 / prevSize)),
        true, `${prefix}head_${name}_w`,
      )
      const b = tf.variable(tf.zeros([outputSize]), true, `${prefix}head_${name}_b`)
      this.sigmoidHeadWeights.set(name, [w, b])
      this.allVariables.push(w, b)
    }

    // Value head
    const vw = tf.variable(
      tf.randomNormal([prevSize, 1], 0, Math.sqrt(2 / prevSize)),
      true, `${prefix}value_w`,
    )
    const vb = tf.variable(tf.zeros([1]), true, `${prefix}value_b`)
    this.valueWeights = [vw, vb]
    this.allVariables.push(vw, vb)

    this.optimizer = tf.train.adam(lr)
  }

  /** 単一サンプルの推論（ゲーム内で使用） */
  forward(input: Float32Array): ForwardResult {
    const policies = new Map<string, Float32Array>()
    let value = 0

    tf.tidy(() => {
      const x = this.forwardTrunk(tf.tensor2d(input, [1, this.config.inputSize]))

      for (const [name, [w, b]] of this.headWeights) {
        const logits = tf.add(tf.matMul(x, w), b)
        policies.set(name, logits.dataSync() as Float32Array)
      }
      for (const [name, [w, b]] of this.sigmoidHeadWeights) {
        const logits = tf.add(tf.matMul(x, w), b)
        policies.set(name, logits.dataSync() as Float32Array)
      }

      const [vw, vb] = this.valueWeights
      const rawValue = tf.add(tf.matMul(x, vw), vb).dataSync()[0]
      value = Math.tanh(rawValue)
    })

    return { policies, value }
  }

  /** trunk部分の forward（共有） */
  private forwardTrunk(input: tf.Tensor): tf.Tensor {
    let x = input
    for (let i = 0; i < this.trunkWeights.length; i += 2) {
      const w = this.trunkWeights[i]
      const b = this.trunkWeights[i + 1]
      x = tf.relu(tf.add(tf.matMul(x, w), b))
    }
    return x
  }

  /**
   * PPOバッチ学習
   *
   * ミニバッチ全体を1回のGPU呼び出しで処理。
   */
  trainBatch(batch: {
    observations: Float32Array[]
    actionHeads: string[]
    actionIndices: number[]
    oldLogProbs: number[]
    advantages: number[]
    returns: number[]
    sigmoidActions?: (Float32Array | undefined)[]  // sigmoid heads用
    clipEpsilon: number
    valueLossCoeff: number
    entropyCoeff: number
  }): { policyLoss: number, valueLoss: number, entropy: number } {
    const n = batch.observations.length
    if (n === 0) return { policyLoss: 0, valueLoss: 0, entropy: 0 }

    const inputSize = this.config.inputSize
    const sigmoidHeadNames = new Set(Object.keys(this.config.sigmoidHeads ?? {}))

    // バッチテンソル構築
    const obsData = new Float32Array(n * inputSize)
    for (let i = 0; i < n; i++) {
      obsData.set(batch.observations[i], i * inputSize)
    }

    const result = { policyLoss: 0, valueLoss: 0, entropy: 0 }

    // ヘッド別にグループ化してバッチ処理
    const headGroups = new Map<string, number[]>()
    for (let i = 0; i < n; i++) {
      const head = batch.actionHeads[i]
      if (!headGroups.has(head)) headGroups.set(head, [])
      headGroups.get(head)!.push(i)
    }

    const lossFunc = () => {
      const obsTensor = tf.tensor2d(obsData, [n, inputSize])
      const trunk = this.forwardTrunk(obsTensor)

      // Value loss
      const [vw, vb] = this.valueWeights
      const rawValues = tf.add(tf.matMul(trunk, vw), vb).squeeze([1])  // [n]
      const values = tf.tanh(rawValues)
      const returnsTensor = tf.tensor1d(batch.returns)
      const vLoss = tf.mul(
        tf.scalar(batch.valueLossCoeff),
        tf.mean(tf.squaredDifference(values, returnsTensor)),
      )

      // Policy losses per head
      let totalPolicyLoss = tf.scalar(0)
      let totalEntropy = tf.scalar(0)

      for (const [headName, indices] of headGroups) {
        if (sigmoidHeadNames.has(headName)) {
          // === Sigmoid head: PPO with multi-binary BCE ===
          const [hw, hb] = this.sigmoidHeadWeights.get(headName)!
          const allLogits = tf.add(tf.matMul(trunk, hw), hb)  // [n, headSize]
          const headLogits = tf.gather(allLogits, indices)  // [m, headSize]
          const headProbs = tf.sigmoid(headLogits)  // [m, headSize]

          // Build target actions tensor
          const headSize = allLogits.shape[1]!
          const actionsData = new Float32Array(indices.length * headSize)
          for (let j = 0; j < indices.length; j++) {
            const sa = batch.sigmoidActions?.[indices[j]]
            if (sa) actionsData.set(sa, j * headSize)
          }
          const actionsTensor = tf.tensor2d(actionsData, [indices.length, headSize])

          // Per-element log prob: a*log(p) + (1-a)*log(1-p)
          const logP = tf.log(tf.add(headProbs, tf.scalar(1e-8)))
          const log1mP = tf.log(tf.add(tf.sub(tf.scalar(1), headProbs), tf.scalar(1e-8)))
          const perElementLogProb = tf.add(
            tf.mul(actionsTensor, logP),
            tf.mul(tf.sub(tf.scalar(1), actionsTensor), log1mP),
          )
          const newLogProbs = tf.sum(perElementLogProb, 1)  // [m]

          // PPO ratio & clipped surrogate
          const headOldLogProbs = indices.map(i => batch.oldLogProbs[i])
          const headAdvantages = indices.map(i => batch.advantages[i])
          const ratio = tf.exp(tf.sub(newLogProbs, tf.tensor1d(headOldLogProbs)))
          const advTensor = tf.tensor1d(headAdvantages)
          const surr1 = tf.mul(ratio, advTensor)
          const surr2 = tf.mul(
            tf.clipByValue(ratio, 1 - batch.clipEpsilon, 1 + batch.clipEpsilon),
            advTensor,
          )
          const pLoss = tf.neg(tf.mean(tf.minimum(surr1, surr2)))

          // Entropy: -Σ [p*log(p) + (1-p)*log(1-p)] per element, averaged
          const ent = tf.neg(tf.mean(tf.add(
            tf.mul(headProbs, logP),
            tf.mul(tf.sub(tf.scalar(1), headProbs), log1mP),
          )))

          totalPolicyLoss = tf.add(totalPolicyLoss, pLoss)
          totalEntropy = tf.add(totalEntropy, ent)
        } else {
          // === Softmax head: standard PPO ===
          const [hw, hb] = this.headWeights.get(headName)!
          const allLogits = tf.add(tf.matMul(trunk, hw), hb)  // [n, headSize]
          const headLogits = tf.gather(allLogits, indices)  // [m, headSize]
          const headProbs = tf.softmax(headLogits)

          const headActions = indices.map(i => batch.actionIndices[i])
          const headAdvantages = indices.map(i => batch.advantages[i])
          const headOldLogProbs = indices.map(i => batch.oldLogProbs[i])

          const actionMask = tf.oneHot(headActions, allLogits.shape[1]!)
          const selectedProbs = tf.sum(tf.mul(headProbs, actionMask), 1)
          const newLogProbs = tf.log(tf.add(selectedProbs, tf.scalar(1e-8)))

          const ratio = tf.exp(tf.sub(newLogProbs, tf.tensor1d(headOldLogProbs)))
          const advTensor = tf.tensor1d(headAdvantages)
          const surr1 = tf.mul(ratio, advTensor)
          const surr2 = tf.mul(
            tf.clipByValue(ratio, 1 - batch.clipEpsilon, 1 + batch.clipEpsilon),
            advTensor,
          )
          const pLoss = tf.neg(tf.mean(tf.minimum(surr1, surr2)))

          const ent = tf.neg(tf.mean(
            tf.sum(tf.mul(headProbs, tf.log(tf.add(headProbs, tf.scalar(1e-8)))), 1)
          ))

          totalPolicyLoss = tf.add(totalPolicyLoss, pLoss)
          totalEntropy = tf.add(totalEntropy, ent)
        }
      }

      const entBonus = tf.mul(tf.scalar(-batch.entropyCoeff), totalEntropy)
      const totalLoss = tf.add(tf.add(totalPolicyLoss, vLoss), entBonus) as tf.Scalar

      // Record for logging (sync values)
      result.policyLoss = totalPolicyLoss.dataSync()[0]
      result.valueLoss = vLoss.dataSync()[0]
      result.entropy = totalEntropy.dataSync()[0]

      return totalLoss
    }

    this.optimizer.minimize(lossFunc, false, this.allVariables)

    return result
  }

  /** 重みのクローン（チェックポイント用） */
  cloneWeights(): Map<string, Float32Array> {
    const weights = new Map<string, Float32Array>()
    for (let i = 0; i < this.trunkWeights.length; i += 2) {
      const layerIdx = i / 2
      weights.set(`trunk_${layerIdx}_w`, this.trunkWeights[i].dataSync() as Float32Array)
      weights.set(`trunk_${layerIdx}_b`, this.trunkWeights[i + 1].dataSync() as Float32Array)
    }
    for (const [name, [w, b]] of this.headWeights) {
      weights.set(`head_${name}_w`, w.dataSync() as Float32Array)
      weights.set(`head_${name}_b`, b.dataSync() as Float32Array)
    }
    for (const [name, [w, b]] of this.sigmoidHeadWeights) {
      weights.set(`head_${name}_w`, w.dataSync() as Float32Array)
      weights.set(`head_${name}_b`, b.dataSync() as Float32Array)
    }
    weights.set('value_w', this.valueWeights[0].dataSync() as Float32Array)
    weights.set('value_b', this.valueWeights[1].dataSync() as Float32Array)
    return weights
  }

  /** 重みをロード */
  loadWeights(weights: Map<string, Float32Array>): void {
    tf.tidy(() => {
      for (let i = 0; i < this.trunkWeights.length; i += 2) {
        const layerIdx = i / 2
        const w = weights.get(`trunk_${layerIdx}_w`)!
        const b = weights.get(`trunk_${layerIdx}_b`)!
        this.trunkWeights[i].assign(tf.tensor(w, this.trunkWeights[i].shape))
        this.trunkWeights[i + 1].assign(tf.tensor(b, this.trunkWeights[i + 1].shape))
      }
      for (const [name, [wVar, bVar]] of this.headWeights) {
        const w = weights.get(`head_${name}_w`)!
        const b = weights.get(`head_${name}_b`)!
        wVar.assign(tf.tensor(w, wVar.shape))
        bVar.assign(tf.tensor(b, bVar.shape))
      }
      for (const [name, [wVar, bVar]] of this.sigmoidHeadWeights) {
        const w = weights.get(`head_${name}_w`)!
        const b = weights.get(`head_${name}_b`)!
        wVar.assign(tf.tensor(w, wVar.shape))
        bVar.assign(tf.tensor(b, bVar.shape))
      }
      const vw = weights.get('value_w')!
      const vb = weights.get('value_b')!
      this.valueWeights[0].assign(tf.tensor(vw, this.valueWeights[0].shape))
      this.valueWeights[1].assign(tf.tensor(vb, this.valueWeights[1].shape))
    })
  }

  /**
   * 教師あり学習バッチ（vote head用 cross-entropy）
   *
   * soft label対応: labelが分布（合計~1）の場合はKLダイバージェンスに近い損失になる。
   * trunk + vote head の重みのみが更新される。
   */
  trainSupervisedVote(batch: {
    observations: Float32Array[]
    /** soft label: [SEATS] per sample, 合計~1 */
    labels: Float32Array[]
    /** vote mask: [SEATS] per sample, -Inf=invalid, 0=valid */
    masks: Float32Array[]
  }): { loss: number, accuracy: number } {
    const n = batch.observations.length
    if (n === 0) return { loss: 0, accuracy: 0 }

    const inputSize = this.config.inputSize
    const obsData = new Float32Array(n * inputSize)
    for (let i = 0; i < n; i++) {
      obsData.set(batch.observations[i], i * inputSize)
    }

    const voteHeadSize = this.config.heads.vote
    const labelData = new Float32Array(n * voteHeadSize)
    const maskData = new Float32Array(n * voteHeadSize)
    for (let i = 0; i < n; i++) {
      labelData.set(batch.labels[i], i * voteHeadSize)
      maskData.set(batch.masks[i], i * voteHeadSize)
    }

    const result = { loss: 0, accuracy: 0 }

    // trunk + vote head のみ学習対象
    const [hw, hb] = this.headWeights.get('vote')!
    const trainableVars = [...this.trunkWeights, hw, hb]

    const lossFunc = () => {
      const obsTensor = tf.tensor2d(obsData, [n, inputSize])
      const trunk = this.forwardTrunk(obsTensor)
      const logits = tf.add(tf.matMul(trunk, hw), hb)  // [n, voteHeadSize]

      // マスク適用
      const maskTensor = tf.tensor2d(maskData, [n, voteHeadSize])
      const maskedLogits = tf.add(logits, maskTensor)

      const probs = tf.softmax(maskedLogits)
      const labelTensor = tf.tensor2d(labelData, [n, voteHeadSize])

      // cross-entropy: -Σ label[i] * log(probs[i])
      const logProbs = tf.log(tf.add(probs, tf.scalar(1e-8)))
      const loss = tf.neg(tf.mean(tf.sum(tf.mul(labelTensor, logProbs), 1)))

      // accuracy: argmax(probs) === argmax(label)
      const predIndices = tf.argMax(probs, 1).dataSync()
      const labelIndices = tf.argMax(labelTensor, 1).dataSync()
      let correct = 0
      for (let i = 0; i < n; i++) {
        if (predIndices[i] === labelIndices[i]) correct++
      }
      result.accuracy = correct / n
      result.loss = loss.dataSync()[0]

      return loss as tf.Scalar
    }

    this.optimizer.minimize(lossFunc, false, trainableVars)

    return result
  }

  /** 総パラメータ数 */
  get totalParams(): number {
    let total = 0
    for (const v of this.allVariables) {
      total += v.size
    }
    return total
  }

  /** リソース解放 */
  dispose(): void {
    for (const v of this.allVariables) v.dispose()
  }
}
