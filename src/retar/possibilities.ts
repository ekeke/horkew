import type { SystemRole, Seat } from '../types/index.ts'
export type { SystemRole } from '../types/index.ts'

export type RolePossibility = number

export const RoleSignatureBits: { [role in SystemRole]: number } = {
  villager: 0b00000000001,
  seer: 0b00000000010,
  medium: 0b00000000100,
  bodyguard: 0b00000001000,
  mason: 0b00000010000,
  nekomata: 0b00000100000,
  werewolf: 0b00001000000,
  possessed: 0b00010000000,
  fanatic: 0b00100000000,
  werehamster: 0b01000000000,
  immoralist: 0b10000000000,
}

export const RoleSignatureBitsReverseMap: Map<number, SystemRole> = new Map(
  Object.entries(RoleSignatureBits).map(([role, bit]) => [bit, role as SystemRole])
)

const AllRoles: RolePossibility
  = Object.values(RoleSignatureBits).reduce((acc, cur) => acc | cur, 0)

const Human = AllRoles & ~RoleSignatureBits['werewolf']

const VillageRoles: RolePossibility
  = RoleSignatureBits['seer']
  | RoleSignatureBits['medium']
  | RoleSignatureBits['bodyguard']
  | RoleSignatureBits['mason']
  | RoleSignatureBits['nekomata']

const Liar = RoleSignatureBits['werewolf']
  | RoleSignatureBits['possessed']
  | RoleSignatureBits['fanatic']
  | RoleSignatureBits['werehamster']
  | RoleSignatureBits['immoralist']

export function popCount(x: number): number {
  const a = x - (x >>> 1 & 0x55555555)
  const b = (a & 0x33333333) + (a >>> 2 & 0x33333333)
  const c = (b + (b >>> 4)) & 0x0f0f0f0f
  const d = c + (c >>> 8)
  const y = d + (d >>> 16)
  return y & 0xff
}

function bitsetToArray(value: number) {
  const results: number[] = []
  let position = 0
  while (value !== 0) {
      if ((value & 1) === 1) {
          results.push(1 << position)
      }
      value >>= 1
      position++
  }
  return results
}

export function rolesFromPossibility(bit: number): SystemRole[] {
  return bitsetToArray(bit).map(num => RoleSignatureBitsReverseMap.get(num)!)
}

export function possibilityFromSet(roles: Set<SystemRole>): RolePossibility {
  let result: RolePossibility = 0
  for (const role of roles) {
    result |= RoleSignatureBits[role]
  }
  return result
}

export function addRoleToPossibility(possibility: RolePossibility, role: SystemRole): RolePossibility {
  return possibility | RoleSignatureBits[role]
}

export function removeRoleFromPossibility(possibility: RolePossibility, role: SystemRole): RolePossibility {
  return possibility & ~RoleSignatureBits[role]
}

export function hasRoleInPossibility(possibility: RolePossibility, role: SystemRole): boolean {
  return (possibility & RoleSignatureBits[role]) !== 0
}

export function roleCount(possibility: RolePossibility): number {
  return popCount(possibility)
}

export function intersectionOfRolePossibility(a: RolePossibility, b: RolePossibility): RolePossibility {
  return a & b
}

export function differenceOfRolePossibilities(a: RolePossibility, b: RolePossibility): RolePossibility {
  return a & ~b
}

export function setOfRolesFromPossibility(possibility: RolePossibility): Set<SystemRole> {
  const result = new Set<SystemRole>()
  for (const [role, bit] of Object.entries(RoleSignatureBits)) {
    if ((possibility & bit) !== 0) {
      result.add(role as SystemRole)
    }
  }
  return result
}

// This function will yield all possible combinations of roles in a set
export function* combinationWithReplacementInLimit<T extends string>(
  roles: T[],
  k: number,
  limits: { [key in T]?: number },
  left: number = 0,
  result: { [key in T]?: number } = {},
): Generator<{ [key in T]?: number }> {
  if (left > roles.length || k <= 0) {
    yield Object.assign({}, result)
    return
  }
  while (left < roles.length) {
    const role = roles[left]
    if (!limits[role]) {
      left++
      continue
    }
    const max = Math.min(k, limits[role]!)
    for (let count = 1; count <= max; count++) {
      result[role] = count
      yield* combinationWithReplacementInLimit(roles, k - count, limits, left + 1, result)
      delete result[role]
    }
    left++
  }
}

export class Possibilities {
  possibilities: Uint16Array
  setup: { [role in SystemRole]?: number }
  setupOriginal!: { [role in SystemRole]?: number }
  constructor(
    setup: Map<SystemRole, number> | Uint16Array | number,
    setupObject?: { [role in SystemRole]?: number },
    originalSetup?: { [role in SystemRole]?: number }
  ) {
    if (typeof setup === 'number') {
      this.possibilities = new Uint16Array(setup + 1) // 0番目は使わない
      this.setup = {}
      return
    }

    if (setupObject && setup instanceof Uint16Array && originalSetup) {
      this.setup = Object.assign({}, setupObject)
      this.setupOriginal = Object.assign({}, originalSetup)
      this.possibilities = setup
      return
    }
    if (setup instanceof Uint16Array) {
      throw new Error('setupObject is required when setup is Uint16Array')
    }
    let count: number = 0
    let initial: RolePossibility = 0
    this.setup = {}
    for (const [role, num] of setup) {
      this.setup[role] = num
      count += num
      initial |= RoleSignatureBits[role]
    }
    this.setupOriginal = Object.assign({}, this.setup)
    this.possibilities = new Uint16Array(count + 1) // 0番目は使わない
    for (let i = 1; i < this.possibilities.length; i++) {
      this.possibilities[i] = initial
    }
  }

  static empty(setup: Map<SystemRole, number>): Possibilities {
    const p = new Possibilities(setup)
    p.possibilities.fill(0)
    return p
  }

  clone(): Possibilities {
    return new Possibilities(new Uint16Array(this.possibilities), this.setup, this.setupOriginal)
  }

  /** @internal debug用 */
  toObj() {
    const obj: { [seat: Seat]: SystemRole[] } = {}
    for (let i = 1; i < this.possibilities.length; i++) {
      obj[i] = Array.from(setOfRolesFromPossibility(this.possibilities[i]))
    }
    const setup = Object.assign({}, this.setup)
    return { obj, setup }
  }

  toStructured(): Map<Seat, Set<SystemRole>> {
    const result = new Map<Seat, Set<SystemRole>>()
    for (let i = 1; i < this.possibilities.length; i++) {
      result.set(i, setOfRolesFromPossibility(this.possibilities[i]))
    }
    return result
  }

  refix(): boolean {
    this.setup = Object.assign({}, this.setupOriginal)
    for (let i = 1; i < this.possibilities.length; i++) {
      if (!this.fix(i)) return false
    }
    return true
  }

  fix(seat: number): boolean {
    const p = this.possibilities[seat]
    const count = popCount(p)
    if (count === 0) return false
    if (count === 1) {
      const role = RoleSignatureBitsReverseMap.get(p)!
      if (!this.setup[role]) {
        return false
      }
      if (this.setup[role] === 1) {
        const theRole = p
        for (let i = 1; i < this.possibilities.length; i++) {
          if (i === seat) continue
          if (this.possibilities[i] === theRole) continue
          this.possibilities[i] &= ~theRole
          if (this.possibilities[i] === 0) return false
        }
      }
      this.setup[role]!--
    }
    return true
  }

  get(seat: number): RolePossibility {
    return this.possibilities[seat]
  }

  set(seat: number, possibility: RolePossibility | SystemRole): void {
    if (typeof possibility === 'number') {
      this.possibilities[seat] = possibility
      return
    }
    this.possibilities[seat] = RoleSignatureBits[possibility]
  }

  isFixed(seat: number): boolean {
    return popCount(this.possibilities[seat]) === 1
  }

  fixRole(seat: number, role: SystemRole): boolean {
    if (this.possibilities[seat] === RoleSignatureBits[role]) return true
    if (!this.hasRole(seat, role)) return false
    this.possibilities[seat] &= RoleSignatureBits[role]
    return this.fix(seat)
  }

  getPossibleSeatsForRole(role: SystemRole): Seat[] {
    const result: Seat[] = []
    for (let i = 1; i < this.possibilities.length; i++) {
      if (this.hasRole(i, role)) {
        result.push(i)
      }
    }
    return result
  }

  union(otherPossibilities: Possibilities): void {
    for (let i = 1; i < this.possibilities.length; i++) {
      this.possibilities[i] |= otherPossibilities.possibilities[i]
    }
  }

  markAsLiar(seat: number): boolean {
    this.possibilities[seat] &= Liar
    return this.possibilities[seat] !== 0
  }

  markAsNotLiar(seat: number): boolean {
    this.possibilities[seat] &= ~Liar
    return this.possibilities[seat] !== 0
  }

  markAsHuman(seat: number): boolean {
    this.possibilities[seat] &= Human
    return this.possibilities[seat] !== 0
  }

  markAsNoVillageRole(seat: number): boolean {
    this.possibilities[seat] &= ~VillageRoles
    return this.possibilities[seat] !== 0
  }

  denyRole(seat: number, role: SystemRole): boolean {
    this.possibilities[seat] &= ~RoleSignatureBits[role]
    return this.possibilities[seat] !== 0
  }

  hasRole(seat: number, role: SystemRole): boolean {
    return (this.possibilities[seat] & RoleSignatureBits[role]) !== 0
  }

  isActualRole(seat: number, role: SystemRole): boolean {
    return this.possibilities[seat] === RoleSignatureBits[role]
  }
}
