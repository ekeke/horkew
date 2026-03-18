// @ts-nocheck
// TODO: Fix type errors inherited from reference implementation
import type { CauseOfDeath, EnumSpecies, VillageStatus, SeatStatus, SystemRole } from '../types/index.ts'
import { Possibilities } from './possibilities.ts'

/*
組み合わせ生成器。０～M-1の整数からN個の数値の組み合わせを生成する。
パフォーマンスはベストではない。combination(6,3) で250ops/ms程度
ビット演算を使った実装などに代えれば5倍くらい早くなる。

  => 高速化バージョンを試したが、問題となるような大人数村ではこの部分はクリティカルではなかった
  => そのため、可読性を重視してこの実装のママにする
*/

// M個の整数からN個の数値の組み合わせを生成するジェネレーター
function* combGen(M: number, N: number, Base: number = 0): Generator<number[]> {
  if (N === 1) {
    for (let i = Base; i < M; i++) {
      yield [i]
    }
    return
  }
  for (let i = Base; i < M; i++) {
    for (let comb of combGen(M, N - 1, i + 1)) {
      yield [i, ...comb]
    }
  }
}

// 配列　arr から、N個の要素を選んで、その組み合わせと残りの要素を返す
function* combinationFromArray<T>(arr: T[], N: number) {
  for (let comb of combGen(arr.length, N)) {
    const selected = comb.map(i => arr[i])
    const rest = arr.filter((_, i) => !comb.includes(i))
    yield [selected, rest]
  }
}

// 配列 arr から、indexesToSelect で指定されたインデックスの要素を選んで、その組み合わせと残りの要素を返す
function selectFromArray<T>(arr: T[], indexesToSelect: number[]) {
  const indexSet: Set<number> = new Set();
  // 指定されたインデックスをMapに追加
  for (const idx of indexesToSelect) {
    indexSet.add(idx)
  }

  const selected: T[] = []
  const remaining: T[] = []

  arr.forEach((item, index) => {
    if (indexSet.has(index)) {
      selected.push(item)
    } else {
      remaining.push(item)
    }
  })
  return [selected, remaining]
}

// 配列 arr から、N個、N-1個、...の要素を選んで、その組み合わせと残りの要素を返す
export function* selectCombinationsFromArray<T>(arr: T[], min: number, max: number) {
  for (let i = min; i <= Math.min(max, arr.length); i++) {
    for (let comb of combGen(arr.length, i)) {
      yield selectFromArray(arr, comb)
    }
  }
}

// 与えられた配列から一つの要素を返すジェネレータ
// 戻り値は [選択された要素、選択済みの要素の配列、未選択の要素の配列]のタプル
// 動的に組み合わせを生成するのに使う
// 元の並び順序は維持されないので注意
export function* selectOne<T>(arr: T[], additionalLeft: T[] = []): Generator<[T, T[], T[]], void, undefined> {
  if ( arr.length === 0 ) return
  const left: T[] = additionalLeft
  const right: T[] = [...arr]
  while (right.length) {
    const item: T = right.pop()
    yield [item, left, right]
    left.push(item)
  }
  return
}

// ジェネレータ使わない板、却って遅い
export function _selectOne<T>(arr: T[], additionalLeft: T[] = []): IterableIterator<[T, T[], T[]]> {
  const left: T[] = additionalLeft
  const right: T[] = [...arr]
  let current: T
  return {
    [Symbol.iterator](): IterableIterator<[T, T[], T[]]> {
      return this;
    },
    next(): IteratorResult<[T, T[], T[]]> {

      if (right.length === 0) {
        return { done: true, value: undefined };
      }
      if ( current ) {
        left.push(current)
      }
      current = right.pop()
      return { done: false, value: [current, left, right] }
    }
  };
}

function* generateUniqueCombinationsFromMap(counts, size) {
  const uniqueElements = Array.from(counts.keys());
  const path = [];

  function* backtrack(start, path) {
      if (path.length === size) {
          yield Array.from(path);
          return;
      }
      for (let i = start; i < uniqueElements.length; i++) {
          const currentElement = uniqueElements[i];
          const currentCount = counts.get(currentElement);

          // Only add the element if there are still occurrences left
          if (currentCount > 0) {
              path.push(currentElement);
              counts.set(currentElement, currentCount - 1);

              yield* backtrack(i, path);

              // Undo the move
              path.pop();
              counts.set(currentElement, currentCount);
          }
      }
  }

  yield* backtrack(0, path);
}

function* generateCombinations<T>(arrays: T[][]): Generator<T[], void, undefined> {
  // 再帰的なヘルパー関数を定義
  function* combine(index: number, current: T[]): Generator<T[], void, undefined> {
      if (index === arrays.length) {
          yield current;
          return;
      }

      for (const item of arrays[index]) {
          yield* combine(index + 1, current.concat(item));
      }
  }

  // 初期インデックスと空の組み合わせリストから開始
  yield* combine(0, []);
}

/**
 * バックトラックを使った組み合わせ生成器
 * @param matrix 要素の配列の配列
 */
export function* backtrackForMatrix<T, U>(matrix: T[][], context: U): Generator<{item: T, context: U, depth: number, index: number, last: boolean }, void, [boolean, U]> {
  let stack: { index: number, subIndex: number, context: U }[] = [{ index: 0, subIndex: 0, context: context }]
  if (matrix.length === 0) return
  while (stack.length > 0) {
    const top = stack[stack.length - 1]
    if (top.subIndex >= matrix[top.index].length) {
      stack.pop() // No more tests in this group, backtrack
      continue
    }
    const test = matrix[top.index][top.subIndex]
    const payload = {item: test, depth: top.index, index: top.subIndex, context: top.context, finished: false, last: top.index === matrix.length - 1}
    top.subIndex++ // Prepare next test in the current group
    const [result, newContext] = yield payload
    if (result) {
      if (top.index + 1 < matrix.length) {
        // Move to the next group
        stack.push({ index: top.index + 1, subIndex: 0, context: newContext })
      }
    }
  }
}

function combinationWithReplacementFromSet<T>(set: Set<T>, k: number, limits: Map<T, number>): T[][] {
  const result: T[][] = [];
  const elements = Array.from(set);
  const counts = new Map<T, number>();

  function backtrack(path: T[]): void {
      if (path.length === k) {
          result.push([...path]);
          return;
      }
      for (let element of elements) {
          const currentCount = counts.get(element) ?? 0;
          if (currentCount < (limits.get(element) ?? Number.MAX_SAFE_INTEGER)) {
              counts.set(element, currentCount + 1);
              path.push(element);
              backtrack(path);
              path.pop();
              counts.set(element, currentCount);
          }
      }
  }

  backtrack([]);
  return result;
}


type RolePossibility = number

const RoleSignatureBits: {[role in SystemRole]: number} = {
  villager:    0b00000000001,
  seer:        0b00000000010,
  medium:      0b00000000100,
  bodyguard:   0b00000001000,
  mason:       0b00000010000,
  nekomata:    0b00000100000,
  werewolf:    0b00001000000,
  possessed:   0b00010000000,
  fanatic:     0b00100000000,
  werehamster: 0b01000000000,
  immoralist:  0b10000000000,
}

function popCount(x: number): number {
  const a = x - (x >>> 1 & 0x55555555);
  const b = (a & 0x33333333) + (a >>> 2 & 0x33333333);
  const c = (b + (b >>> 4)) & 0x0f0f0f0f;
  const d = c + (c >>> 8);
  const y = d + (d >>> 16);
  return y & 0xff;
}

// debug用ユーティリティー。重複ログを出力しない
const _logged = new Map<string, 1>()
function logUnique(...any) {
  const str = JSON.stringify(any)
  if (_logged.has(str)) return
  _logged.set(str, 1)
  console.log(...any)
}

type Seat = number
type Day = number

const replacer = (k, v) => { // key, valueを受け取る
  if (v instanceof Map) {    // valueがMapのインスタンスだったら……
    return {                 // 独自に定義したオブジェクトに変換して返す
      dataType: "Map",
      value: [...v]          // MapはIterable。Array.from(v)もOK
    }
  }
  else if (v instanceof Set) {    // valueがMapのインスタンスだったら……
    return {                 // 独自に定義したオブジェクトに変換して返す
      dataType: "Set",
      value: [...v]          // MapはIterable。Array.from(v)もOK
    }
  }
  return v                   // それ以外は標準のまま返す(これをしないと消える)
}
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

const LiarRoles = ['werewolf', 'werehamster', 'immoralist', 'possessed', 'fanatic']
const WhiteEnemies = ['possessed', 'fanatic', 'immoralist']
const HumanRoles = ['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'possessed', 'fanatic', 'immoralist', 'werehamster']

type RoleTest = {
  role: SystemRole | 'allpass',
  selected: Seat[],
  rest: Seat[],

}

type DeathCounts = {
  add: number,
  sub: number
}

type AnalyzeContext = {
  possibilities: Possibilities
  needSeerAtDay?: number
  additionalLiars: number
  hamstersKilledBySeer: { day: number, seat: Seat }[]
  hamstersMaxSurvivingDay: number
  requireOneOf: { seat: Seat, role: SystemRole }[][]
  deathChronicle: Map<Day, DeathCounts>
}

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

    // 露呈人外数の管理の準備
    let numLiars = 0
    this.setOfRoles = new Set<SystemRole>(setup.keys())
    this.setOfHuman = new Set(HumanRoles as SystemRole[]).intersection(this.setOfRoles)
    this.setOfLiar = new Set(LiarRoles as SystemRole[]).intersection(this.setOfRoles)

    const rolesInTestPlanning
      = ['nekomata', 'mason', 'seer', 'medium', 'bodyguard'] as const
    type RoleInTestPlanning = typeof rolesInTestPlanning[number]

    const claims: {[role in RoleInTestPlanning]: Seat[]}
      = Object.fromEntries(rolesInTestPlanning.map(role => [role, []]))as {[role in RoleInTestPlanning]: Seat[]}
    const poseAsCount: {[role in RoleInTestPlanning]: number}
      = Object.fromEntries(rolesInTestPlanning.map(role => [role, 0])) as {[role in RoleInTestPlanning]: number}
    const minClaimDay: {[role in RoleInTestPlanning]: number}
      = Object.fromEntries(rolesInTestPlanning.map(role => [role, Infinity])) as {[role in RoleInTestPlanning]: number}

    for ( const [seat, status] of village.statuses.entries() ) {
      // XXX: I'm not good at TS... is this `as` needed?
      if ( !rolesInTestPlanning.includes(status.claimingRole as RoleInTestPlanning) ) continue
      if ( status.claiming ) {
        claims[status.claimingRole].push(seat)
        const claimDay = status.claimedAt || Infinity
        minClaimDay[status.claimingRole] = Math.min(minClaimDay[status.claimingRole], claimDay)
      }
    }

    let poseAsCountTotal = 0
    for ( const [role, count] of setup.entries() ) {
      if ( LiarRoles.includes(role) ) {
        if ( this.options.batch === 0)console.log('liar', role, count, numLiars)
        numLiars += count
      }
      if ( role === 'seer' || role === 'medium' || role === 'bodyguard' || role === 'mason' || role === 'nekomata' ) {
        if ( claims[role].length <= 0 ) continue
        const c = Math.max(0, claims[role].length - count)
        poseAsCount[role] = c
        poseAsCountTotal += c
      }
    }

    this.maxLiars = numLiars
    this.numLiars = poseAsCountTotal

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
    //console.log('multiple victims', multipleVictims)
    // プランニング

    // 狐の処理は面倒なので、最初に全員分のプランを作成しておく
    if (this.setup.has('werehamster') && this.setup.get('werehamster') > 0 ) {
      const hamsterTests: RoleTest[] = []
      const allSeats = Array.from(village.statuses.keys())
      const num = this.setup.get('werehamster')
      const iter = selectCombinationsFromArray(allSeats, num, num)
      for ( const [selected, rest] of iter ) {
        hamsterTests.push({ role: 'werehamster', selected, rest })
      }
      this.roleTests.push(hamsterTests)
    }

    for ( const role of rolesInTestPlanning ) {
      if ( 'nekomata' !== role && claims[role].length === 0 ) continue
      if (claims[role].length === 0 && multipleVictims.length === 0) continue
      const testsOfRole: RoleTest[] = []
      const num = setup.get(role) || 0
      if ( !num ) continue

      // 役職のCO数に基づいてプランを作成する。
      // COのタイミングより前に襲撃死した人数の分だけ乗っ取りの可能性を追加する
      // XXX: バカ正直に全員追加しない方法はないか？
      const unrevealedSeats = []
      for ( const [seat, status] of village.statuses.entries() ) {
        if (
          // 同じ役職の最初のCOがある日より前に、襲撃で死亡した人を候補に加える
          // TODO: オプションから調整できるようにする
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
      const iter = selectCombinationsFromArray([...new Set([...claims[role], ...unrevealedSeats])], num, num)
      for ( const [selected, rest] of iter ) {
        testsOfRole.push({ role, selected, rest })
      }

      this.roleTests.push(testsOfRole)
    }
    this.roleTests = this.roleTests.filter( tests => tests.length > 0 )
    if ( this.roleTests.length === 0 ) {
      this.roleTests.push([{ role: 'allpass', selected: [], rest: []}])
    }

    console.log(this.maxLiars, this.numLiars, this.roleTests, this.initialPossibilities.toObj())
  }

  getStatus(seat: Seat) {
    return this.vs.statuses.get(seat)
  }

  testRole(scenario: RoleTest) {
    const { role, selected, rest } = scenario
    let result = false
    switch (role) {
      case 'allpass':
        return true
      case 'werehamster':
        this.debugStash.werehamsterTests++
        result = this.testHamster(selected, rest)
        if ( result ) this.debugStash.werehamsterTestPasses++
        return result
      case 'seer':
        this.debugStash.seerTests++

        result = this.testSeer(selected, rest)
        //console.log({result, pos: this.context.possibilities.toObj()})
        if ( result ) this.debugStash.seerTestPasses++
        return result
      case 'medium':
        this.debugStash.mediumTests++

        result = this.testMedium(selected, rest)
        if ( result ) this.debugStash.mediumTestPasses++
        return result
      case 'bodyguard':
        this.debugStash.bodyguardTests++

        result = this.testBodyguard(selected, rest)
        if ( result ) this.debugStash.bodyguardTestPasses++
        return result
      case 'mason':
        this.debugStash.masonTests++

        result = this.testMason(selected, rest)
        if ( result ) this.debugStash.masonTestPasses++
        return result
      case 'nekomata':
        this.debugStash.nekomataTests++
        result = this.testNekomata(selected, rest)
        if ( result ) this.debugStash.nekomataTestPasses++
        return result
    }
    throw new Error('unknown role')
  }

  testHamster(selected: Seat[], rest: Seat[]) {
    const hamsters = new Set()
    let lastHamsterDiedAt = -Infinity
    let lastHamsterDiedBy: CauseOfDeath | undefined
    let livingHamsters = 0
    let seerKilledHamsterAt = -Infinity
    for ( const seat of selected ) {
      const self = this.getStatus(seat)
      hamsters.add(seat)
      if ( !this.context.possibilities.fixRole(seat,'werehamster') ) {
        return false
      }
      const status = this.getStatus(seat)
      if ( status.surviving ) {
        livingHamsters++
      }
      else {
        if ( status.causeOfDeath === 'night_kill' ) {

          const deathChronicle = this.context.deathChronicle.get(self.diedDay)
          if ( !deathChronicle ) {
            this.context.deathChronicle.set(self.diedDay, { add: 1, sub: 0 })
          }
          else {
            deathChronicle.add += 1
          }

          this.context.hamstersKilledBySeer.push({ day: status.diedDay, seat })
          if ( seerKilledHamsterAt < status.diedDay ) {
            seerKilledHamsterAt = status.diedDay
          }
        }
        if ( lastHamsterDiedAt < status.diedDay) {
          lastHamsterDiedAt = status.diedDay
          lastHamsterDiedBy = status.causeOfDeath
        }
      }
    }
    if ( 0 <= seerKilledHamsterAt ) {
      this.context.needSeerAtDay = seerKilledHamsterAt
    }

    if ( this.lastHamsterMustDieAt != null ) {
      if (lastHamsterDiedAt !== this.lastHamsterMustDieAt ) return false
      if (lastHamsterDiedBy !== this.lastHamsterMustDiedBy ) return false
    }
    for ( const seat of rest ) {
      this.context.possibilities.denyRole(seat, 'werehamster')
      if ( !livingHamsters ) {
        const status = this.getStatus(seat)
        if ( status.surviving || lastHamsterDiedAt < status.diedDay ) {
          this.context.possibilities.denyRole(seat, 'immoralist')
        }
      }
    }
    if ( livingHamsters ) {
      this.context.hamstersMaxSurvivingDay = Infinity
    }
    else {
      this.context.hamstersMaxSurvivingDay = lastHamsterDiedAt
    }
    return true
  }

  testSeer(selected: Seat[], rest: Seat[]) {
    const seers = new Set()
    let maxSurviving = -Infinity
    const seerTargets: Map<Day, (Seat | 'unknown')[]> = new Map()
    let unresolvedHamsterDeath: Map<number, number> = new Map()
    if ( this.context.hamstersKilledBySeer.length > 0 ) {
      for ( const { day } of this.context.hamstersKilledBySeer ) {
        const current = unresolvedHamsterDeath.get(day) || 0
        unresolvedHamsterDeath.set(day, current + 1)
      }
    }

    for ( const seat of selected ) {
      seers.add(seat)
      if ( !this.context.possibilities.fixRole(seat, 'seer') ) {
        return false
      }

      const self = this.getStatus(seat)

      if (!self.claiming) {
        for ( const [day, count] of unresolvedHamsterDeath.entries() ) {
          if ( self.surviving || self.diedDay >= day ) {
            unresolvedHamsterDeath.set(day, count - 1)
          }
        }
      }
      if (self.surviving) maxSurviving = Infinity
      else if (maxSurviving < self.diedDay) maxSurviving = self.diedDay

      // Populate seerTargets from divination assertions (insertion order = chronological)
      let assertionDay = this.options.dayCountFrom
      for (const [targetSeat] of self.assertions) {
        seerTargets.set(assertionDay, [...(seerTargets.get(assertionDay) || []), targetSeat])
        assertionDay++
      }
      // If seer died at night, they acted that night but result is unreported
      if (!self.surviving && self.causeOfDeath === 'night_kill') {
        seerTargets.set(self.diedDay, [...(seerTargets.get(self.diedDay) || []), 'unknown'])
      }
      // Add 'unknown' only for genuinely unreported nights beyond known assertions
      const maxActiveDay = self.surviving ? this.vs.day - 1 : (self.causeOfDeath === 'night_kill' ? self.diedDay : self.diedDay - 1)
      for (let d = assertionDay; d <= maxActiveDay; d++) {
        if (!seerTargets.has(d)) {
          seerTargets.set(d, ['unknown'])
        }
      }
      for (const [targetSeat, species] of self.assertions) {
        const target = this.context.possibilities.get(targetSeat)
        if ( species === 'wolf' ) {
          if ( ! this.context.possibilities.fixRole(targetSeat,'werewolf') ) {
            return false
          }
          const targetStatus = this.getStatus(targetSeat)
          if ( !targetStatus.surviving && targetStatus.causeOfDeath === 'night_kill' ) {
            const nightKillsAtDay = this.nightKillsByDay.get(targetStatus.diedDay)
            if ( nightKillsAtDay && nightKillsAtDay.length <= 1 ) {
              return false
            }
          }
        }
        else if ( this.context.possibilities.isActualRole(targetSeat, 'werehamster') ) {
          const targetStatus = this.getStatus(targetSeat)
          if ( targetStatus.surviving ) return false
          const targetsOnDeathDay = seerTargets.get(targetStatus.diedDay) || []
          if ( !targetsOnDeathDay.includes(targetSeat) && !targetsOnDeathDay.includes('unknown') ) return false
        }
        else {
          if ( ! this.context.possibilities.markAsHuman(targetSeat) ) return false
        }
      }
    }

    for ( const { day, seat } of this.context.hamstersKilledBySeer ) {
      for ( const [seerDay, targets] of seerTargets.entries() ) {
        for ( const target of targets ) {
          if ( day === seerDay && seat === target ) {
            unresolvedHamsterDeath.set(day, (unresolvedHamsterDeath.get(day) || 1) - 1)
          }
          else if ( day === seerDay && target === 'unknown' ) {
            unresolvedHamsterDeath.set(day, (unresolvedHamsterDeath.get(day) || 1) - 1)
          }
        }
      }
    }
    for ( const count of unresolvedHamsterDeath.values() ) {
      if ( count > 0 ) return false
    }

    if ( this.context.needSeerAtDay != null && maxSurviving < this.context.needSeerAtDay )
      return false

    for ( const seat of rest ) {
      const status = this.getStatus(seat)
      if ( !status.claiming ) {
        if ( !this.context.possibilities.denyRole(seat, 'seer') ) {
          return false
        }
        continue
      }
      else {
        if (!this.context.possibilities.markAsLiar(seat)) {
          return false
        }
      }
    }

    for ( const seat of this.vs.statuses.keys() ) {
      if ( seers.has(seat) ) continue
      if (!this.context.possibilities.denyRole(seat, 'seer')) {
        return false
      }
    }
    return true
  }

  testMedium(selected: Seat[], rest: Seat[]) {
    const mediums = new Set()
//    console.log('testing medium', selected, rest)
    for ( const seat of selected ) {
      mediums.add(seat)
      if ( !this.context.possibilities.fixRole(seat, 'medium') ) {
//        console.log('failed to fix medium', seat)
        return false
      }
      const self = this.getStatus(seat)

      for (const [targetSeat, species] of self.assertions) {
        const target = this.context.possibilities.get(targetSeat)
        if ( species === 'wolf' ) {
          if ( ! this.context.possibilities.fixRole(targetSeat, 'werewolf') ) {
  //          console.log('failed to fix werewolf',seat, targetSeat)
            return false
          }
        }
        else {
          if ( ! this.context.possibilities.markAsHuman(targetSeat) ) {
            return false
          }
        }
      }
    }
    for ( const seat of rest ) {
      const status = this.getStatus(seat)
      if ( !status.claiming ) {
        if (! this.context.possibilities.denyRole(seat, 'medium') ) {
          return false
        }
        continue
      }
      else {
        if ( ! this.context.possibilities.markAsLiar(seat) ) {
          return false
        }
      }
    }
    for ( const seat of this.vs.statuses.keys() ) {
      if ( mediums.has(seat) ) continue
      if (!this.context.possibilities.denyRole(seat, 'medium')) {
//        console.log('failed to deny medium', seat)
        return false
      }
    }

    return true
  }

  testBodyguard(selected: Seat[], rest: Seat[]) {
    const bodyguards = new Set()
    for ( const seat of selected ) {
      const self = this.getStatus(seat)
      bodyguards.add(seat)
      if ( !this.context.possibilities.fixRole(seat, 'bodyguard') ) {
        return false
      }
    }

    for ( const seat of rest ) {
      const status = this.getStatus(seat)
      if ( !status.claiming ) {
        if (!this.context.possibilities.denyRole(seat, 'bodyguard')) {
          return false
        }
        continue
      }
      else {
        if (!this.context.possibilities.markAsLiar(seat)) {
          return false
        }
      }
    }
    for ( const seat of this.vs.statuses.keys() ) {
      if ( bodyguards.has(seat) ) continue
      if (!this.context.possibilities.denyRole(seat, 'bodyguard')) {
        return false
      }
    }
    return true
  }

  testMason(selected: Seat[], rest: Seat[]) {
    const masons = new Set()
    for ( const seat of selected ) {
      masons.add(seat)
      if ( ! this.context.possibilities.fixRole(seat, 'mason') ) {
        return false
      }
      const self = this.getStatus(seat)

      for (const [targetSeat, species] of self.assertions) {
        const target = this.context.possibilities.get(targetSeat)
        if ( species === 'wolf' ) {
          // 仕様です。共有は相方に人間とアサーションします。
          return false
        }
        else {
          if ( ! this.context.possibilities.fixRole(targetSeat, 'mason') ) {
            return false
          }
        }
      }
    }
    for ( const seat of rest ) {
      const status = this.getStatus(seat)
      if ( !status.claiming ) continue
      if ( ! this.context.possibilities.markAsLiar(seat) ) {
        return false
      }
    }
    for ( const seat of this.vs.statuses.keys() ) {
      if ( masons.has(seat) ) continue
      if ( ! this.context.possibilities.denyRole(seat, 'mason') ) {
        return false
      }
    }
    return true
  }

  testNekomata(selected: Seat[], rest: Seat[]) {
    const nekomatas = new Set()
    const possibleCursed: Seat[] = []
    for ( const seat of selected ) {
      nekomatas.add(seat)
      if ( ! this.context.possibilities.fixRole(seat, 'nekomata') ) {
        return false
      }
      const self = this.getStatus(seat)
      if (!self.claiming) {
        this.context.additionalLiars++
        if ( this.maxLiars < this.context.additionalLiars + this.numLiars ) {
          return false
        }
      }
      if ( !self.surviving ) {
        const deathChronicle = this.context.deathChronicle.get(self.diedDay)
        if ( self.causeOfDeath === 'night_kill' ) {
          if ( !deathChronicle ) {
            this.context.deathChronicle.set(self.diedDay, { add: 1, sub: 0 })
          }
          else {
            deathChronicle.add += 1
          }
        }
        let ok = false
        for ( const [targetSeat, targetStatus] of this.vs.statuses.entries() ) {
          if ( targetStatus.surviving ) continue
          if (targetStatus.diedDay !== self.diedDay) continue
          if ( targetStatus.causeOfDeath === 'execution' ) continue
          if ( targetStatus.causeOfDeath === 'follow_executed_hamster' || targetStatus.causeOfDeath === 'follow_killed_hamster' ) continue
          if (targetSeat === seat) continue
          // 別の死体がある
          if ( self.causeOfDeath === 'execution' ) {
            if ( targetStatus.causeOfDeath === 'cursed_by_executed_nekomata' ) {
              ok = true
              break
            }
          }
          else {
            ok = true
            if ( targetStatus.causeOfDeath === 'cursed_by_killed_nekomata' ) {
              const targetPossible = this.context.possibilities.get(targetSeat)
              if ( ! this.context.possibilities.fixRole(targetSeat, 'werewolf') ) {
                return false
              }
            }
            possibleCursed.push(targetSeat)
          }
        }
        if ( !ok ) return false
      }
    }
    if ( possibleCursed.length ) {
      this.context.requireOneOf.push(
        possibleCursed.map(targetSeat => ({ seat: targetSeat, role: 'werewolf' }))
      )
    }

    for ( const seat of rest ) {
      const status = this.getStatus(seat)
      if ( !status.claiming || status.claimingRole !== 'nekomata' ) {
        if ( !this.context.possibilities.denyRole(seat, 'nekomata') ) {
          return false
        }
        continue
      }
      else {
        if ( ! this.context.possibilities.markAsLiar(seat) ) {
          return false
        }
      }
    }
    for ( const seat of this.vs.statuses.keys() ) {
      if ( nekomatas.has(seat) ) continue
      if ( ! this.context.possibilities.denyRole(seat, 'nekomata') ) {
        return false
      }
    }
    return true
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
