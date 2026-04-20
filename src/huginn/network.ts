/**
 * Pure JS Huginn Network.
 * Architecture:
 *   [CLS, Agent_0..Agent_{MAX-1}] → projection → TransformerEncoder
 *     → CLS  → Dense → message logits (vocabSize)
 *     → Agent[i] → Dense → vote logit i (pointer style)
 *     → CLS  → Dense → value
 */

import { TransformerEncoder } from '../fenrir/src/ml/transformer.ts'
import { DenseLayer, softmax } from '../fenrir/src/ml/nn.ts'
import { CLS_FEATURE_DIMS, AGENT_FEATURE_DIMS } from './observation.ts'
import { MAX_AGENTS } from './types.ts'

export type HuginnNetworkConfig = {
  dModel: number
  numLayers: number
  numHeads: number
  dFf: number
  vocabSize: number
}

export type ForwardResult = {
  msgLogits: Float32Array       // length vocabSize
  voteLogits: Float32Array      // length numAgents
  value: number
}

export class HuginnNetwork {
  readonly config: HuginnNetworkConfig
  readonly projCls: DenseLayer
  readonly projAgent: DenseLayer
  readonly encoder: TransformerEncoder
  readonly headMessage: DenseLayer
  readonly headVote: DenseLayer
  readonly headValue: DenseLayer

  private readonly tokens: Float32Array
  private readonly seqLen: number

  constructor(config: HuginnNetworkConfig) {
    this.config = config
    this.seqLen = 1 + MAX_AGENTS
    this.projCls = new DenseLayer(CLS_FEATURE_DIMS, config.dModel)
    this.projAgent = new DenseLayer(AGENT_FEATURE_DIMS, config.dModel)
    this.encoder = new TransformerEncoder({
      dModel: config.dModel,
      numLayers: config.numLayers,
      numHeads: config.numHeads,
      dFf: config.dFf,
      maxSeqLen: this.seqLen,
    })
    this.headMessage = new DenseLayer(config.dModel, config.vocabSize)
    this.headVote = new DenseLayer(config.dModel, 1)
    this.headValue = new DenseLayer(config.dModel, 1)
    this.tokens = new Float32Array(this.seqLen * config.dModel)
  }

  forward(cls: Float32Array, agents: Float32Array, numAgents: number): ForwardResult {
    const dm = this.config.dModel
    const mask = new Array<boolean>(this.seqLen).fill(false)
    mask[0] = true

    const clsProj = this.projCls.forward(cls)
    this.tokens.set(clsProj, 0)

    for (let i = 0; i < MAX_AGENTS; i++) {
      const slice = agents.subarray(i * AGENT_FEATURE_DIMS, (i + 1) * AGENT_FEATURE_DIMS)
      if (i < numAgents) {
        const out = this.projAgent.forward(slice)
        this.tokens.set(out, (1 + i) * dm)
        mask[1 + i] = true
      } else {
        for (let k = 0; k < dm; k++) this.tokens[(1 + i) * dm + k] = 0
      }
    }

    this.encoder.forward(this.tokens, this.seqLen, mask)

    const clsOut = this.tokens.slice(0, dm)
    const msgLogits = this.headMessage.forward(clsOut)

    const voteLogits = new Float32Array(numAgents)
    for (let i = 0; i < numAgents; i++) {
      const agentOut = this.tokens.slice((1 + i) * dm, (2 + i) * dm)
      const out = this.headVote.forward(agentOut)
      voteLogits[i] = out[0]
    }

    const valueOut = this.headValue.forward(clsOut)
    return { msgLogits, voteLogits, value: valueOut[0] }
  }
}

export function applyMask(logits: Float32Array, mask: Uint8Array): Float32Array {
  const out = new Float32Array(logits.length)
  for (let i = 0; i < logits.length; i++) {
    out[i] = mask[i] ? logits[i] : -1e9
  }
  return out
}

export function sampleArgmax(logits: Float32Array): number {
  let bestIdx = 0
  let best = -Infinity
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > best) {
      best = logits[i]
      bestIdx = i
    }
  }
  return bestIdx
}

export function sampleStochastic(logits: Float32Array, rngNext: () => number): number {
  const probs = softmax(logits)
  let r = rngNext()
  for (let i = 0; i < probs.length; i++) {
    r -= probs[i]
    if (r <= 0) return i
  }
  return probs.length - 1
}

export function logProbOf(logits: Float32Array, idx: number): number {
  let max = -Infinity
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > max) max = logits[i]
  }
  let sum = 0
  for (let i = 0; i < logits.length; i++) {
    sum += Math.exp(logits[i] - max)
  }
  return logits[idx] - max - Math.log(sum)
}
