import type { CauseOfDeath, VillageStatus, SystemRole, Seat, Day, Regulation } from '../types/index.ts'
import { Possibilities, possibilityFromRoles } from './possibilities.ts'
import { generateCombinations } from './combinatorics.ts'
import { testRole as runRoleTest, saveContext, restoreContext } from './roleTesters.ts'
import type { AnalyzeContext, RoleTesterEnv } from './roleTesters.ts'
import { buildRoleTestPlan } from './planBuilder.ts'
import { humanRolesIn, liarRolesIn, poweredVillageRolesIn, hasTrait, singleRoleByPredicate, rolesByTrait, rolesBySeerResult } from './role-sets.ts'
import { systemRoles } from '../types/index.ts'

// 単一役職 const (役職追加時に他役職が新規に該当しなければ自動追従).
const wolfRoles = rolesBySeerResult('wolf')
const foxRoles = rolesByTrait('passive', 'die-when-divined')
const villagerRole = singleRoleByPredicate(r => {
  const x = systemRoles.get(r)!
  return x.faction === 'village' && x.traits.length === 0
})
// fixedPositions の確定先として使う集合. systemRoles 全体から取るので setup 非依存.
// 将来 同 trait を持つ役職が複数になったら、 fixedPositions に「集合のどれか」 を表現する
// 仕組みが必要 (現状は 1 役職前提で [0] を使う).
const nekomataRoles = rolesByTrait('reactive', 'curse-on-executed')
const immoralistRoles = rolesByTrait('reactive', 'follow-fox-death')
import type { RoleTest } from './planBuilder.ts'
import { finalize as runFinalize, updateDeathCountConstraints, createDebugStash } from './finalizer.ts'
import type { DebugStash } from './finalizer.ts'
import { dumpAnalyzeResult, resetDump } from './dump.ts'


type SeatPossibility = Set<SystemRole>
export type AnalyzedPossibilities = Map<Seat, SeatPossibility>
export type AnalyzeResult = {
  elapsed?: number,
  id?: number,
  batch?: number,
  aborted?: boolean,
  error?: Error,
  info?: any,
  result: AnalyzedPossibilities,
  maxSurvivingNV: number,
}

/*
 * 現在の村の状態を解析し、各プレイヤーに可能な役職を割り当てる
 */
export type AnalyzeOptions = {
  /** @deprecated 未使用。 planBuilder は実 CO 日 (minClaimDay) を使用するため、 この閾値は読み出されない。 将来削除予定 */
  seerClaimingDueDate: number
  /** @deprecated 未使用。 [[seerClaimingDueDate]] と同じ理由 */
  mediumClaimingDueDate: number
  /** @deprecated 未使用。 [[seerClaimingDueDate]] と同じ理由 */
  bodyguardClaimingDueDate: number
  /** @deprecated 未使用。 [[seerClaimingDueDate]] と同じ理由 */
  masonClaimingDueDate: number
  /** @deprecated 未使用。 [[seerClaimingDueDate]] と同じ理由 */
  nekomataClaimingDueDate: number

  // ゲーム規定 (Regulation): hasFirstGhost / seerFirstSeek はここから導出する。
  regulation: Regulation
  // 占い行動の起点夜 (retar 固有、 ruleset の omitFirstDay とは独立)
  dayCountFrom: number

  // ユーザーが仮定した役職
  assumptions: Map<Seat, SystemRole>
  // ユーザーが指定した「狼同士を否定」ペア
  wolfPairDenyals: [Seat, Seat][]
  hocusPocus: Map<Seat, boolean>
  // aggregate用の実行ID
  id: number
  batches: number
  batch: number

  // cooperative abort via SharedArrayBuffer
  signal?: Int32Array

  // 事前計算済みanalyze結果を基に再計算する場合に指定
  prior?: AnalyzedPossibilities
}

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
  private _initialPossibilities!: Possibilities
  get initialPossibilities(): Possibilities { return this._initialPossibilities }
  set initialPossibilities(value: Possibilities) { this._initialPossibilities = value }
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

    this.setOfRoles = new Set<SystemRole>(setup.keys())
    this.setOfHuman = new Set(humanRolesIn(setup))
    this.setOfLiar = new Set(liarRolesIn(setup))

    // Village由来メタデータ（possibilities非依存）
    this.extractHamsterDeathInfo(village)
    const multipleVictims = this.buildNightKillMap(village)
    this.lastDeaths = this.findLastDeaths()

    // 初期化分岐
    if (options.prior) this.initFromPrior(options.prior)
    else this.initFromScratch(village)

    // 共通後処理
    const plan = buildRoleTestPlan(village, setup, multipleVictims, this.initialPossibilities, this.options.hocusPocus, this.options.assumptions)
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
      seerFirstSeek: this.options.regulation['role.seer.first-seek'],
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

  // ゼロから初期化（従来のフルパス）
  private initFromScratch(village: VillageStatus) {
    this.applyHocusPocus()
    this.initialPossibilities = new Possibilities(this.setup)
    this.applyFixedPositions(village)

    // 単独の夜死体は狼襲撃によるものなので、被害者は人狼ではない
    for ( const [, killed] of this.nightKillsByDay ) {
      if ( killed.length === 1 ) {
        for ( const r of wolfRoles ) this.initialPossibilities.denyRole(killed[0], r)
      }
    }

    this.applyGameEndConstraints()
  }

  // 現在の vs に役職スライド or 結果スライドが含まれているか検査する。
  // スライドは「過去 valid だった世界線が無効化される or 過去 invalid だった世界線が解禁される」
  // という非単調な変化を引き起こすため、prior の possibilities (= 過去前提で求めた役職集合の和) は
  // チェーンの起点として安全に使えない。
  private hasSlidesInVs(): boolean {
    for ( const status of this.vs.statuses.values() ) {
      if ( status.previousClaims && status.previousClaims.length > 0 ) return true
      if ( status.previousAssertions && status.previousAssertions.size > 0 ) return true
    }
    return false
  }

  // 事前計算済みanalyze結果を基に、追加assumptionで再計算。
  // prior は過去の時点で取得した結果でも良く、その場合は現在の vs に追加で発生した
  // 制約（新しい CO、CO無し処刑、特殊死因、単独夜死体、ゲーム終了制約 等）を
  // monotonic な narrowing として prior の上から AND で適用する。
  //
  // 例外: vs にスライドが含まれている場合、prior は安全に使えない。
  // initFromScratch にフォールバックして prior を破棄する（assumptions は維持）。
  private initFromPrior(prior: AnalyzedPossibilities) {
    if ( this.hasSlidesInVs() ) {
      this.initFromScratch(this.vs)
      // initFromScratch 内の applyFixedPositions は assumption の fixRole を silent に行うため、
      // 不整合があった場合に明示的にエラーを投げるための事後検査。
      for ( const [seat, role] of this.options.assumptions.entries() ) {
        if ( !this.initialPossibilities.hasRole(seat, role) ) {
          throw new Error(`Prior-based re-analysis (slide-fallback): seat ${seat} cannot be ${role}`)
        }
      }
      return
    }

    this.applyHocusPocus()

    this.initialPossibilities = new Possibilities(this.setup)
    for ( const [seat, roles] of prior.entries() ) {
      this.initialPossibilities.possibilities[seat] = possibilityFromRoles(roles)
    }

    // prior ビットマスクに合わせて setup カウントを同期し、確定席の伝播を実行
    this.initialPossibilities.refix()

    // applyFixedPositions が assumption を fixRole する際は失敗が silent なので、
    // ここで prior に対する整合性を先に明示的に検査する
    for ( const [seat, role] of this.options.assumptions.entries() ) {
      if ( !this.initialPossibilities.hasRole(seat, role) ) {
        throw new Error(`Prior-based re-analysis: seat ${seat} cannot be ${role} (not in prior possibilities)`)
      }
    }

    // 現在の vs から得られる制約（新しい日に発生した CO/処刑/特殊死因/assumption/wolfPairDenyals）を
    // prior の possibilities に追加適用する。prior が古い時点のものでも、進んだ日の制約を取りこぼさない。
    this.applyFixedPositions(this.vs)

    // 単独の夜死体は狼襲撃によるものなので、被害者は人狼ではない
    for ( const [, killed] of this.nightKillsByDay ) {
      if ( killed.length === 1 ) {
        for ( const r of wolfRoles ) this.initialPossibilities.denyRole(killed[0], r)
      }
    }

    this.applyGameEndConstraints()

    // 全制約適用後、assumption が依然成立しているか検査（特殊死因と矛盾するケース等を捕捉）
    for ( const [seat, role] of this.options.assumptions.entries() ) {
      if ( !this.initialPossibilities.hasRole(seat, role) ) {
        throw new Error(`Prior-based re-analysis: fixRole(${seat}, ${role}) caused contradiction`)
      }
    }
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

  // 後追い死亡によるハムスター死亡情報の抽出（possibilities非依存）
  private extractHamsterDeathInfo(village: VillageStatus) {
    for ( const [, status] of village.statuses.entries() ) {
      if ( !status.surviving ) {
        if ( status.causeOfDeath === 'follow_executed_hamster' ) {
          this.lastHamsterMustDieAt = status.diedDay
          this.lastHamsterMustDiedBy = 'execution'
        }
        else if ( status.causeOfDeath === 'follow_killed_hamster' ) {
          this.lastHamsterMustDieAt = status.diedDay
          this.lastHamsterMustDiedBy = 'night_kill'
        }
      }
    }
  }

  // 村COと黙って吊られた人の役職否定、仮定・特殊死因による役職固定
  private applyFixedPositions(village: VillageStatus) {
    const fixedPositions = new Map<Seat, SystemRole>()

    // 処刑道連れが発生した日を事前収集（処刑者が猫又の可能性を残すため）
    const curseDays = new Set<number>()
    for ( const s of this.vs.statuses.values() ) {
      if ( s.causeOfDeath === 'cursed_by_executed_nekomata' && s.diedDay !== undefined ) {
        curseDays.add(s.diedDay)
      }
    }

    for ( const [seat, status] of this.vs.statuses.entries() ) {
      if ( status.claiming && status.claimingRole === villagerRole ) {
        this.initialPossibilities.markAsNoVillageRole(seat)
      }
      if ( status.claiming && status.claimingRole === 'surrender' ) {
        this.initialPossibilities.markAsLiar(seat)
      }
      if ( !status.claiming && !status.surviving && status.causeOfDeath === 'execution' && !status.noCoOpportunity ) {
        if ( curseDays.has(status.diedDay!) ) {
          // 道連れ発生 → 道連れ役職 (猫又) の可能性を残し、他の能力持ち村役職を deny
          for ( const role of poweredVillageRolesIn(this.setup) ) {
            if ( hasTrait(role, 'reactive', 'curse-on-executed') ) continue
            this.initialPossibilities.denyRole(seat, role)
          }
        } else {
          this.initialPossibilities.markAsNoVillageRole(seat)
        }
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

    // 狼ペア否定の早期適用: 片方がwerewolf確定なら他方からdeny
    for ( const [seatA, seatB] of this.options.wolfPairDenyals ) {
      if ( fixedPositions.get(seatA) === wolfRoles[0] ) {
        for ( const r of wolfRoles ) this.initialPossibilities.denyRole(seatB, r)
      }
      if ( fixedPositions.get(seatB) === wolfRoles[0] ) {
        for ( const r of wolfRoles ) this.initialPossibilities.denyRole(seatA, r)
      }
    }

    // 特殊な死因による役職固定
    for ( const [seat, status] of village.statuses.entries() ) {
      if ( !status.surviving ) {
        if ( status.causeOfDeath === 'cursed_by_killed_nekomata' ) {
          fixedPositions.set(seat, wolfRoles[0])
        }
        else if ( status.causeOfDeath === 'cursed_by_executed_nekomata' ) {
          for ( const [nekoSeat, nekoStatus] of village.statuses.entries() ) {
            if ( nekoStatus.surviving ) continue
            if ( nekoStatus.causeOfDeath === 'execution' && status.diedDay === nekoStatus.diedDay ) {
              fixedPositions.set(nekoSeat, nekomataRoles[0])
            }
          }
        }
        else if ( status.causeOfDeath === 'follow_executed_hamster') {
          fixedPositions.set(seat, immoralistRoles[0])
        }
        else if ( status.causeOfDeath === 'follow_killed_hamster' ) {
          fixedPositions.set(seat, immoralistRoles[0])
        }
      }
    }

    for ( const [seat, role] of fixedPositions.entries() ) {
      this.initialPossibilities.fixRole(seat, role)
    }
  }

  // 夜死体数のカウント。複数死体の日のseat一覧を返す
  private buildNightKillMap(village: VillageStatus): Seat[] {
    const hasFirstGhost = this.options.regulation['general.first-victim'] !== 'none'
    const firstKill = this.options.dayCountFrom - (hasFirstGhost ? 1 : 0)
    for ( let d = firstKill; d<this.vs.day; d++) {
      this.nightKillsByDay.set(d, [])
    }
    // bridge が peace 文を kills に空エントリで登録している day を取り込み.
    // vs.day < d (= 「平和」 で day が増えた後の最終 peace day) のケースをカバー.
    for ( const [d, seats] of village.kills.entries() ) {
      if ( seats.length === 0 && !this.nightKillsByDay.has(d) ) {
        this.nightKillsByDay.set(d, [])
      }
    }
    for ( const [seat, status] of village.statuses.entries() ) {
      if ( status.surviving ) continue
      if ( status.causeOfDeath === 'night_kill' || status.causeOfDeath === 'cursed_by_killed_nekomata' ) {
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
    // 同じ日に昼フェーズ（処刑系）と夜フェーズ（夜殺系）の死亡が混在する場合、
    // 夜フェーズの死亡のみがゲーム終了のトリガーとなる
    const nightPhaseDeaths: Seat[] = []
    const dayPhaseDeaths: Seat[] = []
    for (const [seat, status] of this.vs.statuses.entries()) {
      if (!status.surviving && status.diedDay === maxDiedDay) {
        if (status.causeOfDeath === 'night_kill' || status.causeOfDeath === 'cursed_by_killed_nekomata' || status.causeOfDeath === 'follow_killed_hamster') {
          nightPhaseDeaths.push(seat)
        } else {
          dayPhaseDeaths.push(seat)
        }
      }
    }
    return nightPhaseDeaths.length > 0 ? nightPhaseDeaths : dayPhaseDeaths
  }

  // ゲーム結果に基づく最終死者の役職制約を initialPossibilities に適用
  // werehamster_won は analyze() で2パスに分解するためここでは処理しない
  private applyGameEndConstraints() {
    if (this.lastDeaths.length === 0) return

    if (this.vs.result === 'villager_won') {
      // 村勝利: 最終死者に狼が1以上含まれる
      // 狼候補が1席のみなら確定できる
      const wolfCandidates = this.lastDeaths.filter(seat => wolfRoles.some(r => this.initialPossibilities.hasRole(seat, r)))
      if (wolfCandidates.length === 1) {
        this.initialPossibilities.fixRole(wolfCandidates[0], wolfRoles[0])
      }
    }
    else if (this.vs.result === 'werewolf_won') {
      // 狼勝利: 飽和のトリガーとして非狼・非狐が最低1人含まれる
      // 固定席も含めて人間（非狼・非狐）が既にいれば制約は満たされている
      const hasConfirmedHuman = this.lastDeaths.some(seat => {
        const isWolfOrHamster = wolfRoles.some(r => this.initialPossibilities.hasRole(seat, r))
          || foxRoles.some(r => this.initialPossibilities.hasRole(seat, r))
        // 固定席が人間 or 狼/狐の可能性がない席がある → 制約充足
        return !isWolfOrHamster
      })
      if (!hasConfirmedHuman) {
        // 全員が狼/狐になりうる → 狼/狐候補が1席のみならその席は人間
        const unfixed = this.lastDeaths.filter(seat => !this.initialPossibilities.isFixed(seat))
        if (unfixed.length === 1) {
          for ( const r of wolfRoles ) {
            this.initialPossibilities.denyRole(unfixed[0], r)
          }
          for ( const r of foxRoles ) {
            this.initialPossibilities.denyRole(unfixed[0], r)
          }
        }
      }
    }
    // werehamster_won は analyzeHamsterWin() で処理
  }

  private isAborted(): boolean {
    return this.options.signal != null && this.options.signal[0] !== 0
  }

  private isSaturated(): boolean {
    for (let i = 1; i < this.initialPossibilities.possibilities.length; i++) {
      const initial = this.initialPossibilities.possibilities[i]
      if ((this.conclusions.possibilities[i] & initial) !== initial) return false
    }
    return true
  }

  private getStatus(seat: Seat) {
    return this.vs.statuses.get(seat)
  }

  private testRole(scenario: RoleTest) {
    const { role, selected, rest } = scenario
    if (role === 'allpass') return true
    this.debugStash.roleTests[role]++
    const result = runRoleTest(this.env, this.context, role, selected, rest)
    if ( result ) this.debugStash.roleTestPasses[role]++
    return result
  }

  private computeAliveMask(): number {
    let alive = 0
    for (const seat of this.cachedSurvivors) alive |= (1 << seat)
    return alive
  }

  analyze(): AnalyzeResult {
    resetDump()
    if (this.vs.result === 'werehamster_won' && this.lastDeaths.length > 0) {
      return this.analyzeHamsterWin()
    }
    const t0 = performance.now()
    this.runAnalysis()
    const elapsed = performance.now() - t0
    const aborted = this.isAborted()
    if (!aborted) this.conclusions.computeMaxSurvivingNv(this.computeAliveMask())
    const res: AnalyzeResult = {
      elapsed,
      batch: this.options.batch,
      id: this.options.id,
      aborted,
      result: aborted ? new Map() : this.conclusions.toStructured(),
      maxSurvivingNV: this.conclusions.maxSurvivingNV,
    }
    dumpAnalyzeResult([...this.conclusions.possibilities].map((bits, seat) => ({ seat, bits })).filter(x => x.seat > 0))
    return res
  }

  // werehamster_won を2パスに分解して分析する
  private analyzeHamsterWin(): AnalyzeResult {
    const t0 = performance.now()
    const originalPossibilities = this.initialPossibilities

    // パス1: 狼全滅（村勝利相当）→ 最終死者に狼が1以上含まれる
    this.hamsterWinPath = 'village'
    const poss1 = originalPossibilities.cloneInstance()
    let path1Valid = true
    const wolfCandidates = this.lastDeaths.filter(seat => wolfRoles.some(r => poss1.hasRole(seat, r)))
    if (wolfCandidates.length === 1) {
      path1Valid = poss1.fixRole(wolfCandidates[0], wolfRoles[0])
    } else if (wolfCandidates.length === 0) {
      path1Valid = false
    }
    if (path1Valid) {
      this.initialPossibilities = poss1
      this.runAnalysis()
    }

    if (this.isAborted()) {
      this.initialPossibilities = originalPossibilities
      this.hamsterWinPath = undefined
      return { aborted: true, result: new Map(), maxSurvivingNV: 0 }
    }

    // パス2: 飽和（狼勝利相当）→ 最終死者は非狼・非狐
    this.hamsterWinPath = 'wolf'
    const poss2 = originalPossibilities.cloneInstance()
    let path2Valid = true
    for (const seat of this.lastDeaths) {
      if (poss2.isFixed(seat)) {
        // 確定席が狼/狐なら飽和パスの前提と矛盾 → 無効
        if (wolfRoles.some(r => poss2.hasRole(seat, r)) || foxRoles.some(r => poss2.hasRole(seat, r))) {
          path2Valid = false
          break
        }
        continue
      }
      let wolfDenied = true
      for ( const r of wolfRoles ) {
        if (!poss2.denyRole(seat, r)) { wolfDenied = false; break }
      }
      if (!wolfDenied) { path2Valid = false; break }
      for ( const r of foxRoles ) {
        if (!poss2.denyRole(seat, r)) { path2Valid = false; break }
      }
      if (!path2Valid) break
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
    if (!aborted) this.conclusions.computeMaxSurvivingNv(this.computeAliveMask())
    return {
      elapsed,
      batch: this.options.batch,
      id: this.options.id,
      aborted,
      result: aborted ? new Map() : this.conclusions.toStructured(),
      maxSurvivingNV: this.conclusions.maxSurvivingNV,
    }
  }

  private runAnalysis(): void {
    // Initialize
    const maxDay = this.vs.day + 1
    this.context = {
      hamstersKilledByDivine: [],
      requireOneOf: [],
      deathChronicle: { add: new Int8Array(maxDay), sub: new Int8Array(maxDay) },
      possibilities: this.initialPossibilities.cloneInstance(),
      hamstersMaxSurvivingDay: Infinity,
      divineAliveMaxDay: -Infinity,
      divineTargetsByDay: new Map(),
    }

    this.walkRoleTests(0)
  }

  private walkRoleTests(depth: number, baseIndex: number = 0): void {
    if (depth >= this.roleTests.length) {
      if (!this.isAborted()) this.tryFinalize()
      return
    }

    const group = this.roleTests[depth]
    const stride = this.strides[depth]
    const { batches, batch } = this.options
    for (let i = 0; i < group.length; i++) {
      if (this.isAborted()) return
      if (this.isSaturated()) return

      const myIndex = baseIndex + i * stride
      // Skip subtrees that contain no paths for this batch
      if (batches > 1 && !subtreeContainsBatch(myIndex, stride, batches, batch)) continue

      const test = group[i]
      if (test.role !== 'allpass') {
        let skip = false
        for (const seat of test.selected) {
          if (!this.context.possibilities.hasRole(seat, test.role as SystemRole)) {
            skip = true
            break
          }
        }
        if (skip) continue
      }

      const snapshot = saveContext(this.context)
      const result = this.testRole(test)

      if (result) {
        this.walkRoleTests(depth + 1, myIndex)
        if (this.isAborted()) { restoreContext(this.context, snapshot); return }
      }

      restoreContext(this.context, snapshot)
    }
  }

  private tryFinalize(): void {
    if (this.isSaturated()) return
    this.debugStash.preFinalizeTests++
    // 死体数の確認
    if (!updateDeathCountConstraints(this.context, this.vs, this.nightKillsByDay, this.setup)) {
      return
    }

    if ( this.totalLiarRoles <= this.knownFakeClaimCount ) {
      for ( const seat of this.vs.statuses.keys() ) {
        if ( this.context.possibilities.isFixed(seat) ) continue
        const status = this.getStatus(seat)!
        if ( !status.claiming || status.claimingRole === villagerRole ) {
          this.context.possibilities.markAsNotLiar(seat)
        }
      }
    }
    this.debugStash.preFinalizePasses++

    // 狼ペア否定をdenyOneOfグループに変換
    // 各ペア(A,B) → 「Aからwerewolf deny」or「Bからwerewolf deny」の2択
    const denyOneOf: { seat: Seat, role: SystemRole }[][] = []
    for ( const [seatA, seatB] of this.options.wolfPairDenyals ) {
      const aCanBeWolf = wolfRoles.some(r => this.context.possibilities.hasRole(seatA, r))
      const bCanBeWolf = wolfRoles.some(r => this.context.possibilities.hasRole(seatB, r))
      // 両方がwolf候補でなければ制約は既に満たされている
      if ( !aCanBeWolf || !bCanBeWolf ) continue
      denyOneOf.push([
        { seat: seatA, role: wolfRoles[0] },
        { seat: seatB, role: wolfRoles[0] },
      ])
    }

    if ( this.context.requireOneOf.length > 0 || denyOneOf.length > 0 ) {
      const snapshot = saveContext(this.context)
      // requireOneOf（fixRole）とdenyOneOf（denyRole）の全組み合わせを列挙
      const fixGroups = this.context.requireOneOf
      const denyGroups = denyOneOf
      const fixVariations = fixGroups.length > 0 ? [...generateCombinations(fixGroups)] : [null]
      const denyVariations = denyGroups.length > 0 ? [...generateCombinations(denyGroups)] : [null]

      VARIATION:
      for ( const fixVariation of fixVariations ) {
        for ( const denyVariation of denyVariations ) {
          if (this.isAborted()) break VARIATION
          restoreContext(this.context, snapshot)
          if ( fixVariation ) {
            for ( const {seat, role} of fixVariation ) {
              if ( ! this.context.possibilities.fixRole(seat, role) ) {
                continue VARIATION
              }
            }
          }
          if ( denyVariation ) {
            for ( const {seat, role} of denyVariation ) {
              this.context.possibilities.denyRole(seat, role)
              if ( ! this.context.possibilities.fix(seat) ) {
                continue VARIATION
              }
            }
          }
          this.finalize()
        }
      }
    }
    else {
      this.finalize()
    }
  }

  private finalize() {
    runFinalize(this.context, this.vs, this.setup, this.conclusions, this.debugStash, this.hamsterWinPath, this.cachedSurvivors, this.cachedSurvivingMap)
  }

  analyzeSafe(): AnalyzeResult {
    try {
      return this.analyze()
    }
    catch (e) {
      return { error: e instanceof Error ? e : new Error(String(e)), result: new Map(), maxSurvivingNV: 0 }
    }
  }
}
