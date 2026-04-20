/**
 * Bot なし symmetric self-play シナリオ:
 *   - 7 agents 全員 learning
 *   - 各 agent が独立チーム = 1人1チーム (teams=[[0],[1],...,[6]])
 *   - 各自の primary は他 6 人からランダム選出
 *   - desire: self=0, primary=HIGH(0.95), others=MID(0.55) + noise
 *
 * 狙い: 不可避負け局面が対称化され、学習シグナルが綺麗になる。
 * 期待値: random baseline で mean_R ≈ MID (各 agent の視点でランダムに吊られるので)、
 *        完璧 primary 吊りで mean_R ≈ HIGH だが全員が primary 吊り成功は不可能
 *        (1 人だけが primary を吊れる = 他 6 人のうち 1 人だけが「自分のターゲットが吊られた」)
 *
 * 比較 variants:
 *   1. SGD baseline
 *   2. Adam baseline
 *   3. Adam + C-noNorm vw=3
 */

import { Rng } from './rng.ts'
import { TrainableNetwork } from './trainable-network.ts'
import { AbstractGame, type EnvConfig } from './abstract-env.ts'
import { encodeObservation } from './observation.ts'
import { buildVocabLayout, decodeMessage, buildLegalMask } from './message-vocab.ts'
import { applyMask } from './network.ts'
import { K_ROUNDS, OFFER_REF_WINDOW, type Message, type Observation, type AgentId } from './types.ts'
import { train } from './train.ts'

const envConfig: EnvConfig = {
  numAgents: 7,
  // agentRoles 未指定 → 全員 learning
  primaryFromBots: false,
  teams: [[0], [1], [2], [3], [4], [5], [6]],   // 1 人 1 チーム
  desireCorrelation: 0.7,
  kRounds: K_ROUNDS,
  rewardMode: 'eliminated',
  consensusBonus: 0,
}

function argmax(arr: Float32Array): number {
  let best = -Infinity, idx = 0
  for (let i = 0; i < arr.length; i++) if (arr[i] > best) { best = arr[i]; idx = i }
  return idx
}

function evalGreedy(network: TrainableNetwork, numGames: number, env: AbstractGame) {
  const layout = buildVocabLayout(envConfig.numAgents, OFFER_REF_WINDOW)
  let totalReward = 0, rewardCount = 0
  let primaryHits = 0            // 自分の primary が eliminate された回数
  let ownPrimaryVotes = 0        // 自分の primary に投票した回数

  for (let g = 0; g < numGames; g++) {
    const inputs = env.reset()
    const N = inputs.length
    const primaries = env.getPrimaryByAgent()

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
        const m = decodeMessage(argmax(masked), inputs[a].participants, layout)
        round.push(m)
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
      const seat = inputs[a].participants[idx]
      finalVotes.push(seat)
      const myPrimary = primaries.get(a)
      if (myPrimary !== undefined && seat === myPrimary) ownPrimaryVotes++
    }

    const counts = new Array<number>(N).fill(0)
    for (const seat of finalVotes) counts[seat]++
    let max = -1, top: number[] = []
    for (let i = 0; i < N; i++) {
      if (counts[i] > max) { max = counts[i]; top = [i] }
      else if (counts[i] === max) top.push(i)
    }
    const elim = top[Math.floor(env.rng.next() * top.length)]

    for (let a = 0; a < N; a++) {
      totalReward += inputs[a].desire[elim]
      rewardCount++
      const myPrimary = primaries.get(a)
      if (myPrimary !== undefined && elim === myPrimary) primaryHits++
    }
  }

  return {
    meanReward: totalReward / rewardCount,
    ownPrimaryHitRate: primaryHits / rewardCount,
    ownPrimaryVoteRate: ownPrimaryVotes / rewardCount,
  }
}

console.log(`# Bot なし symmetric self-play`)
console.log(`# 7 agent × 1 人 1 チーム、全員 learning、consensusBonus=0`)
console.log(``)

const layout = buildVocabLayout(7, OFFER_REF_WINDOW)

// Untrained baseline
const untrained = new TrainableNetwork({
  dModel: 32, numLayers: 1, numHeads: 2, dFf: 64, vocabSize: layout.vocabSize,
})
const r0 = evalGreedy(untrained, 200, new AbstractGame(envConfig, new Rng(1)))
console.log(`## Untrained (random) eval`)
console.log(`  mean_R = ${r0.meanReward.toFixed(3)} (期待 ≈ 0.55 で MID 付近)`)
console.log(`  自分の primary が吊られた率 = ${(r0.ownPrimaryHitRate * 100).toFixed(1)}%`)
console.log(`  自分の primary に投票した率 = ${(r0.ownPrimaryVoteRate * 100).toFixed(1)}%`)
console.log(``)

type Variant = {
  label: string
  iter: number
  lr: number
  optimizer: 'sgd' | 'adam'
  normalizeAdvantage: boolean
  valueLossWeight: number
}

const variants: Variant[] = [
  { label: 'sgd baseline (norm on, vw=1)',      iter: 500, lr: 0.05,  optimizer: 'sgd',  normalizeAdvantage: true,  valueLossWeight: 1 },
  { label: 'adam baseline (norm on, vw=1)',     iter: 500, lr: 0.001, optimizer: 'adam', normalizeAdvantage: true,  valueLossWeight: 1 },
  { label: 'adam C-noNorm vw=3',                iter: 500, lr: 0.001, optimizer: 'adam', normalizeAdvantage: false, valueLossWeight: 3 },
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
    msgLossWeight: 1.0,
    normalizeAdvantage: v.normalizeAdvantage,
    valueLossWeight: v.valueLossWeight,
    optimizer: v.optimizer,
    greedyEvalEvery: 0,
  })
  const trainEl = ((Date.now() - tStart) / 1000).toFixed(1)
  console.log(`  done in ${trainEl}s`)

  const r = evalGreedy(trained, 200, new AbstractGame(envConfig, new Rng(1)))
  console.log(`  mean_R = ${r.meanReward.toFixed(3)}`)
  console.log(`  自分の primary が吊られた率 = ${(r.ownPrimaryHitRate * 100).toFixed(1)}%`)
  console.log(`  自分の primary に投票した率 = ${(r.ownPrimaryVoteRate * 100).toFixed(1)}%`)
  console.log(``)
}
