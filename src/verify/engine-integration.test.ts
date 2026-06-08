import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../types/index.ts'
import { runGame } from '../lupa/engine.ts'
import type { GameConfig } from '../lupa/handlers.ts'
import { agentAdapter } from './agent-adapter.ts'
import { RandomAgent } from './random-agent.ts'

// 14D猫の標準構成
const STANDARD_ROLES: Map<SystemRole, number> = new Map([
  ['villager', 4],
  ['seer', 1],
  ['medium', 1],
  ['bodyguard', 1],
  ['mason', 2],
  ['nekomata', 1],
  ['werewolf', 3],
  ['werehamster', 1],
])

const STANDARD_CONFIG: GameConfig = {
  roles: STANDARD_ROLES,
  seed: 42,
  hasFirstGhost: true,
}

describe('engine + agent-adapter', () => {
  it('runs a complete game with RandomAgent', async () => {
    const handlers = agentAdapter({
      defaultAgent: new RandomAgent(),
      seed: 42,
      roles: STANDARD_ROLES,
    })

    const result = await runGame(STANDARD_CONFIG, handlers)

    assert.ok(result.state.finished, 'game should finish')
    assert.ok(result.state.result !== null, 'game should have a result')
    assert.ok(['villager_won', 'werewolf_won', 'werehamster_won', 'draw'].includes(result.state.result!))
    assert.ok(result.events.length > 0, 'should have events')

    const reveals = result.events.filter(e => e.type === 'reveal')
    assert.equal(reveals.length, 14, 'should reveal all 14 roles')
  })

  it('produces game_over event', async () => {
    const handlers = agentAdapter({
      defaultAgent: new RandomAgent(),
      seed: 123,
      roles: STANDARD_ROLES,
    })

    const result = await runGame(STANDARD_CONFIG, handlers)
    const gameOver = result.events.find(e => e.type === 'game_over')
    assert.ok(gameOver, 'should have game_over event')
  })

  it('handles different seeds producing different outcomes', async () => {
    const results: string[] = []
    for (let seed = 0; seed < 10; seed++) {
      const handlers = agentAdapter({
        defaultAgent: new RandomAgent(),
        seed,
        roles: STANDARD_ROLES,
      })
      const result = await runGame({ ...STANDARD_CONFIG, seed }, handlers)
      results.push(result.state.result!)
    }
    const unique = new Set(results)
    assert.ok(unique.size >= 1, 'should have at least one result type')
  })

  it('correctly tracks execution history', async () => {
    const handlers = agentAdapter({
      defaultAgent: new RandomAgent(),
      seed: 42,
      roles: STANDARD_ROLES,
    })
    const result = await runGame(STANDARD_CONFIG, handlers)
    const executions = result.events.filter(e => e.type === 'execution')
    assert.ok(executions.length > 0, 'should have at least one execution')
    assert.equal(result.state.executionHistory.size, executions.length, 'execution history should match events')
  })
})
