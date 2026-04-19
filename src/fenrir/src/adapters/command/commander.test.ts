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

test('selectCommanderFromRetar: preferred 席が村確定なら優先', () => {
  const possibilities = new Map([
    [1, roles('villager')],  // 村確定（= 通常ならここが commander）
    [2, roles('villager')],  // 村確定（preferred）
    [3, roles('werewolf')],
  ])
  assert.equal(
    selectCommanderFromRetar(possibilities, [1, 2, 3], new Set([2])),
    2,
    'preferred 席 2 が村確定なので最小席 1 を差し置いて選ばれる',
  )
})

test('selectCommanderFromRetar: preferred 席が村確定でなければ通常選出にフォールバック', () => {
  const possibilities = new Map([
    [1, roles('villager')],        // 村確定（preferred じゃない）
    [2, roles('werewolf', 'seer')], // preferred だが村未確定
    [3, roles('medium')],
  ])
  assert.equal(
    selectCommanderFromRetar(possibilities, [1, 2, 3], new Set([2])),
    1,
    'preferred 席 2 が村未確定なので通常通り最小村確定席 1',
  )
})

test('selectCommanderFromRetar: preferred 席が複数村確定なら preferred 内の最小', () => {
  const possibilities = new Map([
    [1, roles('villager')],
    [3, roles('villager')],  // preferred
    [5, roles('villager')],  // preferred
  ])
  assert.equal(
    selectCommanderFromRetar(possibilities, [1, 3, 5], new Set([3, 5])),
    3,
  )
})

test('selectCommanderFromRetar: preferred が空 Set なら通常選出', () => {
  const possibilities = new Map([
    [1, roles('werewolf')],
    [2, roles('villager')],
  ])
  assert.equal(selectCommanderFromRetar(possibilities, [1, 2], new Set()), 2)
})
