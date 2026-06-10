import type { SystemRole, Seat } from '../types/index.ts'
import { dumpSolveResult } from './dump.ts'
import {
  Possibilities,
  RoleSignatureBits,
  popCount,
  combinationWithReplacementBit,
  bitIndicesFromMask,
  RoleBitIndex,
  ROLE_COUNT,
} from './possibilities.ts'
import type { RolePossibility } from './possibilities.ts'
import { rolesBySeerResult } from './role-sets.ts'
import { systemRoles } from '../types/index.ts'

// 「seerResult='wolf' な役職」 全集合 (現状は werewolf 1 種、 将来複数化に対応).
// HAMSTER_BITS / FOX_SIGNATURES と同パターン.
const WOLF_BITS: number[] = rolesBySeerResult('wolf').map(r => RoleBitIndex[r])
const WOLF_SIGNATURES: number[] = WOLF_BITS.map(bit => 1 << bit)

// 狐陣営勝利の生存カウント対象 = passive:fox-win-counter trait を持つ全役職 (妖狐 + 子狐 + 将来追加).
// passive:die-when-divined (= 妖狐のみ) で数えると子狐生存パスが棄却される.
const HAMSTER_BITS: number[] = Array.from(systemRoles.entries())
  .filter(([, meta]) => meta.traits.some(t => t.kind === 'passive' && t.sub === 'fox-win-counter'))
  .map(([role]) => RoleBitIndex[role])
const FOX_SIGNATURES: number[] = HAMSTER_BITS.map(bit => 1 << bit)

/*
 * Solver configuration — immutable across recursion.
 * These values define the search space and are threaded through
 * the recursive backtracking without changing.
 */
type SolverConfig = {
  conclusion: Possibilities
  items: ([RolePossibility, number[]] | 'check')[]
  wolvesRange: [min: number, max: number]
  hamstersRange: [min: number, max: number]
}

/*
 * Role assignment backtracking solver.
 *
 * The `items` array is structured as:
 *   [ ...fixed(dead), ...fixed(alive), ...survivors, "check", ...dead ]
 *
 * - Fixed seats (popCount=1) come first regardless of alive/dead status.
 * - Unfixed survivors come next — all valid role combinations are enumerated.
 * - "check" sentinel validates wolf/hamster survival counts at the boundary.
 * - Unfixed dead seats come last — only satisfiability is checked (not all solutions),
 *   because enumerating all dead combinations would explode combinatorially.
 *
 * The solver writes valid role possibilities into `config.conclusion` via bitwise OR,
 * accumulating the union of all valid assignments.
 *
 * roleCount: Uint8Array[ROLE_COUNT] indexed by bit position (0=villager, ..., 10=immoralist)
 */
function backtrackForRoleAssignment(
  config: SolverConfig,
  roleCount: Uint8Array,
  index: number,
  selectedWolves: number,
  selectedHamsters: number,
  path: [number[], Uint8Array][],
  all: boolean,
): boolean {
  const item = config.items[index]
  if (item === 'check') {
    if (config.wolvesRange[1] < selectedWolves) return false
    if (selectedWolves < config.wolvesRange[0]) return false
    if (config.hamstersRange[1] < selectedHamsters) return false
    if (selectedHamsters < config.hamstersRange[0]) return false
    const res = backtrackForRoleAssignment(
      config,
      new Uint8Array(roleCount),
      index + 1,
      selectedWolves,
      selectedHamsters,
      [],
      false,
    )
    if (!res) return false
    // Build bitmask of roles with remaining count > 0
    let filterForDeads = 0
    for (let i = 0; i < ROLE_COUNT; i++) {
      if (roleCount[i] > 0) filterForDeads |= (1 << i)
    }
    // Collect dead seat entries with filtered possibilities
    const deadEntries: [RolePossibility, number[]][] = []
    for (let i = index + 1; i < config.items.length; i++) {
      const item = config.items[i]
      if (item === 'check') continue
      const [possibility, seats] = item
      deadEntries.push([possibility & filterForDeads, seats])
    }
    // Propagate constraints among dead seats:
    // If a group has only one possible role and that role's remaining count
    // equals the group size, remove that role from all other groups
    const deadRoleCount = new Uint8Array(roleCount)
    let changed = true
    while (changed) {
      changed = false
      for (const entry of deadEntries) {
        if (popCount(entry[0]) === 1) {
          const bitIdx = 31 - Math.clz32(entry[0])
          if (deadRoleCount[bitIdx] > 0 && deadRoleCount[bitIdx] === entry[1].length) {
            deadRoleCount[bitIdx] = 0
            for (const other of deadEntries) {
              if (other === entry) continue
              const before = other[0]
              other[0] = before & ~entry[0]
              if (other[0] !== before) changed = true
            }
          }
        }
      }
      // Naked subset: groups whose possibilities ⊆ mask consume exactly those roles
      const checked = new Set<number>()
      for (const entry of deadEntries) {
        const mask = entry[0]
        if (mask === 0 || checked.has(mask)) continue
        checked.add(mask)
        let roleSum = 0
        for (let i = 0; i < ROLE_COUNT; i++) {
          if (mask & (1 << i)) roleSum += deadRoleCount[i]
        }
        if (roleSum === 0) continue
        let seatSum = 0
        for (const e of deadEntries) {
          if (e[0] !== 0 && (e[0] & mask) === e[0]) seatSum += e[1].length
        }
        if (seatSum === roleSum) {
          for (const e of deadEntries) {
            if ((e[0] & mask) === e[0]) continue
            const before = e[0]
            e[0] = before & ~mask
            if (e[0] !== before) changed = true
          }
        }
      }
      // Also check: if a role's remaining count is fully consumed by
      // groups that must include it, remove it from other groups
      for (let bitIdx = 0; bitIdx < ROLE_COUNT; bitIdx++) {
        if (deadRoleCount[bitIdx] <= 0) continue
        const roleBit = 1 << bitIdx
        let totalSeats = 0
        const mustHaveGroups: typeof deadEntries = []
        for (const entry of deadEntries) {
          if (entry[0] & roleBit) {
            totalSeats += entry[1].length
            mustHaveGroups.push(entry)
          }
        }
        if (totalSeats === deadRoleCount[bitIdx]) {
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
        config.conclusion.possibilities[seat] |= possibility
      }
    }
    for (const p of path) {
      const [seats, counts] = p
      for (let i = 0; i < ROLE_COUNT; i++) {
        if (counts[i] === 0) continue
        const bit = 1 << i
        for (const seat of seats) {
          config.conclusion.possibilities[seat] |= bit
        }
      }
    }
    return true
  }
  else if (index === config.items.length) {
    return true
  }
  else if (index === config.items.length - 1) {
    // Last element: check remaining role counts match seat count
    let count = 0
    let sub = 0
    for (let i = 0; i < ROLE_COUNT; i++) {
      if (roleCount[i] > 0) {
        count += roleCount[i]
        sub |= (1 << i)
      }
    }
    const [last, seats] = item as [RolePossibility, number[]]
    if (seats.length !== count) {
      return false
    }
    if ((last & sub) !== sub) {
      return false
    }
    return true
  }

  const [set, seats] = item as [RolePossibility, number[]]
  const indices = bitIndicesFromMask(set)
  let oneOK = false
  for (const v of combinationWithReplacementBit(indices, seats.length, roleCount)) {
    let ok = true
    for (const idx of indices) {
      if (v[idx] === 0) continue
      if (roleCount[idx] < v[idx]) ok = false
      roleCount[idx] -= v[idx]
    }
    path.push([seats, new Uint8Array(v)])
    if (ok) {
      let addedHamsters = 0
      for (const bit of HAMSTER_BITS) addedHamsters += v[bit]
      let addedWolves = 0
      for (const bit of WOLF_BITS) addedWolves += v[bit]
      const res = backtrackForRoleAssignment(
        config,
        roleCount,
        index + 1,
        selectedWolves + addedWolves,
        selectedHamsters + addedHamsters,
        path,
        all,
      )
      if (res && !all) return true
      if (res) oneOK = true
    }
    for (const idx of indices) {
      if (v[idx] === 0) continue
      roleCount[idx] += v[idx]
    }
    path.pop()
  }
  return oneOK
}

/*
 * Solve possible role assignments for all seats.
 *
 * Groups seats by their possibility bitmask (seats with identical possibilities
 * are tested together for efficiency). Fixed seats are processed first, then
 * survivors (full enumeration), then dead seats (satisfiability only).
 *
 * Returns a Possibilities object with the union of all valid assignments,
 * or undefined if no valid assignment exists.
 */
export function solvePossibilities(
  source: Possibilities,
  survivors: Map<Seat, boolean>,
  minSurvivingWolves: number,
  maxSurvivingWolves: number,
  minSurvivingHamsters: number,
  maxSurvivingHamsters: number,
  setup: Map<SystemRole, number>,
): Possibilities | undefined {
  // Group seats by possibility bitmask, separated by survival status
  const survivorsMap: Map<number, number[]> = new Map()
  const deadMap: Map<number, number[]> = new Map()
  const fixedMap: Map<number, number[]> = new Map()
  let fixedDiedWolves: number = 0
  let fixedDiedHamsters: number = 0
  for (let i = 1; i < source.possibilities.length; i++) {
    const possibility = source.possibilities[i]
    const count = popCount(possibility)
    if (count === 0) return undefined
    if (count === 1) {
      if (!fixedMap.has(possibility)) {
        fixedMap.set(possibility, [])
      }
      fixedMap.get(possibility)!.push(i)
      if (WOLF_SIGNATURES.includes(possibility) && !survivors.get(i)) {
        fixedDiedWolves++
      }
      if (!survivors.get(i) && FOX_SIGNATURES.includes(possibility)) {
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

  const config: SolverConfig = {
    conclusion: Possibilities.empty(setup),
    items,
    wolvesRange: [fixedDiedWolves + minSurvivingWolves, fixedDiedWolves + maxSurvivingWolves],
    hamstersRange: [fixedDiedHamsters + minSurvivingHamsters, fixedDiedHamsters + maxSurvivingHamsters],
  }

  // Build initial roleCount as Uint8Array from setup
  const roleCount = new Uint8Array(ROLE_COUNT)
  for (const [role, count] of setup) {
    roleCount[RoleBitIndex[role]] = count
  }

  const res = backtrackForRoleAssignment(
    config,
    roleCount,
    0, 0, 0, [], true,
  )
  if (!res) {
    dumpSolveResult(undefined)
    return undefined
  }
  dumpSolveResult(config.conclusion)
  return config.conclusion
}
