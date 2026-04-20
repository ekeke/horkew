/**
 * Multi-agent K-round synchronous protocol.
 * 全 agent が同時に発話 → K ラウンド後、全員が同時に finalVote。
 */

import type { HuginnInput, Message, Observation, AgentId } from './types.ts'
import { OFFER_REF_WINDOW } from './types.ts'
import {
  TrainableNetwork,
  applyMask,
  sampleArgmax,
  sampleStochastic,
  logProbOf,
} from './trainable-network.ts'
import { encodeObservation } from './observation.ts'
import { buildVocabLayout, decodeMessage, buildLegalMask } from './message-vocab.ts'
import type { Rng } from './rng.ts'

export type AgentTraceStep = {
  round: number
  cls: Float32Array
  agents: Float32Array
  numAgents: number
  chosenToken: number
  logProb: number
  value: number
}

export type AgentTrace = {
  agent: AgentId
  steps: AgentTraceStep[]      // K 個 (各ラウンド)
  messages: Message[]           // 自分の発話、K 個
  finalVoteIdx: number
  finalVoteLogProb: number
  finalVoteValue: number
}

export type Trace = {
  perAgent: AgentTrace[]
  messageHistory: { round: number; sender: AgentId; message: Message }[]
}

export type RunOptions = {
  kRounds: number
  sampling: 'argmax' | 'stochastic'
  rng?: Rng
}

export function runRounds(
  inputs: HuginnInput[],
  network: TrainableNetwork,
  pastCommitViolations: Map<AgentId, number>,
  opts: RunOptions,
): Trace {
  const numActors = inputs.length
  if (numActors === 0) throw new Error('no inputs')
  const numAgentsInGame = inputs[0].participants.length
  for (let i = 1; i < numActors; i++) {
    if (inputs[i].participants.length !== numAgentsInGame) {
      throw new Error('participants length mismatch across inputs')
    }
  }
  const layout = buildVocabLayout(numAgentsInGame, OFFER_REF_WINDOW)

  const messageHistory: { round: number; sender: AgentId; message: Message }[] = []
  const perAgent: AgentTrace[] = inputs.map((input) => ({
    agent: input.self,
    steps: [],
    messages: [],
    finalVoteIdx: 0,
    finalVoteLogProb: 0,
    finalVoteValue: 0,
  }))

  for (let round = 0; round < opts.kRounds; round++) {
    const roundMessages: Message[] = []
    for (let a = 0; a < numActors; a++) {
      const input = inputs[a]
      const obs: Observation = {
        input,
        roundNumber: round,
        messageHistory: messageHistory,
        pastCommitViolations,
      }
      const { cls, agents, numAgents } = encodeObservation(obs, opts.kRounds)
      const { msgLogits, value } = network.forward(cls, agents, numAgents)
      const recentOfferCount = countRecentOffers(messageHistory, layout.offerRefWindow)
      const mask = buildLegalMask(input, recentOfferCount, layout)
      const masked = applyMask(msgLogits, mask)
      const tokenId = (opts.sampling === 'argmax' || !opts.rng)
        ? sampleArgmax(masked)
        : sampleStochastic(masked, () => opts.rng!.next())
      const lp = logProbOf(masked, tokenId)
      const message = decodeMessage(tokenId, input.participants, layout)
      perAgent[a].steps.push({ round, cls, agents, numAgents, chosenToken: tokenId, logProb: lp, value })
      perAgent[a].messages.push(message)
      roundMessages.push(message)
    }
    for (let a = 0; a < numActors; a++) {
      messageHistory.push({ round, sender: inputs[a].self, message: roundMessages[a] })
    }
  }

  for (let a = 0; a < numActors; a++) {
    const input = inputs[a]
    const obs: Observation = {
      input,
      roundNumber: opts.kRounds,
      messageHistory: messageHistory,
      pastCommitViolations,
    }
    const { cls, agents, numAgents } = encodeObservation(obs, opts.kRounds)
    const { voteLogits, value } = network.forward(cls, agents, numAgents)
    const voteMask = new Uint8Array(numAgents)
    for (let i = 0; i < numAgents; i++) {
      voteMask[i] = input.excluded[i] ? 0 : 1
    }
    const masked = applyMask(voteLogits, voteMask)
    const idx = (opts.sampling === 'argmax' || !opts.rng)
      ? sampleArgmax(masked)
      : sampleStochastic(masked, () => opts.rng!.next())
    perAgent[a].finalVoteIdx = idx
    perAgent[a].finalVoteLogProb = logProbOf(masked, idx)
    perAgent[a].finalVoteValue = value
  }

  return { perAgent, messageHistory }
}

function countRecentOffers(history: { message: Message }[], window: number): number {
  let count = 0
  for (let i = history.length - 1; i >= 0 && count < window; i--) {
    if (history[i].message.type === 'offer') count++
  }
  return count
}

export function detectCommitViolation(trace: AgentTrace, participants: AgentId[]): boolean {
  let lastCommitTarget: AgentId | null = null
  for (const m of trace.messages) {
    if (m.type === 'commit') lastCommitTarget = m.target
  }
  if (lastCommitTarget === null) return false
  return participants[trace.finalVoteIdx] !== lastCommitTarget
}
