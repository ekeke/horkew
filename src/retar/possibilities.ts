import type { SystemRole } from '../types/index.ts'
export type { SystemRole } from '../types/index.ts'

export type RolePossibility = number
type Seat = number

const RoleSignatureBits: { [role in SystemRole]: number } = {
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

  clone(): Possibilities {
    return new Possibilities(new Uint16Array(this.possibilities), this.setup, this.setupOriginal)
  }

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

  getPossibieSeatsForRole(role: SystemRole): Seat[] {
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


  /* 組み合わせの中から、実際に満たせるものを絞り込む
  // items の前半は生存者、後半は死亡者
  // 追記：　処理能率の都合で、生死かかわらず役職確定の位置がその前に来る。
  // 区切りの部分で集約を行う。生存者は全ての組み合わせを試すが、死亡者は全ての組み合わせを試すと計算量が爆発するので、
  // 前半のみall solutions, 後半はsatisfiableを探索する
  // 実際のデータは次の例のようになる。
  [ ...死亡済み・役職確定位置, ...生存中・役職確定位置, ...生存者, "check", ...死亡者 ]
  */
  __isPossibleSetsForRoleBackTrack(
    conclusion: Possibilities,
    items: ([RolePossibility, number[]] | 'check')[],
    roleCount: { [key in SystemRole]?: number },
    minSurvivingWolves: number,
    maxSurvivingWolves: number,
    minSurvivingHamsters: number,
    maxSurvivingHamsters: number,
    index: number = 0,
    selectedWolves: number = 0,
    selectedHamsters: number = 0,
    path: [Seat[],{[k in SystemRole]?: number}][] = [],
    all: boolean = true
  ) {
    const item = items[index]
    if (item === 'check') {
      if (maxSurvivingWolves < selectedWolves) return false
      if (selectedWolves < minSurvivingWolves) return false
      if (maxSurvivingHamsters < selectedHamsters) return false
      if (selectedHamsters < minSurvivingHamsters) return false
      const res = this.__isPossibleSetsForRoleBackTrack(
        conclusion,
        items,
        Object.assign({},roleCount),
        minSurvivingWolves,
        maxSurvivingWolves,
        minSurvivingHamsters,
        maxSurvivingHamsters,
        index + 1,
        selectedWolves,
        selectedHamsters,
        [],
        false
      )
      if (!res) return false
      const filterForDeads = possibilityFromSet(new Set(Object.keys(roleCount).filter(k => roleCount[k as SystemRole]! > 0) as SystemRole[]))
      // Collect dead seat entries with filtered possibilities
      const deadEntries: [RolePossibility, number[]][] = []
      for (let i = index + 1; i < items.length; i++) {
        const item = items[i]
        if (item === 'check') continue
        const [possibility, seats] = item
        deadEntries.push([possibility & filterForDeads, seats])
      }
      // Propagate constraints among dead seats:
      // If a group has only one possible role and that role's remaining count
      // equals the group size, remove that role from all other groups
      const deadRoleCount = Object.assign({}, roleCount)
      let changed = true
      while (changed) {
        changed = false
        for (const entry of deadEntries) {
          if (popCount(entry[0]) === 1) {
            const role = RoleSignatureBitsReverseMap.get(entry[0])!
            if ((deadRoleCount[role] ?? 0) > 0 && deadRoleCount[role] === entry[1].length) {
              deadRoleCount[role] = 0
              for (const other of deadEntries) {
                if (other === entry) continue
                const before = other[0]
                other[0] = before & ~entry[0]
                if (other[0] !== before) changed = true
              }
            }
          }
        }
        // Also check: if a role's remaining count is fully consumed by
        // groups that must include it, remove it from other groups
        for (const [roleStr, count] of Object.entries(deadRoleCount)) {
          if (count as number <= 0) continue
          const roleBit = RoleSignatureBits[roleStr as SystemRole]
          let totalSeats = 0
          const mustHaveGroups: typeof deadEntries = []
          for (const entry of deadEntries) {
            if (entry[0] & roleBit) {
              totalSeats += entry[1].length
              mustHaveGroups.push(entry)
            }
          }
          if (totalSeats === count) {
            // All seats that can have this role must have it
            for (const entry of mustHaveGroups) {
              if (entry[0] !== roleBit) {
                entry[0] = roleBit
                changed = true
              }
            }
          }
        }
      }
      for (const [possibility, seats] of deadEntries) {
        for (const seat of seats) {
          conclusion.possibilities[seat] |= possibility
        }
      }
      for (const p of path) {
        const [seats, roles] = p
        for (const [role, count] of Object.entries(roles)) {
          if (count === 0) continue
          for (const seat of seats) {
            conclusion.possibilities[seat] |= RoleSignatureBits[role as SystemRole]
          }
        }
      }
      return true
    }
    else if (index === items.length) {
      return true
    }
    else if (index === items.length - 1) {
      // 最後の要素の場合は、残りの数を全部足してチェック
      let count = 0
      for (const [_role, num] of Object.entries(roleCount)) {
        count += num as number
      }
      const keys = Object.keys(roleCount).filter(k => roleCount[k as SystemRole]! > 0) as SystemRole[]
      const set = new Set(keys)
      const sub = possibilityFromSet(set)
      const last = (item as [RolePossibility, number[]])[0]
      if ((item as [RolePossibility, number[]])[1].length !== count) {
        return false
      }
      if ((last & sub) !== sub) {
        return false
      }
      return true
    }

    const [set, seats] = item as [RolePossibility, number[]]
    const roles = rolesFromPossibility(set)
    let oneOK = false
    for (const v of combinationWithReplacementInLimit(roles, seats.length, roleCount)) {
      Object.assign({}, roleCount)
      let ok = true
      for (const [role, count] of Object.entries(v)) {
        if (roleCount[role as SystemRole]! < (count as number)) ok = false
        roleCount[role as SystemRole] = roleCount[role as SystemRole]! - (count as number)
      }
      path.push([seats, v as {[k in SystemRole]?: number}])
      if (ok) {
        const res = this.__isPossibleSetsForRoleBackTrack(
          conclusion,
          items,
          roleCount,
          minSurvivingWolves,
          maxSurvivingWolves,
          minSurvivingHamsters,
          maxSurvivingHamsters,
          index + 1,
          selectedWolves + ((v as any)['werewolf'] || 0),
          selectedHamsters + ((v as any)['werehamster'] || 0),
          path,
          all)
        if (res && !all) return true
        if (res) oneOK = true
      }
      for (const [role, count] of Object.entries(v)) {
        roleCount[role as SystemRole] = roleCount[role as SystemRole]! + (count as number)
      }
      path.pop()
    }
    return oneOK
  }

  // Function which solves at least one possible combination for given roles in setup
  // Also check that the game is still running
  solvePossibilities(
    survivors: Map<Seat, boolean>,
    minSurvivingWolves: number,
    maxSurvivingWolves: number,
    minSurvivingHamsters: number,
    maxSurvivingHamsters: number,
    setup: Map<SystemRole, number>): Possibilities | undefined {

    // 同じ可能性を持つ席はまとめる, ただし生存かどうかを考慮する
    const survivorsMap: Map<number, number[]> = new Map()
    const deadMap: Map<number, number[]> = new Map()
    const fixedMap: Map<number, number[]> = new Map()
    let fixedDiedWolves: number = 0
    let fixedDiedHamsters: number = 0
    for (let i = 1; i < this.possibilities.length; i++) {
      const possibility = this.possibilities[i]
      const count = popCount(possibility)
      if (count === 0) return undefined
      if (count === 1) {
        if (!fixedMap.has(possibility)) {
          fixedMap.set(possibility, [])
        }
        fixedMap.get(possibility)!.push(i)
        if (possibility === RoleSignatureBits['werewolf'] && !survivors.get(i) ) {
          fixedDiedWolves++
        }
        if (possibility === RoleSignatureBits['werehamster'] && !survivors.get(i) ) {
          fixedDiedHamsters++
        }
        continue
      }
      if (survivors.get(i)) {
        if (!survivorsMap.has(possibility)) {
          survivorsMap.set(possibility, [])
        }
        survivorsMap.get(possibility)!.push(i)
      } else {
        if (!deadMap.has(possibility)) {
          deadMap.set(possibility, [])
        }
        deadMap.get(possibility)!.push(i)
      }
    }
    const items: ([number, number[]] | 'check')[]
      = Array.from(deadMap.size
        ? [...fixedMap.entries(), ...survivorsMap.entries(), 'check' as const, ...deadMap.entries()]
        : [...fixedMap.entries(), ...survivorsMap.entries(), 'check' as const]
      )

    const conclusion = new Possibilities(setup)
    for ( let i=0; i<conclusion.possibilities.length; i++) {
      conclusion.possibilities[i] = 0
    }
    const res = this.__isPossibleSetsForRoleBackTrack(
      conclusion,
      items,
      Object.fromEntries(setup),
      fixedDiedWolves + minSurvivingWolves,
      fixedDiedWolves + maxSurvivingWolves,
      fixedDiedHamsters + minSurvivingHamsters,
      fixedDiedHamsters + maxSurvivingHamsters
    )
    if (!res) return undefined
    return conclusion
  }
}
