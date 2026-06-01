/**
 * huginn-vote-collector のテスト:
 *   - collector が alive seat 全員に vote を返す (death / self / !candidates を除外)
 *   - emit callback に交渉メッセージ + finalVote が流れる
 *   - alive 0 のとき空 Map
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../../../types/index.ts'
import type { GameState, PlayerState, GameEvent } from '../../../../lupa/types.ts'
import type { VoteContext } from '../../../../lupa/handlers.ts'
import type { FenrirExtEvent } from '../../events.ts'
import { createCommandAdapterExt, type CommandAdapterExt } from './command-types.ts'
import { createHuginnVoteCollector } from './huginn-vote-collector.ts'
import { TrainableNetwork } from '../../../../huginn/trainable-network.ts'
import { buildVocabLayout } from '../../../../huginn/message-vocab.ts'
import { MAX_AGENTS, OFFER_REF_WINDOW } from '../../../../huginn/types.ts'
import type { CommandAgent, DecisionResult } from '../../command-agents/command-agent.ts'
import type { Command } from './command-types.ts'

function makePlayer(seat: number, role: SystemRole, alive = true): PlayerState {
  return {
    seat,
    name: `P${seat}`,
    role,
    alive,
    claimedRole: null,
    claimedDay: null,
    divineHistory: new Map(),
    guardHistory: new Map(),
    attackHistory: new Map(),
    mediumHistory: new Map(),
    fakeDivineHistory: new Map(),
    forecastTarget: null,
  }
}

function makeState(players: PlayerState[]): GameState<CommandAdapterExt> {
  return {
    players,
    day: 1,
    phase: 'day',
    finished: false,
    result: null,
    executionHistory: new Map(),
    commander: null,
    ext: createCommandAdapterExt(),
  }
}

function makeNetwork(): TrainableNetwork {
  const layout = buildVocabLayout(MAX_AGENTS, OFFER_REF_WINDOW)
  return new TrainableNetwork({
    dModel: 16,
    numLayers: 1,
    numHeads: 2,
    dFf: 32,
    vocabSize: layout.vocabSize,
  })
}

function makeVoteContext(
  state: GameState<CommandAdapterExt>,
): VoteContext<FenrirExtEvent, CommandAdapterExt> {
  return {
    state,
    events: [],
    revoteRound: 0,
  } as unknown as VoteContext<FenrirExtEvent, CommandAdapterExt>
}

test('huginn collector: alive 全員に vote を返し、死亡者は map に含まれない', async () => {
  const state = makeState([
    makePlayer(1, 'villager'),
    makePlayer(2, 'seer'),
    makePlayer(3, 'werewolf', false),  // 死亡
    makePlayer(4, 'bodyguard'),
    makePlayer(5, 'fanatic'),
  ])
  const alive = state.players.filter(p => p.alive)
  const candidates = alive.map(p => p.seat)

  const collector = createHuginnVoteCollector({
    network: makeNetwork(),
    sampling: 'argmax',
  })
  const ctx = makeVoteContext(state)
  const votes = await collector(ctx, { state, candidates, alive })

  assert.ok(votes !== null, 'collector は null を返してはいけない (fallback しない)')
  assert.equal(votes!.size, alive.length, 'alive 全員分の vote')
  for (const p of alive) {
    assert.ok(votes!.has(p.seat), `seat ${p.seat} の vote が欠落`)
    const target = votes!.get(p.seat)!
    assert.ok(candidates.includes(target), `target seat ${target} は candidates 外`)
    assert.notEqual(target, p.seat, 'self-vote 禁止')
    const targetPlayer = state.players.find(pl => pl.seat === target)
    assert.ok(targetPlayer?.alive, `target seat ${target} は生存者でない`)
  }
  // 死亡席は map に無い
  assert.ok(!votes!.has(3))
})

test('huginn collector: emitEvent に交渉メッセージ + finalVote が流れる', async () => {
  const state = makeState([
    makePlayer(1, 'villager'),
    makePlayer(2, 'villager'),
    makePlayer(3, 'werewolf'),
    makePlayer(4, 'fanatic'),
  ])
  const alive = state.players.filter(p => p.alive)
  const candidates = alive.map(p => p.seat)

  const events: (GameEvent | FenrirExtEvent)[] = []
  const collector = createHuginnVoteCollector({
    network: makeNetwork(),
    sampling: 'argmax',
    emitEvent: (ev) => events.push(ev),
  })
  const ctx = makeVoteContext(state)
  await collector(ctx, { state, candidates, alive })

  // K=4 rounds × 4 agents = 16 発話 + 4 finalVote = 20 comment
  const comments = events.filter(e => e.type === 'comment') as Array<{ type: 'comment', text: string }>
  assert.equal(comments.length, 4 * 4 + 4, `comment 数が期待値と不一致: ${comments.length}`)
  const finalVoteLines = comments.filter(c => c.text.includes('finalVote'))
  assert.equal(finalVoteLines.length, 4, 'finalVote のログが各 alive seat 分出ていない')
  const huginnRoundLines = comments.filter(c => c.text.includes('huginn R'))
  assert.equal(huginnRoundLines.length, 16, '交渉メッセージのログ数が不一致')
})

test('huginn collector: alive 0 なら空 Map', async () => {
  const state = makeState([
    makePlayer(1, 'villager', false),
    makePlayer(2, 'werewolf', false),
  ])
  const collector = createHuginnVoteCollector({
    network: makeNetwork(),
    sampling: 'argmax',
  })
  const ctx = makeVoteContext(state)
  const votes = await collector(ctx, { state, candidates: [], alive: [] })
  assert.ok(votes !== null)
  assert.equal(votes!.size, 0)
})

class FakeMCTSAgent implements CommandAgent {
  readonly name = 'fake-mcts'
  decideCalledFor: number[] = []
  private mcts: { visits: Map<number, number> } | null
  constructor(mcts: { visits: Map<number, number> } | null = null) {
    this.mcts = mcts
  }
  async decide(
    _state: unknown,
    seat: number,
    legal: readonly Command[],
    _events: unknown,
  ): Promise<DecisionResult> {
    this.decideCalledFor.push(seat)
    return { cmd: legal[0], log: 'fake decide' }
  }
  getLastMCTSResult(): { visits: Map<number, number> } | null {
    return this.mcts
  }
}

test('huginn collector: agents 指定時は各 alive seat で decide が呼ばれる', async () => {
  const state = makeState([
    makePlayer(1, 'villager'),
    makePlayer(2, 'villager'),
    makePlayer(3, 'werewolf'),
    makePlayer(4, 'fanatic'),
  ])
  const alive = state.players.filter(p => p.alive)
  const candidates = alive.map(p => p.seat)

  const mcts = { visits: new Map<number, number>([[3, 20], [4, 5]]) }
  const defaultAgent = new FakeMCTSAgent(mcts)

  const collector = createHuginnVoteCollector({
    network: makeNetwork(),
    sampling: 'argmax',
    defaultAgent,
  })
  const ctx = makeVoteContext(state)
  const votes = await collector(ctx, { state, candidates, alive })

  // 各 alive seat で decide が呼ばれ、戻り値は votes に反映
  assert.ok(votes !== null)
  assert.equal(defaultAgent.decideCalledFor.length, alive.length)
  for (const p of alive) {
    assert.ok(defaultAgent.decideCalledFor.includes(p.seat), `seat ${p.seat} で decide が呼ばれていない`)
  }
})

test('huginn collector: retarCache 経由の knowledge で throw せず map が返る', async () => {
  const state = makeState([
    makePlayer(1, 'villager'),
    makePlayer(2, 'werewolf'),
    makePlayer(3, 'bodyguard'),
  ])
  const alive = state.players.filter(p => p.alive)
  const candidates = alive.map(p => p.seat)

  // retarCache に可能性集合を流し込む (1=村人確定、2=狼確定、3=狩人/占い/猫又いずれか)
  state.ext.retarCache = {
    possibilities: new Map<number, Set<string>>([
      [1, new Set(['villager'])],
      [2, new Set(['werewolf'])],
      [3, new Set(['bodyguard', 'seer', 'nekomata'])],
    ]) as unknown as Map<number, Set<import('../../../../types/index.ts').SystemRole>>,
    lastArtifacts: null,
    computedAtEventCount: 0,
  }

  const collector = createHuginnVoteCollector({
    network: makeNetwork(),
    sampling: 'argmax',
  })
  const ctx = makeVoteContext(state)
  const votes = await collector(ctx, { state, candidates, alive })
  assert.ok(votes !== null)
  assert.equal(votes!.size, alive.length)
})

test('huginn collector: candidates 外への投票は起きない (excluded mask)', async () => {
  // revote シナリオ: 候補を 2 seat に絞る
  const state = makeState([
    makePlayer(1, 'villager'),
    makePlayer(2, 'seer'),
    makePlayer(3, 'werewolf'),
    makePlayer(4, 'bodyguard'),
    makePlayer(5, 'villager'),
  ])
  const alive = state.players.filter(p => p.alive)
  const candidates = [3, 5]  // 候補は 2 seat のみ

  const collector = createHuginnVoteCollector({
    network: makeNetwork(),
    sampling: 'argmax',
  })
  const ctx = makeVoteContext(state)
  const votes = await collector(ctx, { state, candidates, alive })

  for (const p of alive) {
    const target = votes!.get(p.seat)!
    assert.ok(
      candidates.includes(target),
      `seat ${p.seat} → seat ${target} は candidates [${candidates.join(',')}] 外`,
    )
  }
})
