/**
 * Bot 位置可変シナリオ:
 *   - 4 学習 + 3 bot 構成は固定だが、毎ゲーム seat をシャッフル
 *   - bot は最若 learner seat を fixedVote
 *   - 「最若 bot に投票」みたいな絶対位置ベースの convention は通用しない
 *     → 真の「観測ベースの coordination strategy」が必要
 *
 * 4 バリアント比較:
 *   1. random pos, msgW=1, no consensus bonus
 *   2. random pos, msgW=1, consensus bonus 0.5
 *   3. random pos, msgW=0, consensus bonus 0.5  ← メッセージなしでの合意能力
 *   4. random pos, msgW=1, consensus bonus 0.5, longer (1000 iter)
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
  const msgTypeCounts: Record<string, number> = { silent: 0, propose: 0, offer: 0, accept: 0, reject: 0, commit: 0 }
  let totalMsgs = 0
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
    const lowestLearner = learnerSeats[0]   // = bot's fixedVote target

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
        round.push(m); msgTypeCounts[m.type]++; totalMsgs++
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
    msgFractions: Object.fromEntries(Object.entries(msgTypeCounts).map(([k, v]) => [k, v / totalMsgs])),
  }
}

console.log(`# Bot 位置可変シナリオ`)
console.log(`# 学習 4 + bot 3、毎ゲーム seat 順序ランダム化`)
console.log(`# bot は最若 learner seat に fixedVote、SILENT`)
console.log(``)

const layout = buildVocabLayout(7, OFFER_REF_WINDOW)
console.log(`vocab size = ${layout.vocabSize}`)
console.log(``)

// Untrained baseline
const untrained = new TrainableNetwork({
  dModel: 32, numLayers: 1, numHeads: 2, dFf: 64, vocabSize: layout.vocabSize,
})
const r0 = evalGreedy(untrained, 200, new AbstractGame(envConfig, new Rng(1)))
console.log(`## Untrained eval`)
console.log(`「生存対象」生存率 = ${(r0.aSurvivalRate * 100).toFixed(1)}%, learner mean_R = ${r0.learnerMeanReward.toFixed(3)}`)
console.log(`合意 (3+) = ${(r0.consensusRate * 100).toFixed(1)}%, 完全合意 (4/4) = ${(r0.strictConsensusRate * 100).toFixed(1)}%`)
console.log(``)

const variants = [
  { label: 'msgW=1, bonus=0', iter: 500, msgW: 1.0, bonus: 0 },
  { label: 'msgW=1, bonus=0.5', iter: 500, msgW: 1.0, bonus: 0.5 },
  { label: 'msgW=0, bonus=0.5 (msg なし)', iter: 500, msgW: 0.0, bonus: 0.5 },
  { label: 'msgW=1, bonus=0.5, 1000 iter', iter: 1000, msgW: 1.0, bonus: 0.5 },
]

for (const v of variants) {
  console.log(`## Training: ${v.label}`)
  const tStart = Date.now()
  const cfg = { ...envConfig, consensusBonus: v.bonus }
  const { network: trained } = train({
    iterations: v.iter,
    gamesPerIter: 8,
    lr: 0.05,
    dModel: 32, numLayers: 1, numHeads: 2, dFf: 64,
    envConfig: cfg,
    seed: 42,
    log: (s: string) => {
      const m = s.match(/^iter\s+(\d+)/)
      if (m && parseInt(m[1]) % 200 === 0) {
        const el = ((Date.now() - tStart) / 1000).toFixed(1)
        console.log(`  [${el}s] ${s}`)
      }
    },
    msgLossWeight: v.msgW,
    greedyEvalEvery: 0,
  })
  const trainEl = ((Date.now() - tStart) / 1000).toFixed(1)
  console.log(`  done in ${trainEl}s`)

  const r = evalGreedy(trained, 200, new AbstractGame({ ...envConfig, consensusBonus: 0 }, new Rng(1)))
  console.log(`  生存率 = ${(r.aSurvivalRate * 100).toFixed(1)}%, learner mean_R = ${r.learnerMeanReward.toFixed(3)}`)
  console.log(`  primary 命中 = ${(r.primaryHitRate * 100).toFixed(1)}%, bot 投票率 = ${(r.botVoteRate * 100).toFixed(1)}%`)
  console.log(`  合意 (3+) = ${(r.consensusRate * 100).toFixed(1)}%, 完全合意 (4/4) = ${(r.strictConsensusRate * 100).toFixed(1)}%`)
  console.log(`  msgs: silent=${(r.msgFractions.silent * 100).toFixed(0)}% propose=${(r.msgFractions.propose * 100).toFixed(0)}% offer=${(r.msgFractions.offer * 100).toFixed(0)}% commit=${(r.msgFractions.commit * 100).toFixed(0)}%`)
  console.log(``)
}
