import type { VillageStatus, SystemRole, Seat, Day } from '../types/index.ts'
import type { Possibilities } from './possibilities.ts'
import type { AnalyzeContext } from './roleTesters.ts'
import { solvePossibilities } from './solver.ts'

/**
 * 死体数の検証。各日の夜死体数が仮説と整合するか確認する。
 * @returns true: 検証パス、false: 仮説を棄却
 * 副作用: context.requireOneOf に背徳後追い制約を追加する場合がある
 */
export function constrainByDeathCounts(
  context: AnalyzeContext,
  vs: VillageStatus,
  nightKillsByDay: Map<Day, Seat[]>,
  setup: Map<SystemRole, number>,
): boolean {
  DAY:
  for ( const [day, killed] of nightKillsByDay.entries() ) {
    if ( vs.day <= day ) continue DAY
    const addCount = context.deathChronicle.add[day]
    let expected = 1
    if ( addCount ) expected += addCount
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
      const hamsterDiedThisNight = context.hamstersKilledBySeer.some(h => h.day === day)
      if ( hamsterDiedThisNight ) {
        for ( let i=0; i<immoralists; i++ ) {
          context.requireOneOf.push( killed.map(seat => ({ seat, role: 'immoralist' })) )
        }
        continue DAY
      }
    }
    if ( actual < expected ) {
      for ( const [seat, status] of vs.statuses.entries() ) {
        if ( !status.surviving && status.diedDay! < day ) continue
        if (
          context.possibilities.hasRole(seat, 'bodyguard')
          || context.possibilities.hasRole(seat, 'werehamster')
        ) {
          continue DAY
        }
      }
    }
    return false
  }
  return true
}

export function createDebugStash(): DebugStash {
  return {
    finalizerRuns: 0, finalizerMiddle: 0, finalizerPasses: 0, finalizerFails: 0,
    seerTests: 0, mediumTests: 0, bodyguardTests: 0, masonTests: 0,
    nekomataTests: 0, werehamsterTests: 0,
    seerTestPasses: 0, mediumTestPasses: 0, bodyguardTestPasses: 0, masonTestPasses: 0,
    nekomataTestPasses: 0, werehamsterTestPasses: 0,
    preFinalizeTests: 0, preFinalizePasses: 0,
  }
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
  hamsterWinPath: 'village' | 'wolf' | undefined,
  cachedSurvivors: Seat[],
  cachedSurvivingMap: Map<Seat, boolean>,
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
    const candidates = context.possibilities.getPossibleSeatsForRole(role)
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


  const survivors = cachedSurvivors
  const numSurvivingHamsters = survivors.filter(seat => context.possibilities.isActualRole(seat, 'werehamster')).length
  const maxSurvivingWolves = Math.min(
    setup.get('werewolf') || Infinity,
    Math.floor((survivors.length - numSurvivingHamsters - 0.1) / 2)
  )

  const survivingMap = cachedSurvivingMap
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

  // All seats fully determined → validate survival counts and skip solver
  let allFixed = true
  for (let i = 1; i < context.possibilities.possibilities.length; i++) {
    if (!context.possibilities.isFixed(i)) { allFixed = false; break }
  }
  if (allFixed) {
    // Count surviving wolves and hamsters
    let survWolves = 0, survHamsters = 0
    for (const seat of survivors) {
      if (context.possibilities.isActualRole(seat, 'werewolf')) survWolves++
      if (context.possibilities.isActualRole(seat, 'werehamster')) survHamsters++
    }
    const checkCondition = (minW: number, maxW: number, minH: number, maxH: number) =>
      survWolves >= minW && survWolves <= maxW && survHamsters >= minH && survHamsters <= maxH

    if (vs.result === 'werehamster_won') {
      if (hamsterWinPath !== 'wolf' && checkCondition(0, 0, 1, Infinity)) {
        debugStash.finalizerPasses++
        conclusions.union(context.possibilities)
      }
      if (hamsterWinPath !== 'village' && checkCondition(maxSurvivingWolves + 1, Infinity, 1, Infinity)) {
        debugStash.finalizerPasses++
        conclusions.union(context.possibilities)
      }
    } else if (checkCondition(condition.minSurvivingWolves, condition.maxSurvivingWolves, condition.minSurvivingHamsters, condition.maxSurvivingHamsters)) {
      debugStash.finalizerPasses++
      conclusions.union(context.possibilities)
    } else {
      debugStash.finalizerFails++
    }
    return
  }

  // 狐勝ちの場合だけは、狼全滅と飽和の両方を検証する
  // hamsterWinPath が指定されている場合は該当パスのみ実行
  if ( vs.result === 'werehamster_won') {
    if (hamsterWinPath !== 'wolf') {
      const conclusion = solvePossibilities(
        context.possibilities,
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
    }
    if (hamsterWinPath !== 'village') {
      const conclusion2 = solvePossibilities(
        context.possibilities,
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
  }
  else {
    const conclusion = solvePossibilities(
      context.possibilities,
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
