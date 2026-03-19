// @ts-nocheck
// TODO: Fix type errors inherited from reference implementation
import type { CauseOfDeath, EnumSpecies, VillageStatus, SeatStatus, SystemRole } from '../types/index.ts'
import { Possibilities } from './possibilities.ts'
import { generateCombinations, backtrackForMatrix } from './combinatorics.ts'
import { roleTesterMap } from './roleTesters.ts'
import type { AnalyzeContext, RoleTesterEnv } from './roleTesters.ts'
import { buildRoleTestPlan, LiarRoles } from './planBuilder.ts'
import type { RoleTest } from './planBuilder.ts'

export { selectCombinationsFromArray, selectOne, backtrackForMatrix } from './combinatorics.ts'

type Seat = number
type Day = number
/**
 * 解析オプション
 * no: 現在も潜伏している可能性を含める
 * auto: 潜伏を可能性に含めるが、対抗が出たら必ず対抗COすると仮定する
 * yes: 潜伏を考慮しない。死亡済みまたはCO済みのプレイヤーのみを考慮する
 */
type AnalyzeOptionValue = 'no' | 'auto' | 'yes'

export type RetarOptions = {
  // システム設定

  // aggregate用の実行ID
  id: number
  batches: number
  batch: number

  // 潜伏役職の扱い
  noMoreHiddenSeer: AnalyzeOptionValue,
  noMoreHiddenMedium: AnalyzeOptionValue,
  noMoreHiddenBodyguard: AnalyzeOptionValue,
  noMoreHiddenMason: AnalyzeOptionValue,
  noMoreHiddenNekomata: AnalyzeOptionValue,

  // ユーザーが仮定した役職
  assumptions: Map<Seat, SystemRole>

  dayCountFrom: number
  hasFirstGhost: boolean

  /* 後追いのタイミングなど、ローカルルールへの対応 */
  // TODO: レギュレーションとどう組み合わせるか考える

  // 妖狐が吊られたときの背徳の後追いの発生タイミング
  immoralistFollowsExecutedHamsterImmediately?: boolean

  // 妖狐が溶けたとき、背徳の後追いに特別なアナウンスがあるか
  immoralistFollowsKilledHamsterWithAnnounce?: boolean

  // 猫又が吊られたときのランダム対象が村人陣営限定か
  executedNekomataCursesOnlyVillagers?: boolean

  // 猫又が吊られたとき、猫又の呪いが翌朝に発動するか
  executedNekomataCursesImmediately?: boolean
}

type SeatPossibility = Set<SystemRole>
export type AnalyzedPossibilities = Map<Seat, SeatPossibility>
export type AnalyzeResult = {
  elapsed?: number,
  id?: number,
  batch?: number,
  error?: Error,
  info?: any,
  result: AnalyzedPossibilities
}

/*
 * 現在の村の状態を解析し、各プレイヤーに可能な役職を割り当てる
 */
export type AnalyzeOptions = {
  seerClaimingDueDate: number
  mediumClaimingDueDate: number
  bodyguardClaimingDueDate: number
  masonClaimingDueDate: number
  nekomataClaimingDueDate: number

  // regulation options
  dayCountFrom: number
  hasFirstGhost: boolean

  // ユーザーが仮定した役職
  assumptions: Map<Seat, SystemRole>
  hocusPocus: Map<Seat, boolean>
  // aggregate用の実行ID
  id: number
  batches: number
  batch: number

}

const WhiteEnemies = ['possessed', 'fanatic', 'immoralist']
const HumanRoles = ['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'possessed', 'fanatic', 'immoralist', 'werehamster']

// AnalyzeContext and RoleTesterEnv types are defined in roleTesters.ts

export class VillageRetar {
  // 状況の初期値
  // 死因が明らかな場合や仮説が存在するなど、明確な条件が反映済みの値
  initialPossibilities: Possibilities
  // 実行中の解析状況
  // コンテキスト的なものにまとめるべき？
  maxLiars: number
  numLiars: number

  context: AnalyzeContext
  lastHamsterMustDieAt?: number
  lastHamsterMustDiedBy?: CauseOfDeath
  nightKillsByDay: Map<Day, Seat[]> = new Map()

  // 最終結果
  conclusions: Possibilities

  // 世界線ベースの解析プラン
  roleTests: RoleTest[][] = []

  // この村の役職の集合
  setOfRoles: Set<SystemRole>
  setOfLiar: Set<SystemRole>
  setOfHuman: Set<SystemRole>

  vs: VillageStatus
  setup: Map<SystemRole, number>

  options: AnalyzeOptions
  env: RoleTesterEnv

  debugStash: {
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
  } = {
    finalizerRuns: 0,
    finalizerMiddle: 0,
    finalizerPasses: 0,
    finalizerFails: 0,
    seerTests: 0,
    mediumTests: 0,
    bodyguardTests: 0,
    masonTests: 0,
    nekomataTests: 0,
    werehamsterTests: 0,
    seerTestPasses: 0,
    mediumTestPasses: 0,
    bodyguardTestPasses: 0,
    masonTestPasses: 0,
    nekomataTestPasses: 0,
    werehamsterTestPasses: 0,
    preFinalizeTests: 0,
    preFinalizePasses: 0,
  }
  constructor(village: VillageStatus, setup: Map<SystemRole, number>, options: AnalyzeOptions) {
    this.vs = village
    this.setup = setup
    this.options = options
    this.conclusions = new Possibilities(setup)
    for ( let i=0; i<this.conclusions.possibilities.length; i++) {
      this.conclusions.possibilities[i] = 0
    }

    // 村騙りなどのハルプンテ指定
    // 一切のCOを無視
    if ( this.options.hocusPocus ) {
      for ( const seat of this.options.hocusPocus.keys() ) {
        const state = this.vs.statuses.get(seat)
        state.assertions = new Map()
        state.claiming = false
        state.claimingRole = null
        state.actions = new Map()
      }
    }

    this.setOfRoles = new Set<SystemRole>(setup.keys())
    this.setOfHuman = new Set(HumanRoles as SystemRole[]).intersection(this.setOfRoles)
    this.setOfLiar = new Set(LiarRoles as SystemRole[]).intersection(this.setOfRoles)

    // 状態空間の初期状態を設定
    const fixedPositions = new Map<Seat, SystemRole>()

    this.initialPossibilities = new Possibilities(setup)

    // 村COと、黙って吊られた人は役職否定とみなす
    for ( const [seat,status] of this.vs.statuses.entries() ) {
      if ( status.claiming && status.claimingRole === 'villager' ) {
        this.initialPossibilities.markAsNoVillageRole(seat)
      }
      if ( status.claiming && status.claimingRole === 'surrender' ) {
        this.initialPossibilities.markAsLiar(seat)
      }
      if ( !status.claiming && !status.surviving && status.causeOfDeath === 'execution' ) {
        this.initialPossibilities.markAsNoVillageRole(seat)
      }
    }

    if ( this.options.assumptions.size > 0 ) {
      for ( const [seat, role] of this.options.assumptions.entries() ) {
        fixedPositions.set(seat, role)
      }
    }

    // 特殊な死因による役職固定
    for ( const [seat, status] of village.statuses.entries() ) {
      if ( !status.surviving ) {
        if ( status.causeOfDeath === 'cursed_by_killed_nekomata' ) {
          fixedPositions.set(seat, 'werewolf')
        }
        else if ( status.causeOfDeath === 'cursed_by_executed_nekomata' ) {
          for ( const [nekoSeat, nekoStatus] of village.statuses.entries() ) {
            if ( nekoStatus.surviving ) continue
            if ( nekoStatus.causeOfDeath === 'execution' && status.diedDay === nekoStatus.diedDay ) {
              fixedPositions.set(nekoSeat, 'nekomata')
            }
          }
        }
        else if ( status.causeOfDeath === 'follow_executed_hamster') {
          fixedPositions.set(seat, 'immoralist')
          this.lastHamsterMustDieAt = status.diedDay
          this.lastHamsterMustDiedBy = 'execution'
        }
        else if ( status.causeOfDeath === 'follow_killed_hamster' ) {
          fixedPositions.set(seat, 'immoralist')
          this.lastHamsterMustDieAt = status.diedDay
          this.lastHamsterMustDiedBy = 'night_kill'
        }
      }
    }

    // 役職固定位置に役職を設定していく
    // この時点で、固定位置に設定できない場合は、矛盾があるか、村の状態がおかしい
    const setupWithoutFixed = new Map(this.setup)
    for ( const [seat, role] of fixedPositions.entries() ) {
      this.initialPossibilities.fixRole(seat, role)
    }

    // 後で使うために、死体数のカウントを取っておく
    const firstKill = this.options.dayCountFrom - (this.options.hasFirstGhost ? 1 : 0)
    for ( let d = firstKill; d<this.vs.day; d++) {
      this.nightKillsByDay.set(d, [])
    }
    for ( const [seat, status] of village.statuses.entries() ) {
      if ( status.surviving ) continue
      if ( status.causeOfDeath === 'night_kill' ) {
        this.nightKillsByDay.set(status.diedDay, [...(this.nightKillsByDay.get(status.diedDay) || []), seat])
      }
    }
    const multipleVictims = Array.from(this.nightKillsByDay.values()).filter(v => v.length > 1).flat()

    // プランニング
    const plan = buildRoleTestPlan(village, setup, multipleVictims)
    this.roleTests = plan.roleTests
    this.maxLiars = plan.maxLiars
    this.numLiars = plan.numLiars

    this.env = {
      vs: this.vs,
      nightKillsByDay: this.nightKillsByDay,
      maxLiars: this.maxLiars,
      numLiars: this.numLiars,
      lastHamsterMustDieAt: this.lastHamsterMustDieAt,
      lastHamsterMustDiedBy: this.lastHamsterMustDiedBy,
      dayCountFrom: this.options.dayCountFrom,
    }
  }

  getStatus(seat: Seat) {
    return this.vs.statuses.get(seat)
  }

  testRole(scenario: RoleTest) {
    const { role, selected, rest } = scenario
    if (role === 'allpass') return true
    const tester = roleTesterMap[role]
    if (!tester) throw new Error('unknown role')
    this.debugStash[`${role}Tests`]++
    const result = tester(this.env, this.context, selected, rest)
    if ( result ) this.debugStash[`${role}TestPasses`]++
    return result
  }

  analyze() {
    const t0 = performance.now()
    let count = 0

    // Initialize
    this.context = {
      additionalLiars: 0,
      hamstersKilledBySeer: [],
      requireOneOf: [],
      deathChronicle: new Map(),
      possibilities: this.initialPossibilities.clone(),
      hamstersMaxSurvivingDay: Infinity,
    }

    const cloneContext = (context: AnalyzeContext): AnalyzeContext => {
      return {
        additionalLiars: structuredClone(context.additionalLiars),
        hamstersKilledBySeer: structuredClone(context.hamstersKilledBySeer),
        hamstersMaxSurvivingDay: context.hamstersMaxSurvivingDay,
        requireOneOf: structuredClone(context.requireOneOf),
        deathChronicle: structuredClone(context.deathChronicle),
        possibilities: context.possibilities.clone(),
      }
    }
    const loop = backtrackForMatrix(this.roleTests, this.context)
    let testIter = loop.next([true, this.context])

    TESTS:
    while (true) {
      if ( testIter.done ) {
//        console.log('done')
        break TESTS
      }
      const testItem = testIter.value
      if ( testItem == null ) throw new Error('invalid test item')
      if ( 'object' !== typeof testItem ) throw new Error('invalid test item')
      if ( !('context' in testItem ) ) throw new Error('invalid context')
      this.context = cloneContext(testItem.context)
      if (testItem.depth === 0 && testItem.index % this.options.batches !== this.options.batch) {
        testIter = loop.next([false, this.context])
        continue TESTS
      }
      const result = this.testRole(testItem.item)

      if ( ! result ) {
        testIter = loop.next([result, this.context])
        continue TESTS
      }

      if ( !testItem.last ) {
        testIter = loop.next([result, this.context])
        continue TESTS
      }



      this.debugStash.preFinalizeTests++
      // 死体数の確認
      DAY:
      for ( const [day, killed] of this.nightKillsByDay.entries() ) {
        if ( this.vs.day <= day ) continue DAY
        const deathChronicle = this.context.deathChronicle.get(day)
        let expected = 1
        if ( deathChronicle ) expected += deathChronicle.add
        const actual = killed.length
        const immoralists = this.setup.get('immoralist') || 0
        if ( actual === expected ) continue DAY
        if ( expected + immoralists < actual ) {
          testIter = loop.next([false, this.context])
          continue TESTS
        }
        else if ( actual < expected - 1 ) {
          testIter = loop.next([false, this.context])
          continue TESTS
        }
        else if ( expected < actual && actual <= expected + immoralists ) {
          for ( let i=0; i<immoralists; i++ ) {
            this.context.requireOneOf.push( killed.map(seat => ({ seat, role: 'immoralist' })) )
          }
          continue DAY
        }
        else if (this.context.hamstersMaxSurvivingDay >= day) {
          continue DAY
        }
        for ( const [seat, status] of this.vs.statuses.entries() ) {
          if (
            ( status.surviving || day <= status.diedDay)
            && this.context.possibilities.hasRole(seat,'bodyguard')
          ) {
            continue DAY
          }
        }
        testIter = loop.next([false, this.context])
        continue TESTS
      }

      if ( this.maxLiars <= (this.context.additionalLiars || 0) + this.numLiars ) {
        for ( const seat of this.vs.statuses.keys() ) {
          const status = this.getStatus(seat)
          if ( !status.claiming || status.claimingRole === 'villager' ) {
            this.context.possibilities.markAsNotLiar(seat)
          }
        }
      }
      this.debugStash.preFinalizePasses++

      if ( this.context.requireOneOf.length > 0 ) {
        const originalContext = this.context
        VARIATION:
        for ( const variation of generateCombinations(this.context.requireOneOf)) {
          this.context = cloneContext(originalContext)
          for ( const {seat, role} of variation ) {
            if ( ! this.context.possibilities.fixRole(seat, role) ) {
              continue VARIATION
            }
          }

          this.finalize()
        }
      }
      else {
        this.finalize()
      }
      testIter = loop.next([result, this.context])
    }

    const elapsed = performance.now() - t0
    console.log('debug', this.debugStash)
    return {
      elapsed,
      batch: this.options.batch,
      id: this.options.id,
      result: this.conclusions.toStructured(),
    }
  }

  checkPossibility(possibilities: Set<SystemRole>[], setup: {[key in SystemRole]?: number}, depth: number = 0) : boolean {
    if ( depth === possibilities.length ) {
      return true
    }
    const roles = possibilities[depth]
    for ( const role of roles ) {
      if ( setup[role] > 0 ) {
        setup[role]--
        if ( this.checkPossibility(possibilities, setup, depth + 1) ) {
          return true
        }
        setup[role]++
      }
    }
    return false
  }

  finalize() {
    this.debugStash.finalizerRuns++
    // ここまで処理が終わったところで、襲撃死した人物は非狼とみなす
    for ( const [seat, status] of this.vs.statuses.entries() ) {
      if ( !status.surviving && status.causeOfDeath === 'night_kill' ) {
        if ( this.context.possibilities.isFixed(seat) ) {
          continue
        }
        if (!this.context.possibilities.markAsHuman(seat)) {
          return
        }
      }
    }

    if (!this.context.possibilities.refix()) {
      return
    }
    for (const [role, count] of this.setup.entries()) {
      const candidates = this.context.possibilities.getPossibieSeatsForRole(role)
      if (candidates.length < count) {
        return
      }
      if ( candidates.length === count ) {
        for ( const seat of candidates ) {
          if ( !this.context.possibilities.fixRole(seat, role) ) {
            return
          }
        }
      }
    }
    if (!this.context.possibilities.refix()) {
      return
    }
    this.debugStash.finalizerMiddle++

    /*
    TODO: ここで、同じ役職の組み合わせをまとめてテストを行う
    const set = {}
    for ( const [seat, possibilities] of remained.entries() ) {
      const stringOfRoles = Array.from(possibilities).sort().join(',')
      set[stringOfRoles] ??= []
      set[stringOfRoles].push(seat)
    }
    */


    const survivors = Array.from(this.vs.statuses.keys()).filter(seat => this.getStatus(seat).surviving)
    const numSurvivingHamsters = survivors.filter(seat => this.context.possibilities.isActualRole(seat, 'werehamster')).length
    const maxSurvivingWolves = Math.min(
      this.setup.get('werewolf') || Infinity,
      Math.floor((survivors.length - numSurvivingHamsters - 0.1) / 2)
    )

    const survivingMap = new Map(survivors.map(seat => [seat, true]))
    const condition = {
      minSurvivingWolves: 1,
      maxSurvivingWolves,
      minSurvivingHamsters: 0,
      maxSurvivingHamsters: this.setup.get('werehamster') || 0,
    }

    // 村勝ちまたは狼勝ちの場合は、狼の生存数の条件を変更する
    if ( this.vs.result === 'werewolf_won' ) {
      condition.minSurvivingWolves = maxSurvivingWolves + 1
      condition.maxSurvivingWolves = Infinity
      condition.minSurvivingHamsters = 0
      condition.maxSurvivingHamsters = 0
    }
    else if ( this.vs.result === 'villager_won' ) {
      condition.minSurvivingWolves = 0
      condition.maxSurvivingWolves = 0
      condition.minSurvivingHamsters = 0
      condition.maxSurvivingHamsters = 0
    }

    // 狐勝ちの場合だけは、狼全滅と飽和の両方を検証する
    if ( this.vs.result === 'werehamster_won') {
      const conclusion = this.context.possibilities.solvePossibilities(
        survivingMap,
        0,
        0,
        1,
        Infinity,
        this.setup
      )
      if (conclusion) {
        this.debugStash.finalizerPasses++
        this.conclusions.union(conclusion)
      }
      const conclusion2 = this.context.possibilities.solvePossibilities(
        survivingMap,
        maxSurvivingWolves + 1,
        Infinity,
        1,
        Infinity,
        this.setup
      )
      if (conclusion2) {
        this.debugStash.finalizerPasses++
        this.conclusions.union(conclusion2)
      }
    }
    else {
      const conclusion = this.context.possibilities.solvePossibilities(
        survivingMap,
        condition.minSurvivingWolves,
        condition.maxSurvivingWolves,
        condition.minSurvivingHamsters,
        condition.maxSurvivingHamsters,
        this.setup
      )
      if ( !conclusion ) {
        this.debugStash.finalizerFails++
        return
      }
      this.debugStash.finalizerPasses++
      this.conclusions.union(conclusion)
    }
  }

  analyzeSafe() {
    try {
      return this.analyze()
    }
    catch (e) {
      return { error: e }
    }
  }
}
