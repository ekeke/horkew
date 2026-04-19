/**
 * Phase 2 テスト: RandomCommandAgent / AsyncRemoteAgent
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GameState } from '../../../lupa/types.ts'
import {
  createCommandAdapterExt, type CommandAdapterExt, type Command,
} from '../adapters/command/command-types.ts'
import { RandomCommandAgent } from './random-command-agent.ts'
import { AsyncRemoteAgent, type PendingDecision } from './async-remote-agent.ts'

// ============================================================
// フィクスチャ
// ============================================================

function dummyState(): GameState<CommandAdapterExt> {
  return {
    players: [],
    day: 1,
    phase: 'day',
    finished: false,
    result: null,
    executionHistory: new Map(),
    commander: null,
    ext: createCommandAdapterExt(),
  }
}

const SAMPLE_LEGAL: Command[] = [
  { type: 'skip' },
  { type: 'role_co', claim: { type: 'seer_co', results: [] } },
  { type: 'role_co', claim: { type: 'medium_co' } },
]

// ============================================================
// RandomCommandAgent
// ============================================================

test('RandomCommandAgent: 合法手から 1 つを返す', async () => {
  const agent = new RandomCommandAgent(42)
  const state = dummyState()
  const result = await agent.decide(state, 1, SAMPLE_LEGAL)
  assert.ok(SAMPLE_LEGAL.some(c => JSON.stringify(c) === JSON.stringify(result.cmd)))
  assert.ok(typeof result.log === 'string' && result.log.length > 0, 'log が付与される')
})

test('RandomCommandAgent: 同一 seed は同一結果（決定性）', async () => {
  const a = new RandomCommandAgent(123)
  const b = new RandomCommandAgent(123)
  const state = dummyState()
  const ra = await a.decide(state, 1, SAMPLE_LEGAL)
  const rb = await b.decide(state, 1, SAMPLE_LEGAL)
  assert.deepEqual(ra, rb)
})

test('RandomCommandAgent: legal が空なら throw', async () => {
  const agent = new RandomCommandAgent(1)
  const state = dummyState()
  await assert.rejects(
    async () => agent.decide(state, 1, []),
    /legal commands is empty/,
  )
})

// ============================================================
// AsyncRemoteAgent
// ============================================================

test('AsyncRemoteAgent: decide() は submit されるまで resolve しない', async () => {
  const agent = new AsyncRemoteAgent()
  const state = dummyState()
  let resolved = false
  const p = agent.decide(state, 1, SAMPLE_LEGAL).then((r) => {
    resolved = true
    return r
  })

  await new Promise(r => setImmediate(r))
  assert.equal(resolved, false, 'まだ未 submit なら resolve しない')

  agent.submit({ type: 'skip' })
  const result = await p
  assert.deepEqual(result.cmd, { type: 'skip' })
  assert.ok(typeof result.log === 'string', 'log が付与される')
})

test('AsyncRemoteAgent: subscribe リスナーは pending 変化を受け取る', async () => {
  const agent = new AsyncRemoteAgent()
  const state = dummyState()
  const events: (PendingDecision | null)[] = []
  const unsub = agent.subscribe(p => events.push(p))

  // 初期通知（null）
  assert.equal(events.length, 1)
  assert.equal(events[0], null)

  const p = agent.decide(state, 3, SAMPLE_LEGAL)
  // pending 変化
  assert.equal(events.length, 2)
  assert.equal(events[1]?.mySeat, 3)

  agent.submit({ type: 'skip' })
  await p
  // resolve 後の null 通知
  assert.equal(events.length, 3)
  assert.equal(events[2], null)

  unsub()
})

test('AsyncRemoteAgent: 未 pending での submit は throw', () => {
  const agent = new AsyncRemoteAgent()
  assert.throws(
    () => agent.submit({ type: 'skip' }),
    /no pending decision/,
  )
})

test('AsyncRemoteAgent: 非合法 cmd の submit は throw', async () => {
  const agent = new AsyncRemoteAgent()
  const state = dummyState()
  // 2 手以上で pending が立つ（1 手の場合は自動決定される）
  const p = agent.decide(state, 1, [{ type: 'skip' }, { type: 'no_action' }])
  assert.throws(
    () => agent.submit({ type: 'role_co', claim: { type: 'medium_co' } }),
    /not in legal list/,
  )
  // pending は生きたまま → 正しい cmd で解消
  agent.submit({ type: 'skip' })
  await p
})

test('AsyncRemoteAgent: legal が 1 つのみなら pending 化せず自動決定', async () => {
  const agent = new AsyncRemoteAgent()
  const state = dummyState()
  const only: Command = { type: 'no_action' }
  const result = await agent.decide(state, 1, [only])
  assert.deepEqual(result.cmd, only)
  assert.equal(agent.getPending(), null)
})

test('AsyncRemoteAgent: pending 中の二重 decide は throw', async () => {
  const agent = new AsyncRemoteAgent()
  const state = dummyState()
  const p = agent.decide(state, 1, SAMPLE_LEGAL)
  await assert.rejects(
    async () => agent.decide(state, 2, SAMPLE_LEGAL),
    /another decision is pending/,
  )
  agent.submit({ type: 'skip' })
  await p
})

test('AsyncRemoteAgent: unsubscribe でリスナー解除', async () => {
  const agent = new AsyncRemoteAgent()
  const state = dummyState()
  let count = 0
  const unsub = agent.subscribe(() => count++)
  assert.equal(count, 1)  // 初期通知
  unsub()
  const p = agent.decide(state, 1, SAMPLE_LEGAL)
  assert.equal(count, 1, '解除後は通知なし')
  agent.submit({ type: 'skip' })
  await p
})
