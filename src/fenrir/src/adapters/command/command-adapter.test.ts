/**
 * Phase 1 ユニットテスト: legal-commands / apply-command
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../../../types/index.ts'
import type { GameState, PlayerState } from '../../../../lupa/types.ts'
import { legalCommands } from './legal-commands.ts'
import {
  applyCommand, resetDiscussionQueue, isDiscussionExhausted,
} from './apply-command.ts'
import {
  createCommandAdapterExt, type CommandAdapterExt, type Command,
} from './command-types.ts'

// ============================================================
// フィクスチャ
// ============================================================

function makePlayer(seat: number, role: SystemRole, alive = true, name?: string): PlayerState {
  return {
    seat,
    name: name ?? `P${seat}`,
    role,
    alive,
    claimedRole: null,
    claimedDay: null,
    divineHistory: new Map(),
    guardHistory: new Map(),
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

/** 典型的な 5 人村（占 1 / 狩 1 / 村 1 / 狼 1 / 狂信 1） */
function fiveSeatVillage(): GameState<CommandAdapterExt> {
  return makeState([
    makePlayer(1, 'seer'),
    makePlayer(2, 'bodyguard'),
    makePlayer(3, 'villager'),
    makePlayer(4, 'werewolf'),
    makePlayer(5, 'fanatic'),
  ])
}

// ============================================================
// legalCommands
// ============================================================

test('legalCommands: 退場席は空配列', () => {
  const state = fiveSeatVillage()
  state.players[0].alive = false
  state.ext.currentPhase = 'night'
  assert.deepEqual(legalCommands(state, 1), [])
})

test('legalCommands: 夜フェーズ 占い師は divine × (生存-1) + no_action', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'night'
  const cmds = legalCommands(state, 1)
  const divines = cmds.filter(c => c.type === 'divine')
  const noActs = cmds.filter(c => c.type === 'no_action')
  assert.equal(divines.length, 4)
  assert.equal(noActs.length, 1)
})

test('legalCommands: 夜フェーズ 狩人は guard × (生存-1) + no_action', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'night'
  const cmds = legalCommands(state, 2)
  const guards = cmds.filter(c => c.type === 'guard')
  assert.equal(guards.length, 4)
})

test('legalCommands: 夜フェーズ 狼リーダーのみ attack 可、他狼は no_action のみ', () => {
  const state = makeState([
    makePlayer(1, 'villager'),
    makePlayer(2, 'werewolf'), // leader = 最小席番
    makePlayer(3, 'werewolf'),
    makePlayer(4, 'villager'),
    makePlayer(5, 'seer'),
  ])
  state.ext.currentPhase = 'night'
  const leaderCmds = legalCommands(state, 2)
  const otherCmds = legalCommands(state, 3)

  const leaderAttacks = leaderCmds.filter(c => c.type === 'attack')
  const otherAttacks = otherCmds.filter(c => c.type === 'attack')
  assert.equal(leaderAttacks.length, 3, '狼リーダーは非狼席3人へ attack 可')
  assert.equal(otherAttacks.length, 0, '非リーダー狼は attack 不可')
  assert.equal(otherCmds.length, 1, '非リーダー狼は no_action のみ')
})

test('legalCommands: 夜フェーズ 狂信者は no_action のみ（夜行動なし）', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'night'
  const cmds = legalCommands(state, 5)
  assert.equal(cmds.length, 1)
  assert.equal(cmds[0].type, 'no_action')
})

test('legalCommands: 夜フェーズ 村人は no_action のみ', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'night'
  const cmds = legalCommands(state, 3)
  assert.equal(cmds.length, 1)
  assert.equal(cmds[0].type, 'no_action')
})

test('legalCommands: 議論フェーズ 未 CO 席は role_co 候補 + skip', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'discussion'
  const cmds = legalCommands(state, 1)
  assert.ok(cmds.some(c => c.type === 'skip'))
  assert.ok(cmds.some(c => c.type === 'role_co'))
})

test('legalCommands: 議論フェーズ seer CO 済みは result_report + skip', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'discussion'
  state.players[0].claimedRole = 'seer'
  const cmds = legalCommands(state, 1)
  assert.ok(cmds.some(c => c.type === 'role_result_report'))
  assert.ok(cmds.some(c => c.type === 'skip'))
  assert.ok(!cmds.some(c => c.type === 'role_co'))
})

test('legalCommands: 指揮フェーズ commander のみ非空', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'commander'
  state.ext.commander = 1
  assert.ok(legalCommands(state, 1).length > 0)
  assert.deepEqual(legalCommands(state, 2), [])
})

test('legalCommands: CCO フェーズ ccoQueue 外は空', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'cco'
  state.ext.ccoQueue = [4]
  assert.deepEqual(legalCommands(state, 2), [])
  assert.ok(legalCommands(state, 4).length > 0)
})

test('legalCommands: CCO 未 CO 席は cco_full + cco_skip', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'cco'
  state.ext.ccoQueue = [4]
  const cmds = legalCommands(state, 4)
  assert.ok(cmds.some(c => c.type === 'cco_full'))
  assert.ok(cmds.some(c => c.type === 'cco_skip'))
  assert.ok(!cmds.some(c => c.type === 'cco_villain_reveal'))
})

test('legalCommands: CCO CO 済み人外席は cco_villain_reveal + cco_skip のみ', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'cco'
  state.ext.ccoQueue = [4]
  state.players[3].claimedRole = 'seer' // 狼の seer 騙り
  const cmds = legalCommands(state, 4)
  assert.ok(cmds.some(c => c.type === 'cco_skip'))
  assert.ok(cmds.some(c => c.type === 'cco_villain_reveal'
    && c.trueRole === 'werewolf'))
  assert.ok(!cmds.some(c => c.type === 'cco_full'))
})

test('legalCommands: CCO CO 済み村役は cco_skip のみ', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'cco'
  state.ext.ccoQueue = [1]
  state.players[0].claimedRole = 'seer'
  const cmds = legalCommands(state, 1)
  assert.equal(cmds.length, 1)
  assert.equal(cmds[0].type, 'cco_skip')
})

// ============================================================
// applyCommand
// ============================================================

test('applyCommand: skip は consecutiveSkips に追加 & キュー先頭 pop', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'discussion'
  state.ext.discussionQueue = [1, 2, 3]
  applyCommand(state, 1, { type: 'skip' })
  assert.ok(state.ext.consecutiveSkips.has(1))
  assert.deepEqual(state.ext.discussionQueue, [2, 3])
})

test('applyCommand: role_co は consecutiveSkips リセット & 行動者除外', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'discussion'
  state.ext.discussionQueue = [1, 2, 3]
  state.ext.consecutiveSkips = new Set([2, 3])

  const cmd: Command = { type: 'role_co', claim: { type: 'seer_co', results: [] } }
  applyCommand(state, 1, cmd)

  assert.equal(state.ext.consecutiveSkips.size, 0)
  assert.ok(!state.ext.discussionQueue.includes(1))
})

test('applyCommand: designate_execution で cco フェーズへ遷移 & ccoQueue 設定', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'commander'
  state.ext.commander = 1
  applyCommand(state, 1, { type: 'designate_execution', target: 4 })
  assert.equal(state.ext.currentPhase, 'cco')
  assert.equal(state.ext.designatedTarget, 4)
  assert.deepEqual(state.ext.ccoQueue, [4])
  assert.equal(state.ext.ccoAnyReveal, false)
})

test('applyCommand: designate_runoff で cco フェーズ & 複数ターゲット', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'commander'
  state.ext.commander = 1
  applyCommand(state, 1, { type: 'designate_runoff', targets: [3, 4] })
  assert.equal(state.ext.currentPhase, 'cco')
  assert.equal(state.ext.designatedTarget, null)
  assert.deepEqual(state.ext.runoffCandidates, [3, 4])
  assert.deepEqual(state.ext.ccoQueue, [3, 4])
})

test('applyCommand: request_co は discussion へ戻す', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'commander'
  state.ext.commander = 1
  state.ext.consecutiveSkips = new Set([1, 2, 3, 4, 5])
  applyCommand(state, 1, { type: 'request_co', category: 'seer' })
  assert.equal(state.ext.currentPhase, 'discussion')
  assert.equal(state.ext.consecutiveSkips.size, 0)
})

test('applyCommand: cco_full は ccoAnyReveal=true & ccoQueue から除去', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'cco'
  state.ext.ccoQueue = [3, 4]
  applyCommand(state, 3, { type: 'cco_full', claim: { type: 'seer_co', results: [] } })
  assert.equal(state.ext.ccoAnyReveal, true)
  assert.deepEqual(state.ext.ccoQueue, [4])
})

test('applyCommand: cco_skip はキュー除去のみ、ccoAnyReveal 変化なし', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'cco'
  state.ext.ccoQueue = [3, 4]
  applyCommand(state, 3, { type: 'cco_skip' })
  assert.equal(state.ext.ccoAnyReveal, false)
  assert.deepEqual(state.ext.ccoQueue, [4])
})

test('applyCommand: history に全コマンド記録', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'discussion'
  state.ext.discussionQueue = [1, 2]
  applyCommand(state, 1, { type: 'skip' })
  applyCommand(state, 2, { type: 'skip' })
  assert.equal(state.ext.history.length, 2)
  assert.equal(state.ext.history[0].seat, 1)
  assert.equal(state.ext.history[1].seat, 2)
})

// ============================================================
// ヘルパー
// ============================================================

test('resetDiscussionQueue: seats コピー & skip リセット', () => {
  const state = fiveSeatVillage()
  state.ext.consecutiveSkips = new Set([1, 2, 3])
  resetDiscussionQueue(state.ext, [4, 5, 1])
  assert.deepEqual(state.ext.discussionQueue, [4, 5, 1])
  assert.equal(state.ext.consecutiveSkips.size, 0)
})

test('isDiscussionExhausted: 生存全員が skip なら true', () => {
  const state = fiveSeatVillage()
  state.ext.consecutiveSkips = new Set([1, 2, 3, 4, 5])
  assert.equal(isDiscussionExhausted(state.ext, [1, 2, 3, 4, 5]), true)
})

test('isDiscussionExhausted: 一人でも未 skip なら false', () => {
  const state = fiveSeatVillage()
  state.ext.consecutiveSkips = new Set([1, 2, 3, 4])
  assert.equal(isDiscussionExhausted(state.ext, [1, 2, 3, 4, 5]), false)
})
