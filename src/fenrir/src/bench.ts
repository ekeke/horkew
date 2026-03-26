#!/usr/bin/env node
/**
 * ボトルネック計測: ゲーム生成の各フェーズの所要時間を分解
 */

import type { SystemRole } from '../../types/index.ts'
import type { LupaConfig } from '../../lupa/types.ts'
import { runGame } from '../../lupa/engine.ts'
import { OBSERVATION_SIZE } from './observation.ts'
import { FenrirStrategy, WolfTeamStrategy, MasonTeamStrategy } from './policy.ts'
import { createNetwork, createWolfTeamNetwork, createMasonTeamNetwork, createTfNetwork } from './training.ts'
import { encodeObservation } from './observation.ts'

// 14D猫: 14人、初日犠牲者あり、完全再投票→引き分け
const roles = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])
const totalPlayers = 14
const hasFirstGhost = true
const revoteConfig = { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const }

const N = 5

const baseConfig = { roles, hasFirstGhost, revoteConfig }

// 1. Heuristic only (no ML, no Retar)
console.log('=== Heuristic only (no ML, no Retar) ===')
{
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    const config: LupaConfig = { ...baseConfig, seed: i }
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
    const config: LupaConfig = { ...baseConfig, seed: i, enableRetar: true }
    runGame(config)
  }
  const ms = performance.now() - t0
  console.log(`  ${N} games: ${ms.toFixed(0)}ms (${(ms / N).toFixed(1)}ms/game)`)
}

// 3. ML + Retar (full)
console.log('=== ML + Retar (full) ===')
{
  const network = createNetwork()
  const wolfTeamNet = createWolfTeamNetwork()
  const masonTeamNet = createMasonTeamNetwork()
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    const strategies = new Map<number, any>()
    for (let seat = 1; seat <= totalPlayers; seat++) {
      strategies.set(seat, new FenrirStrategy(network, { explore: true }))
    }
    const config: LupaConfig = {
      ...baseConfig, seed: i, strategies, enableRetar: true,
      wolfTeamStrategy: new WolfTeamStrategy(wolfTeamNet, { explore: true }),
      masonTeamStrategy: new MasonTeamStrategy(masonTeamNet, { explore: true }),
    }
    runGame(config)
  }
  const ms = performance.now() - t0
  console.log(`  ${N} games: ${ms.toFixed(0)}ms (${(ms / N).toFixed(1)}ms/game)`)
}

// 4. ML only (no Retar)
console.log('=== ML only (no Retar) ===')
{
  const network = createNetwork()
  const wolfTeamNet = createWolfTeamNetwork()
  const masonTeamNet = createMasonTeamNetwork()
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    const strategies = new Map<number, any>()
    for (let seat = 1; seat <= totalPlayers; seat++) {
      strategies.set(seat, new FenrirStrategy(network, { explore: true }))
    }
    const config: LupaConfig = {
      ...baseConfig, seed: i, strategies,
      wolfTeamStrategy: new WolfTeamStrategy(wolfTeamNet, { explore: true }),
      masonTeamStrategy: new MasonTeamStrategy(masonTeamNet, { explore: true }),
    }
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
  const config: LupaConfig = { ...baseConfig, seed: 42 }
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
  const tfNet = createTfNetwork()
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
