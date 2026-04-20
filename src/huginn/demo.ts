/** Smoke demo: ランダム重み NN で 1 ゲーム流して end-to-end を確認 */

import { Rng } from './rng.ts'
import { HuginnNetwork } from './network.ts'
import { runRounds } from './protocol.ts'
import { AbstractGame } from './abstract-env.ts'
import { buildVocabLayout } from './message-vocab.ts'
import { OFFER_REF_WINDOW, K_ROUNDS } from './types.ts'

const N = 7
const seed = 42
const rng = new Rng(seed)

const teams = [[0, 1, 2], [3, 4], [5, 6]]
const env = new AbstractGame({
  numAgents: N,
  teams,
  desireCorrelation: 0.7,
  kRounds: K_ROUNDS,
}, rng)

const layout = buildVocabLayout(N, OFFER_REF_WINDOW)
const network = new HuginnNetwork({
  dModel: 64,
  numLayers: 2,
  numHeads: 4,
  dFf: 128,
  vocabSize: layout.vocabSize,
})

console.log(`# Huginn demo`)
console.log(`N=${N}, K=${K_ROUNDS}, vocabSize=${layout.vocabSize}`)
console.log(`teams: ${JSON.stringify(teams)}`)

const inputs = env.reset()
const teamArr = env.getTeams()
const primaryByTeam = env.getPrimaryByTeam()
console.log(`\n## scenario`)
for (const [t, p] of primaryByTeam) {
  const members = teamArr.map((x, i) => x === t ? i : -1).filter(i => i >= 0)
  console.log(`team ${t} ${JSON.stringify(members)} → primary target: agent ${p}`)
}
console.log(`\n## desire vectors`)
for (let a = 0; a < N; a++) {
  const d = Array.from(inputs[a].desire).map(v => v.toFixed(2)).join(' ')
  console.log(`agent ${a} (team ${teamArr[a]}): [${d}]`)
}

const pastViolations = new Map<number, number>()
const trace = runRounds(inputs, network, pastViolations, {
  kRounds: K_ROUNDS,
  sampling: 'stochastic',
  rng,
})

console.log(`\n## messages`)
for (let r = 0; r < K_ROUNDS; r++) {
  console.log(`-- round ${r} --`)
  for (let a = 0; a < N; a++) {
    const m = trace.perAgent[a].messages[r]
    console.log(`  agent ${a}: ${formatMessage(m)}`)
  }
}

console.log(`\n## final votes`)
const result = env.step(trace)
for (let a = 0; a < N; a++) {
  const v = trace.perAgent[a].finalVoteIdx
  const target = inputs[a].participants[v]
  const violated = result.commitViolations[a] ? ' (commit violated!)' : ''
  console.log(`  agent ${a} → ${target}${violated}`)
}
console.log(`vote counts: [${result.voteCounts.join(' ')}]`)
console.log(`eliminated: ${result.eliminated}`)
console.log(`rewards: [${result.rewards.map(r => r.toFixed(2)).join(' ')}]`)

function formatMessage(m: import('./types.ts').Message): string {
  switch (m.type) {
    case 'silent': return 'SILENT'
    case 'propose': return `PROPOSE(target=${m.target}, p=${m.priority}, heat=${m.heat})`
    case 'offer': return `OFFER(iVote=${m.iVote}, youVote=${m.youVote})`
    case 'accept': return `ACCEPT(ref=${m.offerRef})`
    case 'reject': return `REJECT(ref=${m.offerRef})`
    case 'commit': return `COMMIT(target=${m.target})`
  }
}
