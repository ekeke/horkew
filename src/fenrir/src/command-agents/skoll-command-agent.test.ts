/**
 * SkollCommandAgent ユニットテスト
 *
 * - 未対応フェーズ（night/discussion/commander/cco）で fallback に委譲されること
 * - vote フェーズで retarCache 未設定時は fallback（no-retar-cache）
 * - vote フェーズで vote コマンドが legal に無い時は fallback（no-vote-legal）
 * - integration: CommandAdapter + SkollCommandAgent でゲーム完走し comment イベントが出る
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../../types/index.ts'
import type { GameState, PlayerState, GameEvent } from '../../../lupa/types.ts'
import type { GameConfig } from '../../../lupa/handlers.ts'
import { runGame } from '../../../lupa/engine.ts'
import {
  createCommandAdapterExt, type CommandAdapterExt, type Command,
} from '../adapters/command/command-types.ts'
import { CommandAdapter } from '../adapters/command/command-adapter.ts'
import { SkollCommandAgent } from './skoll-command-agent.ts'
import { RandomCommandAgent } from './random-command-agent.ts'

// ============================================================
// 固定 fallback: 常に legal[0] を返す（テスト決定性）
// ============================================================

class FixedFallback {
  readonly name = 'fixed'
  async decide(
    _state: unknown, _seat: number, legal: readonly Command[],
  ): Promise<{ cmd: Command, log: string }> {
    return { cmd: legal[0], log: 'fixed' }
  }
}

// ============================================================
// フィクスチャ
// ============================================================

function makePlayer(seat: number, role: SystemRole): PlayerState {
  return {
    seat, name: `P${seat}`, role, alive: true,
    claimedRole: null, claimedDay: null,
    divineHistory: new Map(), guardHistory: new Map(),
    fakeDivineHistory: new Map(), forecastTarget: null,
  }
}

function makeState(
  phase: CommandAdapterExt['currentPhase'] = 'vote',
): GameState<CommandAdapterExt> {
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
// フェーズ委譲
// ============================================================

test('SkollCommandAgent: night フェーズは fallback に委譲', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('night')
  const legal: Command[] = [{ type: 'no_action' }, { type: 'divine', target: 2 }]
  const result = await agent.decide(state, 1, legal)
  assert.deepEqual(result.cmd, legal[0])
  assert.match(result.log ?? '', /fallback→fixed/)
})

test('SkollCommandAgent: discussion フェーズは fallback に委譲', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('discussion')
  const legal: Command[] = [{ type: 'skip' }]
  const result = await agent.decide(state, 1, legal)
  assert.deepEqual(result.cmd, legal[0])
  assert.match(result.log ?? '', /fallback/)
})

test('SkollCommandAgent: commander フェーズは fallback', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('commander')
  const legal: Command[] = [{ type: 'request_co', category: 'seer' }]
  const result = await agent.decide(state, 1, legal)
  assert.deepEqual(result.cmd, legal[0])
})

test('SkollCommandAgent: cco フェーズは fallback', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('cco')
  const legal: Command[] = [{ type: 'cco_skip' }]
  const result = await agent.decide(state, 1, legal)
  assert.deepEqual(result.cmd, legal[0])
})

// ============================================================
// Vote フェーズ
// ============================================================

test('SkollCommandAgent: vote で retarCache 未設定 → no-retar-cache fallback', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('vote')
  // retarCache は createCommandAdapterExt で null
  const legal: Command[] = [
    { type: 'vote', target: 2 },
    { type: 'vote', target: 3 },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.deepEqual(result.cmd, legal[0])
  assert.match(result.log ?? '', /no-retar-cache/)
})

test('SkollCommandAgent: vote legal が空 → no-vote-legal fallback', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('vote')
  const legal: Command[] = [{ type: 'skip' }]  // vote 無し
  const result = await agent.decide(state, 1, legal)
  assert.match(result.log ?? '', /no-vote-legal/)
})

test('SkollCommandAgent: legal 空なら throw', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('vote')
  await assert.rejects(
    async () => agent.decide(state, 1, []),
    /legal commands is empty/,
  )
})

// ============================================================
// Integration: CommandAdapter + SkollCommandAgent で完走
// ============================================================

test('SkollCommandAgent + CommandAdapter: 小規模構成でゲーム完走 + comment emit', async () => {
  const roleConfig = new Map<SystemRole, number>([
    ['seer', 1], ['villager', 2], ['werewolf', 1], ['fanatic', 1],
  ])
  const seed = 42
  const adapter = new CommandAdapter({
    agents: new Map(),
    defaultAgent: new SkollCommandAgent({ seed, fallback: new RandomCommandAgent(seed) }),
    roles: roleConfig,
    seed,
  })
  const config: GameConfig = { roles: roleConfig, seed }
  const result = await runGame(config, adapter)

  assert.ok(result.state.finished, 'ゲーム完走')

  // comment イベントが少なくとも 1 つ出ている（skoll の判断ログ）
  const comments = result.events.filter((e): e is GameEvent =>
    (e as GameEvent).type === 'comment',
  )
  assert.ok(comments.length > 0, 'comment イベントが出力されている')

  // skoll か random のログが含まれる
  const agentComments = comments.filter(c =>
    'text' in c && (c.text.includes('skoll') || c.text.includes('random')),
  )
  assert.ok(agentComments.length > 0, 'agent 判断ログがコメントに含まれる')
})

test('SkollCommandAgent + CommandAdapter: vote フェーズで skoll ログが残る', async () => {
  // retarCache が populate される十分な構成。14 人構成は重いので 8 人で。
  const roleConfig = new Map<SystemRole, number>([
    ['seer', 1], ['medium', 1], ['bodyguard', 1], ['villager', 2],
    ['werewolf', 2], ['fanatic', 1],
  ])
  const seed = 13
  const adapter = new CommandAdapter({
    agents: new Map(),
    defaultAgent: new SkollCommandAgent({ seed, fallback: new RandomCommandAgent(seed) }),
    roles: roleConfig,
    seed,
  })
  const config: GameConfig = { roles: roleConfig, seed }
  const result = await runGame(config, adapter)

  assert.ok(result.state.finished)

  const voteLogs = result.events.filter((e): e is GameEvent => {
    if ((e as GameEvent).type !== 'comment') return false
    const text = (e as { text?: string }).text ?? ''
    return text.includes('vote') && text.includes('skoll')
  })
  // skoll の vote 判断が少なくとも数件あるはず（retar が通れば bestVote、無ければ vote-fallback）
  assert.ok(voteLogs.length > 0, `vote 判断ログが残る (found ${voteLogs.length})`)
})
