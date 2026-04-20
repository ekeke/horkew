/**
 * Observation encoding: Observation → Float32Array (CLS + per-agent tokens).
 * collect/pack 分離 (中間型 ObservationIntermediate が仕様書).
 */

import type { Observation } from './types.ts'
import { MAX_AGENTS } from './types.ts'

// CLS feature dims:
//   0: roundNumber / kRounds
//   1: numAgents / MAX_AGENTS
//   2: top1 desire (non-excluded)
//   3: top2 desire
//   4: top3 desire
//   5: mean desire
//   6: top1 - top2 gap
//   7: reserved
export const CLS_FEATURE_DIMS = 8

// Per-agent feature dims:
//   0: desire[i]
//   1: excluded[i]
//   2: isSelf
//   3: alive (1 if i < numAgents)
//   4: pastCommitViolations (clipped/normalized)
//   5: didIProposeThis (this game so far)
//   6: commitsAgainstThis (count, normalized)
//   7: proposesAgainstThis (count, normalized)
//   8: position index / MAX_AGENTS (絶対位置情報)
//   9: offersIVoteCount   — このゲームで「i に "I vote" で投じる」と宣言された offer の count / 10
//  10: offersYouVoteCount — このゲームで「i に "You vote" と要請する」offer の count / 10
//                           unanimous offer(X,X) は両方に加算. split offer(X,Y) は別々の seat に加算.
export const AGENT_FEATURE_DIMS = 11

export type ObservationIntermediate = {
  cls: Float32Array
  agents: Float32Array  // [MAX_AGENTS * AGENT_FEATURE_DIMS]
  numAgents: number
}

export function collectObservation(obs: Observation, kRounds: number): ObservationIntermediate {
  const input = obs.input
  const N = input.participants.length

  const agents = new Float32Array(MAX_AGENTS * AGENT_FEATURE_DIMS)
  for (let i = 0; i < N; i++) {
    const off = i * AGENT_FEATURE_DIMS
    agents[off + 0] = input.desire[i]
    agents[off + 1] = input.excluded[i] ? 1 : 0
    agents[off + 2] = input.participants[i] === input.self ? 1 : 0
    agents[off + 3] = 1
    const violations = obs.pastCommitViolations.get(input.participants[i]) ?? 0
    agents[off + 4] = Math.min(violations, 5) / 5
    agents[off + 8] = i / MAX_AGENTS
  }

  for (const entry of obs.messageHistory) {
    const m = entry.message
    if (m.type === 'propose') {
      const tIdx = input.participants.indexOf(m.target)
      if (tIdx >= 0) {
        if (entry.sender === input.self) {
          agents[tIdx * AGENT_FEATURE_DIMS + 5] = 1
        }
        agents[tIdx * AGENT_FEATURE_DIMS + 7] += 1
      }
    } else if (m.type === 'commit') {
      const tIdx = input.participants.indexOf(m.target)
      if (tIdx >= 0) {
        agents[tIdx * AGENT_FEATURE_DIMS + 6] += 1
      }
    } else if (m.type === 'offer') {
      const iIdx = input.participants.indexOf(m.iVote)
      const yIdx = input.participants.indexOf(m.youVote)
      if (iIdx >= 0) agents[iIdx * AGENT_FEATURE_DIMS + 9] += 1
      if (yIdx >= 0) agents[yIdx * AGENT_FEATURE_DIMS + 10] += 1
    }
  }

  for (let i = 0; i < N; i++) {
    const off = i * AGENT_FEATURE_DIMS
    agents[off + 6] = Math.min(agents[off + 6], 10) / 10
    agents[off + 7] = Math.min(agents[off + 7], 10) / 10
    agents[off + 9] = Math.min(agents[off + 9], 10) / 10
    agents[off + 10] = Math.min(agents[off + 10], 10) / 10
  }

  const cls = new Float32Array(CLS_FEATURE_DIMS)
  cls[0] = obs.roundNumber / kRounds
  cls[1] = N / MAX_AGENTS
  const sorted: number[] = []
  for (let i = 0; i < N; i++) {
    if (!input.excluded[i]) sorted.push(input.desire[i])
  }
  sorted.sort((a, b) => b - a)
  cls[2] = sorted[0] ?? 0
  cls[3] = sorted[1] ?? 0
  cls[4] = sorted[2] ?? 0
  cls[5] = sorted.length > 0 ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0
  cls[6] = (sorted[0] ?? 0) - (sorted[1] ?? 0)
  cls[7] = 0

  return { cls, agents, numAgents: N }
}

export function packObservation(mid: ObservationIntermediate): ObservationIntermediate {
  return mid
}

export function encodeObservation(obs: Observation, kRounds: number): ObservationIntermediate {
  return packObservation(collectObservation(obs, kRounds))
}
