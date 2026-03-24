#!/usr/bin/env node
/**
 * 学習済みモデルでゲームを実行し、Howl形式で出力する
 *
 * Usage:
 *   npm run play
 *   npm run play -- --checkpoint ./checkpoints/final.json --seed 42
 *   npm run play -- --seed 42 --all-ml
 */

import type { SystemRole } from '../../types/index.ts'
import type { LupaConfig } from '../../lupa/types.ts'
import type { Strategy } from '../../lupa/strategy.ts'
import { runGame } from '../../lupa/engine.ts'
import { formatHowl } from '../../lupa/format.ts'
import { HeuristicStrategy } from '../../lupa/heuristic.ts'
import { createNetwork, DEFAULT_TRAINING_CONFIG } from './training.ts'
import { loadCheckpoint } from './ml/checkpoint.ts'
import { FenrirStrategy } from './policy.ts'

function parseArgs() {
  const args = process.argv.slice(2)
  let checkpoint: string | undefined
  let seed: number | undefined
  let allMl = false
  let rolesStr: string | undefined

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--checkpoint':
        checkpoint = args[++i]
        break
      case '--seed':
        seed = parseInt(args[++i])
        break
      case '--all-ml':
        allMl = true
        break
      case '--roles':
        rolesStr = args[++i]
        break
    }
  }

  return { checkpoint, seed, allMl, rolesStr }
}

const { checkpoint, seed, allMl, rolesStr } = parseArgs()
const network = createNetwork()

if (checkpoint) {
  const data = loadCheckpoint(network, checkpoint)
  console.error(`# Loaded checkpoint: iteration ${data.metadata.iteration} (${data.metadata.timestamp})`)
} else {
  console.error('# No checkpoint — using untrained network')
}

// 役職構成
const rolesConfig = rolesStr
  ? Object.fromEntries(rolesStr.split(',').map(s => {
      const [role, count] = s.split(':')
      return [role, parseInt(count)]
    }))
  : DEFAULT_TRAINING_CONFIG.roles

const roles = new Map(Object.entries(rolesConfig) as [SystemRole, number][])
const totalPlayers = Array.from(roles.values()).reduce((a, b) => a + b, 0)

// Strategy割り当て
const strategies = new Map<number, Strategy>()
const heuristic = new HeuristicStrategy()

for (let seat = 1; seat <= totalPlayers; seat++) {
  if (allMl) {
    strategies.set(seat, new FenrirStrategy(network, { explore: false }))
  } else {
    // 偶数seatがML、奇数seatがヒューリスティック
    if (seat % 2 === 0) {
      strategies.set(seat, new FenrirStrategy(network, { explore: false }))
    } else {
      strategies.set(seat, heuristic)
    }
  }
}

const config: LupaConfig = {
  roles,
  seed: seed ?? Math.floor(Math.random() * 100000),
  strategies,
  enableRetar: true,
}

const { events, state } = runGame(config)
const howl = formatHowl(events, state, config)

console.log(howl)
