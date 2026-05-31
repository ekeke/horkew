import { describe, it } from 'node:test'
import assert from 'node:assert'
import type { SystemRole } from '../types/index.ts'
import { allKnownRoles, allRolesIn, villageRolesIn, liarRolesIn, humanRolesIn } from './role-sets.ts'

const make = (entries: Array<[SystemRole, number]>): Map<SystemRole, number> => new Map(entries)

describe('role-sets', () => {
  it('allKnownRoles は systemRoles の全 entry を宣言順で返す', () => {
    const all = allKnownRoles()
    assert.ok(all.includes('villager' as SystemRole))
    assert.ok(all.includes('werewolf' as SystemRole))
    assert.ok(all.includes('paparazzi' as SystemRole))
    assert.ok(all.length >= 12)
  })

  it('allRolesIn は setup に count>0 で含まれる役職のみ返す', () => {
    const setup = make([
      ['villager', 3],
      ['werewolf', 1],
      ['seer', 0],
    ])
    const got = allRolesIn(setup)
    assert.ok(got.includes('villager' as SystemRole))
    assert.ok(got.includes('werewolf' as SystemRole))
    assert.ok(!got.includes('seer' as SystemRole))
  })

  it('villageRolesIn は faction=village の役職のみ返す', () => {
    const setup = make([
      ['villager', 3],
      ['seer', 1],
      ['werewolf', 1],
      ['paparazzi', 1],
      ['werehamster', 1],
    ])
    const got = villageRolesIn(setup)
    assert.ok(got.includes('villager' as SystemRole))
    assert.ok(got.includes('seer' as SystemRole))
    assert.ok(!got.includes('werewolf' as SystemRole))
    assert.ok(!got.includes('paparazzi' as SystemRole))
    assert.ok(!got.includes('werehamster' as SystemRole))
  })

  it('liarRolesIn は faction!=village の役職のみ返す (paparazzi も含む)', () => {
    const setup = make([
      ['villager', 3],
      ['werewolf', 1],
      ['paparazzi', 1],
      ['werehamster', 1],
      ['immoralist', 1],
    ])
    const got = liarRolesIn(setup)
    for (const role of ['werewolf', 'paparazzi', 'werehamster', 'immoralist'] as SystemRole[]) {
      assert.ok(got.includes(role), `expected ${role} in liarRolesIn`)
    }
    assert.ok(!got.includes('villager' as SystemRole))
  })

  it('liarRolesIn は setup に含まれない役職を除外する', () => {
    const setup = make([
      ['villager', 3],
      ['werewolf', 1],
    ])
    const got = liarRolesIn(setup)
    assert.deepStrictEqual(got, ['werewolf'])
    assert.ok(!got.includes('paparazzi' as SystemRole))
    assert.ok(!got.includes('werehamster' as SystemRole))
  })

  it('humanRolesIn は seerResult=human の役職のみ返す', () => {
    const setup = make([
      ['villager', 3],
      ['seer', 1],
      ['werewolf', 1],
      ['paparazzi', 1],
      ['werehamster', 1],
      ['immoralist', 1],
    ])
    const got = humanRolesIn(setup)
    for (const role of ['villager', 'seer', 'paparazzi', 'werehamster', 'immoralist'] as SystemRole[]) {
      assert.ok(got.includes(role), `expected ${role} in humanRolesIn`)
    }
    assert.ok(!got.includes('werewolf' as SystemRole))
  })
})
