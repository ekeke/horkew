/**
 * Transformer-based trainable Huginn network.
 *
 * Architecture:
 *   tokens = [CLS, agent_0, ..., agent_{MAX_AGENTS-1}]
 *     CLS:    Linear(CLS_DIMS → dModel)
 *     agents: Linear(AGENT_DIMS → dModel) (per-token shared weights)
 *   → TransformerEncoder (numLayers, numHeads, dFf)
 *   → CLS_out → headMessage: Linear(dModel → vocabSize)
 *   → agent_out[i] → headVote: Linear(dModel → 1) (per-token shared, pointer style)
 *   → CLS_out → headValue: Linear(dModel → 1)
 *
 * 重要: vote head は per-agent token に同じ Linear を適用する pointer スタイル。
 * これが「desire の高い agent token に大きい vote logit を出す」を学べる根拠。
 */

import { Linear, TransformerEncoder, type EncoderCache, sgdLinear, adamLinear, type AdamOpts } from './transformer.ts'
import { CLS_FEATURE_DIMS, AGENT_FEATURE_DIMS } from './observation.ts'
import { MAX_AGENTS } from './types.ts'

export type TrainableConfig = {
  dModel: number
  numLayers: number
  numHeads: number
  dFf: number
  vocabSize: number
}

export type ForwardCache = {
  cls: Float32Array              // CLS_DIMS
  agents: Float32Array           // MAX_AGENTS * AGENT_DIMS
  tokens: Float32Array           // (1 + MAX_AGENTS) * dModel (post-projection input to encoder)
  encOut: { output: Float32Array; cache: EncoderCache }
  clsTokenOut: Float32Array      // dModel (encoder output for CLS)
  agentTokenOuts: Float32Array[] // numAgents 個の per-agent dModel ベクトル
  mask: boolean[]
  numAgents: number
}

export type ForwardResult = {
  msgLogits: Float32Array
  voteLogits: Float32Array
  value: number
  cache: ForwardCache
}

export class TrainableNetwork {
  readonly config: TrainableConfig
  projCls: Linear
  projAgent: Linear
  encoder: TransformerEncoder
  headMessage: Linear
  headVote: Linear              // dModel → 1 (pointer style)
  headValue: Linear

  private readonly seqLen: number

  constructor(config: TrainableConfig) {
    this.config = config
    this.seqLen = 1 + MAX_AGENTS
    this.projCls = new Linear(CLS_FEATURE_DIMS, config.dModel)
    this.projAgent = new Linear(AGENT_FEATURE_DIMS, config.dModel)
    this.encoder = new TransformerEncoder(config.dModel, config.numLayers, config.numHeads, config.dFf)
    this.headMessage = new Linear(config.dModel, config.vocabSize)
    this.headVote = new Linear(config.dModel, 1)
    this.headValue = new Linear(config.dModel, 1)
  }

  forward(cls: Float32Array, agents: Float32Array, numAgents: number): ForwardResult {
    const dM = this.config.dModel
    const mask = new Array<boolean>(this.seqLen).fill(false)
    mask[0] = true

    const tokens = new Float32Array(this.seqLen * dM)
    const clsProj = this.projCls.forward(cls)
    tokens.set(clsProj, 0)

    const agentProj = this.projAgent.forwardBatched(agents, MAX_AGENTS)
    tokens.set(agentProj, dM)

    for (let i = 0; i < numAgents; i++) mask[1 + i] = true

    const encOut = this.encoder.forward(tokens, this.seqLen, mask)

    const clsTokenOut = encOut.output.slice(0, dM)
    const msgLogits = this.headMessage.forward(clsTokenOut)
    const value = this.headValue.forward(clsTokenOut)[0]

    const voteLogits = new Float32Array(numAgents)
    const agentTokenOuts: Float32Array[] = []
    for (let i = 0; i < numAgents; i++) {
      const tok = encOut.output.slice((1 + i) * dM, (2 + i) * dM)
      agentTokenOuts.push(tok)
      voteLogits[i] = this.headVote.forward(tok)[0]
    }

    return {
      msgLogits,
      voteLogits,
      value,
      cache: { cls, agents, tokens, encOut, clsTokenOut, agentTokenOuts, mask, numAgents },
    }
  }

  backward(
    cache: ForwardCache,
    msgGrad: Float32Array,             // size vocabSize
    voteGradPartial: Float32Array,     // size numAgents
    valueGrad: number,
  ): void {
    const dM = this.config.dModel

    const dClsFromMsg = this.headMessage.backward(cache.clsTokenOut, msgGrad)
    const dClsFromValue = this.headValue.backward(cache.clsTokenOut, new Float32Array([valueGrad]))
    const dCls = new Float32Array(dM)
    for (let i = 0; i < dM; i++) dCls[i] = dClsFromMsg[i] + dClsFromValue[i]

    const dEncOut = new Float32Array(this.seqLen * dM)
    dEncOut.set(dCls, 0)
    for (let i = 0; i < cache.numAgents; i++) {
      const dAgent = this.headVote.backward(cache.agentTokenOuts[i], new Float32Array([voteGradPartial[i]]))
      dEncOut.set(dAgent, (1 + i) * dM)
    }

    const dTokens = this.encoder.backward(cache.encOut.cache, dEncOut, this.seqLen, cache.mask)

    const dClsProj = dTokens.slice(0, dM)
    this.projCls.backward(cache.cls, dClsProj)

    const dAgentProj = dTokens.slice(dM)  // [MAX_AGENTS * dM]
    this.projAgent.backwardBatched(cache.agents, dAgentProj, MAX_AGENTS)
  }

  applyStep(lr: number, divisor: number): void {
    sgdLinear(this.projCls, lr, divisor)
    sgdLinear(this.projAgent, lr, divisor)
    sgdLinear(this.headMessage, lr, divisor)
    sgdLinear(this.headVote, lr, divisor)
    sgdLinear(this.headValue, lr, divisor)
    this.encoder.applyStep(lr, divisor)
  }

  applyStepAdam(lr: number, divisor: number, opts?: AdamOpts): void {
    adamLinear(this.projCls, lr, divisor, opts)
    adamLinear(this.projAgent, lr, divisor, opts)
    adamLinear(this.headMessage, lr, divisor, opts)
    adamLinear(this.headVote, lr, divisor, opts)
    adamLinear(this.headValue, lr, divisor, opts)
    this.encoder.applyStepAdam(lr, divisor, opts)
  }
}

export function softmax(logits: Float32Array): Float32Array {
  let max = -Infinity
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > max) max = logits[i]
  }
  const out = new Float32Array(logits.length)
  let sum = 0
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - max)
    sum += out[i]
  }
  for (let i = 0; i < logits.length; i++) out[i] /= sum
  return out
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
  let max = -Infinity
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > max) max = logits[i]
  }
  let sum = 0
  const probs = new Float32Array(logits.length)
  for (let i = 0; i < logits.length; i++) {
    probs[i] = Math.exp(logits[i] - max)
    sum += probs[i]
  }
  for (let i = 0; i < logits.length; i++) probs[i] /= sum
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
