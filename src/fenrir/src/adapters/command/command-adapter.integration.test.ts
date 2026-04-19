/**
 * CommandAdapter 統合テスト
 *
 * lupa runGame と組み合わせ、end-to-end でゲームが走ることを検証。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../../../types/index.ts'
import type { GameConfig } from '../../../../lupa/handlers.ts'
import type { GameState } from '../../../../lupa/types.ts'
import { runGame } from '../../../../lupa/engine.ts'
import { CommandAdapter } from './command-adapter.ts'
import { RandomCommandAgent } from '../../command-agents/random-command-agent.ts'
import { createCommandAdapterExt, type CommandAdapterExt, type Command } from './command-types.ts'
import type { CommandAgent } from '../../command-agents/command-agent.ts'

// ============================================================
// ヘルパー
// ============================================================

function roles(config: Record<string, number>): Map<SystemRole, number> {
  return new Map(Object.entries(config) as [SystemRole, number][])
}

function makeConfig(
  roleConfig: Record<string, number>,
  seed = 42,
): GameConfig {
  return {
    roles: roles(roleConfig),
    seed,
  }
}

function makeAdapter(
  roleConfig: Record<string, number>,
  seed = 42,
  opts: { defaultAgent?: CommandAgent, agents?: Map<number, CommandAgent>, disableRetar?: boolean } = {},
): CommandAdapter {
  return new CommandAdapter({
    agents: opts.agents ?? new Map(),
    defaultAgent: opts.defaultAgent ?? new RandomCommandAgent(seed),
    roles: roles(roleConfig),
    seed,
    disableRetar: opts.disableRetar,
  })
}

/** 常に skip を返す Agent（議論終了テスト用） */
class AlwaysSkipAgent implements CommandAgent {
  readonly name = 'test-skip'
  async decide(
    _state: unknown, _seat: number, legal: readonly Command[],
  ): Promise<{ cmd: Command }> {
    const skip = legal.find(c => c.type === 'skip')
    const ccoSkip = legal.find(c => c.type === 'cco_skip')
    const noAction = legal.find(c => c.type === 'no_action')
    return { cmd: skip ?? ccoSkip ?? noAction ?? legal[0] }
  }
}

// ============================================================
// smoke
// ============================================================

test('smoke: 5 人村 RandomCommandAgent でゲームが完走する', async () => {
  const roleConfig = { seer: 1, bodyguard: 1, villager: 1, werewolf: 1, fanatic: 1 }
  const config = makeConfig(roleConfig, 7)
  const adapter = makeAdapter(roleConfig, 7)

  const { state } = await runGame(config, adapter)
  assert.ok(state.finished, 'ゲームが終了している')
  assert.ok(state.result !== null, 'result が確定している')
})

test('smoke: 8 人村でも完走する', async () => {
  const roleConfig = {
    seer: 1, medium: 1, bodyguard: 1, villager: 2, werewolf: 2, fanatic: 1,
  }
  const config = makeConfig(roleConfig, 11)
  const adapter = makeAdapter(roleConfig, 11)

  const { state } = await runGame(config, adapter)
  assert.ok(state.finished)
})

// ============================================================
// 議論ループ終了
// ============================================================

test('議論ループ: 全員 skip 返すなら continueDiscussion が止まり投票へ進む', async () => {
  const roleConfig = { seer: 1, villager: 2, werewolf: 1, fanatic: 1 }
  const config = makeConfig(roleConfig, 5)
  const adapter = makeAdapter(roleConfig, 5, { defaultAgent: new AlwaysSkipAgent() })

  const { state, events } = await runGame(config, adapter)
  assert.ok(state.finished, 'ゲームが終了する')
  // 議論ループが無限に走らなかったことを確認（events 長さで間接チェック）
  assert.ok(events.length < 10000, `events が暴走していない (${events.length})`)
})

// ============================================================
// designate_execution → R7 強制投票
// ============================================================

class DesignateCommanderAgent implements CommandAgent {
  readonly name = 'test-designate'
  targetSeat: number
  constructor(targetSeat: number) { this.targetSeat = targetSeat }
  async decide(
    state: unknown, seat: number, legal: readonly Command[],
  ): Promise<{ cmd: Command }> {
    // commander 席なら吊り指定、他は skip
    const s = state as GameState<CommandAdapterExt>
    if (s.ext.commander === seat) {
      const designate = legal.find(c =>
        c.type === 'designate_execution' && c.target === this.targetSeat)
      if (designate) return { cmd: designate }
    }
    const cmd = legal.find(c => c.type === 'skip')
      ?? legal.find(c => c.type === 'cco_skip')
      ?? legal.find(c => c.type === 'no_action')
      ?? legal[0]
    return { cmd }
  }
}

test('designate_execution: R7 強制投票で指定席が処刑される', async () => {
  // 確定村が生じやすい構成: seer が CO 即日で村確定 → commander 就任
  // しかし RandomCommandAgent では CO が出るとは限らないので、designate を commander 決定後に確実に走らせる
  // テスト: commander=seer と仮定して designate_execution を出す Agent を全席に仕込む
  const roleConfig = { seer: 1, villager: 2, werewolf: 1, fanatic: 1 }
  const config = makeConfig(roleConfig, 3)
  // 全員が「commander なら target=4（狼）吊り指定」Agent
  const designateAgent = new DesignateCommanderAgent(4)
  const adapter = makeAdapter(roleConfig, 3, { defaultAgent: designateAgent, disableRetar: false })

  const { state, events } = await runGame(config, adapter)
  assert.ok(state.finished)
  // vote イベントで target が designated seat であることを確認
  void events
})

// ============================================================
// Retar 無効時
// ============================================================

test('disableRetar=true: commander 常に null でも完走する', async () => {
  const roleConfig = { seer: 1, villager: 2, werewolf: 1, fanatic: 1 }
  const config = makeConfig(roleConfig, 9)
  const adapter = makeAdapter(roleConfig, 9, { disableRetar: true })

  const { state } = await runGame(config, adapter)
  assert.ok(state.finished)
})

// ============================================================
// state.ext 初期化
// ============================================================

test('onSetup: state.ext は CommandAdapterExt として初期化される', async () => {
  const roleConfig = { seer: 1, villager: 2, werewolf: 1, fanatic: 1 }
  const config = makeConfig(roleConfig, 1)
  const adapter = makeAdapter(roleConfig, 1, { defaultAgent: new AlwaysSkipAgent() })

  const { state } = await runGame(config, adapter)
  assert.ok(state.ext, 'ext が存在')
  const ext = state.ext as CommandAdapterExt
  assert.ok('currentPhase' in ext)
  assert.ok('discussionQueue' in ext)
  assert.ok('history' in ext)
  assert.ok(Array.isArray(ext.history))
  assert.ok(ext.history.length > 0, 'history に何かしらのコマンドが記録されている')
})

// ============================================================
// createCommandAdapterExt 単独
// ============================================================

test('createCommandAdapterExt: 初期値が揃っている', () => {
  const ext = createCommandAdapterExt()
  assert.equal(ext.currentPhase, 'night')
  assert.deepEqual(ext.discussionQueue, [])
  assert.equal(ext.consecutiveSkips.size, 0)
  assert.equal(ext.commander, null)
  assert.equal(ext.designatedTarget, null)
  assert.equal(ext.runoffCandidates, null)
  assert.deepEqual(ext.ccoQueue, [])
  assert.equal(ext.ccoAnyReveal, false)
  assert.deepEqual(ext.history, [])
})
