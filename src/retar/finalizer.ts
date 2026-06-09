import { systemRoles } from '../types/index.ts'
import type { VillageStatus, SystemRole, Seat, Day, SeatStatus } from '../types/index.ts'
import type { Possibilities } from './possibilities.ts'
import type { AnalyzeContext } from './roleTesters.ts'
import { solvePossibilities } from './solver.ts'
import { dumpFinalizePre } from './dump.ts'
import {
  singleRoleByTrait,
  singleRoleBySeerResult,
  countByTraitIn,
  countBySeerResultIn,
  rolesWithTraitIn,
} from './role-sets.ts'

// hot path で繰り返し呼ばれるため module-level 解決.
const foxRole = singleRoleByTrait('passive', 'die-when-divined')
const wolfRole = singleRoleBySeerResult('wolf')

/**
 * seat が夜 `day` の時点で行動可能 (alive) かどうか.
 * 夜 D の causeOfDeath === 'night_kill' は「その夜に襲撃で死亡」 = その夜の行動は可能, とみなす
 * (verifyDivineAbility の seer maxActiveDay と同じ流儀).
 * execution は昼の処刑なので diedDay === D でも夜 D は alive ではない.
 */
function isAliveAtNight(status: SeatStatus, day: Day): boolean {
  if (status.surviving) return true
  if (status.diedDay! > day) return true
  if (status.diedDay! === day && status.causeOfDeath === 'night_kill') return true
  return false
}

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
  const guardRoles = rolesWithTraitIn(setup, 'action', 'guard')
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
      const hamsterDiedThisNight = context.hamstersKilledByDivine.some(h => h.day === day)
      if ( hamsterDiedThisNight ) {
        // mut版では requireOneOf に制約を追加する。読み取り専用版では矛盾なしとして通す
        continue DAY
      }
    }
    if ( actual < expected ) {
      // peace night (actual < expected) を成立させる説明:
      //   (A) 夜 day に alive な妖狐がいる (狼襲撃先 = 妖狐 → 襲撃免疫で死体なし)
      //   (B) 夜 day に alive な狩人がいる (護衛成功)
      // 「狐 or 狩人」 を possibilities で見るだけでなく、 夜 day 時点で alive な seat に絞る.
      for ( const [seat, status] of vs.statuses.entries() ) {
        if ( !isAliveAtNight(status, day) ) continue
        if (
          guardRoles.some(r => context.possibilities.hasRole(seat, r))
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
  const guardRoles = rolesWithTraitIn(setup, 'action', 'guard')
  const guardCount = countByTraitIn(setup, 'action', 'guard')
  const followFoxRoles = rolesWithTraitIn(setup, 'reactive', 'follow-fox-death')
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
      const hamsterDiedThisNight = context.hamstersKilledByDivine.some(h => h.day === day)
      if ( hamsterDiedThisNight ) {
        for ( let i=0; i<immoralists; i++ ) {
          context.requireOneOf.push(
            killed.flatMap(seat => followFoxRoles.map(role => ({ seat, role })))
          )
        }
        continue DAY
      }
    }
    if ( actual < expected ) {
      // peace night (actual < expected) を成立させる説明:
      //   (A) 夜 day に alive な妖狐がいる (狼襲撃先 = 妖狐 → 襲撃免疫で死体なし)
      //   (B) 夜 day に alive な狩人がいる (護衛成功)
      // どちらの可能性も無ければ世界棄却. 片方しか可能性が無い場合, かつ setup の該当 role が
      // 1 体しかいない場合に限り, 「その 1 体は alive 側にいる」 と確定するので, 夜 day に
      // alive でない seat から該当 role を deny する. setup に 2 体以上いる場合は片方が
      // 死んでいても他方が alive なら peace を説明できるため deny できない (例: 狐 2 体構成で
      // 片方が呪殺後、 もう片方が襲撃先になる).
      let aliveFoxExists = false
      let aliveGuardExists = false
      for ( const [seat, status] of vs.statuses.entries() ) {
        if ( !isAliveAtNight(status, day) ) continue
        if ( context.possibilities.hasRole(seat, foxRole) ) aliveFoxExists = true
        if ( guardRoles.some(r => context.possibilities.hasRole(seat, r)) ) aliveGuardExists = true
      }
      if ( !aliveFoxExists && !aliveGuardExists ) return false
      if ( !aliveFoxExists && guardCount === 1 ) {
        // 説明は (B) のみ + 狩人は 1 体 → 夜 day に alive でない seat の guard 役職を deny
        for ( const [seat, status] of vs.statuses.entries() ) {
          if ( isAliveAtNight(status, day) ) continue
          for ( const r of guardRoles ) {
            if ( !context.possibilities.denyRole(seat, r) ) return false
          }
        }
      }
      if ( !aliveGuardExists && (setup.get(foxRole) ?? 0) === 1 ) {
        // 説明は (A) のみ + 狐は 1 体 → 夜 day に alive でない seat の foxRole を deny
        for ( const [seat, status] of vs.statuses.entries() ) {
          if ( isAliveAtNight(status, day) ) continue
          if ( !context.possibilities.denyRole(seat, foxRole) ) return false
        }
      }
      continue DAY
    }
    return false
  }
  return true
}

/**
 * action:divine trait 集約による狐呪殺の説明可能性チェック (読み取り専用).
 *
 * verifyDivineAbility が個別 role ごとに溜めた divineAliveMaxDay / divineTargetsByDay を
 * 使って、 「狐死日に占い能力者のいずれかが生きていた + その日の対象集合に狐 seat (または
 * 'unknown') が含まれる」を判定する.
 *
 * paparazzi 等の untrusted divine role がいる setup では、 seer 単独では説明できなくても
 * paparazzi が説明する可能性があるためここで集約判定する.
 */
export function checkDivineCoverage(context: AnalyzeContext): boolean {
  if (context.hamstersKilledByDivine.length === 0) return true

  // 1. 占い能力者の最大生存日 >= 狐呪殺最終日
  if (context.needDivineAliveAtDay != null
      && context.divineAliveMaxDay < context.needDivineAliveAtDay) {
    return false
  }

  // 2. 各狐呪殺について、 その日の divine target 集合に対象 seat (または 'unknown') を含む
  for (const { day, seat } of context.hamstersKilledByDivine) {
    const targets = context.divineTargetsByDay.get(day)
    if (!targets) return false
    if (!targets.has(seat) && !targets.has('unknown')) return false
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
  // 全 divine role の集約済み状態で狐呪殺の説明可能性を最終判定
  if (!checkDivineCoverage(context)) {
    debugStash.finalizerFails++
    return
  }
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
  // 狐陣営勝利の生存カウントは passive:fox-win-counter trait を持つ全役職 (妖狐 + 子狐) を対象にする.
  // die-when-divined (= 妖狐のみ) で数えると子狐生存だけで勝った世界線が拾えない.
  const hamsterWinRoles = rolesWithTraitIn(setup, 'passive', 'fox-win-counter')
  const setupFoxes = countByTraitIn(setup, 'passive', 'fox-win-counter')
  // 飽和ライン (maxSurvivingWolves) 算出時の hamster 数は候補ベース (hasRole) で setup 枠キャップ.
  // 確定数 (isActualRole) で数えると planBuilder が妖狐しか枝刈り固定しないので子狐は未確定の
  // まま 0 計上され、 「妖狐+子狐 両生存 + 狼 2 + 人間 2 = 飽和」 のような解を取り逃す.
  const possibleSurvivingHamsters = Math.min(
    setupFoxes,
    survivors.filter(seat =>
      hamsterWinRoles.some(r => context.possibilities.hasRole(seat, r))
    ).length
  )
  const setupWolves = countBySeerResultIn(setup, 'wolf')
  const maxSurvivingWolves = Math.min(
    setupWolves || Infinity,
    Math.floor((survivors.length - possibleSurvivingHamsters - 0.1) / 2)
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
      if (hamsterWinRoles.some(r => context.possibilities.isActualRole(seat, r))) survHamsters++
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
