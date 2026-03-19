// @ts-nocheck
// TODO: Fix type errors inherited from reference implementation
import type { VillageStatus, SystemRole } from '../types/index.ts'
import type { Possibilities } from './possibilities.ts'
import type { AnalyzeContext } from './roleTesters.ts'

type Seat = number
type Day = number

/**
 * 死体数の検証。各日の夜死体数が仮説と整合するか確認する。
 * @returns true: 検証パス、false: 仮説を棄却
 * 副作用: context.requireOneOf に背徳後追い制約を追加する場合がある
 */
export function validateDeathCounts(
  context: AnalyzeContext,
  vs: VillageStatus,
  nightKillsByDay: Map<Day, Seat[]>,
  setup: Map<SystemRole, number>,
): boolean {
  DAY:
  for ( const [day, killed] of nightKillsByDay.entries() ) {
    if ( vs.day <= day ) continue DAY
    const deathChronicle = context.deathChronicle.get(day)
    let expected = 1
    if ( deathChronicle ) expected += deathChronicle.add
    const actual = killed.length
    const immoralists = setup.get('immoralist') || 0
    if ( actual === expected ) continue DAY
    if ( expected + immoralists < actual ) {
      return false
    }
    else if ( actual < expected - 1 ) {
      return false
    }
    else if ( expected < actual && actual <= expected + immoralists ) {
      for ( let i=0; i<immoralists; i++ ) {
        context.requireOneOf.push( killed.map(seat => ({ seat, role: 'immoralist' })) )
      }
      continue DAY
    }
    else if (context.hamstersMaxSurvivingDay >= day) {
      continue DAY
    }
    for ( const [seat, status] of vs.statuses.entries() ) {
      if (
        ( status.surviving || day <= status.diedDay)
        && context.possibilities.hasRole(seat,'bodyguard')
      ) {
        continue DAY
      }
    }
    return false
  }
  return true
}

export type DebugStash = {
  finalizerRuns: number
  finalizerMiddle: number
  finalizerPasses: number
  finalizerFails: number
  seerTests: number
  mediumTests: number
  bodyguardTests: number
  masonTests: number
  nekomataTests: number
  werehamsterTests: number
  seerTestPasses: number
  mediumTestPasses: number
  bodyguardTestPasses: number
  masonTestPasses: number
  nekomataTestPasses: number
  werehamsterTestPasses: number
  preFinalizeTests: number
  preFinalizePasses: number
}

export function finalize(
  context: AnalyzeContext,
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
  conclusions: Possibilities,
  debugStash: DebugStash,
): void {
  debugStash.finalizerRuns++
  // ここまで処理が終わったところで、襲撃死した人物は非狼とみなす
  for ( const [seat, status] of vs.statuses.entries() ) {
    if ( !status.surviving && status.causeOfDeath === 'night_kill' ) {
      if ( context.possibilities.isFixed(seat) ) {
        continue
      }
      if (!context.possibilities.markAsHuman(seat)) {
        return
      }
    }
  }

  if (!context.possibilities.refix()) {
    return
  }
  for (const [role, count] of setup.entries()) {
    const candidates = context.possibilities.getPossibieSeatsForRole(role)
    if (candidates.length < count) {
      return
    }
    if ( candidates.length === count ) {
      for ( const seat of candidates ) {
        if ( !context.possibilities.fixRole(seat, role) ) {
          return
        }
      }
    }
  }
  if (!context.possibilities.refix()) {
    return
  }
  debugStash.finalizerMiddle++

  /*
  TODO: ここで、同じ役職の組み合わせをまとめてテストを行う
  const set = {}
  for ( const [seat, possibilities] of remained.entries() ) {
    const stringOfRoles = Array.from(possibilities).sort().join(',')
    set[stringOfRoles] ??= []
    set[stringOfRoles].push(seat)
  }
  */


  const survivors = Array.from(vs.statuses.keys()).filter(seat => vs.statuses.get(seat).surviving)
  const numSurvivingHamsters = survivors.filter(seat => context.possibilities.isActualRole(seat, 'werehamster')).length
  const maxSurvivingWolves = Math.min(
    setup.get('werewolf') || Infinity,
    Math.floor((survivors.length - numSurvivingHamsters - 0.1) / 2)
  )

  const survivingMap = new Map(survivors.map(seat => [seat, true]))
  const condition = {
    minSurvivingWolves: 1,
    maxSurvivingWolves,
    minSurvivingHamsters: 0,
    maxSurvivingHamsters: setup.get('werehamster') || 0,
  }

  // 村勝ちまたは狼勝ちの場合は、狼の生存数の条件を変更する
  if ( vs.result === 'werewolf_won' ) {
    condition.minSurvivingWolves = maxSurvivingWolves + 1
    condition.maxSurvivingWolves = Infinity
    condition.minSurvivingHamsters = 0
    condition.maxSurvivingHamsters = 0
  }
  else if ( vs.result === 'villager_won' ) {
    condition.minSurvivingWolves = 0
    condition.maxSurvivingWolves = 0
    condition.minSurvivingHamsters = 0
    condition.maxSurvivingHamsters = 0
  }

  // 狐勝ちの場合だけは、狼全滅と飽和の両方を検証する
  if ( vs.result === 'werehamster_won') {
    const conclusion = context.possibilities.solvePossibilities(
      survivingMap,
      0,
      0,
      1,
      Infinity,
      setup
    )
    if (conclusion) {
      debugStash.finalizerPasses++
      conclusions.union(conclusion)
    }
    const conclusion2 = context.possibilities.solvePossibilities(
      survivingMap,
      maxSurvivingWolves + 1,
      Infinity,
      1,
      Infinity,
      setup
    )
    if (conclusion2) {
      debugStash.finalizerPasses++
      conclusions.union(conclusion2)
    }
  }
  else {
    const conclusion = context.possibilities.solvePossibilities(
      survivingMap,
      condition.minSurvivingWolves,
      condition.maxSurvivingWolves,
      condition.minSurvivingHamsters,
      condition.maxSurvivingHamsters,
      setup
    )
    if ( !conclusion ) {
      debugStash.finalizerFails++
      return
    }
    debugStash.finalizerPasses++
    conclusions.union(conclusion)
  }
}
