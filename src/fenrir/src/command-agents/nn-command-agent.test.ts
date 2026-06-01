/**
 * NNCommandAgent ユニットテスト + 統合テスト
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../../types/index.ts'
import type { GameState, PlayerState } from '../../../lupa/types.ts'
import type { GameConfig } from '../../../lupa/handlers.ts'
import { runGame } from '../../../lupa/engine.ts'
import {
  createCommandAdapterExt, type CommandAdapterExt, type Command,
} from '../adapters/command/command-types.ts'
import { CommandAdapter } from '../adapters/command/command-adapter.ts'
import { NNCommandAgent, factionOf } from './nn-command-agent.ts'
import { RandomCommandNN, type CommandNN, type CommandNNOutput, type PerspectiveView } from './command-nn.ts'

// ============================================================
// フィクスチャ
// ============================================================

function makePlayer(seat: number, role: SystemRole): PlayerState {
  return {
    seat, name: `P${seat}`, role, alive: true,
    claimedRole: null, claimedDay: null,
    divineHistory: new Map(), guardHistory: new Map(),
    attackHistory: new Map(), mediumHistory: new Map(),
    fakeDivineHistory: new Map(), forecastTarget: null,
  }
}

function makeState(phase: CommandAdapterExt['currentPhase'] = 'vote'): GameState<CommandAdapterExt> {
  const ext = createCommandAdapterExt()
  ext.currentPhase = phase
  return {
    players: [
      makePlayer(1, 'seer'),
      makePlayer(2, 'villager'),
      makePlayer(3, 'werewolf'),
      makePlayer(4, 'villager'),
    ],
    day: 1, phase: 'day', finished: false, result: null,
    executionHistory: new Map(), commander: null, ext,
  }
}

// ============================================================
// factionOf
// ============================================================

test('factionOf: 役職別の陣営判定', () => {
  assert.equal(factionOf('villager'), 'village')
  assert.equal(factionOf('seer'), 'village')
  assert.equal(factionOf('werewolf'), 'wolf')
  assert.equal(factionOf('fanatic'), 'wolf')
  assert.equal(factionOf('werehamster'), 'hamster')
  assert.equal(factionOf('immoralist'), 'hamster')
})

// ============================================================
// RandomCommandNN
// ============================================================

test('RandomCommandNN: value=0.5、policyPrior は legal.length と一致', () => {
  const nn = new RandomCommandNN(42)
  const state = makeState()
  const view: PerspectiveView = {
    mySeat: 1, myRole: 'seer', state, events: [],
  }
  const legal: Command[] = [
    { type: 'vote', target: 2 },
    { type: 'vote', target: 3 },
    { type: 'vote', target: 4 },
  ]
  const out = nn.evaluate(view, legal)
  assert.equal(out.value, 0.5)
  assert.equal(out.policyPrior.length, 3)
  assert.ok(out.opponentDist.size >= 4, 'opponentDist is populated per seat')
})

test('RandomCommandNN: 同一 seed は同一結果（決定性）', () => {
  const state = makeState()
  const view: PerspectiveView = { mySeat: 1, myRole: 'seer', state, events: [] }
  const legal: Command[] = [{ type: 'vote', target: 2 }, { type: 'vote', target: 3 }]
  const a = new RandomCommandNN(7).evaluate(view, legal)
  const b = new RandomCommandNN(7).evaluate(view, legal)
  assert.deepEqual([...a.policyPrior], [...b.policyPrior])
})

// ============================================================
// NNCommandAgent 基本
// ============================================================

test('NNCommandAgent: 合法手 1 つなら評価省略', async () => {
  const agent = new NNCommandAgent({ seed: 42 })
  const state = makeState('night')
  const legal: Command[] = [{ type: 'no_action' }]
  const result = await agent.decide(state, 1, legal)
  assert.deepEqual(result.cmd, legal[0])
  assert.match(result.log ?? '', /only legal/)
})

test('NNCommandAgent: 合法手 0 なら throw', async () => {
  const agent = new NNCommandAgent({ seed: 42 })
  const state = makeState('vote')
  await assert.rejects(
    async () => agent.decide(state, 1, []),
    /legal commands is empty/,
  )
})

test('NNCommandAgent: 複数合法手から 1 つ選ぶ（stub NN）', async () => {
  const agent = new NNCommandAgent({ seed: 42 })
  const state = makeState('vote')
  const legal: Command[] = [
    { type: 'vote', target: 2 },
    { type: 'vote', target: 3 },
    { type: 'vote', target: 4 },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.ok(legal.includes(result.cmd))
  assert.match(result.log ?? '', /nn\[random-nn\]/)
})

test('NNCommandAgent: NN throw なら fallback', async () => {
  const throwingNN: CommandNN = {
    name: 'throwing',
    evaluate: (): CommandNNOutput => { throw new Error('test-throw') },
  }
  // fallback として常に skip を返す agent
  const skipFallback: CommandAgentStub = {
    name: 'test-skip',
    async decide(_s, _seat, legal) {
      return { cmd: legal.find(c => c.type === 'skip') ?? legal[0], log: 'fallback-skip' }
    },
  }
  const agent = new NNCommandAgent({ nn: throwingNN, fallback: skipFallback })
  const state = makeState('discussion')
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.match(result.log ?? '', /fallback.*nn-throw/)
})

// ============================================================
// Integration: CommandAdapter + NNCommandAgent (stub NN) で完走
// ============================================================

test('NNCommandAgent + CommandAdapter: 小構成でゲーム完走', async () => {
  const roleConfig = new Map<SystemRole, number>([
    ['seer', 1], ['villager', 2], ['werewolf', 1], ['fanatic', 1],
  ])
  const seed = 42
  const adapter = new CommandAdapter({
    agents: new Map(),
    defaultAgent: new NNCommandAgent({ seed }),
    roles: roleConfig,
    seed,
  })
  const config: GameConfig = { roles: roleConfig, seed }
  const result = await runGame(config, adapter)
  assert.ok(result.state.finished, 'ゲーム完走')
  assert.ok(
    ['villager_won', 'werewolf_won', 'werehamster_won', 'draw'].includes(result.state.result ?? ''),
    `result=${result.state.result}`,
  )

  // nn ログが出ているはず
  const nnLogs = result.events.filter(e => {
    if ((e as { type: string }).type !== 'comment') return false
    const text = (e as { text?: string }).text ?? ''
    return text.includes('nn[')
  })
  assert.ok(nnLogs.length > 0, `nn ログが出ている (found ${nnLogs.length})`)
})

// ============================================================
// stub 型 (import 循環回避のため local 定義)
// ============================================================

type CommandAgentStub = {
  readonly name: string
  decide(
    state: Readonly<GameState<CommandAdapterExt>>,
    mySeat: number,
    legal: readonly Command[],
    events?: readonly unknown[],
  ): Promise<{ cmd: Command, log?: string }>
}
