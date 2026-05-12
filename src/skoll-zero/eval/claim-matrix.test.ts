import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createEmptyClaimMatrix, addClaim, mergeClaimMatrix,
  createEmptyDayOneDeaths, addDayOneDeath, mergeDayOneDeaths,
} from './claim-matrix.ts'

test('createEmptyClaimMatrix returns {}', () => {
  const m = createEmptyClaimMatrix()
  assert.deepEqual(m, {})
})

test('addClaim increments the (role, claimedRole) cell', () => {
  const m = createEmptyClaimMatrix()
  addClaim(m, 'werewolf', 'seer')
  addClaim(m, 'werewolf', 'seer')
  addClaim(m, 'werewolf', 'medium')
  addClaim(m, 'villager', null)
  assert.equal(m.werewolf?.seer, 2)
  assert.equal(m.werewolf?.medium, 1)
  assert.equal(m.villager?.none, 1)
})

test('addClaim with null claimedRole maps to "none" column', () => {
  const m = createEmptyClaimMatrix()
  addClaim(m, 'seer', null)
  addClaim(m, 'seer', null)
  assert.equal(m.seer?.none, 2)
  assert.equal(m.seer?.seer, undefined)
})

test('mergeClaimMatrix sums matching cells and copies new ones', () => {
  const a = createEmptyClaimMatrix()
  addClaim(a, 'werewolf', 'seer')
  addClaim(a, 'werewolf', 'seer')
  addClaim(a, 'villager', null)

  const b = createEmptyClaimMatrix()
  addClaim(b, 'werewolf', 'seer')
  addClaim(b, 'werewolf', 'medium')
  addClaim(b, 'werehamster', 'bodyguard')

  mergeClaimMatrix(a, b)
  assert.equal(a.werewolf?.seer, 3)
  assert.equal(a.werewolf?.medium, 1)
  assert.equal(a.villager?.none, 1)
  assert.equal(a.werehamster?.bodyguard, 1)
})

test('mergeClaimMatrix from empty src is a no-op', () => {
  const a = createEmptyClaimMatrix()
  addClaim(a, 'werewolf', 'seer')
  mergeClaimMatrix(a, createEmptyClaimMatrix())
  assert.equal(a.werewolf?.seer, 1)
})

test('mergeClaimMatrix into empty target copies src', () => {
  const a = createEmptyClaimMatrix()
  const b = createEmptyClaimMatrix()
  addClaim(b, 'werewolf', 'seer')
  addClaim(b, 'werewolf', 'medium')
  mergeClaimMatrix(a, b)
  assert.equal(a.werewolf?.seer, 1)
  assert.equal(a.werewolf?.medium, 1)
})

test('createEmptyDayOneDeaths returns {}', () => {
  assert.deepEqual(createEmptyDayOneDeaths(), {})
})

test('addDayOneDeath increments the role counter', () => {
  const c = createEmptyDayOneDeaths()
  addDayOneDeath(c, 'seer')
  addDayOneDeath(c, 'seer')
  addDayOneDeath(c, 'werewolf')
  assert.equal(c.seer, 2)
  assert.equal(c.werewolf, 1)
  assert.equal(c.villager, undefined)
})

test('mergeDayOneDeaths sums per-role counts', () => {
  const a = createEmptyDayOneDeaths()
  addDayOneDeath(a, 'seer')
  addDayOneDeath(a, 'medium')
  const b = createEmptyDayOneDeaths()
  addDayOneDeath(b, 'seer')
  addDayOneDeath(b, 'werewolf')
  mergeDayOneDeaths(a, b)
  assert.equal(a.seer, 2)
  assert.equal(a.medium, 1)
  assert.equal(a.werewolf, 1)
})

test('row total across columns equals total addClaim calls for that role', () => {
  const m = createEmptyClaimMatrix()
  // wolf 3 seat × 100 game = 300
  for (let i = 0; i < 102; i++) addClaim(m, 'werewolf', 'seer')
  for (let i = 0; i < 38; i++) addClaim(m, 'werewolf', 'medium')
  for (let i = 0; i < 9; i++) addClaim(m, 'werewolf', 'bodyguard')
  for (let i = 0; i < 6; i++) addClaim(m, 'werewolf', 'nekomata')
  for (let i = 0; i < 145; i++) addClaim(m, 'werewolf', null)
  const row = m.werewolf ?? {}
  const total = Object.values(row).reduce((s, v) => s + (v ?? 0), 0)
  assert.equal(total, 300)
})
