/** 診断: untrained vs trained で primary 命中率と mean_R を比較 */

import { Rng } from './rng.ts'
import { TrainableNetwork } from './trainable-network.ts'
import { AbstractGame } from './abstract-env.ts'
import { encodeObservation } from './observation.ts'
import { buildVocabLayout, decodeMessage, buildLegalMask } from './message-vocab.ts'
import { applyMask } from './network.ts'
import { K_ROUNDS, OFFER_REF_WINDOW, type Message, type Observation, type AgentId } from './types.ts'
import { train } from './train.ts'

function argmax(arr: Float32Array): number {
  let best = -Infinity, idx = 0
  for (let i = 0; i < arr.length; i++) if (arr[i] > best) { best = arr[i]; idx = i }
  return idx
}

function runGreedy(
  network: TrainableNetwork,
  numGames: number,
  envRng: Rng,
  envConfig: any,
): { meanReward: number; primaryHitRate: number; voteDistByDesireRank: number[]; numAgents: number } {
  const env = new AbstractGame(envConfig, envRng)
  const layout = buildVocabLayout(envConfig.numAgents, OFFER_REF_WINDOW)
  let totalReward = 0
  let totalAgents = 0
  let primaryHits = 0
  // desire rank 0 = highest desire (= primary), rank 5 = lowest among legal targets
  const voteByRank = new Array<number>(envConfig.numAgents).fill(0)

  for (let g = 0; g < numGames; g++) {
    const inputs = env.reset()
    const N = inputs.length
    const teams = env.getTeams()
    const primaries = env.getPrimaryByTeam()
    const messageHistory: { round: number; sender: AgentId; message: Message }[] = []
    const past = new Map<AgentId, number>()

    for (let r = 0; r < K_ROUNDS; r++) {
      const round: Message[] = []
      for (let a = 0; a < N; a++) {
        const obs: Observation = { input: inputs[a], roundNumber: r, messageHistory, pastCommitViolations: past }
        const enc = encodeObservation(obs, K_ROUNDS)
        const out = network.forward(enc.cls, enc.agents, enc.numAgents)
        const recent = messageHistory.filter(e => e.message.type === 'offer').length
        const mask = buildLegalMask(inputs[a], Math.min(recent, layout.offerRefWindow), layout)
        const masked = applyMask(out.msgLogits, mask)
        round.push(decodeMessage(argmax(masked), inputs[a].participants, layout))
      }
      for (let a = 0; a < N; a++) messageHistory.push({ round: r, sender: inputs[a].self, message: round[a] })
    }

    const finalVotes: number[] = []
    for (let a = 0; a < N; a++) {
      const obs: Observation = { input: inputs[a], roundNumber: K_ROUNDS, messageHistory, pastCommitViolations: past }
      const enc = encodeObservation(obs, K_ROUNDS)
      const out = network.forward(enc.cls, enc.agents, enc.numAgents)
      const voteMask = new Uint8Array(enc.numAgents)
      for (let i = 0; i < enc.numAgents; i++) voteMask[i] = inputs[a].excluded[i] ? 0 : 1
      const masked = applyMask(out.voteLogits, voteMask)
      const idx = argmax(masked)
      finalVotes.push(idx)

      // diagnostic: vote の desire rank
      const ranking = inputs[a].participants
        .map((seat, j) => ({ seat, desire: inputs[a].desire[j], excluded: inputs[a].excluded[j] }))
        .filter(x => !x.excluded)
        .sort((p, q) => q.desire - p.desire)
      const votedSeat = inputs[a].participants[idx]
      const rank = ranking.findIndex(x => x.seat === votedSeat)
      if (rank >= 0) voteByRank[rank]++

      // primary 命中?
      const myPrimary = primaries.get(teams[a])
      if (myPrimary !== undefined && votedSeat === myPrimary) primaryHits++
    }

    // rewards
    const voteCounts = new Array<number>(N).fill(0)
    for (let a = 0; a < N; a++) voteCounts[inputs[a].participants[finalVotes[a]]]++
    let max = -1, top: number[] = []
    for (let i = 0; i < N; i++) {
      if (voteCounts[i] > max) { max = voteCounts[i]; top = [i] }
      else if (voteCounts[i] === max) top.push(i)
    }
    const eliminated = top[Math.floor(env.rng.next() * top.length)]
    for (let a = 0; a < N; a++) {
      totalReward += inputs[a].desire[eliminated]
      totalAgents++
    }
  }

  return {
    meanReward: totalReward / totalAgents,
    primaryHitRate: primaryHits / totalAgents,
    voteDistByDesireRank: voteByRank.map(c => c / totalAgents),
    numAgents: envConfig.numAgents,
  }
}

const envConfig = {
  numAgents: 7,
  teams: [[0, 1, 2], [3, 4], [5, 6]],
  desireCorrelation: 0.7,
  kRounds: K_ROUNDS,
  rewardMode: 'voteDirect' as const,
}

console.log(`# Diagnostic: primary hit rate と vote desire-rank 分布`)
console.log(`# baseline: random uniform vote → primary hit rate = 1/6 = 16.7%`)
console.log(`# baseline: random uniform vote → desire rank 分布 = 各 1/6 ≈ 16.7%`)
console.log(``)

// Untrained
const NET_CONFIG = { dModel: 64, numLayers: 2, numHeads: 4, dFf: 128, vocabSize: buildVocabLayout(7, OFFER_REF_WINDOW).vocabSize }
const untrained = new TrainableNetwork(NET_CONFIG)
const r1 = runGreedy(untrained, 200, new Rng(1), envConfig)
console.log(`## Untrained (random init)`)
console.log(`mean_R = ${r1.meanReward.toFixed(3)}`)
console.log(`primary hit rate = ${(r1.primaryHitRate * 100).toFixed(1)}%`)
console.log(`vote desire rank dist (高い順): ${r1.voteDistByDesireRank.map(p => (p * 100).toFixed(0) + '%').join(' ')}`)
console.log(``)

// Variants
const variants = [
  { label: 'lr=0.005, msgW=1.0 (baseline)', lr: 0.005, msgLossWeight: 1.0 },
  { label: 'lr=0.05, msgW=1.0',             lr: 0.05,  msgLossWeight: 1.0 },
  { label: 'lr=0.005, msgW=0.0 (vote only)', lr: 0.005, msgLossWeight: 0.0 },
  { label: 'lr=0.05,  msgW=0.0 (vote only)', lr: 0.05,  msgLossWeight: 0.0 },
  { label: 'lr=0.5,   msgW=0.0 (vote only)', lr: 0.5,   msgLossWeight: 0.0 },
]

for (const v of variants) {
  const t0 = Date.now()
  const { network: trained } = train({
    iterations: 200,
    gamesPerIter: 32,
    lr: v.lr,
    dModel: 64,
    numLayers: 2,
    numHeads: 4,
    dFf: 128,
    envConfig,
    seed: 42,
    log: () => {},
    msgLossWeight: v.msgLossWeight,
  })
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const r = runGreedy(trained, 200, new Rng(1), envConfig)
  console.log(`## Trained: ${v.label} (${elapsed}s)`)
  console.log(`mean_R = ${r.meanReward.toFixed(3)}, primary hit = ${(r.primaryHitRate * 100).toFixed(1)}%`)
  console.log(`vote rank dist: ${r.voteDistByDesireRank.map(p => (p * 100).toFixed(0) + '%').join(' ')}`)
  console.log(``)
}

// Hand-coded "always vote argmax(desire)" baseline
console.log(`## Hand-coded argmax(desire) baseline`)
let argmaxR = 0, argmaxAgents = 0, argmaxHits = 0
const argmaxRng = new Rng(1)
const argmaxEnv = new AbstractGame(envConfig, argmaxRng)
for (let g = 0; g < 200; g++) {
  const inputs = argmaxEnv.reset()
  const teams = argmaxEnv.getTeams()
  const primaries = argmaxEnv.getPrimaryByTeam()
  const votes = inputs.map(input => {
    let best = -Infinity, idx = 0
    for (let i = 0; i < input.desire.length; i++) {
      if (!input.excluded[i] && input.desire[i] > best) { best = input.desire[i]; idx = i }
    }
    return idx
  })
  const N = inputs.length
  const counts = new Array<number>(N).fill(0)
  for (let a = 0; a < N; a++) counts[inputs[a].participants[votes[a]]]++
  let max = -1, top: number[] = []
  for (let i = 0; i < N; i++) {
    if (counts[i] > max) { max = counts[i]; top = [i] }
    else if (counts[i] === max) top.push(i)
  }
  const elim = top[Math.floor(argmaxEnv.rng.next() * top.length)]
  for (let a = 0; a < N; a++) {
    argmaxR += inputs[a].desire[elim]
    argmaxAgents++
    const myPrimary = primaries.get(teams[a])
    if (myPrimary !== undefined && inputs[a].participants[votes[a]] === myPrimary) argmaxHits++
  }
}
console.log(`mean_R = ${(argmaxR / argmaxAgents).toFixed(3)}`)
console.log(`primary hit rate = ${(argmaxHits / argmaxAgents * 100).toFixed(1)}%`)
