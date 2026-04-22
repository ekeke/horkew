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
import type { GameState, PlayerState, GameEvent, DayClaim } from '../../../lupa/types.ts'
import type { GameConfig } from '../../../lupa/handlers.ts'
import { runGame } from '../../../lupa/engine.ts'
import {
  createCommandAdapterExt, type CommandAdapterExt, type Command,
} from '../adapters/command/command-types.ts'
import { CommandAdapter } from '../adapters/command/command-adapter.ts'
import { SkollCommandAgent } from './skoll-command-agent.ts'
import { RandomCommandAgent } from './random-command-agent.ts'
import { SkollMasterAgent } from '../../../skoll/skoll-master-agent.ts'
import type { DecisionContext } from '../agents/agent.ts'

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

test('SkollCommandAgent: discussion 狼も独立エージェント、skoll 不能時は hide', async () => {
  // 狼もチーム coordinator を撤廃し独立エージェント化した。本テストは retarCache 未構築なので
  // lookahead が失敗 → fallback で hide (skip)。villainClaimPlan は使われないので entry 無し。
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('discussion')
  const legal: Command[] = [{ type: 'skip' }]
  const result = await agent.decide(state, 3, legal)
  assert.equal(result.cmd.type, 'skip')
  assert.equal(state.ext.villainClaimPlan.has(3), false)
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

// ============================================================
// MCTS 経路 (RoleZeroAgent master 差し替え) のテスト
// ============================================================

/**
 * RoleZeroAgent を模した最小スタブ。
 * - forceFallback=true: MCTS 失敗扱い (lastMCTS=null) + super.decideVote (analyzeVote) に委譲
 * - それ以外: voteSeat を返しつつ visits を保持 → getLastMCTSResult で返す
 */
class FakeZeroMaster extends SkollMasterAgent {
  private lastMCTS: { visits: Map<number, number> } | null = null
  private readonly fakeOpts: {
    voteSeat: number
    visits: Map<number, number>
    forceFallback?: boolean
  }
  constructor(opts: {
    voteSeat: number
    visits: Map<number, number>
    forceFallback?: boolean
  }) {
    super({})
    this.fakeOpts = opts
  }
  override decideVote(ctx: DecisionContext): number {
    if (this.fakeOpts.forceFallback) {
      this.lastMCTS = null
      return super.decideVote(ctx)
    }
    this.lastMCTS = { visits: this.fakeOpts.visits }
    return this.fakeOpts.voteSeat
  }
  // stub retarCache では world-analysis が動かないので analyzeVote 経路を無効化。
  // command-agent は null を受けて voteFallback に落とす想定。
  override analyzeVote(): null {
    return null
  }
  getLastMCTSResult(): { visits: Map<number, number> } | null {
    return this.lastMCTS
  }
}

/** 最小 retarCache を state.ext に注入して buildDecisionContext を通過させる */
function stubRetarCache(state: GameState<CommandAdapterExt>): void {
  const possibilities = new Map<number, Set<SystemRole>>()
  for (const p of state.players) {
    possibilities.set(p.seat, new Set<SystemRole>([p.role]))
  }
  state.ext.retarCache = {
    possibilities,
    lastArtifacts: { vs: {}, setup: new Map() },
    computedAtEventCount: 0,
  }
}

test('SkollCommandAgent: vote MCTS 成功 → [role/zero] ログで bestSeat を採用', async () => {
  const master = new FakeZeroMaster({
    voteSeat: 3,
    visits: new Map([[3, 70], [2, 20], [4, 10]]),
  })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('vote')
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'vote', target: 2 },
    { type: 'vote', target: 3 },
    { type: 'vote', target: 4 },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.deepEqual(result.cmd, { type: 'vote', target: 3 })
  assert.match(result.log ?? '', /\[village\/zero\]/)
  assert.match(result.log ?? '', /bestVote=seat3/)
  assert.match(result.log ?? '', /s3=0\.70/)
})

test('SkollCommandAgent: vote MCTS fallback (visits 空) → analyzeVote 経路', async () => {
  const master = new FakeZeroMaster({
    voteSeat: 3,
    visits: new Map(),
    forceFallback: true,
  })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('vote')
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'vote', target: 2 },
    { type: 'vote', target: 3 },
  ]
  const result = await agent.decide(state, 1, legal)
  // MCTS が null → analyzeVote 経路 (FakeZeroMaster は analyzeVote も null) → no-analysis fallback
  assert.doesNotMatch(result.log ?? '', /\[village\/zero\]/)
  assert.match(result.log ?? '', /no-analysis/)
})

test('SkollCommandAgent: vote MCTS top-1 が legal 外 → analyzeVote 経路にフォールスルー', async () => {
  const master = new FakeZeroMaster({
    voteSeat: 99,  // 存在しない席 (legal に含まれない)
    visits: new Map([[99, 60], [3, 30], [2, 10]]),
  })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('vote')
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'vote', target: 2 },
    { type: 'vote', target: 3 },
  ]
  const result = await agent.decide(state, 1, legal)
  // zero 経路は top-1=99 が legal 外 → analyzeVote 経路へ → FakeZeroMaster.analyzeVote=null → no-analysis
  assert.doesNotMatch(result.log ?? '', /\[village\/zero\]/)
  assert.match(result.log ?? '', /no-analysis/)
})

test('SkollCommandAgent: commander MCTS top1 dominant → designate_execution', async () => {
  const master = new FakeZeroMaster({
    voteSeat: 3,
    visits: new Map([[3, 90], [2, 7], [4, 3]]),
  })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('commander')
  stubRetarCache(state)
  // seer(seat1) は生存・未 CO だが findUnclaimedRoleCategory で事前に処理される。
  // そのため legal に request_co を含めないことで Step B に進ませる。
  const legal: Command[] = [
    { type: 'designate_execution', target: 2 },
    { type: 'designate_execution', target: 3 },
    { type: 'designate_execution', target: 4 },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.deepEqual(result.cmd, { type: 'designate_execution', target: 3 })
  assert.match(result.log ?? '', /\(commander\/zero\) designate seat3/)
})

test('SkollCommandAgent: commander MCTS top1/top2 接近 → designate_runoff', async () => {
  const master = new FakeZeroMaster({
    voteSeat: 3,
    visits: new Map([[3, 42], [2, 38], [4, 20]]),  // top1-top2 = 0.04 < 0.08
  })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('commander')
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'designate_execution', target: 2 },
    { type: 'designate_execution', target: 3 },
    { type: 'designate_runoff', targets: [2, 3] },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.equal(result.cmd.type, 'designate_runoff')
  assert.match(result.log ?? '', /\(commander\/zero\) runoff seat3\/seat2/)
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
// Phase 2 claim head 経路 (villain の CO 種類選択を NN に委譲)
// ============================================================

/**
 * Phase 2 claim head を持つ master のスタブ。
 * hasPhase2Head('claim', *) が true を返し、decideDayClaim が固定の DayClaim を返す。
 * analyzeVote は null (fallback lookahead を意図的に無力化して NN 経路の発火を切り分け)。
 */
class FakeClaimZeroMaster extends SkollMasterAgent {
  private readonly claim: DayClaim
  constructor(claim: DayClaim) {
    super({})
    this.claim = claim
  }
  hasPhase2Head(method: string, _role: SystemRole): boolean {
    return method === 'claim'
  }
  override decideDayClaim(_ctx: DecisionContext): DayClaim {
    return this.claim
  }
  override analyzeVote(): null {
    return null
  }
}

test('SkollCommandAgent: discussion villain NN claim=seer_co → seer_co 発火', async () => {
  const master = new FakeClaimZeroMaster({ type: 'seer_co', results: [] })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  stubRetarCache(state)
  // seat 3 = werewolf (makeState の既定)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'seer_co', results: [] } },
    { type: 'role_co', claim: { type: 'medium_co' } },
  ]
  const result = await agent.decide(state, 3, legal)
  assert.equal(result.cmd.type, 'role_co')
  assert.equal((result.cmd as { claim: DayClaim }).claim.type, 'seer_co')
  assert.match(result.log ?? '', /\[werewolf\/zero\]/)
  assert.match(result.log ?? '', /CO seer_co \(NN\)/)
})

test('SkollCommandAgent: discussion villain NN claim=none → hide (skip)', async () => {
  const master = new FakeClaimZeroMaster({ type: 'none' })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 3, legal)
  assert.equal(result.cmd.type, 'skip')
  assert.match(result.log ?? '', /\[werewolf\/zero\]/)
  assert.match(result.log ?? '', /hide \(NN claim=none\)/)
})

test('SkollCommandAgent: discussion villain NN claim=forecast → lookahead にフォールスルー', async () => {
  // forecast は villain 初期 CO では未対応 → mapVillainCoType が null を返し、
  // 既存 skoll lookahead 経路に落ちる。analyzeVote=null なので最終的に hide。
  const master = new FakeClaimZeroMaster({ type: 'forecast', target: 2 })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 3, legal)
  assert.equal(result.cmd.type, 'skip')
  assert.match(result.log ?? '', /skoll unavailable/)
  assert.doesNotMatch(result.log ?? '', /\(NN\)/)
})

/**
 * Phase 2 forecast head を持つ master のスタブ。
 * hasPhase2Head('forecast', *) が true、decideForecast が固定値を返す。
 */
class FakeForecastZeroMaster extends SkollMasterAgent {
  private readonly forecastClaim: DayClaim
  constructor(forecastClaim: DayClaim) {
    super({})
    this.forecastClaim = forecastClaim
  }
  hasPhase2Head(method: string, _role: SystemRole): boolean {
    return method === 'forecast'
  }
  override decideForecast(_ctx: DecisionContext): DayClaim {
    return this.forecastClaim
  }
  override analyzeVote(): null {
    return null
  }
}

test('SkollCommandAgent: discussion 真 seer 全報告済み + forecast head 発火 → forecast report', async () => {
  const master = new FakeForecastZeroMaster({ type: 'forecast', target: 3 })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  // seat 1 = seer、CO 済で divineHistory 空 (= 全報告済み)
  state.players[0].claimedRole = 'seer'
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_result_report', claim: { type: 'forecast', target: 2 } },
    { type: 'role_result_report', claim: { type: 'forecast', target: 3 } },
    { type: 'role_result_report', claim: { type: 'forecast', target: 4 } },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.equal(result.cmd.type, 'role_result_report')
  assert.equal((result.cmd as { claim: DayClaim }).claim.type, 'forecast')
  assert.match(result.log ?? '', /\[seer\/zero\] forecast seat3 \(NN\)/)
})

test('SkollCommandAgent: discussion 真 seer 全報告済み + forecast head が none → skip (既存挙動)', async () => {
  const master = new FakeForecastZeroMaster({ type: 'none' })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  state.players[0].claimedRole = 'seer'
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_result_report', claim: { type: 'forecast', target: 2 } },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.equal(result.cmd.type, 'skip')
  assert.match(result.log ?? '', /all-reported skip/)
})

test('SkollCommandAgent: discussion 真 seer forecast head 未登録 → skip (既存挙動)', async () => {
  // forecast head を持たない master → NN 経路に入らず、既存の all-reported skip に落ちる
  const agent = new SkollCommandAgent({ fallback: new FixedFallback() })
  const state = makeState('discussion')
  state.players[0].claimedRole = 'seer'
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_result_report', claim: { type: 'forecast', target: 2 } },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.equal(result.cmd.type, 'skip')
  assert.match(result.log ?? '', /all-reported skip/)
})

test('SkollCommandAgent: discussion villain NN claim=seer_co 但し legal 不整合 → フォールスルー', async () => {
  const master = new FakeClaimZeroMaster({ type: 'seer_co', results: [] })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  stubRetarCache(state)
  // role_co が legal に存在しない状況
  const legal: Command[] = [{ type: 'skip' }]
  const result = await agent.decide(state, 3, legal)
  assert.equal(result.cmd.type, 'skip')
  // NN 経路は null を返し、lookahead fallback に落ちる
  assert.doesNotMatch(result.log ?? '', /\(NN\)/)
})

// ============================================================
// 真役職の NN claim head 経路 (seer / medium / bodyguard / nekomata / mason)
// ============================================================

test('SkollCommandAgent: discussion 真 seer NN claim=none → hide', async () => {
  const master = new FakeClaimZeroMaster({ type: 'none' })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  stubRetarCache(state)
  // seat 1 = seer (未 CO)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.equal(result.cmd.type, 'skip')
  assert.match(result.log ?? '', /\[seer\/zero\]/)
  assert.match(result.log ?? '', /hide \(NN claim=none\)/)
})

test('SkollCommandAgent: discussion 真 seer NN claim=seer_co → CO', async () => {
  const master = new FakeClaimZeroMaster({ type: 'seer_co', results: [] })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.equal(result.cmd.type, 'role_co')
  assert.equal((result.cmd as { claim: DayClaim }).claim.type, 'seer_co')
  assert.match(result.log ?? '', /\[seer\/zero\] CO seer_co \(NN\)/)
})

test('SkollCommandAgent: discussion 真 medium NN claim=medium_co → CO', async () => {
  const master = new FakeClaimZeroMaster({ type: 'medium_co' })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  // seat 2 を medium に置き換え
  state.players[1].role = 'medium'
  state.executionHistory = new Map()
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'medium_co' } },
  ]
  const result = await agent.decide(state, 2, legal)
  assert.equal(result.cmd.type, 'role_co')
  assert.equal((result.cmd as { claim: DayClaim }).claim.type, 'medium_co')
  assert.match(result.log ?? '', /\[medium\/zero\] CO medium_co \(NN\)/)
})

test('SkollCommandAgent: discussion 真 medium NN claim=none → hide (lookahead スキップ)', async () => {
  const master = new FakeClaimZeroMaster({ type: 'none' })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  state.players[1].role = 'medium'
  state.executionHistory = new Map()
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'medium_co' } },
  ]
  const result = await agent.decide(state, 2, legal)
  assert.equal(result.cmd.type, 'skip')
  assert.match(result.log ?? '', /\[medium\/zero\] hide \(NN claim=none\)/)
  // 既存 lookahead log が出ないことを確認 (NN 経路で decide が完結)
  assert.doesNotMatch(result.log ?? '', /hide=.*>= co=/)
})

test('SkollCommandAgent: discussion 真 bodyguard NN claim=bodyguard_co → CO', async () => {
  const master = new FakeClaimZeroMaster({ type: 'bodyguard_co', targets: [] })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  state.players[1].role = 'bodyguard'
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'bodyguard_co', targets: [] } },
  ]
  const result = await agent.decide(state, 2, legal)
  assert.equal(result.cmd.type, 'role_co')
  assert.equal((result.cmd as { claim: DayClaim }).claim.type, 'bodyguard_co')
  assert.match(result.log ?? '', /\[bodyguard\/zero\] CO bodyguard_co \(NN\)/)
})

test('SkollCommandAgent: discussion 真 nekomata NN claim=none → hide', async () => {
  const master = new FakeClaimZeroMaster({ type: 'none' })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  state.players[1].role = 'nekomata'
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'nekomata_co' } },
  ]
  const result = await agent.decide(state, 2, legal)
  assert.equal(result.cmd.type, 'skip')
  assert.match(result.log ?? '', /\[nekomata\/zero\] hide \(NN claim=none\)/)
})

test('SkollCommandAgent: discussion 真 mason NN claim=mason_co → CO with partner', async () => {
  const master = new FakeClaimZeroMaster({ type: 'mason_co', partner: 4 })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  // seat 2 と seat 4 を mason に設定
  state.players[1].role = 'mason'
  state.players[3].role = 'mason'
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'mason_co', partner: 4 } },
  ]
  const result = await agent.decide(state, 2, legal)
  assert.equal(result.cmd.type, 'role_co')
  assert.equal((result.cmd as { claim: DayClaim }).claim.type, 'mason_co')
  assert.match(result.log ?? '', /\[mason\/zero\] CO mason_co \(NN\)/)
})

// ============================================================
// CCO フェーズの NN claim head 経路
// ============================================================

test('SkollCommandAgent: cco 真 seer NN claim=seer_co → cco_full', async () => {
  const master = new FakeClaimZeroMaster({ type: 'seer_co', results: [] })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('cco')
  stubRetarCache(state)
  // seat 1 = seer (未 CO)
  const legal: Command[] = [
    { type: 'cco_skip' },
    { type: 'cco_full', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.equal(result.cmd.type, 'cco_full')
  assert.equal((result.cmd as { claim: DayClaim }).claim.type, 'seer_co')
  assert.match(result.log ?? '', /\(cco\)\[seer\/zero\] CO seer_co \(NN\)/)
})

test('SkollCommandAgent: cco 真 seer NN claim=none → cco_skip', async () => {
  const master = new FakeClaimZeroMaster({ type: 'none' })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('cco')
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'cco_skip' },
    { type: 'cco_full', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.equal(result.cmd.type, 'cco_skip')
  assert.match(result.log ?? '', /\(cco\)\[seer\/zero\] skip \(NN claim=none\)/)
})

test('SkollCommandAgent: cco 真 mason NN claim=mason_co → cco_full with partner', async () => {
  const master = new FakeClaimZeroMaster({ type: 'mason_co', partner: 4 })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('cco')
  state.players[1].role = 'mason'
  state.players[3].role = 'mason'
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'cco_skip' },
    { type: 'cco_full', claim: { type: 'mason_co', partner: 4 } },
  ]
  const result = await agent.decide(state, 2, legal)
  assert.equal(result.cmd.type, 'cco_full')
  assert.equal((result.cmd as { claim: DayClaim }).claim.type, 'mason_co')
  assert.match(result.log ?? '', /\(cco\)\[mason\/zero\] CO mason_co \(NN\)/)
})

test('SkollCommandAgent: cco 真 seer NN claim=forecast → 既存 heuristic (無条件 cco_full) にフォールスルー', async () => {
  const master = new FakeClaimZeroMaster({ type: 'forecast', target: 3 })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('cco')
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'cco_skip' },
    { type: 'cco_full', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 1, legal)
  // NN は forecast (unexpected) を返したので既存 heuristic で無条件 cco_full
  assert.equal(result.cmd.type, 'cco_full')
  assert.match(result.log ?? '', /\(cco\)\[seer\] true-role last-chance CO/)
  assert.doesNotMatch(result.log ?? '', /\(NN\)/)
})

test('SkollCommandAgent: cco villain は NN 経路を踏まず既存通り cco_skip', async () => {
  const master = new FakeClaimZeroMaster({ type: 'seer_co', results: [] })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('cco')
  stubRetarCache(state)
  // seat 3 = werewolf。villain は trueCoClaimType が null なので NN 経路を踏まない
  const legal: Command[] = [
    { type: 'cco_skip' },
    { type: 'cco_full', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 3, legal)
  assert.equal(result.cmd.type, 'cco_skip')
  assert.match(result.log ?? '', /\(cco\)\[werewolf\] stay-silent skip/)
})

// ============================================================
// defensive_claim head 経路 (真役職 hide→CO override)
// ============================================================

/**
 * Phase 2 claim + defensive_claim 両方を持つ master のスタブ。
 * claim が hide のとき defensive_claim で CO に override するケースを検証する。
 */
class FakeDefenseZeroMaster extends SkollMasterAgent {
  private readonly claimDecision: DayClaim
  private readonly defenseDecision: DayClaim
  constructor(claim: DayClaim, defense: DayClaim) {
    super({})
    this.claimDecision = claim
    this.defenseDecision = defense
  }
  hasPhase2Head(method: string, _role: SystemRole): boolean {
    return method === 'claim' || method === 'defensive_claim'
  }
  override decideDayClaim(_ctx: DecisionContext): DayClaim {
    return this.claimDecision
  }
  override decideDefensiveClaim(_ctx: DecisionContext): DayClaim {
    return this.defenseDecision
  }
  override analyzeVote(): null {
    return null
  }
}

test('SkollCommandAgent: discussion villain claim=none + defense=seer_co → CO (defense override)', async () => {
  const master = new FakeDefenseZeroMaster(
    { type: 'none' },
    { type: 'seer_co', results: [] },
  )
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  stubRetarCache(state)
  // seat 3 = werewolf
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 3, legal)
  assert.equal(result.cmd.type, 'role_co')
  assert.match(result.log ?? '', /\[werewolf\/zero\] CO seer_co \(defense\)/)
})

test('SkollCommandAgent: discussion 真 seer claim=none + defense=seer_co → CO (defense override)', async () => {
  const master = new FakeDefenseZeroMaster(
    { type: 'none' },
    { type: 'seer_co', results: [] },
  )
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.equal(result.cmd.type, 'role_co')
  assert.match(result.log ?? '', /\[seer\/zero\] CO seer_co \(defense\)/)
})

test('SkollCommandAgent: discussion 真 bodyguard claim=none + defense=bodyguard_co → CO (defense override)', async () => {
  const master = new FakeDefenseZeroMaster(
    { type: 'none' },
    { type: 'bodyguard_co', targets: [] },
  )
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  state.players[1].role = 'bodyguard'
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'bodyguard_co', targets: [] } },
  ]
  const result = await agent.decide(state, 2, legal)
  assert.equal(result.cmd.type, 'role_co')
  assert.match(result.log ?? '', /\[bodyguard\/zero\] CO bodyguard_co \(defense\)/)
})

test('SkollCommandAgent: discussion 真 medium claim=none + defense=none → hide (両方 skip)', async () => {
  const master = new FakeDefenseZeroMaster({ type: 'none' }, { type: 'none' })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  state.players[1].role = 'medium'
  state.executionHistory = new Map()
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'medium_co' } },
  ]
  const result = await agent.decide(state, 2, legal)
  assert.equal(result.cmd.type, 'skip')
  // 両方 hide の場合は primary claim の skip が最終結果 (defense の skip では上書きしない)
  assert.match(result.log ?? '', /\[medium\/zero\] hide \(NN claim=none\)/)
  assert.doesNotMatch(result.log ?? '', /\(defense claim=none\)/)
})

test('SkollCommandAgent: discussion 真 seer claim=seer_co → CO (defense は呼ばれない)', async () => {
  // claim が CO なので defense 経路を踏まない → log は (NN)、(defense) ではない
  const master = new FakeDefenseZeroMaster(
    { type: 'seer_co', results: [] },
    { type: 'none' },  // 呼ばれないはず
  )
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'seer_co', results: [] } },
  ]
  const result = await agent.decide(state, 1, legal)
  assert.equal(result.cmd.type, 'role_co')
  assert.match(result.log ?? '', /\[seer\/zero\] CO seer_co \(NN\)/)
  assert.doesNotMatch(result.log ?? '', /\(defense\)/)
})

test('SkollCommandAgent: discussion 真 mason claim=none + defense=mason_co → CO with partner (defense override)', async () => {
  const master = new FakeDefenseZeroMaster(
    { type: 'none' },
    { type: 'mason_co', partner: 4 },
  )
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  state.players[1].role = 'mason'
  state.players[3].role = 'mason'
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'mason_co', partner: 4 } },
  ]
  const result = await agent.decide(state, 2, legal)
  assert.equal(result.cmd.type, 'role_co')
  assert.match(result.log ?? '', /\[mason\/zero\] CO mason_co \(defense\)/)
})

test('SkollCommandAgent: discussion 真 medium NN claim=forecast → lookahead にフォールスルー', async () => {
  const master = new FakeClaimZeroMaster({ type: 'forecast', target: 3 })
  const agent = new SkollCommandAgent({ master, fallback: new FixedFallback() })
  const state = makeState('discussion')
  state.players[1].role = 'medium'
  state.executionHistory = new Map()
  stubRetarCache(state)
  const legal: Command[] = [
    { type: 'skip' },
    { type: 'role_co', claim: { type: 'medium_co' } },
  ]
  const result = await agent.decide(state, 2, legal)
  // NN は unexpected type を返したので lookahead にフォールスルー。
  // FakeClaimZeroMaster.analyzeVote=null なので最終的に hide (unavailable)
  assert.equal(result.cmd.type, 'skip')
  assert.doesNotMatch(result.log ?? '', /\(NN\)/)
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
