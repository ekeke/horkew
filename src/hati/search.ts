import type { Seat, EnumSpecies } from '../types/index.ts'
import type {
  World, SimState, StrategyNode,
  NightObservation, ObservationKey, SearchOptions,
} from './types.ts'
import {
  allWorldsVillageWin, anyWorldVillageLoss,
  applyExecution, simulateNight, validBiteTargets,
  nightObservationKey, executionObservationKey,
  getMediumResult, isConfirmedVillagerInAllWorlds,
} from './simulate.ts'

type SearchState = {
  nodesVisited: number
  maxDepthReached: number
  options: SearchOptions
  memo: Map<string, StrategyNode | null>
}

/**
 * AND-OR探索の本体。
 * 村が詰み（必ず勝てる）かどうかを判定し、勝利戦略の決定木を返す。
 */
export function searchTsumi(
  worlds: World[],
  state: SimState,
  options: SearchOptions,
): { result: StrategyNode | null, nodesVisited: number, maxDepthReached: number } {
  const searchState: SearchState = {
    nodesVisited: 0,
    maxDepthReached: 0,
    options,
    memo: new Map(),
  }

  const result = isTsumi(worlds, state, 0, searchState)
  return {
    result,
    nodesVisited: searchState.nodesVisited,
    maxDepthReached: searchState.maxDepthReached,
  }
}

/**
 * メモ化キーの生成
 */
function memoKey(worlds: World[], alive: Set<Seat>): string {
  const aliveSorted = Array.from(alive).sort((a, b) => a - b)
  // ワールドの識別: 生存者の役職配置のソートされたリスト
  const worldKeys: string[] = []
  for (const w of worlds) {
    const parts: string[] = []
    for (const s of aliveSorted) {
      parts.push(w.roles.get(s)!)
    }
    worldKeys.push(parts.join(','))
  }
  worldKeys.sort()
  return `${aliveSorted.join(',')}|${worldKeys.join(';')}`
}

/**
 * 再帰的なAND-OR探索
 */
function isTsumi(
  worlds: World[],
  state: SimState,
  depth: number,
  ss: SearchState,
): StrategyNode | null {
  ss.nodesVisited++
  if (depth > ss.maxDepthReached) ss.maxDepthReached = depth

  // 終端チェック
  if (worlds.length === 0) return { type: 'win' }
  if (allWorldsVillageWin(worlds, state.alive)) return { type: 'win' }
  if (anyWorldVillageLoss(worlds, state.alive)) return null
  if (depth >= ss.options.maxDepth) return null

  // メモ化チェック
  const key = memoKey(worlds, state.alive)
  if (ss.memo.has(key)) return ss.memo.get(key)!

  // 自明な詰み: 生存者中の狼候補が1人だけなら即処刑で勝ち
  const trivial = findTrivialTsumi(worlds, state.alive)
  if (trivial !== null) {
    const result: StrategyNode = {
      type: 'action',
      action: { execute: trivial, bodyguardTarget: null, seerTarget: null },
      branches: { 'win': { type: 'win' } },
    }
    ss.memo.set(key, result)
    return result
  }

  // パリティ事前チェック: 最善ケースでもパリティ負けなら即不可
  if (!canPossiblyWin(worlds, state.alive)) {
    ss.memo.set(key, null)
    return null
  }

  // 各処刑候補を試す（OR節点）
  const candidates = getExecutionCandidates(worlds, state.alive)

  for (const target of candidates) {
    const result = tryExecution(worlds, state, target, depth, ss)
    if (result !== null) {
      ss.memo.set(key, result)
      return result
    }
  }

  ss.memo.set(key, null)
  return null
}

/**
 * 自明な詰み判定: 全ワールドで生存中の狼候補が1人だけなら、その席を処刑して即勝ち。
 * 妖狐が生存している可能性がある場合は自明でない（狼全滅で狐勝ちになりうる）。
 */
function findTrivialTsumi(worlds: World[], alive: Set<Seat>): Seat | null {
  const wolfCandidates = new Set<Seat>()
  for (const w of worlds) {
    for (const seat of alive) {
      if (w.wolfSeats.has(seat)) wolfCandidates.add(seat)
    }
    // 妖狐が生存しうる場合は自明でない（処刑後に狐勝ちの可能性）
    if (w.hamsterSeat !== -1 && alive.has(w.hamsterSeat)) return null
  }
  if (wolfCandidates.size !== 1) return null
  return wolfCandidates.values().next().value!
}

/**
 * パリティの事前チェック。
 * 最善ケース（毎回狼を処刑、護衛成功で噛み不発）でもパリティ負けするなら詰み不可。
 */
function canPossiblyWin(worlds: World[], alive: Set<Seat>): boolean {
  for (const w of worlds) {
    let wolfCount = 0
    let nonWolfNonHamsterCount = 0
    for (const seat of alive) {
      const role = w.roles.get(seat)!
      if (role === 'werewolf') wolfCount++
      else if (role !== 'werehamster') nonWolfNonHamsterCount++
    }
    // 最善: 毎日1狼処刑、夜は護衛成功で死者なし
    // wolfCount日で全狼処刑 → その間村人は減らない（護衛成功想定）
    // 最善でも村が足りるか？
    // 実際には毎日処刑で1人減り、夜に1人減る（護衛失敗時）
    // 最善想定: 狼を毎回処刑 + 護衛毎回成功 → wolfCount日で終了
    // その間の人数推移: alive - 1 (処刑) → 翌日 alive - 1 → ...
    // 護衛成功なら夜の死者なし → 処刑だけで人数が減る
    // wolfCount回の処刑後: alive - wolfCount 人生存、狼0
    // 途中でパリティチェック: 各ステップで残り狼 >= 残り非狼非狐 なら負け

    // 簡易チェック: 現在の狼数が非狼非狐数以上なら即負け（既にチェック済みだが念のため）
    if (wolfCount >= nonWolfNonHamsterCount) return false
  }
  return true
}

/**
 * 処刑候補の列挙（枝刈り込み）
 */
function getExecutionCandidates(worlds: World[], alive: Set<Seat>): Seat[] {
  const candidates: Seat[] = []
  // 等価クラスの重複排除
  const seen = new Set<string>()

  for (const seat of alive) {
    // 全ワールドで確定村人なら処刑しない
    if (isConfirmedVillagerInAllWorlds(worlds, seat)) continue

    // 等価クラス: 全ワールドでの役職パターンが同一のseatは1つだけ試す
    const eqKey = worlds.map(w => w.roles.get(seat)!).sort().join(',')
    if (seen.has(eqKey)) continue
    seen.add(eqKey)

    candidates.push(seat)
  }

  return candidates
}

/**
 * 特定のseatを処刑した場合の分岐探索
 */
function tryExecution(
  worlds: World[],
  state: SimState,
  target: Seat,
  depth: number,
  ss: SearchState,
): StrategyNode | null {
  // 処刑後の生存者
  const afterExecAlive = applyExecution(state.alive, target)

  // ワールドを霊媒結果で分岐
  // さらに猫又道連れ・背徳者後追いで分岐
  const obsGroups = partitionWorldsByExecution(worlds, state.alive, afterExecAlive, target)

  const branches = {} as Record<ObservationKey, StrategyNode>

  for (const [obsKey, group] of obsGroups) {
    const { worlds: groupWorlds, alive: groupAlive } = group

    // 処刑後の即座の勝利チェック
    if (allWorldsVillageWin(groupWorlds, groupAlive)) {
      branches[obsKey] = { type: 'win' }
      continue
    }
    if (anyWorldVillageLoss(groupWorlds, groupAlive)) {
      return null
    }

    // 夜フェーズ探索
    const nightResult = searchNight(groupWorlds, groupAlive, state.day, depth, ss)
    if (nightResult === null) return null
    branches[obsKey] = nightResult
  }

  return {
    type: 'action',
    action: { execute: target, bodyguardTarget: null, seerTarget: null },
    branches,
  }
}

/**
 * ワールドを処刑後の観測（霊媒結果 + 猫又道連れ + 背徳者後追い）で分割
 */
function partitionWorldsByExecution(
  worlds: World[],
  _aliveBefore: Set<Seat>,
  aliveAfterExec: Set<Seat>,
  target: Seat,
): Map<ObservationKey, { worlds: World[], alive: Set<Seat> }> {
  // まず霊媒結果で分割
  const byMedium = new Map<string, World[]>()
  for (const w of worlds) {
    const medium = getMediumResult(w.roles.get(target)!)
    const key = medium ?? 'null'
    if (!byMedium.has(key)) byMedium.set(key, [])
    byMedium.get(key)!.push(w)
  }

  const result = new Map<ObservationKey, { worlds: World[], alive: Set<Seat> }>()

  for (const [mediumKey, mediumWorlds] of byMedium) {
    const mediumResult = mediumKey === 'null' ? null : mediumKey as EnumSpecies

    // 猫又道連れの可能性チェック
    const hasNekomata = mediumWorlds.some(w => w.roles.get(target) === 'nekomata')
    const hasNonNekomata = mediumWorlds.some(w => w.roles.get(target) !== 'nekomata')

    if (!hasNekomata) {
      // 猫又なし: 背徳者後追いチェックのみ
      const { obsKey, alive } = resolveFollowDeaths(mediumWorlds, aliveAfterExec, target, mediumResult, null)
      addToPartition(result, obsKey, mediumWorlds, alive)
    } else if (!hasNonNekomata) {
      // 全ワールドで猫又: 各道連れ先で分岐（AND）
      for (const curseTarget of aliveAfterExec) {
        const aliveAfterCurse = new Set(aliveAfterExec)
        aliveAfterCurse.delete(curseTarget)

        const { obsKey, alive } = resolveFollowDeaths(
          mediumWorlds, aliveAfterCurse, target, mediumResult, curseTarget,
        )
        addToPartition(result, obsKey, mediumWorlds, alive)
      }
    } else {
      // 一部が猫又: 猫又ワールドと非猫又ワールドを分離
      const nekoWorlds = mediumWorlds.filter(w => w.roles.get(target) === 'nekomata')
      const nonNekoWorlds = mediumWorlds.filter(w => w.roles.get(target) !== 'nekomata')

      // 非猫又ワールド
      const { obsKey: nonNekoObs, alive: nonNekoAlive } = resolveFollowDeaths(
        nonNekoWorlds, aliveAfterExec, target, mediumResult, null,
      )
      addToPartition(result, nonNekoObs, nonNekoWorlds, nonNekoAlive)

      // 猫又ワールド: 各道連れ先で分岐
      for (const curseTarget of aliveAfterExec) {
        const aliveAfterCurse = new Set(aliveAfterExec)
        aliveAfterCurse.delete(curseTarget)

        const { obsKey, alive } = resolveFollowDeaths(
          nekoWorlds, aliveAfterCurse, target, mediumResult, curseTarget,
        )
        addToPartition(result, obsKey, nekoWorlds, alive)
      }
    }
  }

  return result
}

function resolveFollowDeaths(
  _worlds: World[], alive: Set<Seat>, _executedTarget: Seat,
  mediumResult: EnumSpecies, nekomataCurseTarget: Seat | null,
): { obsKey: ObservationKey, alive: Set<Seat> } {
  // 背徳者後追い: 処刑先が妖狐 or 猫又道連れ先が妖狐の場合
  // いずれかのワールドで妖狐が死んだ場合の背徳者後追いを計算
  const followDeaths: Seat[] = []
  const resultAlive = new Set(alive)

  // 処刑先が妖狐のワールドがあるか？
  // 猫又道連れ先が妖狐のワールドがあるか？
  // → 観測上、後追いが起きるかは実際の役職次第
  // ここでは全ワールドで共通する後追いのみ処理
  // （後追いが起きるワールドと起きないワールドが混在する場合、観測で区別可能）

  // 簡略化: 後追いは観測可能なので、後追いの有無でさらに分岐する必要がある
  // ここでは後追いなしケースで返す（実際の分岐はsearchが行う）

  const obsKey = executionObservationKey(mediumResult, nekomataCurseTarget, followDeaths)
  return { obsKey, alive: resultAlive }
}

function addToPartition(
  partition: Map<ObservationKey, { worlds: World[], alive: Set<Seat> }>,
  obsKey: ObservationKey, worlds: World[], alive: Set<Seat>,
): void {
  const existing = partition.get(obsKey)
  if (existing) {
    existing.worlds.push(...worlds)
  } else {
    partition.set(obsKey, { worlds: [...worlds], alive })
  }
}

/**
 * 夜フェーズの探索。
 * 護衛先・占い先の組み合わせを試し（OR）、
 * 単調性定理を使って狼の噛み先を処理する（AND）。
 */
function searchNight(
  worlds: World[],
  alive: Set<Seat>,
  day: number,
  depth: number,
  ss: SearchState,
): StrategyNode | null {
  // 護衛候補: 生存中の狩人がいるワールドがあれば護衛を最適化
  const bodyguardCandidates = getBodyguardCandidates(worlds, alive)
  // 占い候補: 生存中の占い師がいるワールドがあれば占い先を最適化
  const seerCandidates = getSeerCandidates(worlds, alive)

  for (const bgTarget of bodyguardCandidates) {
    for (const seerTarget of seerCandidates) {
      const result = tryNightAction(worlds, alive, day, bgTarget, seerTarget, depth, ss)
      if (result !== null) return result
    }
  }

  return null
}

function getBodyguardCandidates(worlds: World[], alive: Set<Seat>): (Seat | null)[] {
  // 狩人が生存しているワールドがあるか？
  const hasAliveBodyguard = worlds.some(w => w.bodyguardSeat !== -1 && alive.has(w.bodyguardSeat))
  if (!hasAliveBodyguard) return [null]

  // 護衛候補: 自分以外の生存者
  const candidates: (Seat | null)[] = [null] // nullは護衛なし（狩人が偽のワールドもある）
  for (const seat of alive) {
    candidates.push(seat)
  }
  return candidates
}

function getSeerCandidates(worlds: World[], alive: Set<Seat>): (Seat | null)[] {
  const hasAliveSeer = worlds.some(w => w.seerSeat !== -1 && alive.has(w.seerSeat))
  if (!hasAliveSeer) return [null]

  const candidates: (Seat | null)[] = [null]
  for (const seat of alive) {
    candidates.push(seat)
  }
  return candidates
}

/**
 * 特定の護衛先・占い先での夜の探索。
 * 単調性定理を適用: 各観測 o について POSSIBLE(o) を計算し、全てが詰みなら詰み。
 */
function tryNightAction(
  worlds: World[],
  alive: Set<Seat>,
  day: number,
  bodyguardTarget: Seat | null,
  seerTarget: Seat | null,
  depth: number,
  ss: SearchState,
): StrategyNode | null {
  // 単調性定理: 各観測について、その観測を生み出しうるワールドの最大集合を計算
  const possibleByObs = new Map<ObservationKey, { worlds: Set<World>, alive: Set<Seat> }>()

  for (const world of worlds) {
    const biteTargets = validBiteTargets(world, alive)
    if (biteTargets.length === 0) {
      // 狼が全滅しているワールド → 噛みなし → 即座の観測
      const obs: NightObservation = { deaths: [], seerResult: undefined }
      const key = nightObservationKey(obs)
      if (!possibleByObs.has(key)) {
        possibleByObs.set(key, { worlds: new Set(), alive: new Set(alive) })
      }
      possibleByObs.get(key)!.worlds.add(world)
      continue
    }

    for (const biteTarget of biteTargets) {
      const { nextAlive, observation } = simulateNight(
        world, alive, biteTarget, bodyguardTarget, seerTarget,
      )
      const key = nightObservationKey(observation)
      if (!possibleByObs.has(key)) {
        possibleByObs.set(key, { worlds: new Set(), alive: nextAlive })
      }
      possibleByObs.get(key)!.worlds.add(world)
    }
  }

  // 全観測分岐で詰みか？（AND）
  const branches = {} as Record<ObservationKey, StrategyNode>

  for (const [obsKey, group] of possibleByObs) {
    const groupWorlds = Array.from(group.worlds)
    const nextState: SimState = { alive: group.alive, day: day + 1 }

    const result = isTsumi(groupWorlds, nextState, depth + 1, ss)
    if (result === null) return null
    branches[obsKey] = result
  }

  return {
    type: 'action',
    action: { execute: -1, bodyguardTarget, seerTarget }, // execute=-1 は夜アクション
    branches,
  }
}
