/** Discrete message vocabulary: Message ↔ tokenId */

import type { Message, AgentId, HuginnInput } from './types.ts'
import { PRIORITY_LEVELS, HEAT_LEVELS, HEAT_NAMES } from './types.ts'

export type VocabLayout = {
  numAgents: number
  offerRefWindow: number
  silentBase: number
  proposeBase: number
  offerBase: number
  acceptBase: number
  rejectBase: number
  commitBase: number
  vocabSize: number
}

export function buildVocabLayout(numAgents: number, offerRefWindow: number): VocabLayout {
  const N = numAgents
  const W = offerRefWindow
  const silentBase = 0
  const proposeBase = silentBase + 1
  const offerBase = proposeBase + N * PRIORITY_LEVELS * HEAT_LEVELS
  const acceptBase = offerBase + N * N
  const rejectBase = acceptBase + W
  const commitBase = rejectBase + W
  const vocabSize = commitBase + N
  return {
    numAgents: N,
    offerRefWindow: W,
    silentBase,
    proposeBase,
    offerBase,
    acceptBase,
    rejectBase,
    commitBase,
    vocabSize,
  }
}

function indexOfAgent(agent: AgentId, participants: AgentId[]): number {
  const i = participants.indexOf(agent)
  if (i < 0) throw new Error(`agent ${agent} not in participants`)
  return i
}

export function encodeMessage(msg: Message, participants: AgentId[], layout: VocabLayout): number {
  switch (msg.type) {
    case 'silent':
      return layout.silentBase
    case 'propose': {
      const t = indexOfAgent(msg.target, participants)
      const p = msg.priority - 1
      const h = HEAT_NAMES.indexOf(msg.heat)
      return layout.proposeBase + t * (PRIORITY_LEVELS * HEAT_LEVELS) + p * HEAT_LEVELS + h
    }
    case 'offer': {
      const i = indexOfAgent(msg.iVote, participants)
      const j = indexOfAgent(msg.youVote, participants)
      return layout.offerBase + i * layout.numAgents + j
    }
    case 'accept':
      if (msg.offerRef < 0 || msg.offerRef >= layout.offerRefWindow) {
        throw new Error(`offerRef ${msg.offerRef} out of range`)
      }
      return layout.acceptBase + msg.offerRef
    case 'reject':
      if (msg.offerRef < 0 || msg.offerRef >= layout.offerRefWindow) {
        throw new Error(`offerRef ${msg.offerRef} out of range`)
      }
      return layout.rejectBase + msg.offerRef
    case 'commit':
      return layout.commitBase + indexOfAgent(msg.target, participants)
  }
}

export function decodeMessage(tokenId: number, participants: AgentId[], layout: VocabLayout): Message {
  if (tokenId < 0 || tokenId >= layout.vocabSize) {
    throw new Error(`token ${tokenId} out of vocab (size ${layout.vocabSize})`)
  }
  if (tokenId === layout.silentBase) return { type: 'silent' }
  if (tokenId < layout.offerBase) {
    const off = tokenId - layout.proposeBase
    const stride = PRIORITY_LEVELS * HEAT_LEVELS
    const t = Math.floor(off / stride)
    const r = off % stride
    const p = Math.floor(r / HEAT_LEVELS) + 1
    const h = HEAT_NAMES[r % HEAT_LEVELS]
    return { type: 'propose', target: participants[t], priority: p as 1 | 2 | 3, heat: h }
  }
  if (tokenId < layout.acceptBase) {
    const off = tokenId - layout.offerBase
    const i = Math.floor(off / layout.numAgents)
    const j = off % layout.numAgents
    return { type: 'offer', iVote: participants[i], youVote: participants[j] }
  }
  if (tokenId < layout.rejectBase) {
    return { type: 'accept', offerRef: tokenId - layout.acceptBase }
  }
  if (tokenId < layout.commitBase) {
    return { type: 'reject', offerRef: tokenId - layout.rejectBase }
  }
  return { type: 'commit', target: participants[tokenId - layout.commitBase] }
}

/**
 * 合法トークンマスク。
 * - SILENT: 常に許可
 * - PROPOSE/COMMIT target: excluded でなければ許可
 * - OFFER (iVote, youVote): 両方 excluded でなく、self-OFFER (i===j) でなければ許可
 * - ACCEPT/REJECT: 直近 W 件の OFFER が存在する分だけ許可
 */
export function buildLegalMask(
  input: HuginnInput,
  recentOfferCount: number,
  layout: VocabLayout,
): Uint8Array {
  const N = layout.numAgents
  const mask = new Uint8Array(layout.vocabSize)

  mask[layout.silentBase] = 1

  for (let t = 0; t < N; t++) {
    if (input.excluded[t]) continue
    const base = layout.proposeBase + t * PRIORITY_LEVELS * HEAT_LEVELS
    for (let p = 0; p < PRIORITY_LEVELS; p++) {
      for (let h = 0; h < HEAT_LEVELS; h++) {
        mask[base + p * HEAT_LEVELS + h] = 1
      }
    }
  }

  // offer(iVote=X, youVote=Y): X ≠ Y の制約を撤廃して X===Y (全員で X に合意しよう broadcast) も合法化.
  // excluded[self] は既に除外されるので self-offer の禁止は維持される.
  for (let i = 0; i < N; i++) {
    if (input.excluded[i]) continue
    for (let j = 0; j < N; j++) {
      if (input.excluded[j]) continue
      mask[layout.offerBase + i * N + j] = 1
    }
  }

  const numOffers = Math.min(recentOfferCount, layout.offerRefWindow)
  for (let r = 0; r < numOffers; r++) {
    mask[layout.acceptBase + r] = 1
    mask[layout.rejectBase + r] = 1
  }

  for (let t = 0; t < N; t++) {
    if (!input.excluded[t]) mask[layout.commitBase + t] = 1
  }

  return mask
}
