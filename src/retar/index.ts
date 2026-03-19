import type { CauseOfDeath, VillageStatus, SystemRole } from '../types/index.ts'
import { Possibilities } from './possibilities.ts'
import { generateCombinations, backtrackForMatrix } from './combinatorics.ts'
import { roleTesterMap, cloneContext } from './roleTesters.ts'
import type { AnalyzeContext, RoleTesterEnv } from './roleTesters.ts'
import { buildRoleTestPlan, LiarRoles } from './planBuilder.ts'
import type { RoleTest } from './planBuilder.ts'
import { finalize as runFinalize, validateDeathCounts } from './finalizer.ts'
import type { DebugStash } from './finalizer.ts'

export { selectCombinationsFromArray, selectOne, backtrackForMatrix } from './combinatorics.ts'

type Seat = number
type Day = number
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

  context!: AnalyzeContext
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

  debugStash: DebugStash = {
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
        const state = this.vs.statuses.get(seat)!
        state.assertions = new Map()
        state.claiming = false
        state.claimingRole = ''
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
        this.nightKillsByDay.set(status.diedDay!, [...(this.nightKillsByDay.get(status.diedDay!) || []), seat])
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
    ;(this.debugStash as Record<string, number>)[`${role}Tests`]++
    const result = tester(this.env, this.context, selected, rest)
    if ( result ) (this.debugStash as Record<string, number>)[`${role}TestPasses`]++
    return result
  }

  analyze() {
    const t0 = performance.now()

    // Initialize
    this.context = {
      additionalLiars: 0,
      hamstersKilledBySeer: [],
      requireOneOf: [],
      deathChronicle: new Map(),
      possibilities: this.initialPossibilities.clone(),
      hamstersMaxSurvivingDay: Infinity,
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
      if (!validateDeathCounts(this.context, this.vs, this.nightKillsByDay, this.setup)) {
        testIter = loop.next([false, this.context])
        continue TESTS
      }

      if ( this.maxLiars <= (this.context.additionalLiars || 0) + this.numLiars ) {
        for ( const seat of this.vs.statuses.keys() ) {
          const status = this.getStatus(seat)!
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

  finalize() {
    runFinalize(this.context, this.vs, this.setup, this.conclusions, this.debugStash)
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
