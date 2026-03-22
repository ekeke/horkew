import type { CauseOfDeath, VillageStatus, SystemRole, Seat, Day } from '../types/index.ts'
import { Possibilities } from './possibilities.ts'
import { generateCombinations } from './combinatorics.ts'
import { roleTesterMap, cloneContext, saveContext, restoreContext } from './roleTesters.ts'
import type { AnalyzeContext, RoleTesterEnv } from './roleTesters.ts'
import { buildRoleTestPlan, LiarRoles } from './planBuilder.ts'
import type { RoleTest } from './planBuilder.ts'
import { finalize as runFinalize, constrainByDeathCounts, createDebugStash } from './finalizer.ts'
import type { DebugStash } from './finalizer.ts'


type SeatPossibility = Set<SystemRole>
export type AnalyzedPossibilities = Map<Seat, SeatPossibility>
export type AnalyzeResult = {
  elapsed?: number,
  id?: number,
  batch?: number,
  aborted?: boolean,
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

  // cooperative abort via SharedArrayBuffer
  signal?: Int32Array
}

const HumanRoles: SystemRole[] = ['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'possessed', 'fanatic', 'immoralist', 'werehamster']

// Check if a subtree rooted at `start` with `size` paths contains any path for `batch`
function subtreeContainsBatch(start: number, size: number, batches: number, batch: number): boolean {
  if (size >= batches) return true
  const offset = ((batch - start % batches) % batches + batches) % batches
  return offset < size
}

// AnalyzeContext and RoleTesterEnv types are defined in roleTesters.ts

export class VillageRetar {
  // 状況の初期値
  // 死因が明らかな場合や仮説が存在するなど、明確な条件が反映済みの値
  initialPossibilities: Possibilities
  // 実行中の解析状況
  // コンテキスト的なものにまとめるべき？
  totalLiarRoles: number
  knownFakeClaimCount: number

  context!: AnalyzeContext
  lastHamsterMustDieAt?: number
  lastHamsterMustDiedBy?: CauseOfDeath
  nightKillsByDay: Map<Day, Seat[]> = new Map()
  lastDeaths: Seat[] = []
  hamsterWinPath?: 'village' | 'wolf'

  // 最終結果
  conclusions: Possibilities
  // Pre-computed survivor data (immutable during analysis)
  cachedSurvivors!: Seat[]
  cachedSurvivingMap!: Map<Seat, boolean>

  // 世界線ベースの解析プラン
  roleTests: RoleTest[][] = []
  // Strides for flat-index batch distribution across depths
  private strides: number[] = []

  // この村の役職の集合
  setOfRoles: Set<SystemRole>
  setOfLiar: Set<SystemRole>
  setOfHuman: Set<SystemRole>

  vs: VillageStatus
  setup: Map<SystemRole, number>

  options: AnalyzeOptions
  env: RoleTesterEnv

  debugStash: DebugStash = createDebugStash()
  constructor(village: VillageStatus, setup: Map<SystemRole, number>, options: AnalyzeOptions) {
    this.vs = village
    this.setup = setup
    this.options = options
    this.conclusions = Possibilities.empty(setup)

    this.applyHocusPocus()

    this.setOfRoles = new Set<SystemRole>(setup.keys())
    this.setOfHuman = new Set(HumanRoles).intersection(this.setOfRoles)
    this.setOfLiar = new Set(LiarRoles).intersection(this.setOfRoles)

    this.initialPossibilities = new Possibilities(setup)
    this.applyFixedPositions(village)

    const multipleVictims = this.buildNightKillMap(village)

    // 単独の夜死体は狼襲撃によるものなので、被害者は人狼ではない
    for ( const [, killed] of this.nightKillsByDay ) {
      if ( killed.length === 1 ) {
        this.initialPossibilities.denyRole(killed[0], 'werewolf')
      }
    }

    this.lastDeaths = this.findLastDeaths()
    this.applyGameEndConstraints()

    const plan = buildRoleTestPlan(village, setup, multipleVictims)
    this.roleTests = plan.roleTests
    this.totalLiarRoles = plan.totalLiarRoles
    this.knownFakeClaimCount = plan.knownFakeClaimCount

    this.env = {
      vs: this.vs,
      nightKillsByDay: this.nightKillsByDay,
      totalLiarRoles: this.totalLiarRoles,
      knownFakeClaimCount: this.knownFakeClaimCount,
      lastHamsterMustDieAt: this.lastHamsterMustDieAt,
      lastHamsterMustDiedBy: this.lastHamsterMustDiedBy,
      dayCountFrom: this.options.dayCountFrom,
    }

    // Compute strides for flat-index batch splitting
    if (this.roleTests.length > 0) {
      this.strides = new Array(this.roleTests.length)
      this.strides[this.roleTests.length - 1] = 1
      for (let d = this.roleTests.length - 2; d >= 0; d--) {
        this.strides[d] = this.strides[d + 1] * this.roleTests[d + 1].length
      }
    }

    this.cachedSurvivors = Array.from(village.statuses.keys()).filter(seat => village.statuses.get(seat)!.surviving)
    this.cachedSurvivingMap = new Map(this.cachedSurvivors.map(seat => [seat, true]))
  }

  // 村騙りなどのハルプンテ指定 — 一切のCOを無視
  private applyHocusPocus() {
    if ( !this.options.hocusPocus ) return
    for ( const seat of this.options.hocusPocus.keys() ) {
      const state = this.vs.statuses.get(seat)!
      state.assertions = new Map()
      state.claiming = false
      state.claimingRole = ''
      state.actions = new Map()
    }
  }

  // 村COと黙って吊られた人の役職否定、仮定・特殊死因による役職固定
  private applyFixedPositions(village: VillageStatus) {
    const fixedPositions = new Map<Seat, SystemRole>()

    for ( const [seat, status] of this.vs.statuses.entries() ) {
      if ( status.claiming && status.claimingRole === 'villager' ) {
        this.initialPossibilities.markAsNoVillageRole(seat)
      }
      if ( status.claiming && status.claimingRole === 'surrender' ) {
        this.initialPossibilities.markAsLiar(seat)
      }
      if ( !status.claiming && !status.surviving && status.causeOfDeath === 'execution' ) {
        this.initialPossibilities.markAsNoVillageRole(seat)
      }
      for ( const role of status.deniedRoles ) {
        this.initialPossibilities.denyRole(seat, role)
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

    for ( const [seat, role] of fixedPositions.entries() ) {
      this.initialPossibilities.fixRole(seat, role)
    }
  }

  // 夜死体数のカウント。複数死体の日のseat一覧を返す
  private buildNightKillMap(village: VillageStatus): Seat[] {
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
    return Array.from(this.nightKillsByDay.values()).filter(v => v.length > 1).flat()
  }

  // ゲーム終了をトリガーした最終死者を特定する
  private findLastDeaths(): Seat[] {
    if (!this.vs.finished || !this.vs.result || this.vs.result === 'draw') return []
    let maxDiedDay = -1
    for (const [, status] of this.vs.statuses.entries()) {
      if (!status.surviving && status.diedDay != null && status.diedDay > maxDiedDay) {
        maxDiedDay = status.diedDay
      }
    }
    if (maxDiedDay < 0) return []
    const seats: Seat[] = []
    for (const [seat, status] of this.vs.statuses.entries()) {
      if (!status.surviving && status.diedDay === maxDiedDay && !this.initialPossibilities.isFixed(seat)) {
        seats.push(seat)
      }
    }
    return seats
  }

  // ゲーム結果に基づく最終死者の役職制約を initialPossibilities に適用
  // werehamster_won は analyze() で2パスに分解するためここでは処理しない
  private applyGameEndConstraints() {
    if (this.lastDeaths.length === 0) return

    if (this.vs.result === 'villager_won') {
      // 村勝利: 最終死者で最後の狼が死んだ → 単一なら狼確定
      if (this.lastDeaths.length === 1) {
        this.initialPossibilities.fixRole(this.lastDeaths[0], 'werewolf')
      }
    }
    else if (this.vs.result === 'werewolf_won') {
      // 狼勝利: 人間が死んで飽和 → 最終死者は非狼・非狐
      for (const seat of this.lastDeaths) {
        this.initialPossibilities.denyRole(seat, 'werewolf')
        this.initialPossibilities.denyRole(seat, 'werehamster')
      }
    }
    // werehamster_won は analyzeHamsterWin() で処理
  }

  private isAborted(): boolean {
    return this.options.signal != null && this.options.signal[0] !== 0
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

  analyze(): AnalyzeResult {
    if (this.vs.result === 'werehamster_won' && this.lastDeaths.length > 0) {
      return this.analyzeHamsterWin()
    }
    const t0 = performance.now()
    this.runAnalysis()
    const elapsed = performance.now() - t0
    const aborted = this.isAborted()
    return {
      elapsed,
      batch: this.options.batch,
      id: this.options.id,
      aborted,
      result: aborted ? new Map() : this.conclusions.toStructured(),
    }
  }

  // werehamster_won を2パスに分解して分析する
  private analyzeHamsterWin(): AnalyzeResult {
    const t0 = performance.now()
    const originalPossibilities = this.initialPossibilities

    // パス1: 狼全滅（村勝利相当）→ 最終死者は狼
    this.hamsterWinPath = 'village'
    const poss1 = originalPossibilities.clone()
    let path1Valid = true
    if (this.lastDeaths.length === 1) {
      path1Valid = poss1.fixRole(this.lastDeaths[0], 'werewolf')
    }
    if (path1Valid) {
      this.initialPossibilities = poss1
      this.runAnalysis()
    }

    if (this.isAborted()) {
      this.initialPossibilities = originalPossibilities
      this.hamsterWinPath = undefined
      return { aborted: true, result: new Map() }
    }

    // パス2: 飽和（狼勝利相当）→ 最終死者は非狼・非狐
    this.hamsterWinPath = 'wolf'
    const poss2 = originalPossibilities.clone()
    let path2Valid = true
    for (const seat of this.lastDeaths) {
      if (!poss2.denyRole(seat, 'werewolf')) { path2Valid = false; break }
      if (!poss2.denyRole(seat, 'werehamster')) { path2Valid = false; break }
    }
    if (path2Valid) {
      this.initialPossibilities = poss2
      this.runAnalysis()
    }

    // 復元
    this.initialPossibilities = originalPossibilities
    this.hamsterWinPath = undefined

    const elapsed = performance.now() - t0
    const aborted = this.isAborted()
    return {
      elapsed,
      batch: this.options.batch,
      id: this.options.id,
      aborted,
      result: aborted ? new Map() : this.conclusions.toStructured(),
    }
  }

  private runAnalysis(): void {
    // Initialize
    this.context = {
      additionalLiars: 0,
      hamstersKilledBySeer: [],
      requireOneOf: [],
      deathChronicle: new Map(),
      possibilities: this.initialPossibilities.clone(),
      hamstersMaxSurvivingDay: Infinity,
    }

    this.walkRoleTests(0)
  }

  private walkRoleTests(depth: number, baseIndex: number = 0): void {
    if (depth >= this.roleTests.length) {
      this.tryFinalize()
      return
    }

    const group = this.roleTests[depth]
    const stride = this.strides[depth]
    const { batches, batch } = this.options
    for (let i = 0; i < group.length; i++) {
      if (this.isAborted()) return

      const myIndex = baseIndex + i * stride
      // Skip subtrees that contain no paths for this batch
      if (batches > 1 && !subtreeContainsBatch(myIndex, stride, batches, batch)) continue

      const snapshot = saveContext(this.context)
      const result = this.testRole(group[i])

      if (result) {
        this.walkRoleTests(depth + 1, myIndex)
      }

      restoreContext(this.context, snapshot)
    }
  }

  private tryFinalize(): void {
    this.debugStash.preFinalizeTests++
    // 死体数の確認
    if (!constrainByDeathCounts(this.context, this.vs, this.nightKillsByDay, this.setup)) {
      return
    }

    if ( this.totalLiarRoles <= (this.context.additionalLiars || 0) + this.knownFakeClaimCount ) {
      for ( const seat of this.vs.statuses.keys() ) {
        const status = this.getStatus(seat)!
        if ( !status.claiming || status.claimingRole === 'villager' ) {
          this.context.possibilities.markAsNotLiar(seat)
        }
      }
    }
    this.debugStash.preFinalizePasses++

    if ( this.context.requireOneOf.length > 0 ) {
      const snapshot = saveContext(this.context)
      VARIATION:
      for ( const variation of generateCombinations(this.context.requireOneOf)) {
        restoreContext(this.context, snapshot)
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
  }

  finalize() {
    runFinalize(this.context, this.vs, this.setup, this.conclusions, this.debugStash, this.hamsterWinPath, this.cachedSurvivors, this.cachedSurvivingMap)
  }

  analyzeSafe(): AnalyzeResult {
    try {
      return this.analyze()
    }
    catch (e) {
      return { error: e instanceof Error ? e : new Error(String(e)), result: new Map() }
    }
  }
}
