/**
 * Bot なし team-based self-play バリエーション検証:
 *   7 agents をチームに分け、各チームで共通の primary を敵チーム内からランダム選出。
 *   「チーム内協調 + チーム間対立」が symmetric な形で成立する。
 *
 * Variations:
 *   4v3    — 多数派確実勝ちだが内部一致が必要
 *   5v2    — 大差、少数派にチャンスほぼなし
 *   3v2v2  — 3 チーム、最大派閥 + kingmaker (2 人組 2 つ)
 *   3v3v1  — 3 チーム、独立 kingmaker 1 人
 *
 * 学習設定: Adam + C 案 (norm off, vw=3) で固定。500 iter。
 * 評価: team ごとの primary hit 率 (その team の primary が eliminated された率)
 *       team 内 primary vote 一致率
 *       team ごとの mean_R
 */

import { Rng } from './rng.ts'
import { TrainableNetwork } from './trainable-network.ts'
import { AbstractGame, type EnvConfig } from './abstract-env.ts'
import { encodeObservation } from './observation.ts'
import { buildVocabLayout, decodeMessage, buildLegalMask } from './message-vocab.ts'
import { applyMask } from './network.ts'
import { K_ROUNDS, OFFER_REF_WINDOW, type Message, type Observation, type AgentId } from './types.ts'
import { train } from './train.ts'

type TeamVariant = {
  label: string
  teams: number[][]
}

const teamVariants: TeamVariant[] = [
  { label: '4v3',    teams: [[0, 1, 2, 3], [4, 5, 6]] },
  { label: '5v2',    teams: [[0, 1, 2, 3, 4], [5, 6]] },
  { label: '3v2v2',  teams: [[0, 1, 2], [3, 4], [5, 6]] },
  { label: '3v3v1',  teams: [[0, 1, 2], [3, 4, 5], [6]] },
]

function buildEnvConfig(teams: number[][]): EnvConfig {
  return {
    numAgents: 7,
    primaryFromBots: false,
    teams,
    desireCorrelation: 0.7,
    kRounds: K_ROUNDS,
    rewardMode: 'eliminated',
    consensusBonus: 0,
  }
}

function argmax(arr: Float32Array): number {
  let best = -Infinity, idx = 0
  for (let i = 0; i < arr.length; i++) if (arr[i] > best) { best = arr[i]; idx = i }
  return idx
}

type EvalMetrics = {
  meanReward: number
  teamRewards: number[]
  teamPrimaryHits: number[]        // team t の primary が eliminated された率
  teamInternalAgreement: number[]  // team t 内で「team の primary に投票した人の割合」平均
}

function evalGreedy(network: TrainableNetwork, numGames: number, env: AbstractGame, teams: number[][]): EvalMetrics {
  const layout = buildVocabLayout(7, OFFER_REF_WINDOW)
  const numTeams = teams.length
  const teamOf = new Array<number>(7)
  for (let t = 0; t < teams.length; t++) for (const a of teams[t]) teamOf[a] = t

  let totalReward = 0, rewardCount = 0
  const teamRewardSum = new Array<number>(numTeams).fill(0)
  const teamRewardCount = new Array<number>(numTeams).fill(0)
  const teamPrimaryHit = new Array<number>(numTeams).fill(0)
  const teamAgreementSum = new Array<number>(numTeams).fill(0)
  const teamAgreementCount = new Array<number>(numTeams).fill(0)

  for (let g = 0; g < numGames; g++) {
    const inputs = env.reset()
    const N = inputs.length
    const teamPrimaries = env.getPrimaryByTeam()

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
      finalVotes.push(inputs[a].participants[argmax(masked)])
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
      const r = inputs[a].desire[elim]
      totalReward += r
      rewardCount++
      const t = teamOf[a]
      teamRewardSum[t] += r
      teamRewardCount[t]++
    }

    for (let t = 0; t < numTeams; t++) {
      const primary = teamPrimaries.get(t)
      if (primary !== undefined && elim === primary) teamPrimaryHit[t]++
    }

    for (let t = 0; t < numTeams; t++) {
      const primary = teamPrimaries.get(t)
      if (primary === undefined) continue
      const members = teams[t]
      let agree = 0
      for (const m of members) if (finalVotes[m] === primary) agree++
      teamAgreementSum[t] += agree / members.length
      teamAgreementCount[t]++
    }
  }

  return {
    meanReward: totalReward / rewardCount,
    teamRewards: teamRewardSum.map((s, t) => s / Math.max(1, teamRewardCount[t])),
    teamPrimaryHits: teamPrimaryHit.map(h => h / numGames),
    teamInternalAgreement: teamAgreementSum.map((s, t) => s / Math.max(1, teamAgreementCount[t])),
  }
}

function formatTeamStats(teams: number[][], m: EvalMetrics): string {
  const parts: string[] = []
  for (let t = 0; t < teams.length; t++) {
    const size = teams[t].length
    parts.push(
      `  team${t} (n=${size}): mean_R=${m.teamRewards[t].toFixed(3)}, primary hit=${(m.teamPrimaryHits[t] * 100).toFixed(1)}%, 内部合意=${(m.teamInternalAgreement[t] * 100).toFixed(1)}%`,
    )
  }
  return parts.join('\n')
}

console.log(`# Team-based self-play バリエーション検証`)
console.log(`# Adam + C 案 (norm off, vw=3), 500 iter × gamesPerIter=8`)
console.log(``)

for (const tv of teamVariants) {
  console.log(`## ${tv.label} (${tv.teams.map(t => t.length).join('-')})`)
  const envConfig = buildEnvConfig(tv.teams)

  // Untrained baseline
  const untrained = new TrainableNetwork({
    dModel: 32, numLayers: 1, numHeads: 2, dFf: 64, vocabSize: buildVocabLayout(7, OFFER_REF_WINDOW).vocabSize,
  })
  const r0 = evalGreedy(untrained, 200, new AbstractGame(envConfig, new Rng(1)), tv.teams)
  console.log(`### Untrained (random)`)
  console.log(`  全体 mean_R=${r0.meanReward.toFixed(3)}`)
  console.log(formatTeamStats(tv.teams, r0))

  console.log(`### Trained (Adam + C vw=3)`)
  const tStart = Date.now()
  const { network: trained } = train({
    iterations: 500,
    gamesPerIter: 8,
    lr: 0.001,
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
    normalizeAdvantage: false,
    valueLossWeight: 3.0,
    optimizer: 'adam',
    greedyEvalEvery: 0,
  })
  const trainEl = ((Date.now() - tStart) / 1000).toFixed(1)
  console.log(`  done in ${trainEl}s`)

  const r = evalGreedy(trained, 200, new AbstractGame(envConfig, new Rng(1)), tv.teams)
  console.log(`  全体 mean_R=${r.meanReward.toFixed(3)}`)
  console.log(formatTeamStats(tv.teams, r))
  console.log(``)
}
