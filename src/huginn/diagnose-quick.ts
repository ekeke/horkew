/** Quick diagnostic: 1 variant, 50 iter, log every 10 */

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

function runGreedy(network: TrainableNetwork, numGames: number, envRng: Rng, envConfig: any) {
  const env = new AbstractGame(envConfig, envRng)
  const layout = buildVocabLayout(envConfig.numAgents, OFFER_REF_WINDOW)
  let totalReward = 0
  let totalAgents = 0
  let primaryHits = 0
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
      const ranking = inputs[a].participants
        .map((seat, j) => ({ seat, desire: inputs[a].desire[j], excluded: inputs[a].excluded[j] }))
        .filter(x => !x.excluded)
        .sort((p, q) => q.desire - p.desire)
      const votedSeat = inputs[a].participants[idx]
      const rank = ranking.findIndex(x => x.seat === votedSeat)
      if (rank >= 0) voteByRank[rank]++
      const myPrimary = primaries.get(teams[a])
      if (myPrimary !== undefined && votedSeat === myPrimary) primaryHits++
    }

    const counts = new Array<number>(N).fill(0)
    for (let a = 0; a < N; a++) counts[inputs[a].participants[finalVotes[a]]]++
    let max = -1, top: number[] = []
    for (let i = 0; i < N; i++) {
      if (counts[i] > max) { max = counts[i]; top = [i] }
      else if (counts[i] === max) top.push(i)
    }
    const elim = top[Math.floor(env.rng.next() * top.length)]
    for (let a = 0; a < N; a++) {
      totalReward += inputs[a].desire[elim]
      totalAgents++
    }
  }

  return {
    meanReward: totalReward / totalAgents,
    primaryHitRate: primaryHits / totalAgents,
    voteDistByDesireRank: voteByRank.map(c => c / totalAgents),
  }
}

const envConfig = {
  numAgents: 7,
  teams: [[0, 1, 2], [3, 4], [5, 6]],
  desireCorrelation: 0.7,
  kRounds: K_ROUNDS,
  rewardMode: 'voteDirect' as const,
}

console.log(`# Quick diagnose: Transformer trainable network (vote-only, lr=0.05)`)
console.log(`# baseline: random vote → primary hit rate ≈ 16.7%, mean_R ≈ 0.45-0.47`)
console.log(``)

const t0 = Date.now()

const { network: trained } = train({
  iterations: 50,
  gamesPerIter: 8,
  lr: 0.05,
  dModel: 32,
  numLayers: 1,
  numHeads: 2,
  dFf: 64,
  envConfig,
  seed: 42,
  log: (s: string) => {
    // log every 5 iter
    const m = s.match(/^iter\s+(\d+)/)
    if (m && (parseInt(m[1]) % 5 === 0 || parseInt(m[1]) === 1)) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`[${elapsed}s] ${s}`)
    }
  },
  msgLossWeight: 0.0,
  greedyEvalEvery: 25,
  greedyEvalGames: 50,
})

const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log(``)
console.log(`# training done in ${elapsed}s`)

const r = runGreedy(trained, 200, new Rng(1), envConfig)
console.log(``)
console.log(`## Final greedy eval (200 games)`)
console.log(`mean_R = ${r.meanReward.toFixed(3)}`)
console.log(`primary hit rate = ${(r.primaryHitRate * 100).toFixed(1)}%`)
console.log(`vote rank dist (高い順): ${r.voteDistByDesireRank.map(p => (p * 100).toFixed(0) + '%').join(' ')}`)
