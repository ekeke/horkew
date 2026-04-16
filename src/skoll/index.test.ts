import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../types/index.ts'
import { Possibilities, ROLE_COUNT, RoleSignatureBits } from '../retar/possibilities.ts'
import { collectWorlds } from '../hati/worlds.ts'
import { computeRoleProbabilities, getRoleProbability } from './index.ts'

function makeSetup(roles: Record<string, number>): Map<SystemRole, number> {
  return new Map(Object.entries(roles) as [SystemRole, number][])
}

/** Possibilities を作って特定 seat の可能役職を制限する */
function makePossibilities(
  setup: Map<SystemRole, number>,
  overrides?: Record<number, SystemRole[]>,
): Possibilities {
  const p = Possibilities.fromSetup(setup)
  if (overrides) {
    for (const [seatStr, roles] of Object.entries(overrides)) {
      const seat = Number(seatStr)
      let mask = 0
      for (const role of roles) {
        mask |= RoleSignatureBits[role]
      }
      p.possibilities[seat] = mask
    }
  }
  return p
}

describe('Skoll computeRoleProbabilities', () => {
  it('3人村: 村村狼 — 全員未確定', () => {
    const setup = makeSetup({ villager: 2, werewolf: 1 })
    const p = Possibilities.fromSetup(setup)
    // 全 seat が villager | werewolf の可能性
    const rp = computeRoleProbabilities(p, setup)

    // 3人に狼1 → 各 seat が狼である確率 = 1/3
    assert.equal(rp.totalWorlds, 3)
    for (let seat = 1; seat <= 3; seat++) {
      assertClose(getRoleProbability(rp, seat, 'werewolf'), 1 / 3)
      assertClose(getRoleProbability(rp, seat, 'villager'), 2 / 3)
    }
  })

  it('3人村: seat1 が狼確定', () => {
    const setup = makeSetup({ villager: 2, werewolf: 1 })
    const p = makePossibilities(setup, {
      1: ['werewolf'],
    })
    const rp = computeRoleProbabilities(p, setup)

    assert.equal(rp.totalWorlds, 1)
    assertClose(getRoleProbability(rp, 1, 'werewolf'), 1.0)
    assertClose(getRoleProbability(rp, 1, 'villager'), 0.0)
    assertClose(getRoleProbability(rp, 2, 'villager'), 1.0)
    assertClose(getRoleProbability(rp, 3, 'villager'), 1.0)
  })

  it('4人村: 村村占狼 — 占い確定、狼不明', () => {
    const setup = makeSetup({ villager: 2, seer: 1, werewolf: 1 })
    const p = makePossibilities(setup, {
      1: ['seer'],      // seat1 は占い確定
      // seat2,3,4 は villager | werewolf
      2: ['villager', 'werewolf'],
      3: ['villager', 'werewolf'],
      4: ['villager', 'werewolf'],
    })
    const rp = computeRoleProbabilities(p, setup)

    assert.equal(rp.totalWorlds, 3) // 狼が 2,3,4 のいずれか
    assertClose(getRoleProbability(rp, 1, 'seer'), 1.0)
    assertClose(getRoleProbability(rp, 1, 'werewolf'), 0.0)
    for (let seat = 2; seat <= 4; seat++) {
      assertClose(getRoleProbability(rp, seat, 'werewolf'), 1 / 3)
      assertClose(getRoleProbability(rp, seat, 'villager'), 2 / 3)
      assertClose(getRoleProbability(rp, seat, 'seer'), 0.0)
    }
  })

  it('各 seat の全 role 確率の合計が 1.0', () => {
    const setup = makeSetup({ villager: 3, seer: 1, medium: 1, werewolf: 2 })
    const p = Possibilities.fromSetup(setup)
    const rp = computeRoleProbabilities(p, setup)

    for (let seat = 1; seat <= 7; seat++) {
      let sum = 0
      for (let r = 0; r < ROLE_COUNT; r++) {
        sum += rp.probabilities[seat * ROLE_COUNT + r]
      }
      assertClose(sum, 1.0)
    }
  })

  it('totalWorlds が collectWorlds の結果数と一致', () => {
    const setup = makeSetup({ villager: 3, seer: 1, werewolf: 2, bodyguard: 1 })
    const p = Possibilities.fromSetup(setup)
    const rp = computeRoleProbabilities(p, setup)
    const worlds = collectWorlds(p, setup)!
    assert.equal(rp.totalWorlds, worlds.length)
  })

  it('denied role の確率は 0.0', () => {
    const setup = makeSetup({ villager: 2, seer: 1, werewolf: 1 })
    const p = makePossibilities(setup, {
      1: ['villager', 'seer'],      // 狼ではない
      2: ['villager', 'werewolf'],   // 占いではない
      3: ['villager', 'werewolf'],
      4: ['seer', 'werewolf'],       // 村人ではない
    })
    const rp = computeRoleProbabilities(p, setup)

    assertClose(getRoleProbability(rp, 1, 'werewolf'), 0.0)
    assertClose(getRoleProbability(rp, 2, 'seer'), 0.0)
    assertClose(getRoleProbability(rp, 4, 'villager'), 0.0)
  })
})

function assertClose(actual: number, expected: number, epsilon = 1e-10) {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${expected}, got ${actual}`,
  )
}
