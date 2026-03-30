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
    assert.deepStrictEqual(possibilities.clone().possibilities, possibilities.possibilities)
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
