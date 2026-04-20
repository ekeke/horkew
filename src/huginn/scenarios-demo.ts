/**
 * シナリオ可視化 CLI.
 *
 * 各シナリオについて:
 *   1. 概要 (name / description / learningObjective)
 *   2. 生成された agent 情報 (role, primary, desire)
 *   3. 学習 agent の投票組合せ × 結果得られる報酬
 *
 * 使い方:
 *   node --experimental-strip-types src/huginn/scenarios-demo.ts                 # 全シナリオ
 *   node --experimental-strip-types src/huginn/scenarios-demo.ts pair2v2Block    # 個別
 */

import { catalog, type Scenario } from './scenarios.ts'
import { AbstractGame, type AgentRole, type OutcomeReward } from './abstract-env.ts'
import { Rng } from './rng.ts'
import type { HuginnInput, AgentId } from './types.ts'

const GAMES_PER_SCENARIO = 2
const SEED = 42

function formatAgentRole(role: AgentRole): string {
  if (role === 'learning') return 'learn'
  if (typeof role !== 'object') return String(role)
  switch (role.type) {
    case 'fixedVote': return `fixed→s${role.target}`
    case 'silent': return 'silent'
    case 'offerer': return `offerer(p=s${role.primary},${role.mode ?? 'split'})`
    case 'eagerCommitter': return `committer(p=s${role.primary})`
  }
}

function formatDesire(desire: Float64Array | number[]): string {
  return Array.from(desire).map(d => d.toFixed(2)).join(' ')
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)),
  )
  const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+'
  const lineOf = (cells: string[]): string =>
    '| ' + cells.map((c, i) => (c ?? '').padEnd(widths[i])).join(' | ') + ' |'
  const lines: string[] = [sep, lineOf(headers), sep]
  for (const row of rows) lines.push(lineOf(row))
  lines.push(sep)
  return lines.join('\n')
}

function getLearnerSeats(env: AbstractGame): AgentId[] {
  const N = env.config.numAgents
  const seats: AgentId[] = []
  for (let a = 0; a < N; a++) {
    if (env.getAgentRole(a) === 'learning') seats.push(a)
  }
  return seats
}

type BotVoteEntry = { seat: AgentId; target: AgentId | null }

function getBotVotes(env: AbstractGame): BotVoteEntry[] {
  const N = env.config.numAgents
  const result: BotVoteEntry[] = []
  for (let a = 0; a < N; a++) {
    const role = env.getAgentRole(a)
    if (role === 'learning') continue
    if (typeof role === 'object' && role.type === 'fixedVote') {
      result.push({ seat: a, target: role.target })
    } else {
      // silent 等: 固定先なし (ランダム投票).
      result.push({ seat: a, target: null })
    }
  }
  return result
}

function cartesian<T>(arrays: T[][]): T[][] {
  if (arrays.length === 0) return [[]]
  const [first, ...rest] = arrays
  const restProduct = cartesian(rest)
  const out: T[][] = []
  for (const item of first) {
    for (const r of restProduct) out.push([item, ...r])
  }
  return out
}

function getVoteChoices(input: HuginnInput): AgentId[] {
  const choices: AgentId[] = []
  for (let i = 0; i < input.participants.length; i++) {
    if (!input.excluded[i]) choices.push(input.participants[i])
  }
  return choices
}

type Outcome = {
  voteCounts: number[]
  tieSet: AgentId[]
  outcomeKey: string
  override: OutcomeReward | null
  rewardPerLearner: number[]
}

function computeOutcome(
  env: AbstractGame,
  inputs: HuginnInput[],
  learners: AgentId[],
  learnerVotes: AgentId[],
  botVotes: BotVoteEntry[],
): Outcome {
  const N = env.config.numAgents
  const counts = new Array<number>(N).fill(0)
  for (let i = 0; i < learners.length; i++) counts[learnerVotes[i]]++
  for (const b of botVotes) if (b.target !== null) counts[b.target]++

  let max = -1
  let tieSet: AgentId[] = []
  for (let i = 0; i < N; i++) {
    if (counts[i] > max) { max = counts[i]; tieSet = [i] }
    else if (counts[i] === max) tieSet.push(i)
  }

  // outcomeRewards は論理 seat 基準. 実 seat の tieSet を論理 seat に変換してから lookup.
  const outcomeKey = tieSet
    .map(a => env.getLogicalSeat(a))
    .sort((a, b) => a - b)
    .join(',')
  const override = env.config.outcomeRewards?.[outcomeKey] ?? null

  if (override !== null) {
    const rewardPerLearner = learners.map(() => override.reward)
    return { voteCounts: counts, tieSet, outcomeKey, override, rewardPerLearner }
  }

  const mode = env.config.rewardMode ?? 'eliminated'
  const consensusBonus = env.config.consensusBonus ?? 0
  let bonus = 0
  if (consensusBonus > 0 && learners.length > 1) {
    const c = new Map<AgentId, number>()
    for (const v of learnerVotes) c.set(v, (c.get(v) ?? 0) + 1)
    const maxAgree = Math.max(...c.values())
    const frac = (maxAgree - 1) / (learners.length - 1)
    bonus = consensusBonus * frac
  }

  const rewardPerLearner = learners.map((lSeat, li) => {
    let r: number
    if (mode === 'voteDirect') {
      r = inputs[lSeat].desire[learnerVotes[li]]
    } else {
      let sum = 0
      for (const t of tieSet) sum += inputs[lSeat].desire[t]
      r = sum / tieSet.length
    }
    return r + bonus
  })

  return { voteCounts: counts, tieSet, outcomeKey, override: null, rewardPerLearner }
}

function showAgentInfoTable(env: AbstractGame, inputs: HuginnInput[]): void {
  const N = env.config.numAgents
  const primaries = env.getPrimaryByAgent()
  const desireHeader = 'desire (' + Array.from({ length: N }, (_, i) => `s${i}`).join(' ') + ')'
  const rows: string[][] = []
  for (let a = 0; a < N; a++) {
    const role = env.getAgentRole(a)
    const prim = primaries.get(a)
    rows.push([
      `s${a}`,
      formatAgentRole(role),
      prim !== undefined ? `s${prim}` : '-',
      formatDesire(inputs[a].desire),
    ])
  }
  console.log(renderTable(['seat', 'role', 'primary', desireHeader], rows))
}

function formatTally(counts: number[]): string {
  return counts.map((c, i) => c > 0 ? `s${i}:${c}` : null).filter(Boolean).join(' ')
}

function formatElim(tieSet: AgentId[]): string {
  if (tieSet.length === 1) return `s${tieSet[0]}`
  return `tie(${tieSet.map(t => `s${t}`).join(',')})`
}

function showCombinationsTable(env: AbstractGame, inputs: HuginnInput[]): void {
  const learners = getLearnerSeats(env)
  const botVotes = getBotVotes(env)

  if (learners.length === 0) {
    console.log('(学習 agent なし)')
    return
  }

  const choicesPerLearner = learners.map(l => getVoteChoices(inputs[l]))
  const combos = cartesian(choicesPerLearner)
  const hasOverrides = env.config.outcomeRewards !== undefined

  const headers: string[] = [
    ...learners.map(l => `s${l}→`),
    'tally (bot票込)',
    '吊られ (or tie)',
    'key',
    ...learners.map(l => `reward_s${l}`),
    'reward合計',
    '評価',
  ]
  const rows: string[][] = []
  for (const combo of combos) {
    const outcome = computeOutcome(env, inputs, learners, combo, botVotes)
    const rewardSum = outcome.rewardPerLearner.reduce((a, b) => a + b, 0)
    const evalLabel = outcome.override
      ? outcome.override.label
      : (hasOverrides ? '(override なし: desire default)' : '(desire default)')
    rows.push([
      ...combo.map(v => `s${v}`),
      formatTally(outcome.voteCounts),
      formatElim(outcome.tieSet),
      outcome.outcomeKey,
      ...outcome.rewardPerLearner.map(r => r.toFixed(2)),
      rewardSum.toFixed(2),
      evalLabel,
    ])
  }

  const botDesc = botVotes.length > 0
    ? 'bot: ' + botVotes.map(b => `s${b.seat}→${b.target !== null ? `s${b.target}` : '?'}`).join(', ')
    : 'bot なし'
  console.log(botDesc)
  console.log(renderTable(headers, rows))
}

function showScenario(scenario: Scenario): void {
  console.log(`## ${scenario.name}\n`)
  console.log(`${scenario.description}\n`)
  console.log(`**学習目標**: ${scenario.learningObjective}\n`)

  const mode = scenario.envConfig.rewardMode ?? 'eliminated'
  const consensusBonus = scenario.envConfig.consensusBonus ?? 0
  console.log(
    `**envConfig**: N=${scenario.envConfig.numAgents}, ` +
    `rewardMode=${mode}, consensusBonus=${consensusBonus}, ` +
    `randomize=${scenario.envConfig.randomizeRolesPerGame ?? false}`,
  )
  console.log('')

  const env = new AbstractGame(scenario.envConfig, new Rng(SEED))
  for (let g = 0; g < GAMES_PER_SCENARIO; g++) {
    const inputs = env.reset()
    console.log(`### Game ${g} (seed=${SEED})\n`)
    showAgentInfoTable(env, inputs)
    console.log('')
    showCombinationsTable(env, inputs)
    console.log('')
  }
}

function main(): void {
  const selected = process.argv[2]
  const entries = Object.entries(catalog)
  if (selected) {
    const factory = catalog[selected]
    if (!factory) {
      console.error(`Unknown scenario: ${selected}`)
      console.error(`Available: ${entries.map(([k]) => k).join(', ')}`)
      process.exit(1)
    }
    showScenario(factory())
    return
  }
  console.log(`# Huginn Scenario Catalog\n`)
  for (const [, factory] of entries) {
    showScenario(factory())
  }
}

main()
