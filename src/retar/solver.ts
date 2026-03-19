import type { SystemRole, Seat } from '../types/index.ts'
import {
  Possibilities,
  RoleSignatureBits,
  RoleSignatureBitsReverseMap,
  popCount,
  possibilityFromSet,
  rolesFromPossibility,
  combinationWithReplacementInLimit,
} from './possibilities.ts'
import type { RolePossibility } from './possibilities.ts'

type RoleCount = { [key in SystemRole]?: number }

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
 */
function backtrackForRoleAssignment(
  config: SolverConfig,
  roleCount: RoleCount,
  index: number,
  selectedWolves: number,
  selectedHamsters: number,
  path: [Seat[], RoleCount][],
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
      Object.assign({}, roleCount),
      index + 1,
      selectedWolves,
      selectedHamsters,
      [],
      false,
    )
    if (!res) return false
    const filterForDeads = possibilityFromSet(new Set(Object.keys(roleCount).filter(k => roleCount[k as SystemRole]! > 0) as SystemRole[]))
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
      const [seats, roles] = p
      for (const [role, count] of Object.entries(roles)) {
        if (count === 0) continue
        for (const seat of seats) {
          config.conclusion.possibilities[seat] |= RoleSignatureBits[role as SystemRole]
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
    let ok = true
    for (const [role, count] of Object.entries(v)) {
      if (roleCount[role as SystemRole]! < (count as number)) ok = false
      roleCount[role as SystemRole] = roleCount[role as SystemRole]! - (count as number)
    }
    path.push([seats, v as RoleCount])
    if (ok) {
      const res = backtrackForRoleAssignment(
        config,
        roleCount,
        index + 1,
        selectedWolves + ((v as any)['werewolf'] || 0),
        selectedHamsters + ((v as any)['werehamster'] || 0),
        path,
        all,
      )
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
      if (possibility === RoleSignatureBits['werewolf'] && !survivors.get(i)) {
        fixedDiedWolves++
      }
      if (possibility === RoleSignatureBits['werehamster'] && !survivors.get(i)) {
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

  const res = backtrackForRoleAssignment(
    config,
    Object.fromEntries(setup),
    0, 0, 0, [], true,
  )
  if (!res) return undefined
  return config.conclusion
}
