/**
 * シナリオの学習後 greedy 挙動を可視化する CLI.
 *
 * 指定シナリオで train を走らせ、学習済み network の argmax 挙動で数ゲーム rollout して
 * 各 round のメッセージ、最終投票、outcome、reward を出力する.
 *
 * 使い方:
 *   node --experimental-strip-types src/huginn/trace-scenario.ts <scenario> [iter=200] [gamesPerIter=16] [traceGames=3]
 *
 * 例:
 *   node --experimental-strip-types src/huginn/trace-scenario.ts trio3v2Block 500 32 5
 */

import { train } from './train.ts'
import { catalog, type Scenario } from './scenarios.ts'
import { AbstractGame } from './abstract-env.ts'
import { TrainableNetwork, applyMask } from './trainable-network.ts'
import { Rng } from './rng.ts'
import { encodeObservation } from './observation.ts'
import { buildVocabLayout, decodeMessage, buildLegalMask } from './message-vocab.ts'
import {
  K_ROUNDS,
  OFFER_REF_WINDOW,
  type Message,
  type Observation,
  type AgentId,
} from './types.ts'

const SEED = 42

function argmax(arr: Float32Array): number {
  let best = -Infinity
  let idx = 0
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > best) { best = arr[i]; idx = i }
  }
  return idx
}

function countRecentOffers(history: { message: Message }[], window: number): number {
  let count = 0
  for (let i = history.length - 1; i >= 0 && count < window; i--) {
    if (history[i].message.type === 'offer') count++
  }
  return count
}

function formatMessage(msg: Message): string {
  switch (msg.type) {
    case 'silent':  return '─'
    case 'propose': return `P→s${msg.target} p${msg.priority}/${msg.heat}`
    case 'offer':   return `O I:s${msg.iVote} Y:s${msg.youVote}`
    case 'accept':  return `A#${msg.offerRef}`
    case 'reject':  return `R#${msg.offerRef}`
    case 'commit':  return `C→s${msg.target}`
  }
}

/** actualSeat に対して、シナリオで定義された論理役割ラベル (例: '村1', '狼') を返す. */
function actualSeatLabel(scenario: Scenario, env: AbstractGame, actual: number): string {
  const logical = env.getLogicalSeat(actual)
  const role = scenario.roles.find(r => r.seat === logical)
  return role ? role.label : `s${logical}`
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)),
  )
  const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+'
  const line = (cells: string[]): string =>
    '| ' + cells.map((c, i) => (c ?? '').padEnd(widths[i])).join(' | ') + ' |'
  const out: string[] = [sep, line(headers), sep]
  for (const r of rows) out.push(line(r))
  out.push(sep)
  return out.join('\n')
}

type TraceResult = {
  inputs: ReturnType<AbstractGame['reset']>
  perAgentMessages: Message[][]
  finalVotes: AgentId[]
  envResult: ReturnType<AbstractGame['step']>
}

function greedyTrace(
  network: TrainableNetwork,
  env: AbstractGame,
  layout: ReturnType<typeof buildVocabLayout>,
  rng: Rng,
): TraceResult {
  const inputs = env.reset()
  const N = inputs.length
  const messageHistory: { round: number; sender: AgentId; message: Message }[] = []
  const pastViolations = new Map<AgentId, number>()
  const perAgentMessages: Message[][] = inputs.map(() => [])

  for (let round = 0; round < K_ROUNDS; round++) {
    const roundMsgs: Message[] = []
    for (let a = 0; a < N; a++) {
      const role = env.getAgentRole(a)
      if (role !== 'learning') {
        const m: Message = { type: 'silent' }
        perAgentMessages[a].push(m)
        roundMsgs.push(m)
        continue
      }
      const obs: Observation = {
        input: inputs[a],
        roundNumber: round,
        messageHistory,
        pastCommitViolations: pastViolations,
      }
      const enc = encodeObservation(obs, K_ROUNDS)
      const result = network.forward(enc.cls, enc.agents, enc.numAgents)
      const recentOffers = countRecentOffers(messageHistory, layout.offerRefWindow)
      const mask = buildLegalMask(inputs[a], recentOffers, layout)
      const masked = applyMask(result.msgLogits, mask)
      const tokenId = argmax(masked)
      const message = decodeMessage(tokenId, inputs[a].participants, layout)
      perAgentMessages[a].push(message)
      roundMsgs.push(message)
    }
    for (let a = 0; a < N; a++) {
      messageHistory.push({ round, sender: inputs[a].self, message: roundMsgs[a] })
    }
  }

  const finalVotes: AgentId[] = new Array(N)
  const finalVoteIdx: number[] = new Array(N)
  for (let a = 0; a < N; a++) {
    const role = env.getAgentRole(a)
    if (role !== 'learning') {
      let idx: number
      if (typeof role === 'object' && role.type === 'fixedVote') {
        idx = inputs[a].participants.indexOf(role.target)
        if (idx < 0 || inputs[a].excluded[idx]) {
          const cand: number[] = []
          for (let i = 0; i < N; i++) if (!inputs[a].excluded[i]) cand.push(i)
          idx = cand[Math.floor(rng.next() * cand.length)]
        }
      } else {
        const cand: number[] = []
        for (let i = 0; i < N; i++) if (!inputs[a].excluded[i]) cand.push(i)
        idx = cand[Math.floor(rng.next() * cand.length)]
      }
      finalVoteIdx[a] = idx
      finalVotes[a] = inputs[a].participants[idx]
      continue
    }
    const obs: Observation = {
      input: inputs[a],
      roundNumber: K_ROUNDS,
      messageHistory,
      pastCommitViolations: pastViolations,
    }
    const enc = encodeObservation(obs, K_ROUNDS)
    const result = network.forward(enc.cls, enc.agents, enc.numAgents)
    const voteMask = new Uint8Array(enc.numAgents)
    for (let i = 0; i < enc.numAgents; i++) voteMask[i] = inputs[a].excluded[i] ? 0 : 1
    const masked = applyMask(result.voteLogits, voteMask)
    const idx = argmax(masked)
    finalVoteIdx[a] = idx
    finalVotes[a] = inputs[a].participants[idx]
  }

  const trace = {
    perAgent: inputs.map((input, a) => ({
      agent: input.self,
      steps: [],
      messages: perAgentMessages[a],
      finalVoteIdx: finalVoteIdx[a],
      finalVoteLogProb: 0,
      finalVoteValue: 0,
    })),
    messageHistory,
  }
  const envResult = env.step(trace)

  return { inputs, perAgentMessages, finalVotes, envResult }
}

function printGame(scenario: Scenario, env: AbstractGame, gameNum: number, result: TraceResult): void {
  const N = env.config.numAgents
  console.log(`\n### Game ${gameNum}\n`)

  const primaries = env.getPrimaryByAgent()
  const setupRows: string[][] = []
  for (let a = 0; a < N; a++) {
    const role = env.getAgentRole(a)
    const roleStr = role === 'learning'
      ? 'learn'
      : (typeof role === 'object' && role.type === 'fixedVote' ? `fixed→s${role.target}` : 'silent')
    const prim = primaries.get(a)
    const primStr = prim !== undefined ? `s${prim}` : '-'
    const desireStr = Array.from(result.inputs[a].desire).map(d => d.toFixed(2)).join(' ')
    const logical = env.getLogicalSeat(a)
    setupRows.push([`s${a}`, `L${logical}`, actualSeatLabel(scenario, env, a), roleStr, primStr, desireStr])
  }
  const desireHead = 'desire (' + Array.from({ length: N }, (_, i) => `s${i}`).join(' ') + ')'
  console.log(renderTable(['seat', 'logical', 'label', 'role', 'primary', desireHead], setupRows))
  console.log('')

  const msgHeaders = ['round', ...Array.from({ length: N }, (_, a) => `s${a}(${actualSeatLabel(scenario, env, a)})`)]
  const msgRows: string[][] = []
  for (let r = 0; r < K_ROUNDS; r++) {
    const row: string[] = [`R${r}`]
    for (let a = 0; a < N; a++) row.push(formatMessage(result.perAgentMessages[a][r]))
    msgRows.push(row)
  }
  console.log(renderTable(msgHeaders, msgRows))
  console.log('')

  const voteParts: string[] = []
  for (let a = 0; a < N; a++) {
    const isBot = env.getAgentRole(a) !== 'learning'
    const selfLabel = actualSeatLabel(scenario, env, a)
    const targetLabel = actualSeatLabel(scenario, env, result.finalVotes[a])
    voteParts.push(`${selfLabel}(s${a})→${targetLabel}(s${result.finalVotes[a]})${isBot ? '[bot]' : ''}`)
  }
  console.log(`Final votes: ${voteParts.join(', ')}`)

  const tallyStr = result.envResult.voteCounts
    .map((c, i) => c > 0 ? `s${i}:${c}` : null)
    .filter(Boolean)
    .join(' ')
  console.log(`Tally: ${tallyStr}`)
  console.log(`Eliminated: s${result.envResult.eliminated}`)

  const key = result.envResult.outcomeKey ?? '(no override)'
  const label = result.envResult.outcomeLabel ?? '(desire default)'
  console.log(`Outcome: '${key}' — ${label}`)

  const rewardStr = result.envResult.rewards.map((r, a) => `s${a}:${r.toFixed(2)}`).join(' ')
  console.log(`Rewards: ${rewardStr}`)
}

function printLegend(): void {
  console.log(`Message legend:`)
  console.log(`  ─              silent`)
  console.log(`  P→sX p#/h      propose: target=sX, priority=#, heat=h`)
  console.log(`  O I:sX Y:sY    offer coalition: "I vote sX, You vote sY"`)
  console.log(`  A#n / R#n      accept/reject offer at rounds-ago n`)
  console.log(`  C→sX           commit to voting sX at final`)
}

function main(): void {
  const name = process.argv[2]
  const iterations = Number(process.argv[3] ?? 200)
  const gamesPerIter = Number(process.argv[4] ?? 16)
  const traceGames = Number(process.argv[5] ?? 3)

  if (!name) {
    console.error(`Usage: node --experimental-strip-types src/huginn/trace-scenario.ts <scenario> [iter=200] [gamesPerIter=16] [traceGames=3]`)
    console.error(`Available: ${Object.keys(catalog).join(', ')}`)
    process.exit(1)
  }
  const factory = catalog[name]
  if (!factory) {
    console.error(`Unknown scenario: ${name}`)
    console.error(`Available: ${Object.keys(catalog).join(', ')}`)
    process.exit(1)
  }
  const scenario = factory()

  console.log(`## Scenario: ${scenario.name}`)
  console.log(`${scenario.description}`)
  console.log(`**学習目標**: ${scenario.learningObjective}`)
  console.log(``)
  console.log(`Training: iter=${iterations}, gamesPerIter=${gamesPerIter}, traceGames=${traceGames}`)
  console.log(``)

  const startedAt = Date.now()
  const { network } = train({
    iterations,
    gamesPerIter,
    lr: 0.05,
    dModel: 32,
    numLayers: 1,
    numHeads: 2,
    dFf: 64,
    envConfigs: [scenario.envConfig],
    mixNames: [scenario.name],
    seed: SEED,
    greedyEvalEvery: 50,
    greedyEvalGames: 64,
    normalizeAdvantage: true,
    entropyBonus: 0.01,
  })
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(``)
  console.log(`Training done in ${elapsed}s`)

  console.log(`\n## Greedy trace (${traceGames} games)\n`)
  printLegend()

  const layout = buildVocabLayout(scenario.envConfig.numAgents, OFFER_REF_WINDOW)
  const env = new AbstractGame(scenario.envConfig, new Rng(SEED + 1000))
  const rng = new Rng(SEED + 2000)
  for (let g = 0; g < traceGames; g++) {
    const result = greedyTrace(network, env, layout, rng)
    printGame(scenario, env, g, result)
  }
}

main()
