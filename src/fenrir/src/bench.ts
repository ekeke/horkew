#!/usr/bin/env node
/**
 * ボトルネック計測: ゲーム生成の各フェーズの所要時間を分解
 */

import type { SystemRole } from '../../types/index.ts'
import type { LupaConfig } from '../../lupa/types.ts'
import { runGame } from '../../lupa/engine.ts'
import { NeuralNetwork } from './ml/nn.ts'
import { TfNeuralNetwork } from './ml/nn-tf.ts'
import { OBSERVATION_SIZE } from './observation.ts'
import { HEAD_SIZES } from './action.ts'
import { FenrirStrategy } from './policy.ts'
import { encodeObservation } from './observation.ts'

const roles = new Map<SystemRole, number>([
  ['werewolf', 2], ['villager', 4], ['seer', 1],
  ['medium', 1], ['bodyguard', 1], ['mason', 2],
])
const totalPlayers = 11

function createNetwork(): NeuralNetwork {
  return new NeuralNetwork({
    inputSize: OBSERVATION_SIZE,
    hiddenSizes: [512, 256],
    heads: {
      night: HEAD_SIZES.night,
      claim: HEAD_SIZES.claim,
      vote: HEAD_SIZES.vote,
      comm: HEAD_SIZES.comm,
      leader: HEAD_SIZES.leader,
      target: HEAD_SIZES.target,
    },
  })
}

const N = 5

// 1. Heuristic only (no ML, no Retar)
console.log('=== Heuristic only (no ML, no Retar) ===')
{
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    const config: LupaConfig = { roles, seed: i }
    runGame(config)
  }
  const ms = performance.now() - t0
  console.log(`  ${N} games: ${ms.toFixed(0)}ms (${(ms / N).toFixed(1)}ms/game)`)
}

// 2. Heuristic + Retar (no ML)
console.log('=== Heuristic + Retar ===')
{
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    const config: LupaConfig = { roles, seed: i, enableRetar: true }
    runGame(config)
  }
  const ms = performance.now() - t0
  console.log(`  ${N} games: ${ms.toFixed(0)}ms (${(ms / N).toFixed(1)}ms/game)`)
}

// 3. ML + Retar (full)
console.log('=== ML + Retar (full) ===')
{
  const network = createNetwork()
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    const strategies = new Map<number, any>()
    for (let seat = 1; seat <= totalPlayers; seat++) {
      strategies.set(seat, new FenrirStrategy(network, { explore: true }))
    }
    const config: LupaConfig = { roles, seed: i, strategies, enableRetar: true }
    runGame(config)
  }
  const ms = performance.now() - t0
  console.log(`  ${N} games: ${ms.toFixed(0)}ms (${(ms / N).toFixed(1)}ms/game)`)
}

// 4. ML only (no Retar)
console.log('=== ML only (no Retar) ===')
{
  const network = createNetwork()
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    const strategies = new Map<number, any>()
    for (let seat = 1; seat <= totalPlayers; seat++) {
      strategies.set(seat, new FenrirStrategy(network, { explore: true }))
    }
    const config: LupaConfig = { roles, seed: i, strategies }
    runGame(config)
  }
  const ms = performance.now() - t0
  console.log(`  ${N} games: ${ms.toFixed(0)}ms (${(ms / N).toFixed(1)}ms/game)`)
}

// 5. NN forward only (isolated)
console.log('=== NN forward only (1000 calls) ===')
{
  const network = createNetwork()
  const input = new Float32Array(OBSERVATION_SIZE).fill(0.1)
  const t0 = performance.now()
  for (let i = 0; i < 1000; i++) {
    network.forward(input)
  }
  const ms = performance.now() - t0
  console.log(`  1000 forwards: ${ms.toFixed(0)}ms (${(ms / 1000).toFixed(2)}ms/call)`)
}

// 6. encodeObservation only (isolated)
console.log('=== encodeObservation only (1000 calls) ===')
{
  const config: LupaConfig = { roles, seed: 42 }
  const { state } = runGame(config)
  const ctx = {
    mySeat: 1, myRole: 'villager' as SystemRole, myPlayer: state.players[0],
    day: 3, phase: 'day' as const, alivePlayers: state.players.filter(p => p.alive).map(p => p.seat),
    publicEvents: [], signals: [], commander: null, proposals: [],
    rng: null as any, gameState: state, lastExecutedSeat: null,
    retarPossibilities: null,
    wolfTeammates: null, knownWolves: null, knownHamster: null, masonPartner: null,
    revoteRound: null, revoteCandidates: null,
  }
  const t0 = performance.now()
  for (let i = 0; i < 1000; i++) {
    encodeObservation(ctx)
  }
  const ms = performance.now() - t0
  console.log(`  1000 encodes: ${ms.toFixed(0)}ms (${(ms / 1000).toFixed(2)}ms/call)`)
}

// 7. TF.js NN forward only (isolated)
console.log('=== TF.js NN forward only (1000 calls) ===')
{
  const tfNet = new TfNeuralNetwork({
    inputSize: OBSERVATION_SIZE,
    hiddenSizes: [512, 256],
    heads: {
      night: HEAD_SIZES.night,
      claim: HEAD_SIZES.claim,
      vote: HEAD_SIZES.vote,
      comm: HEAD_SIZES.comm,
      leader: HEAD_SIZES.leader,
      target: HEAD_SIZES.target,
    },
  })
  const input = new Float32Array(OBSERVATION_SIZE).fill(0.1)
  // warmup
  for (let i = 0; i < 10; i++) tfNet.forward(input)

  const t0 = performance.now()
  for (let i = 0; i < 1000; i++) {
    tfNet.forward(input)
  }
  const ms = performance.now() - t0
  console.log(`  1000 forwards: ${ms.toFixed(0)}ms (${(ms / 1000).toFixed(2)}ms/call)`)
  tfNet.dispose()
}
