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

test('SkollCommandAgent: night フェーズ 非役職席は no_action を選ぶ', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('night')
  // seat 2 は villager (makeState で設定)
  const legal: Command[] = [{ type: 'no_action' }]
  const result = await agent.decide(state, 2, legal)
  assert.deepEqual(result.cmd, legal[0])
  assert.match(result.log ?? '', /villager.*no-role-action/)
})

test('SkollCommandAgent: night 狼 non-leader は no_action (legal が 1 手)', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('night')
  // seat 3 は werewolf。leader 判定は legal で既に絞られている前提
  const legal: Command[] = [{ type: 'no_action' }]
  const result = await agent.decide(state, 3, legal)
  assert.deepEqual(result.cmd, legal[0])
  assert.match(result.log ?? '', /non-leader/)
})

test('SkollCommandAgent: night seer は retarCache 無しで fallback', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('night')  // retarCache 未設定
  const legal: Command[] = [{ type: 'no_action' }, { type: 'divine', target: 2 }]
  const result = await agent.decide(state, 1, legal)
  // retarCache 無いので RuleBased を呼べず fallback
  assert.match(result.log ?? '', /no-retar-cache/)
})

test('SkollCommandAgent: discussion 真 seer は未 CO なら seer_co を出す', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('discussion')
  // seat 1 = seer、未 CO（makeState で claimedRole=null）
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.equal(result.cmd.type, 'role_co')
  assert.match(result.log ?? '', /seer.*initial CO/)
})

test('SkollCommandAgent: discussion 村人は潜伏 (skip)', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('discussion')
  // seat 2 = villager
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 2, legal)
  assert.equal(result.cmd.type, 'skip')
  assert.match(result.log ?? '', /villager.*hide/)
})

test('SkollCommandAgent: discussion 単独狼は占い騙り CO (fake-seer)', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('discussion')
  // seat 3 = werewolf（単独）→ electVillainClaims で 'seer' 割当
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 3, legal)
  assert.equal(result.cmd.type, 'role_co')
  assert.match(result.log ?? '', /fake-seer.*initial CO/)
  // plan が populate されていること
  assert.equal(state.ext.villainClaimPlan.get(3), 'seer')
})

test('SkollCommandAgent: discussion 2 匹狼は seer 騙り + medium 騙り に分担', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('discussion')
  // seat4 を werewolf に昇格（seat3 と seat4 が wolf）
  state.players[3].role = 'werewolf'
  // seat3 の legal（CO 済でないので empty seer_co）
  const legalSeat3: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'seer_co', results: [] } },
  ]
  const r3 = await agent.decide(state, 3, legalSeat3)
  assert.match(r3.log ?? '', /fake-seer.*initial CO/)
  assert.equal(state.ext.villainClaimPlan.get(3), 'seer')
  assert.equal(state.ext.villainClaimPlan.get(4), 'medium')
})

test('SkollCommandAgent: 狂信者は skoll 不能時は hide (skip)', async () => {
  // 独立エージェント化により、fanatic はターン毎に skoll で判断するようになった。
  // 本テスト setup は retarCache 未構築なので lookahead が -Infinity を返し、
  // fallback で hide → skip となる。villainClaimPlan は狼のみ登録なので fanatic 用 entry 無し。
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('discussion')
  state.players[1].role = 'bodyguard'
  state.players[3].role = 'fanatic'
  const legal: Command[] = [{ type: 'skip' }]
  const result = await agent.decide(state, 4, legal)
  assert.equal(result.cmd.type, 'skip')
  // fanatic は独立エージェントなので villainClaimPlan には入らない（狼のみ対象）
  assert.equal(state.ext.villainClaimPlan.has(4), false)
})

test('SkollCommandAgent: 狐・背徳は独立エージェント、skoll 不能時は hide', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('discussion')
  state.players[1].role = 'werehamster'
  state.players[3].role = 'immoralist'
  const legalSkip: Command[] = [{ type: 'skip' }]
  const r2 = await agent.decide(state, 2, legalSkip)
  assert.equal(r2.cmd.type, 'skip')
  assert.equal(state.ext.villainClaimPlan.has(2), false)
  const r4 = await agent.decide(state, 4, legalSkip)
  assert.equal(r4.cmd.type, 'skip')
  assert.equal(state.ext.villainClaimPlan.has(4), false)
})

test('SkollCommandAgent: commander 未 CO の役職があれば request_co', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('commander')
  // makeState: seat1=seer, seat2=villager, seat3=werewolf, seat4=villager
  // events 空なので seer が未 CO → request_co seer
  const legal: Command[] = [
    { type: 'request_co', category: 'seer' },
    { type: 'request_co', category: 'medium' },
    { type: 'designate_execution', target: 3 },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.equal(result.cmd.type, 'request_co')
  assert.match(result.log ?? '', /request-co seer/)
})

test('SkollCommandAgent: commander setup に無い役職は request しない', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('commander')
  // medium は state に居ない (makeState に medium なし)
  // seer は居るが events 空 = 未 CO → request_co seer が優先
  const legal: Command[] = [
    { type: 'request_co', category: 'medium' },
    { type: 'request_co', category: 'seer' },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.equal(result.cmd.type, 'request_co')
  if (result.cmd.type === 'request_co') {
    assert.equal(result.cmd.category, 'seer', 'medium は setup に無いので seer を要求')
  }
})

test('SkollCommandAgent: cco 真 seer は未 CO なら cco_full を出す', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('cco')
  // seat 1 = seer, 未 CO
  const legal: Command[] = [
    { type: 'cco_skip' },
    { type: 'cco_full', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.equal(result.cmd.type, 'cco_full')
  assert.match(result.log ?? '', /seer.*last-chance/)
})

test('SkollCommandAgent: cco 狼は cco_skip', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('cco')
  const legal: Command[] = [{ type: 'cco_skip' }]
  const result = await agent.decide(state, 3, legal)
  assert.equal(result.cmd.type, 'cco_skip')
  assert.match(result.log ?? '', /werewolf.*stay-silent/)
})

test('SkollCommandAgent: cco 未 CO 真 mason は真相方付き mason_co を選ぶ', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('cco')
  // seat 2 を mason に、seat 4 を mason (partner) に書き換え
  state.players[1].role = 'mason'
  state.players[3].role = 'mason'
  const legal: Command[] = [
    { type: 'cco_skip' },
    { type: 'cco_full', claim: { type: 'mason_co', partner: 1 } },  // 偽相方
    { type: 'cco_full', claim: { type: 'mason_co', partner: 3 } },  // 偽相方
    { type: 'cco_full', claim: { type: 'mason_co', partner: 4 } },  // 真相方
  ]
  const result = await agent.decide(state, 2, legal)
  assert.equal(result.cmd.type, 'cco_full')
  if (result.cmd.type === 'cco_full' && result.cmd.claim.type === 'mason_co') {
    assert.equal(result.cmd.claim.partner, 4, '真相方の席を選ぶ')
  }
  assert.match(result.log ?? '', /mason.*partner=seat4/)
})

test('SkollCommandAgent: commander skip が legal にあり analysis 不能時に skip', async () => {
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('commander')
  // retarCache 未設定 → no-retar-cache → skip 経由
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'request_co', category: 'seer' },
  ]
  // seer が生存し events 空 → Step A で request_co seer が先に選ばれる
  // ここでは seer を削除して全員 CO 済扱いにするため events を使う想定
  // → 代わりに player 不在で no-player パスをテスト
  const result = await agent.decide(state, 99, legal)
  assert.equal(result.cmd.type, 'skip')
  assert.match(result.log ?? '', /skip.*no-player/)
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

test('SkollCommandAgent + CommandAdapter: night フェーズで rule-based ログが残る', async () => {
  const roleConfig = new Map<SystemRole, number>([
    ['seer', 1], ['bodyguard', 1], ['villager', 2],
    ['werewolf', 2], ['fanatic', 1],
  ])
  const seed = 21
  const adapter = new CommandAdapter({
    agents: new Map(),
    defaultAgent: new SkollCommandAgent({ seed, fallback: new RandomCommandAgent(seed) }),
    roles: roleConfig,
    seed,
  })
  const config: GameConfig = { roles: roleConfig, seed }
  const result = await runGame(config, adapter)

  assert.ok(result.state.finished)

  // night フェーズで rule-based が使われたログが存在するはず
  // (seer の divine / bodyguard の guard / werewolf の attack のどれか)
  const nightRuleBasedLogs = result.events.filter((e): e is GameEvent => {
    if ((e as GameEvent).type !== 'comment') return false
    const text = (e as { text?: string }).text ?? ''
    return text.includes('night') && text.includes('rule-based')
  })
  assert.ok(nightRuleBasedLogs.length > 0,
    `night rule-based ログが残る (found ${nightRuleBasedLogs.length})`)
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
