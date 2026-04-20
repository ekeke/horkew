/** Run a small training session and print the log. */

import { train } from './train.ts'
import { K_ROUNDS } from './types.ts'

const config = {
  iterations: 200,
  gamesPerIter: 32,
  lr: 0.005,
  dModel: 64,
  numLayers: 2,
  numHeads: 4,
  dFf: 128,
  envConfig: {
    numAgents: 7,
    teams: [[0, 1, 2], [3, 4], [5, 6]],
    desireCorrelation: 0.7,
    kRounds: K_ROUNDS,
  },
  seed: 42,
  greedyEvalEvery: 5,
  greedyEvalGames: 32,
}

const t0 = Date.now()
const { history } = train(config)
const elapsed = (Date.now() - t0) / 1000

console.log(``)
console.log(`# done in ${elapsed.toFixed(1)}s`)
console.log(`# first iter mean_R = ${history[0].meanReward.toFixed(3)}`)
console.log(`# last  iter mean_R = ${history[history.length - 1].meanReward.toFixed(3)}`)
const greedy = history.filter(h => h.greedyMeanReward !== undefined)
if (greedy.length > 0) {
  console.log(`# first greedy mean_R = ${greedy[0].greedyMeanReward!.toFixed(3)}`)
  console.log(`# last  greedy mean_R = ${greedy[greedy.length - 1].greedyMeanReward!.toFixed(3)}`)
}
