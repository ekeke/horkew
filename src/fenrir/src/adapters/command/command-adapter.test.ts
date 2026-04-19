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

test('legalCommands: 初日 (day 0) は 狩人の護衛と狼の襲撃が合法手に含まれない', () => {
  const state = makeState([
    makePlayer(1, 'villager'),
    makePlayer(2, 'werewolf'),
    makePlayer(3, 'werewolf'),
    makePlayer(4, 'bodyguard'),
    makePlayer(5, 'seer'),
  ])
  state.day = 0
  state.ext.currentPhase = 'night'
  // 狩人席
  const guardCmds = legalCommands(state, 4)
  assert.equal(guardCmds.length, 1, '初日 狩人は no_action のみ')
  assert.equal(guardCmds[0].type, 'no_action')
  // 狼リーダー席
  const wolfCmds = legalCommands(state, 2)
  assert.equal(wolfCmds.length, 1, '初日 狼リーダーは no_action のみ')
  assert.equal(wolfCmds[0].type, 'no_action')
  // 占い師は初日でも占い可能（初日占い）
  const seerCmds = legalCommands(state, 5)
  assert.ok(seerCmds.some(c => c.type === 'divine'), '初日 占いは合法')
})

test('legalCommands: 夜フェーズ 狼リーダーは (襲撃者 × 対象) の組合せを列挙、他狼は no_action のみ', () => {
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
  // 2 生存狼 × 3 非狼席 = 6 通りの (actor, target) 組
  assert.equal(leaderAttacks.length, 6, 'リーダー席は全狼×全非狼の組合せを出す')
  const actors = new Set(leaderAttacks.map(c => c.type === 'attack' ? c.actor : -1))
  assert.deepEqual([...actors].sort((a, b) => a - b), [2, 3], '襲撃者候補は生存狼全員')
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

test('legalCommands: 真 seer は divineHistory 付き honest CO バリアントを追加で生成', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'discussion'
  // seer が D0 に seat3 (villager=human), D1 に seat4 (werewolf=wolf) を占った体で履歴を積む
  state.players[0].divineHistory.set(0, { target: 3, result: 'human' })
  state.players[0].divineHistory.set(1, { target: 4, result: 'wolf' })
  const cmds = legalCommands(state, 1)
  const seerCos = cmds.filter(c =>
    c.type === 'role_co' && c.claim.type === 'seer_co',
  )
  // 空 results 版 + 履歴付き honest 版の 2 つ
  assert.equal(seerCos.length, 2, '空 + honest の 2 バリアント')
  const honest = seerCos.find(c =>
    c.type === 'role_co'
    && c.claim.type === 'seer_co'
    && c.claim.results.length === 2,
  )
  assert.ok(honest, 'honest バリアント (results 2件) が存在')
  if (honest && honest.type === 'role_co' && honest.claim.type === 'seer_co') {
    assert.deepEqual(honest.claim.results, [
      { target: 3, result: 'human' },
      { target: 4, result: 'wolf' },
    ], 'day 昇順で results が並ぶ')
  }
})

test('legalCommands: 真 seer でも divineHistory 空なら honest バリアント無し', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'discussion'
  const cmds = legalCommands(state, 1)
  const seerCos = cmds.filter(c =>
    c.type === 'role_co' && c.claim.type === 'seer_co',
  )
  assert.equal(seerCos.length, 1, '空 results 版のみ')
})

test('legalCommands: 真 medium は executionHistory 付き honest CO バリアントを追加', () => {
  const state = fiveSeatVillage()
  // seat2 を medium に差し替え（fiveSeatVillage は bodyguard のところ）
  state.players[1].role = 'medium'
  state.ext.currentPhase = 'discussion'
  // seat3 (villager=human) を D1 処刑、seat4 (werewolf=wolf) を D2 処刑
  state.executionHistory.set(1, 3)
  state.executionHistory.set(2, 4)
  const cmds = legalCommands(state, 2)
  const mediumCos = cmds.filter(c =>
    c.type === 'role_co' && c.claim.type === 'medium_co',
  )
  assert.equal(mediumCos.length, 2, '空 + honest の 2 バリアント')
  const honest = mediumCos.find(c =>
    c.type === 'role_co'
    && c.claim.type === 'medium_co'
    && (c.claim.pastResults?.length ?? 0) === 2,
  )
  assert.ok(honest, 'honest バリアント (pastResults 2件) が存在')
  if (honest && honest.type === 'role_co' && honest.claim.type === 'medium_co') {
    assert.deepEqual(honest.claim.pastResults, ['human', 'wolf'], 'day 昇順')
  }
})

test('legalCommands: 真 mason の mason_co は真相方を先頭に列挙', () => {
  const state = fiveSeatVillage()
  // seat2 + seat5 を mason、seat5 が真相方
  state.players[1].role = 'mason'
  state.players[4].role = 'mason'
  state.ext.currentPhase = 'discussion'
  const cmds = legalCommands(state, 2)
  const masonCos = cmds.filter(c =>
    c.type === 'role_co' && c.claim.type === 'mason_co',
  )
  const partners = masonCos
    .filter(c => c.type === 'role_co' && c.claim.type === 'mason_co')
    .map(c => (c as { claim: { partner: number } }).claim.partner)
  assert.equal(partners[0], 5, '真相方 seat5 が先頭')
})

test('legalCommands: 真 seer の honest seer_co が骨子より先に並ぶ', () => {
  const state = fiveSeatVillage()
  state.players[0].divineHistory.set(0, { target: 3, result: 'human' })
  state.ext.currentPhase = 'discussion'
  const cmds = legalCommands(state, 1)
  const seerCoIndices = cmds
    .map((c, i) => ({ c, i }))
    .filter(x => x.c.type === 'role_co' && x.c.claim.type === 'seer_co')
  assert.equal(seerCoIndices.length, 2, 'honest + 骨子')
  const [first, second] = seerCoIndices
  const firstClaim = first.c.type === 'role_co' ? first.c.claim : null
  assert.ok(firstClaim?.type === 'seer_co' && firstClaim.results.length > 0, 'honest が先頭')
  const secondClaim = second.c.type === 'role_co' ? second.c.claim : null
  assert.ok(secondClaim?.type === 'seer_co' && secondClaim.results.length === 0, '骨子が後')
})

test('legalCommands: mason_co は死亡席も partner 候補に含む (初日犠牲の相方を指定可能)', () => {
  const state = fiveSeatVillage()
  // seat1=seer, seat2=bodyguard, seat3=villager, seat4=werewolf, seat5=fanatic
  // seat2 を mason に昇格 + seat3 を死亡（相方が初日犠牲想定）
  state.players[1].role = 'mason'
  state.players[2].role = 'mason'
  state.players[2].alive = false
  state.ext.currentPhase = 'discussion'
  const cmds = legalCommands(state, 2)
  const masonCos = cmds.filter(c =>
    c.type === 'role_co' && c.claim.type === 'mason_co',
  )
  const partners = masonCos
    .filter(c => c.type === 'role_co' && c.claim.type === 'mason_co')
    .map(c => (c as { claim: { partner: number } }).claim.partner)
  assert.ok(partners.includes(3), '死亡した相方 seat3 を partner 指定可能')
  assert.ok(!partners.includes(2), '自席は partner 候補から除外')
})

test('legalCommands: cco_full mason_co も死亡席を partner 候補に含む', () => {
  const state = fiveSeatVillage()
  state.players[0].alive = false  // seat1 が初日犠牲
  state.ext.currentPhase = 'cco'
  state.ext.ccoQueue = [2]
  const cmds = legalCommands(state, 2)
  const ccoMasons = cmds.filter(c =>
    c.type === 'cco_full' && c.claim.type === 'mason_co',
  )
  const partners = ccoMasons
    .filter(c => c.type === 'cco_full' && c.claim.type === 'mason_co')
    .map(c => (c as { claim: { partner: number } }).claim.partner)
  assert.ok(partners.includes(1), 'CCO でも死亡相方を partner 指定可能')
})

test('legalCommands: 真 seer の結果報告は死亡席も対象 (夜占い対象が朝死亡するケース)', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'discussion'
  state.players[0].claimedRole = 'seer'
  // 真 seer が seat3 を D1 に人間占い、seat4 を D0 に狼占いした履歴
  state.players[0].divineHistory.set(0, { target: 4, result: 'wolf' })
  state.players[0].divineHistory.set(1, { target: 3, result: 'human' })
  state.players[2].alive = false  // seat3 退場
  const cmds = legalCommands(state, 1)
  const seerResults = cmds.filter(c =>
    c.type === 'role_result_report' && c.claim.type === 'seer_result',
  )
  // 死亡席 seat3 への真結果 (human) のみ合法
  const seat3Reports = seerResults.filter(c =>
    c.type === 'role_result_report'
    && c.claim.type === 'seer_result'
    && c.claim.target === 3,
  )
  assert.equal(seat3Reports.length, 1, '真 seer は死亡席でも真結果 1 つのみ報告可')
  assert.ok(seat3Reports.some(c =>
    c.type === 'role_result_report'
    && c.claim.type === 'seer_result'
    && c.claim.result === 'human',
  ), '真結果 human が合法')
  // 予告は生存席のみ
  const forecasts = cmds.filter(c =>
    c.type === 'role_result_report' && c.claim.type === 'forecast',
  )
  const seat3Forecasts = forecasts.filter(c =>
    c.type === 'role_result_report'
    && c.claim.type === 'forecast'
    && c.claim.target === 3,
  )
  assert.equal(seat3Forecasts.length, 0, '死亡席への予告は不可')
})

test('legalCommands: 真 seer は嘘結果を合法手に含めない', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'discussion'
  state.players[0].claimedRole = 'seer'
  state.players[0].divineHistory.set(0, { target: 4, result: 'wolf' })  // 真は狼
  const cmds = legalCommands(state, 1)
  const seat4Reports = cmds.filter(c =>
    c.type === 'role_result_report'
    && c.claim.type === 'seer_result'
    && c.claim.target === 4,
  )
  assert.equal(seat4Reports.length, 1, '真結果のみ 1 件')
  assert.ok(seat4Reports[0].type === 'role_result_report'
    && seat4Reports[0].claim.type === 'seer_result'
    && seat4Reports[0].claim.result === 'wolf', '真 wolf のみ合法')
  // 未占の seat2/3/5 は seer_result コマンドなし
  const seat2Reports = cmds.filter(c =>
    c.type === 'role_result_report'
    && c.claim.type === 'seer_result'
    && c.claim.target === 2,
  )
  assert.equal(seat2Reports.length, 0, '未占席への報告は不可')
})

test('legalCommands: 騙り seer (人外が CO) は両結果を合法手に含む', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'discussion'
  // 狼 seat4 が seer を騙る
  state.players[3].claimedRole = 'seer'
  const cmds = legalCommands(state, 4)
  const seat1Reports = cmds.filter(c =>
    c.type === 'role_result_report'
    && c.claim.type === 'seer_result'
    && c.claim.target === 1,
  )
  assert.equal(seat1Reports.length, 2, '騙り seer は ○/● 両方合法')
})

test('legalCommands: 真 medium は直近処刑の真結果のみ合法', () => {
  const state = fiveSeatVillage()
  state.players[1].role = 'medium'
  state.players[1].claimedRole = 'medium'
  state.ext.currentPhase = 'discussion'
  // 直近処刑: D2 に seat4 (werewolf) を処刑
  state.executionHistory.set(1, 3)  // D1 villager
  state.executionHistory.set(2, 4)  // D2 werewolf (直近)
  const cmds = legalCommands(state, 2)
  const mediumResults = cmds.filter(c =>
    c.type === 'role_result_report' && c.claim.type === 'medium_result',
  )
  assert.equal(mediumResults.length, 1, '真 medium は直近の真結果のみ')
  assert.ok(mediumResults[0].type === 'role_result_report'
    && mediumResults[0].claim.type === 'medium_result'
    && mediumResults[0].claim.result === 'wolf', '直近 werewolf 処刑 → wolf のみ合法')
})

test('legalCommands: 騙り medium (人外が CO) は両結果を合法手に含む', () => {
  const state = fiveSeatVillage()
  state.players[3].claimedRole = 'medium'  // 狼 seat4 が medium を騙る
  state.ext.currentPhase = 'discussion'
  state.executionHistory.set(1, 3)
  const cmds = legalCommands(state, 4)
  const mediumResults = cmds.filter(c =>
    c.type === 'role_result_report' && c.claim.type === 'medium_result',
  )
  assert.equal(mediumResults.length, 2, '騙り medium は ○/● 両方合法')
})

test('legalCommands: 指揮フェーズ commander のみ非空', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'commander'
  state.ext.commander = 1
  assert.ok(legalCommands(state, 1).length > 0)
  assert.deepEqual(legalCommands(state, 2), [])
})

test('legalCommands: 指揮フェーズ request_co は当日要求済みカテゴリを除外', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'commander'
  state.ext.commander = 1
  // medium, seer を既に要求済み（初日犠牲者で応答なしだった想定）
  state.ext.requestedCategoriesThisDay.add('medium')
  state.ext.requestedCategoriesThisDay.add('seer')
  const cmds = legalCommands(state, 1)
  const requestCos = cmds.filter(c => c.type === 'request_co')
  const cats = requestCos
    .filter(c => c.type === 'request_co')
    .map(c => (c as { category: string }).category)
  assert.ok(!cats.includes('medium'), '要求済み medium は除外')
  assert.ok(!cats.includes('seer'), '要求済み seer は除外')
  assert.ok(cats.includes('bodyguard'), '未要求 bodyguard は残る')
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

test('applyCommand: request_co は当日要求済みカテゴリ集合に追加', () => {
  const state = fiveSeatVillage()
  state.ext.currentPhase = 'commander'
  state.ext.commander = 1
  assert.equal(state.ext.requestedCategoriesThisDay.size, 0)
  applyCommand(state, 1, { type: 'request_co', category: 'seer' })
  assert.ok(state.ext.requestedCategoriesThisDay.has('seer'))
  // request_co は discussion へ遷移するので、2 回目呼び出し前に commander へ戻す
  state.ext.currentPhase = 'commander'
  applyCommand(state, 1, { type: 'request_co', category: 'bodyguard' })
  assert.ok(state.ext.requestedCategoriesThisDay.has('bodyguard'))
  assert.equal(state.ext.requestedCategoriesThisDay.size, 2)
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
