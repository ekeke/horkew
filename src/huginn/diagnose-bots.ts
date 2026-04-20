/**
 * Bot 混在シナリオの学習診断:
 *   - 学習 4 (A=0, B=1, C=2, D=3)
 *   - bot 3 (E=4, F=5, G=6) — 全員 finalVote=A 固定、SILENT
 *   - ABCD の primary は E/F/G からランダム独立に選出
 *   - 報酬モード: eliminated (A が吊られると ABCD は teammate=LOW reward)
 *
 * 期待される学習:
 *   1. 自分の primary に投票するより、ABCD で合意した1人 (E/F/G のどれか) に集中する方が良い
 *   2. メッセージ (PROPOSE/COMMIT) で誰に集まるかを表明し合う
 *   3. A 生存率 (= bot に勝つ率) が上がる
 */

import { Rng } from './rng.ts'
import { TrainableNetwork } from './trainable-network.ts'
import { AbstractGame, type EnvConfig, type AgentRole } from './abstract-env.ts'
import { encodeObservation } from './observation.ts'
import { buildVocabLayout, decodeMessage, buildLegalMask } from './message-vocab.ts'
import { applyMask } from './network.ts'
import { K_ROUNDS, OFFER_REF_WINDOW, type Message, type Observation, type AgentId } from './types.ts'
import { train } from './train.ts'

const A = 0, B = 1, C = 2, D = 3, E = 4, F = 5, G = 6
const LEARNERS = [A, B, C, D]
const BOTS = [E, F, G]

const agentRoles: AgentRole[] = [
  'learning', 'learning', 'learning', 'learning',
  { type: 'fixedVote', target: A },
  { type: 'fixedVote', target: A },
  { type: 'fixedVote', target: A },
]

const envConfig: EnvConfig = {
  numAgents: 7,
  agentRoles,
  primaryFromBots: true,
  desireCorrelation: 0.7,
  kRounds: K_ROUNDS,
  rewardMode: 'eliminated',
}

function argmax(arr: Float32Array): number {
  let best = -Infinity, idx = 0
  for (let i = 0; i < arr.length; i++) if (arr[i] > best) { best = arr[i]; idx = i }
  return idx
}

function evalGreedy(network: TrainableNetwork, numGames: number, envRng: Rng) {
  const env = new AbstractGame(envConfig, envRng)
  const layout = buildVocabLayout(envConfig.numAgents, OFFER_REF_WINDOW)
  let aSurvival = 0, learnerReward = 0, learnerCount = 0
  let primaryHits = 0, votedBot = 0
  const eliminatedDist: Record<number, number> = {}
  const msgTypeCounts: Record<string, number> = { silent: 0, propose: 0, offer: 0, accept: 0, reject: 0, commit: 0 }
  let totalMsgs = 0
  // 集約: ABCD の vote が同じ bot に集中したか (合意度)
  let consensusGames = 0  // ABCD の最頻投票先が bot で 4/4 か 3/4 のとき consensus
  let strictConsensus = 0  // 4/4

  for (let g = 0; g < numGames; g++) {
    const inputs = env.reset()
    const N = inputs.length
    const primaries = env.getPrimaryByAgent()
    const messageHistory: { round: number; sender: AgentId; message: Message }[] = []
    const past = new Map<AgentId, number>()

    for (let r = 0; r < K_ROUNDS; r++) {
      const round: Message[] = []
      for (let a = 0; a < N; a++) {
        if (!env.isLearning(a)) {
          round.push({ type: 'silent' })
          continue
        }
        const obs: Observation = { input: inputs[a], roundNumber: r, messageHistory, pastCommitViolations: past }
        const enc = encodeObservation(obs, K_ROUNDS)
        const out = network.forward(enc.cls, enc.agents, enc.numAgents)
        const recent = messageHistory.filter(e => e.message.type === 'offer').length
        const mask = buildLegalMask(inputs[a], Math.min(recent, layout.offerRefWindow), layout)
        const masked = applyMask(out.msgLogits, mask)
        const m = decodeMessage(argmax(masked), inputs[a].participants, layout)
        round.push(m)
        msgTypeCounts[m.type]++
        totalMsgs++
      }
      for (let a = 0; a < N; a++) messageHistory.push({ round: r, sender: inputs[a].self, message: round[a] })
    }

    const finalVotes: number[] = []
    for (let a = 0; a < N; a++) {
      if (!env.isLearning(a)) {
        finalVotes.push(A)
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
      if (BOTS.includes(seat)) votedBot++
      const myPrimary = primaries.get(a)
      if (myPrimary !== undefined && seat === myPrimary) primaryHits++
    }

    // 集計
    const counts = new Array<number>(N).fill(0)
    for (const seat of finalVotes) counts[seat]++
    let max = -1, top: number[] = []
    for (let i = 0; i < N; i++) {
      if (counts[i] > max) { max = counts[i]; top = [i] }
      else if (counts[i] === max) top.push(i)
    }
    const elim = top[Math.floor(env.rng.next() * top.length)]
    eliminatedDist[elim] = (eliminatedDist[elim] ?? 0) + 1
    if (elim !== A) aSurvival++

    // ABCD の投票一致度
    const learnerVotes = LEARNERS.map(a => finalVotes[a])
    const voteCount: Record<number, number> = {}
    for (const v of learnerVotes) voteCount[v] = (voteCount[v] ?? 0) + 1
    const maxVote = Math.max(...Object.values(voteCount))
    const maxVoteSeat = parseInt(Object.entries(voteCount).find(([, c]) => c === maxVote)![0])
    if (BOTS.includes(maxVoteSeat) && maxVote >= 3) consensusGames++
    if (BOTS.includes(maxVoteSeat) && maxVote === 4) strictConsensus++

    for (const a of LEARNERS) {
      learnerReward += inputs[a].desire[elim]
      learnerCount++
    }
  }

  return {
    aSurvivalRate: aSurvival / numGames,
    learnerMeanReward: learnerReward / learnerCount,
    primaryHitRate: primaryHits / (LEARNERS.length * numGames),
    botVoteRate: votedBot / (LEARNERS.length * numGames),
    eliminatedDist,
    consensusRate: consensusGames / numGames,
    strictConsensusRate: strictConsensus / numGames,
    msgFractions: Object.fromEntries(Object.entries(msgTypeCounts).map(([k, v]) => [k, v / totalMsgs])),
  }
}

console.log(`# Bot 混在シナリオ`)
console.log(`# 学習: ABCD = [0,1,2,3]、bot: EFG = [4,5,6] (固定で A=0 に投票、SILENT)`)
console.log(`# ABCD の primary は E/F/G からランダム独立に選出`)
console.log(``)
console.log(`# 期待:`)
console.log(`#   - ABCD が bot 3 票 (A 集中) に対抗するため、4 人で合意して bot の誰かに集票する必要`)
console.log(`#   - bot は SILENT なので、ABCD 同士でメッセージ交換が必要`)
console.log(`#   - ベースライン (各自 primary 投票): bot 内部で票割れ → A が吊られる`)
console.log(``)

const layout = buildVocabLayout(7, OFFER_REF_WINDOW)
console.log(`vocab size = ${layout.vocabSize}`)

// Untrained eval
const untrained = new TrainableNetwork({
  dModel: 32, numLayers: 1, numHeads: 2, dFf: 64, vocabSize: layout.vocabSize,
})
const r0 = evalGreedy(untrained, 100, new Rng(1))
console.log(``)
console.log(`## Untrained eval`)
console.log(`A 生存率 = ${(r0.aSurvivalRate * 100).toFixed(1)}%`)
console.log(`learner mean_R = ${r0.learnerMeanReward.toFixed(3)}`)
console.log(`primary 命中 = ${(r0.primaryHitRate * 100).toFixed(1)}%, bot 投票率 = ${(r0.botVoteRate * 100).toFixed(1)}%`)
console.log(`合意 (3+人が同じ bot) = ${(r0.consensusRate * 100).toFixed(1)}%, 完全合意 (4/4) = ${(r0.strictConsensusRate * 100).toFixed(1)}%`)
console.log(``)

const variants = [
  { label: 'baseline (no bonus)', iter: 500, msgW: 1.0, consensusBonus: 0 },
  { label: 'consensus bonus 0.5', iter: 500, msgW: 1.0, consensusBonus: 0.5 },
  { label: 'consensus bonus 1.0', iter: 500, msgW: 1.0, consensusBonus: 1.0 },
]

for (const v of variants) {
  console.log(`## Training: ${v.label} (${v.iter} iter)`)
  const tStart = Date.now()
  const cfg = { ...envConfig, consensusBonus: v.consensusBonus }
  const { network: trained } = train({
    iterations: v.iter,
    gamesPerIter: 8,
    lr: 0.05,
    dModel: 32, numLayers: 1, numHeads: 2, dFf: 64,
    envConfig: cfg,
    seed: 42,
    log: (s: string) => {
      const m = s.match(/^iter\s+(\d+)/)
      if (m && parseInt(m[1]) % 100 === 0) {
        const el = ((Date.now() - tStart) / 1000).toFixed(1)
        console.log(`  [${el}s] ${s}`)
      }
    },
    msgLossWeight: v.msgW,
    greedyEvalEvery: 0,
  })
  const trainEl = ((Date.now() - tStart) / 1000).toFixed(1)
  console.log(`  done in ${trainEl}s`)

  // Eval は consensusBonus なしで純粋に
  const evalEnvConfig = { ...envConfig, consensusBonus: 0 }
  const evalEnv = new AbstractGame(evalEnvConfig, new Rng(1))
  const r = evalGreedy_swapEnv(trained, 200, evalEnv)
  console.log(`  A 生存率 = ${(r.aSurvivalRate * 100).toFixed(1)}%, learner mean_R = ${r.learnerMeanReward.toFixed(3)}`)
  console.log(`  primary 命中 = ${(r.primaryHitRate * 100).toFixed(1)}%, bot 投票率 = ${(r.botVoteRate * 100).toFixed(1)}%`)
  console.log(`  合意 (3+) = ${(r.consensusRate * 100).toFixed(1)}%, 完全合意 (4/4) = ${(r.strictConsensusRate * 100).toFixed(1)}%`)
  console.log(`  msgs: silent=${(r.msgFractions.silent * 100).toFixed(0)}% propose=${(r.msgFractions.propose * 100).toFixed(0)}% offer=${(r.msgFractions.offer * 100).toFixed(0)}% commit=${(r.msgFractions.commit * 100).toFixed(0)}%`)
  console.log(`  eliminated: ${Object.entries(r.eliminatedDist).sort().map(([k, v]) => `${k}:${v}`).join(' ')}`)
  console.log(``)
}

function evalGreedy_swapEnv(network: TrainableNetwork, numGames: number, env: AbstractGame) {
  const layout = buildVocabLayout(envConfig.numAgents, OFFER_REF_WINDOW)
  let aSurvival = 0, learnerReward = 0, learnerCount = 0
  let primaryHits = 0, votedBot = 0
  const eliminatedDist: Record<number, number> = {}
  const msgTypeCounts: Record<string, number> = { silent: 0, propose: 0, offer: 0, accept: 0, reject: 0, commit: 0 }
  let totalMsgs = 0
  let consensusGames = 0, strictConsensus = 0

  for (let g = 0; g < numGames; g++) {
    const inputs = env.reset()
    const N = inputs.length
    const primaries = env.getPrimaryByAgent()
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
      if (!env.isLearning(a)) { finalVotes.push(A); continue }
      const obs: Observation = { input: inputs[a], roundNumber: K_ROUNDS, messageHistory, pastCommitViolations: past }
      const enc = encodeObservation(obs, K_ROUNDS)
      const out = network.forward(enc.cls, enc.agents, enc.numAgents)
      const voteMask = new Uint8Array(enc.numAgents)
      for (let i = 0; i < enc.numAgents; i++) voteMask[i] = inputs[a].excluded[i] ? 0 : 1
      const masked = applyMask(out.voteLogits, voteMask)
      const idx = argmax(masked)
      const seat = inputs[a].participants[idx]
      finalVotes.push(seat)
      if (BOTS.includes(seat)) votedBot++
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
    eliminatedDist[elim] = (eliminatedDist[elim] ?? 0) + 1
    if (elim !== A) aSurvival++

    const learnerVotes = LEARNERS.map(a => finalVotes[a])
    const voteCount: Record<number, number> = {}
    for (const v of learnerVotes) voteCount[v] = (voteCount[v] ?? 0) + 1
    const maxVote = Math.max(...Object.values(voteCount))
    const maxVoteSeat = parseInt(Object.entries(voteCount).find(([, c]) => c === maxVote)![0])
    if (BOTS.includes(maxVoteSeat) && maxVote >= 3) consensusGames++
    if (BOTS.includes(maxVoteSeat) && maxVote === 4) strictConsensus++

    for (const a of LEARNERS) {
      learnerReward += inputs[a].desire[elim]
      learnerCount++
    }
  }

  return {
    aSurvivalRate: aSurvival / numGames,
    learnerMeanReward: learnerReward / learnerCount,
    primaryHitRate: primaryHits / (LEARNERS.length * numGames),
    botVoteRate: votedBot / (LEARNERS.length * numGames),
    eliminatedDist,
    consensusRate: consensusGames / numGames,
    strictConsensusRate: strictConsensus / numGames,
    msgFractions: Object.fromEntries(Object.entries(msgTypeCounts).map(([k, v]) => [k, v / totalMsgs])),
  }
}
