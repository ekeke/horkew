/**
 * C 案 (結果条件付け baseline) 検証:
 *   「多数決で勝てない局面は学習シグナル的にノイズ」問題への対処として、
 *   advantage normalization を外し、value head をより強く学習させる。
 *
 * 仮説:
 *   value head が「この局面の期待勝率」を学べれば、不可避負け局面では
 *   value ≈ low_return で advantage ≈ 0 となり、罰が消える。
 *
 * 比較:
 *   baseline  : 現状 (normalizeAdvantage=true, valueLossWeight=1)
 *   C-noNorm  : normalizeAdvantage=false, valueLossWeight=1
 *   C-vw3     : normalizeAdvantage=false, valueLossWeight=3
 *   C-msgOff  : normalizeAdvantage=false, valueLossWeight=3, msgW=0 (通信なし比較)
 *
 * 評価:
 *   Lv 3 シナリオ (学習 4 + bot 3, 位置ランダム) で
 *   生存率 / 合意率 / primary 命中 / 初期 value spread を計測
 */

import { Rng } from './rng.ts'
import { TrainableNetwork } from './trainable-network.ts'
import { AbstractGame, type EnvConfig, type AgentRole } from './abstract-env.ts'
import { encodeObservation } from './observation.ts'
import { buildVocabLayout, decodeMessage, buildLegalMask } from './message-vocab.ts'
import { applyMask } from './network.ts'
import { K_ROUNDS, OFFER_REF_WINDOW, type Message, type Observation, type AgentId } from './types.ts'
import { train } from './train.ts'

const baseAgentRoles: AgentRole[] = [
  'learning', 'learning', 'learning', 'learning',
  { type: 'fixedVote', target: 0 },
  { type: 'fixedVote', target: 0 },
  { type: 'fixedVote', target: 0 },
]

const envConfig: EnvConfig = {
  numAgents: 7,
  agentRoles: baseAgentRoles,
  primaryFromBots: true,
  randomizeRolesPerGame: true,
  desireCorrelation: 0.7,
  kRounds: K_ROUNDS,
  rewardMode: 'eliminated',
  consensusBonus: 0.5,
}

function argmax(arr: Float32Array): number {
  let best = -Infinity, idx = 0
  for (let i = 0; i < arr.length; i++) if (arr[i] > best) { best = arr[i]; idx = i }
  return idx
}

function evalGreedy(network: TrainableNetwork, numGames: number, env: AbstractGame) {
  const layout = buildVocabLayout(envConfig.numAgents, OFFER_REF_WINDOW)
  let aSurvival = 0, learnerReward = 0, learnerCount = 0
  let primaryHits = 0, votedBot = 0
  let consensusGames = 0, strictConsensus = 0

  for (let g = 0; g < numGames; g++) {
    const inputs = env.reset()
    const N = inputs.length
    const primaries = env.getPrimaryByAgent()
    const learnerSeats: AgentId[] = []
    const botSeats: AgentId[] = []
    for (let i = 0; i < N; i++) {
      if (env.isLearning(i)) learnerSeats.push(i)
      else botSeats.push(i)
    }
    const lowestLearner = learnerSeats[0]

    const messageHistory: { round: number; sender: AgentId; message: Message }[] = []
    const past = new Map<AgentId, number>()

    for (let r = 0; r < K_ROUNDS; r++) {
      const round: Message[] = []
      for (let a = 0; a < N; a++) {
        if (!env.isLearning(a)) { round.push({ type: 'silent' }); continue }
        const obs: Observation = { input: inputs[a], roundNumber: r, messageHistory, pastCommitViolations: past }
        const enc = encodeObservation(obs, K_ROUNDS)
        const out = network.forward(enc.cls, enc.agents, enc.numAgents)
        const recent = messageHistory.filter(e => e.message.type === 'offer').length
        const mask = buildLegalMask(inputs[a], Math.min(recent, layout.offerRefWindow), layout)
        const masked = applyMask(out.msgLogits, mask)
        const m = decodeMessage(argmax(masked), inputs[a].participants, layout)
        round.push(m)
      }
      for (let a = 0; a < N; a++) messageHistory.push({ round: r, sender: inputs[a].self, message: round[a] })
    }

    const finalVotes: number[] = []
    for (let a = 0; a < N; a++) {
      if (!env.isLearning(a)) {
        finalVotes.push(lowestLearner)
        continue
      }
      const obs: Observation = { input: inputs[a], roundNumber: K_ROUNDS, messageHistory, pastCommitViolations: past }
      const enc = encodeObservation(obs, K_ROUNDS)
      const out = network.forward(enc.cls, enc.agents, enc.numAgents)
      const voteMask = new Uint8Array(enc.numAgents)
      for (let i = 0; i < enc.numAgents; i++) voteMask[i] = inputs[a].excluded[i] ? 0 : 1
      const masked = applyMask(out.voteLogits, voteMask)
      const idx = argmax(masked)
      const seat = inputs[a].participants[idx]
      finalVotes.push(seat)
      if (botSeats.includes(seat)) votedBot++
      const myPrimary = primaries.get(a)
      if (myPrimary !== undefined && seat === myPrimary) primaryHits++
    }

    const counts = new Array<number>(N).fill(0)
    for (const seat of finalVotes) counts[seat]++
    let max = -1, top: number[] = []
    for (let i = 0; i < N; i++) {
      if (counts[i] > max) { max = counts[i]; top = [i] }
      else if (counts[i] === max) top.push(i)
    }
    const elim = top[Math.floor(env.rng.next() * top.length)]
    if (elim !== lowestLearner) aSurvival++

    const learnerVotesByLearner = learnerSeats.map(a => finalVotes[a])
    const voteCount: Record<number, number> = {}
    for (const v of learnerVotesByLearner) voteCount[v] = (voteCount[v] ?? 0) + 1
    const maxVote = Math.max(...Object.values(voteCount))
    const maxVoteSeat = parseInt(Object.entries(voteCount).find(([, c]) => c === maxVote)![0])
    if (botSeats.includes(maxVoteSeat) && maxVote >= 3) consensusGames++
    if (botSeats.includes(maxVoteSeat) && maxVote === 4) strictConsensus++

    for (const a of learnerSeats) {
      learnerReward += inputs[a].desire[elim]
      learnerCount++
    }
  }

  return {
    aSurvivalRate: aSurvival / numGames,
    learnerMeanReward: learnerReward / learnerCount,
    primaryHitRate: primaryHits / learnerCount,
    botVoteRate: votedBot / learnerCount,
    consensusRate: consensusGames / numGames,
    strictConsensusRate: strictConsensus / numGames,
  }
}

console.log(`# C 案 (結果条件付け baseline) 検証`)
console.log(`# 学習 4 + bot 3、位置ランダム、consensusBonus=0.5`)
console.log(``)

type Variant = {
  label: string
  iter: number
  lr: number
  msgW: number
  normalizeAdvantage: boolean
  valueLossWeight: number
  optimizer: 'sgd' | 'adam'
}

// SGD 0.05 での発散 (vw=2 で NaN) を踏まえ、Adam での安定化を検証。
// Adam lr は SGD の 1/10〜1/50 程度が定石。
const variants: Variant[] = [
  { label: 'sgd baseline (norm on, vw=1)',      iter: 500, lr: 0.05,  msgW: 1.0, normalizeAdvantage: true,  valueLossWeight: 1, optimizer: 'sgd'  },
  { label: 'adam baseline (norm on, vw=1)',     iter: 500, lr: 0.001, msgW: 1.0, normalizeAdvantage: true,  valueLossWeight: 1, optimizer: 'adam' },
  { label: 'adam C-noNorm (norm off, vw=1)',    iter: 500, lr: 0.001, msgW: 1.0, normalizeAdvantage: false, valueLossWeight: 1, optimizer: 'adam' },
  { label: 'adam C-noNorm-vw3 (norm off, vw=3)',iter: 500, lr: 0.001, msgW: 1.0, normalizeAdvantage: false, valueLossWeight: 3, optimizer: 'adam' },
]

for (const v of variants) {
  console.log(`## Training: ${v.label}`)
  const tStart = Date.now()
  const { network: trained } = train({
    iterations: v.iter,
    gamesPerIter: 8,
    lr: v.lr,
    dModel: 32, numLayers: 1, numHeads: 2, dFf: 64,
    envConfig,
    seed: 42,
    log: (s: string) => {
      const m = s.match(/^iter\s+(\d+)/)
      if (m && parseInt(m[1]) % 100 === 0) {
        const el = ((Date.now() - tStart) / 1000).toFixed(1)
        console.log(`  [${el}s] ${s}`)
      }
    },
    msgLossWeight: v.msgW,
    normalizeAdvantage: v.normalizeAdvantage,
    valueLossWeight: v.valueLossWeight,
    optimizer: v.optimizer,
    greedyEvalEvery: 0,
  })
  const trainEl = ((Date.now() - tStart) / 1000).toFixed(1)
  console.log(`  done in ${trainEl}s`)

  const r = evalGreedy(trained, 200, new AbstractGame({ ...envConfig, consensusBonus: 0 }, new Rng(1)))
  console.log(`  生存率 = ${(r.aSurvivalRate * 100).toFixed(1)}%, learner mean_R = ${r.learnerMeanReward.toFixed(3)}`)
  console.log(`  primary 命中 = ${(r.primaryHitRate * 100).toFixed(1)}%, bot 投票率 = ${(r.botVoteRate * 100).toFixed(1)}%`)
  console.log(`  合意 (3+) = ${(r.consensusRate * 100).toFixed(1)}%, 完全合意 (4/4) = ${(r.strictConsensusRate * 100).toFixed(1)}%`)
  console.log(``)
}
