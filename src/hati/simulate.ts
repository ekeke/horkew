import type { Seat, SystemRole, EnumSpecies } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'
import type { World, NightObservation, ObservationKey } from './types.ts'

// --- 種族判定 ---

export function getMediumResult(role: SystemRole): EnumSpecies {
  return systemRoles.get(role)?.mediumResult ?? 'human'
}

export function getSeerResult(role: SystemRole): EnumSpecies {
  return systemRoles.get(role)?.seerResult ?? 'human'
}

// --- 勝利判定 ---

export type GameOutcome = 'village_win' | 'wolf_win' | 'hamster_win' | 'ongoing'

/**
 * 特定のワールドにおける勝利判定。
 * lupa/roles.ts の checkWinCondition と同じロジック。
 */
export function checkOutcome(world: World, alive: Set<Seat>): GameOutcome {
  let wolfCount = 0
  let hamsterAlive = false
  let nonWolfNonHamsterCount = 0

  for (const seat of alive) {
    const role = world.roles.get(seat)!
    if (role === 'werewolf') {
      wolfCount++
    } else if (role === 'werehamster') {
      hamsterAlive = true
    } else {
      nonWolfNonHamsterCount++
    }
  }

  if (wolfCount === 0) {
    return hamsterAlive ? 'hamster_win' : 'village_win'
  }
  if (wolfCount >= nonWolfNonHamsterCount) {
    return hamsterAlive ? 'hamster_win' : 'wolf_win'
  }
  return 'ongoing'
}

/**
 * 全ワールドで村勝利か判定
 */
export function allWorldsVillageWin(worlds: World[], alive: Set<Seat>): boolean {
  for (const w of worlds) {
    if (checkOutcome(w, alive) !== 'village_win') return false
  }
  return true
}

/**
 * いずれかのワールドで村が負け（狼勝ち or 狐勝ち）か判定
 */
export function anyWorldVillageLoss(worlds: World[], alive: Set<Seat>): boolean {
  for (const w of worlds) {
    const outcome = checkOutcome(w, alive)
    if (outcome === 'wolf_win' || outcome === 'hamster_win') return true
  }
  return false
}

// --- 処刑シミュレーション ---

/**
 * 処刑を適用した後の状態を返す。
 * 猫又道連れ・背徳者後追いは含まない（別途分岐処理が必要）。
 */
export function applyExecution(alive: Set<Seat>, target: Seat): Set<Seat> {
  const next = new Set(alive)
  next.delete(target)
  return next
}

/**
 * 処刑後の観測を計算する（特定ワールド内）。
 * 猫又道連れのランダム先は呼び出し側が分岐するため、ここでは猫又かどうかのみ判定。
 */
export function getExecutionObservation(
  world: World, _alive: Set<Seat>, target: Seat,
): { mediumResult: EnumSpecies, isNekomata: boolean } {
  const role = world.roles.get(target)!
  return {
    mediumResult: getMediumResult(role),
    isNekomata: role === 'nekomata',
  }
}

// --- 夜シミュレーション ---

/**
 * 1つのワールドで、村の夜行動と狼の噛み先を指定して夜を解決する。
 * 返値: 夜の後の生存者集合と観測。
 */
export function simulateNight(
  world: World,
  alive: Set<Seat>,
  wolfBiteTarget: Seat,
  bodyguardTarget: Seat | null,
  seerTarget: Seat | null,
): { nextAlive: Set<Seat>, observation: NightObservation } {
  const deaths: Seat[] = []
  const nextAlive = new Set(alive)
  const targetRole = world.roles.get(wolfBiteTarget)!

  // 占い呪殺チェック
  if (seerTarget !== null && alive.has(world.seerSeat)) {
    const seerTargetRole = world.roles.get(seerTarget)
    if (seerTargetRole === 'werehamster' && nextAlive.has(seerTarget)) {
      nextAlive.delete(seerTarget)
      deaths.push(seerTarget)
      // 背徳者後追い
      if (world.immoralistSeat !== -1 && nextAlive.has(world.immoralistSeat)) {
        nextAlive.delete(world.immoralistSeat)
        deaths.push(world.immoralistSeat)
      }
    }
  }

  // 狼の噛み解決
  if (targetRole === 'werehamster') {
    // 妖狐は噛まれても死なない → 平和に見える
  } else if (bodyguardTarget === wolfBiteTarget && alive.has(world.bodyguardSeat)) {
    // 護衛成功 → 平和
  } else if (targetRole === 'nekomata') {
    // 猫又噛み: 猫又死亡 + 噛んだ狼1匹死亡
    if (nextAlive.has(wolfBiteTarget)) {
      nextAlive.delete(wolfBiteTarget)
      deaths.push(wolfBiteTarget)
    }
    // 狼の1匹が道連れ（生存中の狼から1匹）
    for (const wolfSeat of world.wolfSeats) {
      if (nextAlive.has(wolfSeat)) {
        nextAlive.delete(wolfSeat)
        deaths.push(wolfSeat)
        break // 1匹だけ
      }
    }
  } else {
    // 通常の噛み殺し
    if (nextAlive.has(wolfBiteTarget)) {
      nextAlive.delete(wolfBiteTarget)
      deaths.push(wolfBiteTarget)
    }
  }

  // 占い結果: 占い師がその夜を生き延びた場合のみ翌日報告できる
  let seerResult: EnumSpecies | undefined
  if (seerTarget !== null && nextAlive.has(world.seerSeat)) {
    seerResult = getSeerResult(world.roles.get(seerTarget)!)
  }

  deaths.sort((a, b) => a - b)

  return {
    nextAlive,
    observation: { deaths, seerResult },
  }
}

/**
 * 特定ワールドにおける狼の有効な噛み先を列挙。
 * 狼は自陣営（他の狼）を噛まない。
 */
export function validBiteTargets(world: World, alive: Set<Seat>): Seat[] {
  const targets: Seat[] = []
  // 生存中の狼がいなければ空
  let hasAliveWolf = false
  for (const w of world.wolfSeats) {
    if (alive.has(w)) { hasAliveWolf = true; break }
  }
  if (!hasAliveWolf) return targets

  for (const seat of alive) {
    if (!world.wolfSeats.has(seat)) {
      targets.push(seat)
    }
  }
  return targets
}

// --- 観測キー ---

export function nightObservationKey(obs: NightObservation): ObservationKey {
  const deathPart = obs.deaths.length > 0 ? `d:${obs.deaths.join(',')}` : 'peace'
  const seerPart = obs.seerResult !== undefined ? `|s:${obs.seerResult}` : ''
  return deathPart + seerPart
}

export function executionObservationKey(
  mediumResult: EnumSpecies, nekomataCurseTarget: Seat | null,
  immoralistFollowDeaths: Seat[],
): ObservationKey {
  let key = `m:${mediumResult}`
  if (nekomataCurseTarget !== null) key += `|neko:${nekomataCurseTarget}`
  if (immoralistFollowDeaths.length > 0) key += `|follow:${immoralistFollowDeaths.join(',')}`
  return key
}

/**
 * 全ワールドで指定seatが確定村人側かチェック（枝刈り用）
 */
export function isConfirmedVillagerInAllWorlds(worlds: World[], seat: Seat): boolean {
  const villagerRoles: Set<SystemRole> = new Set([
    'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
  ])
  for (const w of worlds) {
    if (!villagerRoles.has(w.roles.get(seat)!)) return false
  }
  return true
}
