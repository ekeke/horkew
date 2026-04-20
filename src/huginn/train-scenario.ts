/**
 * シナリオ指定で訓練を走らせる CLI. カンマ区切りで複数指定すると mix 訓練になる.
 *
 * 使い方:
 *   node --experimental-strip-types src/huginn/train-scenario.ts <scenario-names> [iters] [gamesPerIter]
 *
 * 例:
 *   node --experimental-strip-types src/huginn/train-scenario.ts trio3v2Block
 *   node --experimental-strip-types src/huginn/train-scenario.ts pair2v2Split 500 32
 *   node --experimental-strip-types src/huginn/train-scenario.ts pair2v2Block,pair2v2Split 300 32
 *
 * 制約: mix 時は全シナリオの numAgents が同一であること.
 */

import { train } from './train.ts'
import { catalog } from './scenarios.ts'

function main(): void {
  const nameArg = process.argv[2]
  const iterations = Number(process.argv[3] ?? 200)
  const gamesPerIter = Number(process.argv[4] ?? 16)

  if (!nameArg) {
    console.error(`Usage: node --experimental-strip-types src/huginn/train-scenario.ts <scenario-names> [iters] [gamesPerIter]`)
    console.error(`Available scenarios: ${Object.keys(catalog).join(', ')}`)
    console.error(`Mix example: pair2v2Block,pair2v2Split`)
    process.exit(1)
  }

  const names = nameArg.split(',').map(s => s.trim()).filter(Boolean)
  for (const n of names) {
    if (!catalog[n]) {
      console.error(`Unknown scenario: ${n}`)
      console.error(`Available: ${Object.keys(catalog).join(', ')}`)
      process.exit(1)
    }
  }
  const scenarios = names.map(n => catalog[n]())

  console.log(`## Scenarios: ${names.join(' + ')}`)
  for (const s of scenarios) {
    console.log(`  - ${s.name}: ${s.description}`)
  }
  console.log(``)

  const startedAt = Date.now()
  train({
    iterations,
    gamesPerIter,
    lr: 0.05,
    dModel: 32,
    numLayers: 1,
    numHeads: 2,
    dFf: 64,
    envConfigs: scenarios.map(s => s.envConfig),
    mixNames: names,
    seed: 42,
    greedyEvalEvery: 50,
    greedyEvalGames: 64,
    normalizeAdvantage: true,
    entropyBonus: 0.01,
  })
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(``)
  console.log(`Training done in ${elapsed}s`)
}

main()
