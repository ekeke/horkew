import type { SystemRole, Seat } from '../types/index.ts'
export type { SystemRole } from '../types/index.ts'

export type RolePossibility = number

export const RoleSignatureBits: { [role in SystemRole]: number } = {
  villager:    0b000000000001,
  seer:        0b000000000010,
  medium:      0b000000000100,
  bodyguard:   0b000000001000,
  mason:       0b000000010000,
  nekomata:    0b000000100000,
  werewolf:    0b000001000000,
  possessed:   0b000010000000,
  fanatic:     0b000100000000,
  werehamster: 0b001000000000,
  immoralist:  0b010000000000,
  paparazzi:   0b100000000000,
}

export const RoleSignatureBitsReverseMap: Map<number, SystemRole> = new Map(
  Object.entries(RoleSignatureBits).map(([role, bit]) => [bit, role as SystemRole])
)

export const ROLE_COUNT = 12
/** inPending が 32bit ビット演算なので最大32席（seat 1..=31） */
export const MAX_SEATS = 32

// Bit position index for each role (villager=0, seer=1, ..., paparazzi=11)
export const RoleBitIndex: { [role in SystemRole]: number } = {
  villager: 0, seer: 1, medium: 2, bodyguard: 3, mason: 4,
  nekomata: 5, werewolf: 6, possessed: 7, fanatic: 8,
  werehamster: 9, immoralist: 10, paparazzi: 11,
}

// Extract set bit indices from a bitmask
export function bitIndicesFromMask(mask: number): number[] {
  const result: number[] = []
  for (let i = 0; mask !== 0; i++, mask >>>= 1) {
    if (mask & 1) result.push(i)
  }
  return result
}

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
  | RoleSignatureBits['paparazzi']

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

export function possibilityFromRoles(roles: Set<SystemRole>): RolePossibility {
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

// Uint8Array-based version for solver hot path.
// indices: bit positions (from bitIndicesFromMask). limits: Uint8Array[ROLE_COUNT].
// Yields into a shared result buffer — caller must consume before next iteration.
export function* combinationWithReplacementBit(
  indices: number[],
  k: number,
  limits: Uint8Array,
  left: number = 0,
  result: Uint8Array = new Uint8Array(ROLE_COUNT),
): Generator<Uint8Array> {
  if (k <= 0) {
    yield result
    return
  }
  if (left >= indices.length) return
  for (let l = left; l < indices.length; l++) {
    const idx = indices[l]
    if (!limits[idx]) continue
    const max = Math.min(k, limits[idx])
    for (let count = 1; count <= max; count++) {
      result[idx] = count
      yield* combinationWithReplacementBit(indices, k - count, limits, l + 1, result)
      result[idx] = 0
    }
  }
}

export class Possibilities {
  possibilities: Uint16Array
  setup: Uint8Array
  setupOriginal!: Uint8Array
  /** 最大生存人外数（事前計算済み。computeMaxSurvivingNv() で設定） */
  maxSurvivingNV: number = 0
  /** ワークリストバッファ（fix/refix 用。constructor で事前確保） */
  private _pendingBuf!: Uint8Array
  constructor(
    setup: Map<SystemRole, number> | Uint16Array | number,
    setupArr?: Uint8Array,
    originalSetupArr?: Uint8Array,
  ) {
    if (typeof setup === 'number') {
      this.possibilities = new Uint16Array(setup + 1) // 0番目は使わない
      this.setup = new Uint8Array(ROLE_COUNT)
      this._pendingBuf = new Uint8Array(setup + 1)
      return
    }

    if (setupArr && setup instanceof Uint16Array && originalSetupArr) {
      this.setup = new Uint8Array(setupArr)
      this.setupOriginal = new Uint8Array(originalSetupArr)
      this.possibilities = setup
      this._pendingBuf = new Uint8Array(setup.length)
      return
    }
    if (setup instanceof Uint16Array) {
      throw new Error('setupArr is required when setup is Uint16Array')
    }
    let count: number = 0
    let initial: RolePossibility = 0
    this.setup = new Uint8Array(ROLE_COUNT)
    for (const [role, num] of setup) {
      this.setup[RoleBitIndex[role]] = num
      count += num
      initial |= RoleSignatureBits[role]
    }
    if (count >= MAX_SEATS) {
      throw new Error(`seat count ${count} exceeds maximum supported (${MAX_SEATS - 1})`)
    }
    this.setupOriginal = new Uint8Array(this.setup)
    this.possibilities = new Uint16Array(count + 1) // 0番目は使わない
    this._pendingBuf = new Uint8Array(count + 1)
    for (let i = 1; i < this.possibilities.length; i++) {
      this.possibilities[i] = initial
    }
  }

  static fromSetup(setup: Map<SystemRole, number>): Possibilities {
    return new Possibilities(setup)
  }

  seatCount(): number {
    return this.possibilities.length - 1
  }

  static empty(setup: Map<SystemRole, number>): Possibilities {
    const p = new Possibilities(setup)
    p.possibilities.fill(0)
    return p
  }

  cloneInstance(): Possibilities {
    return new Possibilities(new Uint16Array(this.possibilities), this.setup, this.setupOriginal)
  }



  toStructured(): Map<Seat, Set<SystemRole>> {
    const result = new Map<Seat, Set<SystemRole>>()
    for (let i = 1; i < this.possibilities.length; i++) {
      result.set(i, setOfRolesFromPossibility(this.possibilities[i]))
    }
    return result
  }

  refix(): boolean {
    this.setup.set(this.setupOriginal)
    const buf = this._pendingBuf
    let head = 0, tail = 0
    let inPending = 0
    for (let i = 1; i < this.possibilities.length; i++) {
      if (popCount(this.possibilities[i]) === 1) {
        buf[tail++] = i
        inPending |= (1 << i)
      }
    }
    return this._drain(buf, head, tail, inPending)
  }

  /**
   * refix + hidden singles を fixpoint まで反復する。
   * hidden singles: 役職 R の残カウントと候補席数が一致 → 全候補を R に確定。
   * finalize() の solver 呼び出し前に最大限の席を確定させる。
   */
  propagateFull(): boolean {
    for (;;) {
      if (!this.refix()) return false
      let changed = false
      for (let bitIdx = 0; bitIdx < ROLE_COUNT; bitIdx++) {
        const remaining = this.setup[bitIdx]
        if (remaining === 0) continue
        const bit = 1 << bitIdx
        let candidateCount = 0
        for (let i = 1; i < this.possibilities.length; i++) {
          if (popCount(this.possibilities[i]) > 1 && (this.possibilities[i] & bit)) {
            candidateCount++
          }
        }
        if (candidateCount < remaining) return false
        if (candidateCount === remaining) {
          for (let i = 1; i < this.possibilities.length; i++) {
            if (popCount(this.possibilities[i]) > 1 && (this.possibilities[i] & bit)) {
              this.possibilities[i] = bit
              changed = true
            }
          }
        }
      }
      if (!changed) return true
    }
  }

  fix(seat: number): boolean {
    const buf = this._pendingBuf
    buf[0] = seat
    return this._drain(buf, 0, 1, 1 << seat)
  }

  /** ワークリストを処理し、全 singleton のカスケードを伝播する */
  private _drain(buf: Uint8Array, head: number, tail: number, inPending: number): boolean {
    while (head < tail) {
      const s = buf[head++]
      const p = this.possibilities[s]
      const count = popCount(p)
      if (count === 0) return false
      if (count !== 1) continue

      const bitIdx = 31 - Math.clz32(p)
      if (!this.setup[bitIdx]) return false

      if (this.setup[bitIdx] === 1) {
        for (let i = 1; i < this.possibilities.length; i++) {
          if (i === s) continue
          if (this.possibilities[i] === p) continue
          const old = this.possibilities[i]
          this.possibilities[i] &= ~p
          if (this.possibilities[i] === 0) return false
          if (popCount(old) > 1 && popCount(this.possibilities[i]) === 1 && !(inPending & (1 << i))) {
            buf[tail++] = i
            inPending |= (1 << i)
          }
        }
      }
      this.setup[bitIdx]--
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

  setRole(seat: number, role: SystemRole): void {
    this.possibilities[seat] = RoleSignatureBits[role]
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

  /**
   * 最大生存人外数を計算し maxSurvivingNV に格納する。
   * 二部マッチングにより死亡者を村役職スロットに最大割り当てし、
   * 配役上の人外総数から最小死亡人外数を差し引く。
   *
   * alive: 生存者ビットマスク (bit N = seat N が生存)
   */
  computeMaxSurvivingNv(alive: number): void {
    const villageMask = ~Liar & AllRoles

    // 配役上の人外総数
    let totalNV = 0
    for (let i = 0; i < ROLE_COUNT; i++) {
      if ((1 << i) & Liar) totalNV += this.setupOriginal[i]
    }

    // 死者席を収集
    const deadSeats: number[] = []
    for (let seat = 1; seat < this.possibilities.length; seat++) {
      if (!(alive & (1 << seat))) deadSeats.push(seat)
    }
    if (deadSeats.length === 0) {
      this.maxSurvivingNV = totalNV
      return
    }

    // 村役職スロットを容量展開（各エントリ = その役職の RoleSignatureBits 値）
    const villageSlots: number[] = []
    for (let i = 0; i < ROLE_COUNT; i++) {
      if (!((1 << i) & villageMask)) continue
      const bit = 1 << i
      for (let j = 0; j < this.setupOriginal[i]; j++) villageSlots.push(bit)
    }
    if (villageSlots.length === 0) {
      this.maxSurvivingNV = totalNV
      return
    }

    // Kuhn's augmenting path matching
    const matchDead = new Int8Array(deadSeats.length).fill(-1)
    const visited = new Uint8Array(deadSeats.length)

    let maxDeadVillage = 0
    for (let si = 0; si < villageSlots.length; si++) {
      visited.fill(0)
      if (tryAugmentVillageSlot(si, villageSlots, deadSeats, this.possibilities, matchDead, visited)) {
        maxDeadVillage++
      }
    }

    this.maxSurvivingNV = Math.max(0, totalNV - (deadSeats.length - maxDeadVillage))
  }
}

/** 二部マッチングの増加パス探索（Kuhn's algorithm） */
function tryAugmentVillageSlot(
  slotIdx: number,
  villageSlots: number[],
  deadSeats: number[],
  possibilities: Uint16Array,
  matchDead: Int8Array,
  visited: Uint8Array,
): boolean {
  const slotBit = villageSlots[slotIdx]
  for (let di = 0; di < deadSeats.length; di++) {
    if (visited[di]) continue
    if (!(possibilities[deadSeats[di]] & slotBit)) continue
    visited[di] = 1
    if (matchDead[di] === -1 || tryAugmentVillageSlot(matchDead[di], villageSlots, deadSeats, possibilities, matchDead, visited)) {
      matchDead[di] = slotIdx
      return true
    }
  }
  return false
}
