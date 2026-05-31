import { systemRoles } from '../types/index.ts'
import type { VillageStatus, SystemRole, Seat, Day } from '../types/index.ts'
import type { Possibilities } from './possibilities.ts'
import type { AnalyzeContext } from './roleTesters.ts'
import { solvePossibilities } from './solver.ts'
import { dumpFinalizePre } from './dump.ts'
import {
  singleRoleByTrait,
  singleRoleBySeerResult,
  countByTraitIn,
  countBySeerResultIn,
} from './role-sets.ts'

// hot path で繰り返し呼ばれるため module-level 解決.
const guardRole = singleRoleByTrait('action', 'guard')
const foxRole = singleRoleByTrait('passive', 'die-when-divined')
const wolfRole = singleRoleBySeerResult('wolf')
const followFoxRole = singleRoleByTrait('reactive', 'follow-fox-death')

/**
 * 死体数の検証。各日の夜死体数が仮説と整合するか確認する。
 * @returns true: 検証パス、false: 仮説を棄却
 * 副作用: context.requireOneOf に背徳後追い制約を追加する場合がある
 */
// 読み取り専用版: 夜死者数の矛盾チェックのみ。context を変更しない。
export function checkDeathCounts(
  context: AnalyzeContext,
  vs: VillageStatus,
  nightKillsByDay: Map<Day, Seat[]>,
  setup: Map<SystemRole, number>,
): boolean {
  const immoralists = countByTraitIn(setup, 'reactive', 'follow-fox-death')
  DAY:
  for ( const [day, killed] of nightKillsByDay.entries() ) {
    if ( vs.day <= day ) continue DAY
    const addCount = context.deathChronicle.add[day]
    let expected = 1
    if ( addCount ) expected += addCount
    const actual = killed.length
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
        // mut版では requireOneOf に制約を追加する。読み取り専用版では矛盾なしとして通す
        continue DAY
      }
    }
    if ( actual < expected ) {
      for ( const [seat, status] of vs.statuses.entries() ) {
        if ( !status.surviving && status.diedDay! < day ) continue
        if (
          context.possibilities.hasRole(seat, guardRole)
          || context.possibilities.hasRole(seat, foxRole)
        ) {
          continue DAY
        }
      }
    }
    return false
  }
  return true
}

// 変更あり版: 夜死者数の矛盾チェック + requireOneOf 制約の追加
export function updateDeathCountConstraints(
  context: AnalyzeContext,
  vs: VillageStatus,
  nightKillsByDay: Map<Day, Seat[]>,
  setup: Map<SystemRole, number>,
): boolean {
  const immoralists = countByTraitIn(setup, 'reactive', 'follow-fox-death')
  DAY:
  for ( const [day, killed] of nightKillsByDay.entries() ) {
    if ( vs.day <= day ) continue DAY
    const addCount = context.deathChronicle.add[day]
    let expected = 1
    if ( addCount ) expected += addCount
    const actual = killed.length
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
          context.requireOneOf.push( killed.map(seat => ({ seat, role: followFoxRole })) )
        }
        continue DAY
      }
    }
    if ( actual < expected ) {
      for ( const [seat, status] of vs.statuses.entries() ) {
        if ( !status.surviving && status.diedDay! < day ) continue
        if (
          context.possibilities.hasRole(seat, guardRole)
          || context.possibilities.hasRole(seat, foxRole)
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
  const roleTests = Object.fromEntries(
    [...systemRoles.keys()].map(r => [r, 0]),
  ) as Record<SystemRole, number>
  const roleTestPasses = Object.fromEntries(
    [...systemRoles.keys()].map(r => [r, 0]),
  ) as Record<SystemRole, number>
  return {
    finalizerRuns: 0, finalizerMiddle: 0, finalizerPasses: 0, finalizerFails: 0,
    roleTests, roleTestPasses,
    preFinalizeTests: 0, preFinalizePasses: 0,
  }
}

export type DebugStash = {
  finalizerRuns: number
  finalizerMiddle: number
  finalizerPasses: number
  finalizerFails: number
  roleTests: Record<SystemRole, number>
  roleTestPasses: Record<SystemRole, number>
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
  dumpFinalizePre(context.possibilities)
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

  if (!context.possibilities.propagateFull()) {
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
  const numSurvivingHamsters = survivors.filter(seat => context.possibilities.isActualRole(seat, foxRole)).length
  const setupWolves = countBySeerResultIn(setup, 'wolf')
  const setupFoxes = countByTraitIn(setup, 'passive', 'die-when-divined')
  const maxSurvivingWolves = Math.min(
    setupWolves || Infinity,
    Math.floor((survivors.length - numSurvivingHamsters - 0.1) / 2)
  )

  const survivingMap = cachedSurvivingMap
  const condition = {
    minSurvivingWolves: 1,
    maxSurvivingWolves,
    minSurvivingHamsters: 0,
    maxSurvivingHamsters: setupFoxes,
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
      if (context.possibilities.isActualRole(seat, wolfRole)) survWolves++
      if (context.possibilities.isActualRole(seat, foxRole)) survHamsters++
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
