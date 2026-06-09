import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'
import type { Possibilities } from './possibilities.ts'
import { selectCombinationsFromArray } from './combinatorics.ts'
import { allRolesIn, liarRolesIn, poweredVillageRolesIn, hasTrait, rolesWithTraitIn } from './role-sets.ts'

/**
 * action:divine trait を持つ liar role (paparazzi 等). seer 等と同じ planning frame で扱う.
 * 同 trait 内で互いの CO 席を pool として共有 (paparazzi は seer 騙り、 seer は paparazzi 騙り).
 */
function divineLiarRolesIn(setup: Map<SystemRole, number>): SystemRole[] {
  return allRolesIn(setup).filter(role => {
    const r = systemRoles.get(role)!
    return r.faction !== 'village' && hasTrait(role, 'action', 'divine')
  })
}

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
  _initialPossibilities?: Possibilities,
  hocusPocus?: Map<Seat, boolean>,
): BuildPlanResult {
  const hocusSeats: Seat[] = hocusPocus ? [...hocusPocus.keys()] : []
  const hasHocusPocus = hocusSeats.length > 0
  // 露呈人外数の管理の準備
  let numLiars = 0

  // setup 駆動で派生. 役職追加で自動追従.
  // 村陣営の能力持ち + divine trait を持つ liar role (paparazzi 等) を planning 対象に.
  const planningRoles = [...poweredVillageRolesIn(setup), ...divineLiarRolesIn(setup)]
  const planningRolesSet = new Set<SystemRole>(planningRoles)
  const liarRolesSet = new Set<SystemRole>(liarRolesIn(setup))

  const claims = new Map<SystemRole, Seat[]>(planningRoles.map(role => [role, []]))
  const poseAsCount = new Map<SystemRole, number>(planningRoles.map(role => [role, 0]))
  const minClaimDay = new Map<SystemRole, number>(planningRoles.map(role => [role, Infinity]))

  for ( const [seat, status] of village.statuses.entries() ) {
    const role = status.claimingRole as SystemRole
    if ( !planningRolesSet.has(role) ) continue
    if ( status.claiming ) {
      claims.get(role)!.push(seat)
      const claimDay = status.claimedAt || Infinity
      minClaimDay.set(role, Math.min(minClaimDay.get(role)!, claimDay))
    }
  }

  /**
   * action:divine trait を共有する role 同士の CO 席を pool として共有する.
   * 例: paparazzi の selected 候補は seer CO 席 + paparazzi CO 席 + unrevealed.
   * paparazzi は通常 seer 騙りするため、 seer CO 席が paparazzi の真の候補となる.
   */
  const getDivineClaimPool = (role: SystemRole): Seat[] => {
    if (!hasTrait(role, 'action', 'divine')) return claims.get(role) || []
    const pool: Seat[] = []
    for (const otherRole of planningRoles) {
      if (hasTrait(otherRole, 'action', 'divine')) {
        pool.push(...(claims.get(otherRole) || []))
      }
    }
    return [...new Set(pool)]
  }

  const getMinClaimDay = (role: SystemRole): number => {
    if (!hasTrait(role, 'action', 'divine')) return minClaimDay.get(role) ?? Infinity
    let m = Infinity
    for (const otherRole of planningRoles) {
      if (hasTrait(otherRole, 'action', 'divine')) {
        m = Math.min(m, minClaimDay.get(otherRole) ?? Infinity)
      }
    }
    return m
  }

  let poseAsCountTotal = 0
  for ( const [role, count] of setup.entries() ) {
    if ( liarRolesSet.has(role) ) {
      numLiars += count
    }
    if ( planningRolesSet.has(role) ) {
      const claimSeats = claims.get(role)!
      if ( claimSeats.length <= 0 ) continue
      const c = Math.max(0, claimSeats.length - count)
      poseAsCount.set(role, c)
      poseAsCountTotal += c
    }
  }

  // プランニング
  const roleTests: RoleTest[][] = []

  // 狐の処理は面倒なので、最初に全員分のプランを作成しておく
  // 注意: initialPossibilities で狐候補をフィルタしない。
  // prior パスでは確定席が狐候補から除外されるが、solver の交差検証
  // (finalizer の死体数チェック等) に確定席の狐仮説が必要なケースがある。
  const foxRoles = rolesWithTraitIn(setup, 'passive', 'die-when-divined')
  for ( const fox of foxRoles ) {
    const count = setup.get(fox)!
    if ( count <= 0 ) continue
    const hamsterTests: RoleTest[] = []
    const allSeats = Array.from(village.statuses.keys())
    const iter = selectCombinationsFromArray(allSeats, count, count)
    for ( const [selected, rest] of iter ) {
      hamsterTests.push({ role: fox, selected, rest })
    }
    roleTests.push(hamsterTests)
  }

  for ( const role of planningRoles ) {
    const hasCurseOnExecuted = hasTrait(role, 'reactive', 'curse-on-executed')
    // divine trait 同士は CO 席を pool 共有 (seer ↔ paparazzi).
    const claimSeats = getDivineClaimPool(role)
    const minDay = getMinClaimDay(role)
    if ( !hasCurseOnExecuted && claimSeats.length === 0 && !hasHocusPocus ) continue
    // 処刑道連れ役職 (猫又) の候補を検出
    const hasExecutionCurse = hasCurseOnExecuted && Array.from(village.statuses.values()).some(
      s => s.causeOfDeath === 'cursed_by_executed_nekomata'
    )
    if (claimSeats.length === 0 && multipleVictims.length === 0 && !hasExecutionCurse && !hasHocusPocus) continue
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
        && (status.causeOfDeath !== 'execution' || status.noCoOpportunity)
        && !status.claiming
        && (status.diedDay == null ? Infinity : status.diedDay) < minDay
      ) {
        unrevealedSeats.push(seat)
      }
    }
    // HocusPocus 指定席は生存/死亡に関わらず全役職の潜伏候補として許容する。
    // applyHocusPocus で claiming=false 済みだが、生存席は上記ループに入らないため明示追加する。
    for ( const hocusSeat of hocusSeats ) {
      if ( !unrevealedSeats.includes(hocusSeat) ) {
        unrevealedSeats.push(hocusSeat)
      }
    }
    if (hasCurseOnExecuted && multipleVictims.length > 0) {
      for ( const seat of multipleVictims ) {
        const status = village.statuses.get(seat)!
        if ( (status.diedDay == null ? Infinity : status.diedDay) < minDay ) {
          unrevealedSeats.push(seat)
        }
      }
      // 複数夜死の説明には道連れ役職 (猫又) CO 不在のケースもある (狐呪殺等で説明可能).
      // この場合、 生存中の非 CO 席も道連れ役職候補として考慮する.
      if ( claimSeats.length === 0 ) {
        for ( const [seat, status] of village.statuses.entries() ) {
          if ( status.surviving && !status.claiming ) {
            unrevealedSeats.push(seat)
          }
        }
      }
    }
    // 処刑道連れ: 処刑された道連れ役職 (猫又) 候補を追加
    if (hasCurseOnExecuted && hasExecutionCurse) {
      for ( const [seat, status] of village.statuses.entries() ) {
        if ( status.causeOfDeath === 'execution' && !status.claiming ) {
          // この処刑で道連れが発生したか確認
          for ( const [, otherStatus] of village.statuses.entries() ) {
            if ( otherStatus.causeOfDeath === 'cursed_by_executed_nekomata' && otherStatus.diedDay === status.diedDay ) {
              unrevealedSeats.push(seat)
              break
            }
          }
        }
      }
      // 道連れがあっても、生存者の道連れ役職候補も考慮（道連れが偽の可能性）
      if ( claimSeats.length === 0 ) {
        for ( const [seat, status] of village.statuses.entries() ) {
          if ( status.surviving && !status.claiming ) {
            unrevealedSeats.push(seat)
          }
        }
      }
    }
    if (hasTrait(role, 'knowledge', 'know-masons')) {
      // 共有の仮説生成: CO者のアサーション構造を尊重する
      // CO者が相方を指名している場合、その指名と矛盾しない仮説のみを生成
      // 共有は相方未公開の場合、COしていない生存者も相方候補になる
      const aliveCandidates: Seat[] = []
      for ( const [seat, status] of village.statuses.entries() ) {
        if ( status.surviving && !status.claiming ) {
          aliveCandidates.push(seat)
        }
      }
      const masonPool = [...new Set([...unrevealedSeats, ...aliveCandidates])]
      for ( const claimSeat of claimSeats ) {
        const status = village.statuses.get(claimSeat)!
        const assertedPartners: Seat[] = []
        for ( const [, { target: targetSeat, species }] of status.assertions ) {
          if ( species === 'human' ) assertedPartners.push(targetSeat)
        }
        // CO者 + 指名相方を固定し、残りの枠をmasonPoolから選ぶ
        const fixed = new Set([claimSeat, ...assertedPartners])
        const remainingSlots = num - fixed.size
        if ( remainingSlots < 0 ) continue
        if ( remainingSlots === 0 ) {
          const rest = [...new Set([...claimSeats, ...masonPool])].filter(s => !fixed.has(s))
          testsOfRole.push({ role, selected: [...fixed], rest })
        } else {
          const available = masonPool.filter(s => !fixed.has(s))
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
      const pool = [...new Set([...claimSeats, ...unrevealedSeats])]
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
