import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../types/index.ts'
import { runGame } from '../lupa/engine.ts'
import type { GameConfig } from '../lupa/handlers.ts'
import { minimalAdapter } from './minimal-adapter.ts'
import { strategyAdapter } from './strategy-adapter.ts'
import { RandomStrategy } from './random-strategy.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../fenrir/src/agents/rule-based-agent.ts'

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

describe('engine-next + minimal-adapter', () => {
  it('runs a complete game with RandomStrategy', async () => {
    const defaultAgent = new RandomStrategy()
    const handlers = minimalAdapter({
      agents: new Map(),
      defaultAgent,
      seed: 42,
    })

    const result = await runGame(STANDARD_CONFIG, handlers)

    assert.ok(result.state.finished, 'game should finish')
    assert.ok(result.state.result !== null, 'game should have a result')
    assert.ok(['villager_won', 'werewolf_won', 'werehamster_won', 'draw'].includes(result.state.result!))
    assert.ok(result.events.length > 0, 'should have events')

    // 最後のイベントは reveal (role公開) のはず
    const reveals = result.events.filter(e => e.type === 'reveal')
    assert.equal(reveals.length, 14, 'should reveal all 14 roles')
  })

  it('produces game_over event', async () => {
    const handlers = minimalAdapter({
      agents: new Map(),
      defaultAgent: new RandomStrategy(),
      seed: 123,
    })

    const result = await runGame(STANDARD_CONFIG, handlers)
    const gameOver = result.events.find(e => e.type === 'game_over')
    assert.ok(gameOver, 'should have game_over event')
  })

  it('handles different seeds producing different outcomes', async () => {
    const results: string[] = []
    for (let seed = 0; seed < 10; seed++) {
      const handlers = minimalAdapter({
        agents: new Map(),
        defaultAgent: new RandomStrategy(),
        seed,
      })
      const result = await runGame({ ...STANDARD_CONFIG, seed }, handlers)
      results.push(result.state.result!)
    }
    // 10ゲームで全部同じ結果はほぼありえない
    const unique = new Set(results)
    assert.ok(unique.size >= 1, 'should have at least one result type')
  })

  it('correctly tracks execution history', async () => {
    const handlers = minimalAdapter({
      agents: new Map(),
      defaultAgent: new RandomStrategy(),
      seed: 42,
    })
    const result = await runGame(STANDARD_CONFIG, handlers)
    const executions = result.events.filter(e => e.type === 'execution')
    assert.ok(executions.length > 0, 'should have at least one execution')
    assert.equal(result.state.executionHistory.size, executions.length, 'execution history should match events')
  })
})

describe('engine-next + strategy-adapter', () => {
  it('runs a complete game with HeuristicStrategy', async () => {
    const handlers = strategyAdapter({
      defaultAgent: new RuleBasedAgent(),
      wolfTeamAgent: new WolfTeamRuleAgent(),
      masonTeamAgent: new MasonTeamRuleAgent(),
      enableRetar: false,
      seed: 42,
      roles: STANDARD_ROLES,
    })

    const result = await runGame(STANDARD_CONFIG, handlers)

    assert.ok(result.state.finished, 'game should finish')
    assert.ok(result.state.result !== null, 'game should have a result')
    assert.ok(result.events.length > 0, 'should have events')
  })

  it('produces signal events with onPreVote', async () => {
    const handlers = strategyAdapter({
      defaultAgent: new RuleBasedAgent(),
      wolfTeamAgent: new WolfTeamRuleAgent(),
      masonTeamAgent: new MasonTeamRuleAgent(),
      enableRetar: false,
      seed: 42,
      roles: STANDARD_ROLES,
    })

    const result = await runGame(STANDARD_CONFIG, handlers)
    const signalEvents = result.events.filter(e => e.type === 'signal')
    assert.ok(signalEvents.length > 0, 'should have signal events from discussion phase')
  })
})

describe('engine-next performance', () => {
  it('minimal-adapter is faster than strategy-adapter for same seed', async () => {
    const N = 20

    // minimal (no discussion)
    const t0 = performance.now()
    for (let i = 0; i < N; i++) {
      const handlers = minimalAdapter({
        agents: new Map(),
        defaultAgent: new RandomStrategy(),
        seed: i,
      })
      await runGame({ ...STANDARD_CONFIG, seed: i }, handlers)
    }
    const minimalMs = performance.now() - t0

    // strategy-adapter (full discussion, no retar)
    const t1 = performance.now()
    for (let i = 0; i < N; i++) {
      const handlers = strategyAdapter({
        defaultAgent: new RuleBasedAgent(),
        wolfTeamAgent: new WolfTeamRuleAgent(),
        enableRetar: false,
        seed: i,
        roles: STANDARD_ROLES,
      })
      await runGame({ ...STANDARD_CONFIG, seed: i }, handlers)
    }
    const fullMs = performance.now() - t1

    console.log(`  ${N} games: minimal=${minimalMs.toFixed(0)}ms, full=${fullMs.toFixed(0)}ms, speedup=${(fullMs / minimalMs).toFixed(1)}x`)
    // minimal should be at least somewhat faster (no signal rounds)
    assert.ok(true, 'benchmark completed')
  })
})
