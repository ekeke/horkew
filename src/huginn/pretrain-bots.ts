/**
 * Supervised pretrain: 「最若 seat の bot に投票」を CE loss で植え付ける.
 *
 * 目的:
 *   - ランダム位置設定でも、ABCD は全員「最若 bot」に集票することで A を守れる
 *   - REINFORCE では局所最適 (各自 primary 投票) に落ちて見つけられない
 *   - Supervised で植え付けて、アーキテクチャがこの policy を表現できるか検証
 */

import { Rng } from './rng.ts'
import { TrainableNetwork } from './trainable-network.ts'
import { AbstractGame, type EnvConfig, type AgentRole } from './abstract-env.ts'
import { encodeObservation } from './observation.ts'
import { applyMask } from './network.ts'
import { buildVocabLayout, decodeMessage, buildLegalMask } from './message-vocab.ts'
import { K_ROUNDS, OFFER_REF_WINDOW, type Message, type Observation, type AgentId } from './types.ts'
import { softmax } from '../fenrir/src/ml/nn.ts'

const VOTE_TARGET_THRESHOLD = 0.3   // この値以上の desire を持つ seat = bot

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

function targetVoteIdx(input: { desire: Float64Array; excluded: boolean[] }): number {
  for (let i = 0; i < input.desire.length; i++) {
    if (input.excluded[i]) continue
    if (input.desire[i] >= VOTE_TARGET_THRESHOLD) return i
  }
  return -1
}

function pretrainStep(
  network: TrainableNetwork,
  env: AbstractGame,
): { lossSum: number; correct: number; count: number } {
  const inputs = env.reset()
  const N = inputs.length
  let lossSum = 0
  let correct = 0
  let count = 0

  // 投票ステップだけを学習: 空メッセージ履歴で K_ROUNDS 時点の obs を使う
  const messageHistory: { round: number; sender: AgentId; message: Message }[] = []
  const past = new Map<AgentId, number>()

  for (let a = 0; a < N; a++) {
    if (!env.isLearning(a)) continue
    const obs: Observation = {
      input: inputs[a],
      roundNumber: K_ROUNDS,
      messageHistory,
      pastCommitViolations: past,
    }
    const enc = encodeObservation(obs, K_ROUNDS)
    const out = network.forward(enc.cls, enc.agents, enc.numAgents)
    const target = targetVoteIdx(inputs[a])
    if (target < 0) continue

    const voteMask = new Uint8Array(enc.numAgents)
    for (let i = 0; i < enc.numAgents; i++) voteMask[i] = inputs[a].excluded[i] ? 0 : 1
    const masked = applyMask(out.voteLogits, voteMask)
    const probs = softmax(masked)

    // CE loss & gradient
    const voteGrad = new Float32Array(enc.numAgents)
    for (let i = 0; i < enc.numAgents; i++) {
      voteGrad[i] = probs[i] - (i === target ? 1 : 0)
    }
    let argmaxIdx = 0
    let argmaxVal = -Infinity
    for (let i = 0; i < probs.length; i++) if (probs[i] > argmaxVal) { argmaxVal = probs[i]; argmaxIdx = i }
    if (argmaxIdx === target) correct++
    lossSum += -Math.log(Math.max(probs[target], 1e-10))
    count++

    // backward: vote のみ、msg/value はゼロ
    const dummyMsg = new Float32Array(network.config.vocabSize)
    network.backward(out.cache, dummyMsg, voteGrad, 0)
  }
  return { lossSum, correct, count }
}

function evalGreedy(network: TrainableNetwork, env: AbstractGame, numGames: number) {
  const layout = buildVocabLayout(envConfig.numAgents, OFFER_REF_WINDOW)
  let aSurv = 0, learnerR = 0, learnerCnt = 0
  let strict = 0, three = 0
  for (let g = 0; g < numGames; g++) {
    const inputs = env.reset()
    const N = inputs.length
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
        let aIdx = 0, aVal = -Infinity
        for (let i = 0; i < masked.length; i++) if (masked[i] > aVal) { aVal = masked[i]; aIdx = i }
        round.push(decodeMessage(aIdx, inputs[a].participants, layout))
      }
      for (let a = 0; a < N; a++) messageHistory.push({ round: r, sender: inputs[a].self, message: round[a] })
    }
    const finalVotes: number[] = []
    for (let a = 0; a < N; a++) {
      if (!env.isLearning(a)) { finalVotes.push(lowestLearner); continue }
      const obs: Observation = { input: inputs[a], roundNumber: K_ROUNDS, messageHistory, pastCommitViolations: past }
      const enc = encodeObservation(obs, K_ROUNDS)
      const out = network.forward(enc.cls, enc.agents, enc.numAgents)
      const voteMask = new Uint8Array(enc.numAgents)
      for (let i = 0; i < enc.numAgents; i++) voteMask[i] = inputs[a].excluded[i] ? 0 : 1
      const masked = applyMask(out.voteLogits, voteMask)
      let aIdx = 0, aVal = -Infinity
      for (let i = 0; i < masked.length; i++) if (masked[i] > aVal) { aVal = masked[i]; aIdx = i }
      finalVotes.push(inputs[a].participants[aIdx])
    }
    const counts = new Array<number>(N).fill(0)
    for (const s of finalVotes) counts[s]++
    let mx = -1, top: number[] = []
    for (let i = 0; i < N; i++) {
      if (counts[i] > mx) { mx = counts[i]; top = [i] }
      else if (counts[i] === mx) top.push(i)
    }
    const elim = top[Math.floor(env.rng.next() * top.length)]
    if (elim !== lowestLearner) aSurv++
    const lvotes = learnerSeats.map(a => finalVotes[a])
    const cnt: Record<number, number> = {}
    for (const v of lvotes) cnt[v] = (cnt[v] ?? 0) + 1
    const mxL = Math.max(...Object.values(cnt))
    const mxSeat = parseInt(Object.entries(cnt).find(([, c]) => c === mxL)![0])
    if (botSeats.includes(mxSeat) && mxL >= 3) three++
    if (botSeats.includes(mxSeat) && mxL === 4) strict++
    for (const a of learnerSeats) {
      learnerR += inputs[a].desire[elim]
      learnerCnt++
    }
  }
  return {
    aSurv: aSurv / numGames,
    learnerR: learnerR / learnerCnt,
    threeRate: three / numGames,
    strictRate: strict / numGames,
  }
}

console.log(`# Supervised pretrain: 「最若 bot に投票」を CE loss で植え付け`)
console.log(`# 目的: アーキテクチャがこの policy を表現できるか検証`)
console.log(``)

const layout = buildVocabLayout(7, OFFER_REF_WINDOW)
const network = new TrainableNetwork({
  dModel: 32, numLayers: 1, numHeads: 2, dFf: 64, vocabSize: layout.vocabSize,
})

const trainEnv = new AbstractGame(envConfig, new Rng(42))
const evalEnv = () => new AbstractGame(envConfig, new Rng(1))

// Untrained eval
const r0 = evalGreedy(network, evalEnv(), 200)
console.log(`## Untrained`)
console.log(`A 生存率 = ${(r0.aSurv * 100).toFixed(1)}%, mean_R = ${r0.learnerR.toFixed(3)}, 完全合意 4/4 = ${(r0.strictRate * 100).toFixed(1)}%`)
console.log(``)

const lr = 0.01
const gamesPerStep = 16
const totalIters = 200

console.log(`## Pretraining (${totalIters} iter, lr=${lr}, ${gamesPerStep} games/iter)`)
const t0 = Date.now()
for (let iter = 1; iter <= totalIters; iter++) {
  let totalLoss = 0, totalCorrect = 0, totalCount = 0
  for (let g = 0; g < gamesPerStep; g++) {
    const r = pretrainStep(network, trainEnv)
    totalLoss += r.lossSum
    totalCorrect += r.correct
    totalCount += r.count
  }
  network.applyStep(lr, totalCount)

  if (iter % 20 === 0 || iter === 1) {
    const acc = totalCorrect / totalCount
    const loss = totalLoss / totalCount
    const el = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`  [${el}s] iter ${String(iter).padStart(3)}: loss=${loss.toFixed(3)} acc=${(acc * 100).toFixed(1)}%`)
  }
}
console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(``)

const r1 = evalGreedy(network, evalEnv(), 200)
console.log(`## Pretrained eval (200 games)`)
console.log(`A 生存率 = ${(r1.aSurv * 100).toFixed(1)}%, mean_R = ${r1.learnerR.toFixed(3)}`)
console.log(`合意 (3+) = ${(r1.threeRate * 100).toFixed(1)}%, 完全合意 (4/4) = ${(r1.strictRate * 100).toFixed(1)}%`)
