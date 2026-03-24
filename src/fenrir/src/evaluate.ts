#!/usr/bin/env node
/**
 * Fenrir Evaluation CLI
 *
 * Usage:
 *   npm run eval
 *   npm run eval -- --checkpoint ./checkpoints/final.json --games 100
 */

import { evaluate, createNetwork, DEFAULT_TRAINING_CONFIG } from './training.ts'
import { loadCheckpoint } from './ml/checkpoint.ts'

function parseArgs(): { checkpoint?: string, games: number } {
  const args = process.argv.slice(2)
  let checkpoint: string | undefined
  let games = 100

  for (let i = 0; i < args.length; i += 2) {
    switch (args[i]) {
      case '--checkpoint':
        checkpoint = args[i + 1]
        break
      case '--games':
        games = parseInt(args[i + 1])
        break
    }
  }

  return { checkpoint, games }
}

const { checkpoint, games } = parseArgs()
const network = createNetwork()

if (checkpoint) {
  console.log(`Loading checkpoint: ${checkpoint}`)
  const data = loadCheckpoint(network, checkpoint)
  console.log(`  Iteration: ${data.metadata.iteration}`)
  console.log(`  Timestamp: ${data.metadata.timestamp}`)
} else {
  console.log('No checkpoint specified, evaluating random network')
}

console.log(`\nRunning ${games} evaluation games...`)
const result = evaluate(network, DEFAULT_TRAINING_CONFIG, games)

console.log('\nResults:')
console.log(`  Win rates: ${JSON.stringify(result.winRates, null, 2)}`)
console.log(`  Average game length: ${result.avgGameLength.toFixed(1)} days`)
