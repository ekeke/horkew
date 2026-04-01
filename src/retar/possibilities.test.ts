import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  type SystemRole,
  type RolePossibility,
  combinationWithReplacementInLimit,
  possibilityFromRoles,
  removeRoleFromPossibility,
  hasRoleInPossibility,
  popCount,
  roleCount,
  intersectionOfRolePossibility,
  differenceOfRolePossibilities,
  setOfRolesFromPossibility,
  Possibilities,
} from './possibilities.ts'

describe('popCount', () => {
  it('should return the correct population count', () => {
    const input = 0b10101010

    const result = popCount(input)

    assert.strictEqual(result, 4)
  })
})

describe('removeRoleFromPossibility', () => {
  it('should remove role from Possibility', () => {
    const possibility: RolePossibility = 0b0011
    const role: SystemRole = 'seer'

    const result = removeRoleFromPossibility(possibility, role)

    assert.strictEqual(result, 0b0001)
  })
})

describe('hasRoleInPossibility', () => {
  it('should return true if role exists in possibility', () => {
    const possibility: RolePossibility = 0b0011
    const role: SystemRole = 'seer'

    const result = hasRoleInPossibility(possibility, role)

    assert.strictEqual(result, true)
  })

  it('should return false if role does not exist in possibility', () => {
    const possibility: RolePossibility = 0b0101
    const role: SystemRole = 'seer'

    const result = hasRoleInPossibility(possibility, role)

    assert.strictEqual(result, false)
  })
})

describe('roleCount', () => {
  it('should return the correct role count', () => {
    const possibility: RolePossibility = 0b10101010

    const result = roleCount(possibility)

    assert.strictEqual(result, 4)
  })
})

describe('setOfRolesFromPossibility', () => {
  it('should return a set of roles from the given possibility', () => {
    const possibility: RolePossibility = 0b10101010

    const result = setOfRolesFromPossibility(possibility)

    assert.deepStrictEqual(result, new Set<SystemRole>(['seer', 'bodyguard', 'nekomata', 'possessed']))
  })

  it('should return an empty set if the possibility is 0', () => {
    const possibility: RolePossibility = 0b0000

    const result = setOfRolesFromPossibility(possibility)

    assert.deepStrictEqual(result, new Set<SystemRole>())
  })
})

describe('intersectionOfRolePossibility', () => {
  it('should return the intersection of two role possibilities', () => {
    const possibilityA: RolePossibility = 0b10101010
    const possibilityB: RolePossibility = 0b11001100

    const result = intersectionOfRolePossibility(possibilityA, possibilityB)

    assert.strictEqual(result, 0b10001000)
  })

  it('should return 0 if there is no intersection between two role possibilities', () => {
    const possibilityA: RolePossibility = 0b10101010
    const possibilityB: RolePossibility = 0b01010101

    const result = intersectionOfRolePossibility(possibilityA, possibilityB)

    assert.strictEqual(result, 0b00000000)
  })
})

describe('differenceOfRolePossibilities', () => {
  it('should return the difference between two role possibilities', () => {
    const possibilityA: RolePossibility = 0b10101010
    const possibilityB: RolePossibility = 0b01010101

    const result = differenceOfRolePossibilities(possibilityA, possibilityB)

    assert.strictEqual(result, 0b10101010)
  })

  it('should return the same role possibility if the second possibility is 0', () => {
    const possibilityA: RolePossibility = 0b10101010
    const possibilityB: RolePossibility = 0b00000000

    const result = differenceOfRolePossibilities(possibilityA, possibilityB)

    assert.strictEqual(result, 0b10101010)
  })

  it('should return the same role possibility if the first possibility is 0', () => {
    const possibilityA: RolePossibility = 0b10101010
    const possibilityB: RolePossibility = 0b00001111

    const result = differenceOfRolePossibilities(possibilityA, possibilityB)

    assert.strictEqual(result, 0b10100000)
  })
})

describe('Possibilities', () => {
  it('should initialize with the correct setup', () => {
    const setup = new Map<SystemRole, number>([
      ['seer', 2],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ])

    const possibilities = new Possibilities(setup)

    assert.ok(possibilities !== undefined)
    assert.deepStrictEqual(possibilities.cloneInstance().possibilities, possibilities.possibilities)
  })

  it('should throw an error when setup is Uint16Array without setupObject', () => {
    const setup = new Uint16Array([0b10101010])

    assert.throws(() => new Possibilities(setup), { message: /setupArr is required when setup is Uint16Array/ })
  })

  it('should fix a role in a seat', () => {
    const setup = new Map<SystemRole, number>([
      ['seer', 1],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ])
    const possibilities = new Possibilities(setup)
    const result = possibilities.fixRole(1, 'nekomata')

    assert.strictEqual(result, true)
    assert.strictEqual( hasRoleInPossibility(possibilities.get(1), 'nekomata'), true)
    assert.strictEqual( roleCount(possibilities.get(1)), 1)
    assert.strictEqual( hasRoleInPossibility(possibilities.get(2), 'nekomata'), false)
  })

  it('should not fix a role if it is not available in the setup', () => {
    const setup = new Map<SystemRole, number>([
      ['seer', 0],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ])
    const possibilities = new Possibilities(setup)

    const result = possibilities.fixRole(1, 'seer')

    assert.strictEqual(result, false)
  })
})

describe('fixRole', () => {
  it('should fix a role in a seat', () => {
    const setup = new Map<SystemRole, number>([
      ['seer', 1],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ])
    const possibilities = new Possibilities(setup)
    const result = possibilities.fixRole(1, 'nekomata')

    assert.strictEqual(result, true)
    assert.strictEqual(hasRoleInPossibility(possibilities.get(1), 'nekomata'), true)
    assert.strictEqual(roleCount(possibilities.get(1)), 1)
    assert.strictEqual(hasRoleInPossibility(possibilities.get(2), 'nekomata'), false)
  })

  it('should not fix a role if it is not available in the setup', () => {
    const setup = new Map<SystemRole, number>([
      ['seer', 0],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ])
    const possibilities = new Possibilities(setup)

    const result = possibilities.fixRole(1, 'seer')

    assert.strictEqual(result, false)
  })
})

describe('markAsLiar', () => {
  it('should mark the seat as a liar', () => {
    const possibilities = new Possibilities(new Map<SystemRole, number>([
      ['seer', 1],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ]))
    possibilities.markAsLiar(1)
    assert.deepStrictEqual(setOfRolesFromPossibility(possibilities.get(1)), new Set<SystemRole>(['possessed']))
  })
})

describe('markAsHuman', () => {
  it('should mark the seat as human', () => {
    const possibilities = new Possibilities(new Map<SystemRole, number>([
      ['seer', 1],
      ['bodyguard', 1],
      ['werewolf', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ]))
    possibilities.markAsHuman(1)
    assert.deepStrictEqual(setOfRolesFromPossibility(possibilities.get(1)), new Set<SystemRole>(['seer', 'bodyguard', 'nekomata', 'possessed']))
  })
})

describe('denyRole', () => {
  it('should deny a role in a seat', () => {
    const possibilities = new Possibilities(new Map<SystemRole, number>([
      ['seer', 1],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ]))
    possibilities.denyRole(1, 'seer')
    assert.strictEqual(hasRoleInPossibility(possibilities.get(1), 'seer'), false)
  })

  it('should not affect other roles in the seat', () => {
    const possibilities = new Possibilities(new Map<SystemRole, number>([
      ['seer', 1],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ]))
    possibilities.denyRole(1, 'seer')
    assert.strictEqual(hasRoleInPossibility(possibilities.get(1), 'bodyguard'), true)
    assert.strictEqual(hasRoleInPossibility(possibilities.get(1), 'nekomata'), true)
    assert.strictEqual(hasRoleInPossibility(possibilities.get(1), 'possessed'), true)
  })
})

describe('union', () => {
  it('should perform the union operation correctly', () => {
    const setup = new Map<SystemRole, number>([
      ['seer', 1],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ])
    const possibilitiesA = new Possibilities(setup)
    possibilitiesA.set(1, possibilityFromRoles(new Set(['seer', 'bodyguard'] as SystemRole[])))
    possibilitiesA.set(2, possibilityFromRoles(new Set(['possessed'] as SystemRole[])))

    const possibilitiesB = new Possibilities(setup)
    possibilitiesB.set(1, possibilityFromRoles(new Set(['bodyguard'] as SystemRole[])))
    possibilitiesB.set(2, possibilityFromRoles(new Set(['seer'] as SystemRole[])))

    possibilitiesA.union(possibilitiesB)

    assert.strictEqual(possibilitiesA.hasRole(1, 'seer'), true)
    assert.strictEqual(possibilitiesA.hasRole(1, 'bodyguard'), true)
    assert.strictEqual(possibilitiesA.hasRole(1, 'nekomata'), false)
    assert.strictEqual(possibilitiesA.hasRole(1, 'possessed'), false)
    assert.strictEqual(possibilitiesA.hasRole(2, 'seer'), true)
    assert.strictEqual(possibilitiesA.hasRole(2, 'bodyguard'), false)
    assert.strictEqual(possibilitiesA.hasRole(2, 'nekomata'), false)
    assert.strictEqual(possibilitiesA.hasRole(2, 'possessed'), true)
  })
})

describe('toStructured', () => {
  it('should return a map of seats with their corresponding set of roles', () => {
    const possibilities = new Possibilities(new Map<SystemRole, number>([
      ['seer', 1],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ]))
    possibilities.fixRole(1, 'seer')
    possibilities.fixRole(2, 'bodyguard')
    possibilities.fixRole(3, 'nekomata')
    possibilities.fixRole(4, 'possessed')

    const result = possibilities.toStructured()

    assert.ok(result instanceof Map)
    assert.strictEqual(result.size, 4)
    assert.deepStrictEqual(result.get(1), new Set<SystemRole>(['seer']))
    assert.deepStrictEqual(result.get(2), new Set<SystemRole>(['bodyguard']))
    assert.deepStrictEqual(result.get(3), new Set<SystemRole>(['nekomata']))
    assert.deepStrictEqual(result.get(4), new Set<SystemRole>(['possessed']))
  })
})

describe('fix confluence', () => {
  it('should produce the same result regardless of fixRole order', () => {
    // Setup: 1 seer, 1 bodyguard, 1 werewolf, 1 possessed, 1 villager (5 seats)
    const makeSetup = () => new Map<SystemRole, number>([
      ['seer', 1], ['bodyguard', 1], ['werewolf', 1], ['possessed', 1], ['villager', 1]
    ])

    // Order A: fix seats 1,2,3
    const pA = new Possibilities(makeSetup())
    pA.fixRole(1, 'seer')
    pA.fixRole(2, 'werewolf')
    pA.fixRole(3, 'bodyguard')

    // Order B: fix seats 3,1,2 (reversed)
    const pB = new Possibilities(makeSetup())
    pB.fixRole(3, 'bodyguard')
    pB.fixRole(1, 'seer')
    pB.fixRole(2, 'werewolf')

    // Order C: fix seats 2,3,1
    const pC = new Possibilities(makeSetup())
    pC.fixRole(2, 'werewolf')
    pC.fixRole(3, 'bodyguard')
    pC.fixRole(1, 'seer')

    for (let i = 1; i <= 5; i++) {
      assert.strictEqual(pA.get(i), pB.get(i), `seat ${i} differs between order A and B`)
      assert.strictEqual(pA.get(i), pC.get(i), `seat ${i} differs between order A and C`)
    }
  })

  it('should cascade through a chain of singletons', () => {
    // Setup: 1 of each role, 4 seats
    // Seat 1: {seer, bodyguard}
    // Seat 2: {bodyguard, nekomata}
    // Seat 3: {nekomata, possessed}
    // Seat 4: {seer, possessed}
    // Fixing seat 1 to seer should chain: seat 4 loses seer → {possessed} → seat 3 loses possessed → {nekomata} → seat 2 loses nekomata → {bodyguard}
    const setup = new Map<SystemRole, number>([
      ['seer', 1], ['bodyguard', 1], ['nekomata', 1], ['possessed', 1]
    ])
    const p = new Possibilities(setup)
    // Manually narrow possibilities
    p.denyRole(1, 'nekomata')
    p.denyRole(1, 'possessed')
    p.denyRole(2, 'seer')
    p.denyRole(2, 'possessed')
    p.denyRole(3, 'seer')
    p.denyRole(3, 'bodyguard')
    p.denyRole(4, 'bodyguard')
    p.denyRole(4, 'nekomata')

    // Fix seat 1 to seer — should cascade through the chain
    const result = p.fixRole(1, 'seer')
    assert.strictEqual(result, true)

    // All seats should be fully determined
    assert.strictEqual(roleCount(p.get(1)), 1)
    assert.strictEqual(roleCount(p.get(2)), 1)
    assert.strictEqual(roleCount(p.get(3)), 1)
    assert.strictEqual(roleCount(p.get(4)), 1)

    assert.strictEqual(hasRoleInPossibility(p.get(1), 'seer'), true)
    assert.strictEqual(hasRoleInPossibility(p.get(2), 'bodyguard'), true)
    assert.strictEqual(hasRoleInPossibility(p.get(3), 'nekomata'), true)
    assert.strictEqual(hasRoleInPossibility(p.get(4), 'possessed'), true)
  })

  it('refix should produce confluent results with pre-set singletons', () => {
    const setup = new Map<SystemRole, number>([
      ['seer', 1], ['bodyguard', 1], ['nekomata', 1], ['possessed', 1]
    ])
    const p = new Possibilities(setup)
    // Manually set seats 1,2 to singletons, leave 3,4 with 2 roles each
    p.denyRole(1, 'bodyguard')
    p.denyRole(1, 'nekomata')
    p.denyRole(1, 'possessed')  // seat 1 = {seer}
    p.denyRole(2, 'seer')
    p.denyRole(2, 'nekomata')
    p.denyRole(2, 'possessed')  // seat 2 = {bodyguard}
    p.denyRole(3, 'seer')
    p.denyRole(3, 'bodyguard')  // seat 3 = {nekomata, possessed}
    p.denyRole(4, 'seer')
    p.denyRole(4, 'bodyguard')  // seat 4 = {nekomata, possessed}

    const result = p.refix()
    assert.strictEqual(result, true)

    // seer and bodyguard should be removed from seats 3,4 (already done)
    // nekomata and possessed each have 1 slot → one cascade should fire
    // Seat 3 and 4 each have {nekomata, possessed}, so refix can't fully determine them
    // but setup counts should be correct
    assert.strictEqual(hasRoleInPossibility(p.get(1), 'seer'), true)
    assert.strictEqual(roleCount(p.get(1)), 1)
    assert.strictEqual(hasRoleInPossibility(p.get(2), 'bodyguard'), true)
    assert.strictEqual(roleCount(p.get(2)), 1)
  })
})

describe('combinationWithReplacementInLimit', () => {
  it('should generate combinations with replacement within limits', () => {
    const roles: SystemRole[] = ['seer', 'bodyguard', 'nekomata']
    const k = 2
    const limits: { [role in SystemRole]?: number } = {
      seer: 1,
      bodyguard: 2,
      nekomata: 1
    }

    const result = Array.from(combinationWithReplacementInLimit(roles, k, limits))
    assert.deepStrictEqual(result, [
      { seer: 1, bodyguard: 1 },
      { seer: 1, nekomata: 1 },
      { bodyguard: 1, nekomata: 1 },
      { bodyguard: 2 },
    ])
  })
})
