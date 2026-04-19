/**
 * commander.ts ユニットテスト
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../../../types/index.ts'
import { isConfirmedVillage, selectCommanderFromRetar } from './commander.ts'

function roles(...names: SystemRole[]): Set<SystemRole> {
  return new Set(names)
}

// ============================================================
// isConfirmedVillage
// ============================================================

test('isConfirmedVillage: 村役職のみなら true', () => {
  assert.equal(isConfirmedVillage(roles('villager')), true)
  assert.equal(isConfirmedVillage(roles('seer', 'medium', 'bodyguard')), true)
  assert.equal(isConfirmedVillage(roles('villager', 'mason', 'nekomata')), true)
})

test('isConfirmedVillage: 人外が 1 つでも含まれれば false', () => {
  assert.equal(isConfirmedVillage(roles('villager', 'werewolf')), false)
  assert.equal(isConfirmedVillage(roles('seer', 'fanatic')), false)
  assert.equal(isConfirmedVillage(roles('villager', 'werehamster')), false)
  assert.equal(isConfirmedVillage(roles('villager', 'immoralist')), false)
})

test('isConfirmedVillage: 空集合 / undefined は false', () => {
  assert.equal(isConfirmedVillage(new Set()), false)
  assert.equal(isConfirmedVillage(undefined), false)
})

// ============================================================
// selectCommanderFromRetar
// ============================================================

test('selectCommanderFromRetar: 村確定席が 1 つなら該当席', () => {
  const possibilities = new Map([
    [1, roles('villager', 'werewolf')],
    [2, roles('seer')],  // 村確定
    [3, roles('villager', 'fanatic')],
  ])
  assert.equal(selectCommanderFromRetar(possibilities, [1, 2, 3]), 2)
})

test('selectCommanderFromRetar: 村確定席が複数なら最小席番', () => {
  const possibilities = new Map([
    [1, roles('villager', 'werewolf')],
    [2, roles('seer')],   // 村確定
    [3, roles('medium')], // 村確定
    [5, roles('villager')],  // 村確定（最小）
  ])
  assert.equal(selectCommanderFromRetar(possibilities, [1, 2, 3, 5]), 2)
})

test('selectCommanderFromRetar: 村確定席なし → null', () => {
  const possibilities = new Map([
    [1, roles('villager', 'werewolf')],
    [2, roles('seer', 'fanatic')],
  ])
  assert.equal(selectCommanderFromRetar(possibilities, [1, 2]), null)
})

test('selectCommanderFromRetar: 生存席に含まれない席は無視', () => {
  const possibilities = new Map([
    [1, roles('villager')],  // 村確定だが退場済み
    [2, roles('seer', 'werewolf')],
    [3, roles('medium')],  // 村確定、生存
  ])
  assert.equal(selectCommanderFromRetar(possibilities, [2, 3]), 3)
})

test('selectCommanderFromRetar: possibilities が空 Map → null', () => {
  assert.equal(selectCommanderFromRetar(new Map(), [1, 2, 3]), null)
})

test('selectCommanderFromRetar: 全員村確定 → 席番号最小', () => {
  const possibilities = new Map([
    [3, roles('villager')],
    [1, roles('seer')],
    [2, roles('medium')],
  ])
  assert.equal(selectCommanderFromRetar(possibilities, [1, 2, 3]), 1)
})
