import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { SystemRole } from '../../types/index.ts'
import type { GameEvent } from '../../lupa/types.ts'
import { extractDayOneDeathRoles } from './multi-runner.ts'

const players: ReadonlyArray<{ seat: number, role: SystemRole }> = [
  { seat: 1, role: 'villager' },
  { seat: 2, role: 'seer' },
  { seat: 3, role: 'medium' },
  { seat: 4, role: 'bodyguard' },
  { seat: 5, role: 'mason' },
  { seat: 6, role: 'mason' },
  { seat: 7, role: 'nekomata' },
  { seat: 8, role: 'werewolf' },
  { seat: 9, role: 'werewolf' },
  { seat: 10, role: 'werewolf' },
  { seat: 11, role: 'fanatic' },
  { seat: 12, role: 'werehamster' },
  { seat: 13, role: 'immoralist' },
  { seat: 14, role: 'villager' },
]

test('extractDayOneDeathRoles: night_kill on day 1 -> single role', () => {
  const events: GameEvent[] = [
    { type: 'night_kill', target: 2 },  // 占い師が初日犠牲
    { type: 'execution', target: 9 },   // Day 1 day phase の処刑 (= Day 1 終了)
    { type: 'night_kill', target: 5 },  // Day 2 以降は対象外
  ]
  const result = extractDayOneDeathRoles(events, players)
  assert.deepEqual(result, ['seer'])
})

test('extractDayOneDeathRoles: empty events -> empty', () => {
  assert.deepEqual(extractDayOneDeathRoles([], players), [])
})

test('extractDayOneDeathRoles: multiple kills before first execution', () => {
  const events: GameEvent[] = [
    { type: 'night_kill', target: 8 },   // wolf (= 初日に占いで殺された?ありえないが unit test)
    { type: 'fox_kill', target: 12 },    // 狐
    { type: 'curse_kill', target: 7 },   // 猫又呪殺 (通常 Day 1 ではないが unit test)
    { type: 'execution', target: 9 },    // Day 1 終了
    { type: 'night_kill', target: 5 },   // 対象外
  ]
  const result = extractDayOneDeathRoles(events, players)
  assert.deepEqual(result, ['werewolf', 'werehamster', 'nekomata'])
})

test('extractDayOneDeathRoles: no execution event (ゲーム終了が Day 1 night 中) -> 全部拾う', () => {
  const events: GameEvent[] = [
    { type: 'night_kill', target: 2 },
    { type: 'fox_kill', target: 12 },
    { type: 'game_over', result: 'werehamster_won' },
  ]
  const result = extractDayOneDeathRoles(events, players)
  assert.deepEqual(result, ['seer', 'werehamster'])
})

test('extractDayOneDeathRoles: ignores non-death events', () => {
  const events: GameEvent[] = [
    { type: 'peace' },
    { type: 'seer_claim', actor: 2, results: [] },
    { type: 'vote', voter: 1, target: 9 },
    { type: 'night_kill', target: 2 },
    { type: 'execution', target: 9 },
  ]
  const result = extractDayOneDeathRoles(events, players)
  assert.deepEqual(result, ['seer'])
})
