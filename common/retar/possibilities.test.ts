import { describe, it, expect } from 'vitest'
import {
  type SystemRole,
  type RolePossibility,
  combinationWithReplacementInLimit,
  combinationWithReplacementFromSet,
  possibilityFromSet,
  addRoleToPossibility,
  removeRoleFromPossibility,
  hasRoleInPossibility,
  popCount,
  roleCount,
  intersectionOfRolePossibility,
  differenceOfRolePossibilities,
  setOfRolesFromPossibility
} from './possibilities'

import { shim as supersetShim } from 'set.prototype.issupersetof'
supersetShim()

describe('popCount', () => {
  it('should return the correct population count', () => {
    const input = 0b10101010; // Example input

    const result = popCount(input);

    expect(result).toBe(4); // Expected population count
  });
});

describe('removeRoleFromPossibility', () => {
  it('should remove role from Possibility', () => {
    const possibility: RolePossibility = 0b0011; // Example possibility
    const role: SystemRole = 'seer'; // Example role

    const result = removeRoleFromPossibility(possibility, role);

    expect(result).toBe(0b0001); // Expected result after removing the role
  });
})

describe('hasRoleInPossibility', () => {
  it('should return true if role exists in possibility', () => {
    const possibility: RolePossibility = 0b0011; // Example possibility
    const role: SystemRole = 'seer'; // Example role

    const result = hasRoleInPossibility(possibility, role);

    expect(result).toBe(true); // Expected result when role exists in possibility
  });

  it('should return false if role does not exist in possibility', () => {
    const possibility: RolePossibility = 0b0101; // Example possibility
    const role: SystemRole = 'seer'; // Example role

    const result = hasRoleInPossibility(possibility, role);

    expect(result).toBe(false); // Expected result when role does not exist in possibility
  });
});

describe('roleCount', () => {
  it('should return the correct role count', () => {
    const possibility: RolePossibility = 0b10101010; // Example possibility

    const result = roleCount(possibility);

    expect(result).toBe(4); // Expected role count
  });
});

describe('setOfRolesFromPossibility', () => {
  it('should return a set of roles from the given possibility', () => {
    const possibility: RolePossibility = 0b10101010; // Example possibility

    const result = setOfRolesFromPossibility(possibility);

    expect(result).toEqual(new Set<SystemRole>(['seer', 'bodyguard', 'nekomata', 'possessed'])); // Expected set of roles
  });

  it('should return an empty set if the possibility is 0', () => {
    const possibility: RolePossibility = 0b0000; // Example possibility

    const result = setOfRolesFromPossibility(possibility);

    expect(result).toEqual(new Set<SystemRole>()); // Expected empty set
  });
});

describe('intersectionOfRolePossibility', () => {
  it('should return the intersection of two role possibilities', () => {
    const possibilityA: RolePossibility = 0b10101010; // Example possibility A
    const possibilityB: RolePossibility = 0b11001100; // Example possibility B

    const result = intersectionOfRolePossibility(possibilityA, possibilityB);

    expect(result).toBe(0b10001000); // Expected intersection of possibilities A and B
  });

  it('should return 0 if there is no intersection between two role possibilities', () => {
    const possibilityA: RolePossibility = 0b10101010; // Example possibility A
    const possibilityB: RolePossibility = 0b01010101; // Example possibility B

    const result = intersectionOfRolePossibility(possibilityA, possibilityB);

    expect(result).toBe(0b00000000); // Expected 0 as there is no intersection between possibilities A and B
  });
});

describe('differenceOfRolePossibilities', () => {
  it('should return the difference between two role possibilities', () => {
    const possibilityA: RolePossibility = 0b10101010; // Example possibility A
    const possibilityB: RolePossibility = 0b01010101; // Example possibility B

    const result = differenceOfRolePossibilities(possibilityA, possibilityB);

    expect(result).toBe(0b10101010); // Expected result when all roles in possibility B are removed from possibility A
  });

  it('should return the same role possibility if the second possibility is 0', () => {
    const possibilityA: RolePossibility = 0b10101010; // Example possibility A
    const possibilityB: RolePossibility = 0b00000000; // Example possibility B

    const result = differenceOfRolePossibilities(possibilityA, possibilityB);

    expect(result).toBe(0b10101010); // Expected result when the second possibility is 0
  });

  it('should return the same role possibility if the first possibility is 0', () => {
    const possibilityA: RolePossibility = 0b10101010; // Example possibility A
    const possibilityB: RolePossibility = 0b00001111; // Example possibility B

    const result = differenceOfRolePossibilities(possibilityA, possibilityB);

    expect(result).toBe(0b10100000); // Expected result when the first possibility is 0
  });
});

import { Possibilities } from './possibilities'

describe('Possibilities', () => {
  it('should initialize with the correct setup', () => {
    const setup = new Map<SystemRole, number>([
      ['seer', 2],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ])

    const possibilities = new Possibilities(setup)

    expect(possibilities).toBeDefined()
    expect(possibilities.clone()).toEqual(possibilities)
  })

  it('should throw an error when setup is Uint16Array without setupObject', () => {
    const setup = new Uint16Array([0b10101010])

    expect(() => new Possibilities(setup)).toThrowError('setupObject is required when setup is Uint16Array')
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

    expect(result).toBe(true)
    expect( hasRoleInPossibility(possibilities.get(1), 'nekomata') ).toBe(true)
    expect( roleCount(possibilities.get(1)) ).toBe(1)
    expect( hasRoleInPossibility(possibilities.get(2), 'nekomata') ).toBe(false)
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

    expect(result).toBe(false)
  })
})

describe('isPossible', () => {
  it('should return true if it is possible', () => {
    const setup = new Map<SystemRole, number>([
      ['seer', 2],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ])
    const instance = new Possibilities(setup)
    const result = instance.isPossible()
    expect(result).toBe(true); // Expected result when it is possible
  })

  it('should return true if it is possible more complex', () => {
    const setup = new Map<SystemRole, number>([
      ['seer', 1],
      ['bodyguard', 1],
      ['villager', 6],
      ['possessed', 1],
      ['werewolf', 2]
    ])
    const instance = new Possibilities(setup)
    instance.fixRole(1, 'seer')
    instance.markAsHuman(2)
    const result = instance.isPossible()
    expect(result).toBe(true); // Expected result when it is possible
  })

  it('should return false if it is not possible', () => {
    const setup = new Map<SystemRole, number>([
      ['seer', 3],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1],
      ['werewolf', 4],
      ['villager', 8]
    ]);
    const instance = new Possibilities(setup);
    instance.set(2, possibilityFromSet(new Set(['medium'])))
    const result = instance.isPossible()
    expect(result).toBe(false); // Expected result when it is not possible
  });
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

    expect(result).toBe(true)
    expect(hasRoleInPossibility(possibilities.get(1), 'nekomata')).toBe(true)
    expect(roleCount(possibilities.get(1))).toBe(1)
    expect(hasRoleInPossibility(possibilities.get(2), 'nekomata')).toBe(false)
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

    expect(result).toBe(false)
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
    expect(setOfRolesFromPossibility(possibilities.get(1))).toEqual(new Set<SystemRole>(['possessed']))
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
    expect(setOfRolesFromPossibility(possibilities.get(1))).toEqual(new Set<SystemRole>(['seer', 'bodyguard', 'nekomata', 'possessed']))
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
    expect(hasRoleInPossibility(possibilities.get(1), 'seer')).toBe(false)
  })

  it('should not affect other roles in the seat', () => {
    const possibilities = new Possibilities(new Map<SystemRole, number>([
      ['seer', 1],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ]))
    possibilities.denyRole(1, 'seer')
    expect(hasRoleInPossibility(possibilities.get(1), 'bodyguard')).toBe(true)
    expect(hasRoleInPossibility(possibilities.get(1), 'nekomata')).toBe(true)
    expect(hasRoleInPossibility(possibilities.get(1), 'possessed')).toBe(true)
  })
})

describe('union', () => {
  it('should perform the union operation correctly', () => {
    const setup = new Map<SystemRole, number>([
      ['seer', 1],
      ['bodyguard', 1],
      ['nekomata', 1],
      ['possessed', 1]
    ]);
    const possibilitiesA = new Possibilities(setup);
    possibilitiesA.set(1, possibilityFromSet(new Set(['seer', 'bodyguard'])));
    possibilitiesA.set(2, possibilityFromSet(new Set(['possessed'])));

    const possibilitiesB = new Possibilities(setup);
    possibilitiesB.set(1, possibilityFromSet(new Set(['bodyguard'])));
    possibilitiesB.set(2, possibilityFromSet(new Set(['seer'])));

    possibilitiesA.union(possibilitiesB);

    expect(possibilitiesA.hasRole(1, 'seer')).toBe(true); // Expected union of possibilities A and B for seat 1
    expect(possibilitiesA.hasRole(1, 'bodyguard')).toBe(true); // Expected union of possibilities A and B for seat 1
    expect(possibilitiesA.hasRole(1, 'nekomata')).toBe(false); // Expected union of possibilities A and B for seat 1
    expect(possibilitiesA.hasRole(1, 'possessed')).toBe(false); // Expected union of possibilities A and B for seat 1
    expect(possibilitiesA.hasRole(2, 'seer')).toBe(true); // Expected union of possibilities A and B for seat 1
    expect(possibilitiesA.hasRole(2, 'bodyguard')).toBe(false); // Expected union of possibilities A and B for seat 1
    expect(possibilitiesA.hasRole(2, 'nekomata')).toBe(false); // Expected union of possibilities A and B for seat 1
    expect(possibilitiesA.hasRole(2, 'possessed')).toBe(true); // Expected union of possibilities A and B for seat 1
  });
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

    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(4)
    expect(result.get(1)).toEqual(new Set<SystemRole>(['seer']))
    expect(result.get(2)).toEqual(new Set<SystemRole>(['bodyguard']))
    expect(result.get(3)).toEqual(new Set<SystemRole>(['nekomata']))
    expect(result.get(4)).toEqual(new Set<SystemRole>(['possessed']))
  });

})

function sortObjectsArray(array) {
  return array.sort((a, b) => {
      const aStr = JSON.stringify(a, Object.keys(a).sort());
      const bStr = JSON.stringify(b, Object.keys(b).sort());
      return aStr.localeCompare(bStr);
  });
}

describe('combinationWithReplacementInLimit', () => {
  it('should generate combinations with replacement within limits', () => {
    const roles: SystemRole[] = ['seer', 'bodyguard', 'nekomata'];
    const k = 2;
    const limits: { [role in SystemRole]?: number } = {
      seer: 1,
      bodyguard: 2,
      nekomata: 1
    };

    const result = Array.from(combinationWithReplacementInLimit(roles, k, limits));
console.log({result})
    expect(result).toEqual([
      { seer: 1, bodyguard: 1 },
      { seer: 1, nekomata: 1 },
      { bodyguard: 1, nekomata: 1 },
      { bodyguard: 2 },
    ]);
  });

});

