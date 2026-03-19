import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import { selectCombinationsFromArray } from './combinatorics.ts'

export const LiarRoles: SystemRole[] = ['werewolf', 'werehamster', 'immoralist', 'possessed', 'fanatic']

const rolesInTestPlanning
  = ['nekomata', 'mason', 'seer', 'medium', 'bodyguard'] as const
type RoleInTestPlanning = typeof rolesInTestPlanning[number]

export type RoleTest = {
  role: SystemRole | 'allpass',
  selected: Seat[],
  rest: Seat[],
}

export type BuildPlanResult = {
  roleTests: RoleTest[][]
  totalLiarRoles: number
  knownFakeClaimCount: number
}

export function buildRoleTestPlan(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  multipleVictims: Seat[],
): BuildPlanResult {
  // 露呈人外数の管理の準備
  let numLiars = 0

  const claims = Object.fromEntries(rolesInTestPlanning.map(role => [role, [] as Seat[]])) as {[role in RoleInTestPlanning]: Seat[]}
  const poseAsCount = Object.fromEntries(rolesInTestPlanning.map(role => [role, 0])) as {[role in RoleInTestPlanning]: number}
  const minClaimDay = Object.fromEntries(rolesInTestPlanning.map(role => [role, Infinity])) as {[role in RoleInTestPlanning]: number}

  for ( const [seat, status] of village.statuses.entries() ) {
    if ( !rolesInTestPlanning.includes(status.claimingRole as RoleInTestPlanning) ) continue
    if ( status.claiming ) {
      const role = status.claimingRole as RoleInTestPlanning
      claims[role].push(seat)
      const claimDay = status.claimedAt || Infinity
      minClaimDay[role] = Math.min(minClaimDay[role], claimDay)
    }
  }

  let poseAsCountTotal = 0
  for ( const [role, count] of setup.entries() ) {
    if ( LiarRoles.includes(role) ) {
      numLiars += count
    }
    if ( role === 'seer' || role === 'medium' || role === 'bodyguard' || role === 'mason' || role === 'nekomata' ) {
      if ( claims[role].length <= 0 ) continue
      const c = Math.max(0, claims[role].length - count)
      poseAsCount[role] = c
      poseAsCountTotal += c
    }
  }

  // プランニング
  const roleTests: RoleTest[][] = []

  // 狐の処理は面倒なので、最初に全員分のプランを作成しておく
  if (setup.has('werehamster') && setup.get('werehamster')! > 0 ) {
    const hamsterTests: RoleTest[] = []
    const allSeats = Array.from(village.statuses.keys())
    const num = setup.get('werehamster')!
    const iter = selectCombinationsFromArray(allSeats, num, num)
    for ( const [selected, rest] of iter ) {
      hamsterTests.push({ role: 'werehamster', selected, rest })
    }
    roleTests.push(hamsterTests)
  }

  for ( const role of rolesInTestPlanning ) {
    if ( 'nekomata' !== role && claims[role].length === 0 ) continue
    if (claims[role].length === 0 && multipleVictims.length === 0) continue
    const testsOfRole: RoleTest[] = []
    const num = setup.get(role) || 0
    if ( !num ) continue

    // 役職のCO数に基づいてプランを作成する。
    // COのタイミングより前に襲撃死した人数の分だけ乗っ取りの可能性を追加する
    const unrevealedSeats: Seat[] = []
    for ( const [seat, status] of village.statuses.entries() ) {
      if (
        // 同じ役職の最初のCOがある日より前に、襲撃で死亡した人を候補に加える
        !status.surviving
        && status.causeOfDeath !== 'execution'
        && !status.claiming
        && (status.diedDay == null ? Infinity : status.diedDay) < minClaimDay[role]
      ) {
        unrevealedSeats.push(seat)
      }
    }
    if (role === 'nekomata' && multipleVictims.length > 0) {
      unrevealedSeats.push(...multipleVictims)
      // Also consider alive non-claiming seats: multiple night deaths can be
      // explained by seer-killed werehamster without nekomata curse
      for ( const [seat, status] of village.statuses.entries() ) {
        if ( status.surviving && !status.claiming ) {
          unrevealedSeats.push(seat)
        }
      }
    }
    if (role === 'mason') {
      // 共有の仮説生成: CO者のアサーション構造を尊重する
      // CO者が相方を指名している場合、その指名と矛盾しない仮説のみを生成
      const claimSeats = claims[role]
      for ( const claimSeat of claimSeats ) {
        const status = village.statuses.get(claimSeat)!
        const assertedPartners: Seat[] = []
        for ( const [targetSeat, species] of status.assertions ) {
          if ( species === 'human' ) assertedPartners.push(targetSeat)
        }
        // CO者 + 指名相方を固定し、残りの枠をunrevealedSeatsから選ぶ
        const fixed = new Set([claimSeat, ...assertedPartners])
        const remainingSlots = num - fixed.size
        if ( remainingSlots < 0 ) continue
        if ( remainingSlots === 0 ) {
          const rest = [...new Set([...claimSeats, ...unrevealedSeats])].filter(s => !fixed.has(s))
          testsOfRole.push({ role, selected: [...fixed], rest })
        } else {
          const available = unrevealedSeats.filter(s => !fixed.has(s))
          const iter = selectCombinationsFromArray(available, remainingSlots, remainingSlots)
          for ( const [sel, rest] of iter ) {
            testsOfRole.push({ role, selected: [...fixed, ...sel], rest: [...rest, ...claimSeats.filter(s => !fixed.has(s))] })
          }
        }
      }
      // 全CO者が偽の仮説: unrevealedSeatsのみから選ぶ
      const nonClaimUnrevealed = unrevealedSeats.filter(s => !claimSeats.includes(s))
      if ( nonClaimUnrevealed.length >= num ) {
        const iter = selectCombinationsFromArray(nonClaimUnrevealed, num, num)
        for ( const [selected, rest] of iter ) {
          testsOfRole.push({ role, selected, rest: [...rest, ...claimSeats] })
        }
      }
    } else {
      const pool = [...new Set([...claims[role], ...unrevealedSeats])]
      const iter = selectCombinationsFromArray(pool, num, num)
      for ( const [selected, rest] of iter ) {
        testsOfRole.push({ role, selected, rest })
      }
    }

    roleTests.push(testsOfRole)
  }

  const filteredTests = roleTests.filter( tests => tests.length > 0 )
  const finalTests = filteredTests.length === 0
    ? [[{ role: 'allpass' as const, selected: [] as Seat[], rest: [] as Seat[] }]]
    : filteredTests

  return {
    roleTests: finalTests,
    totalLiarRoles: numLiars,
    knownFakeClaimCount: poseAsCountTotal,
  }
}
