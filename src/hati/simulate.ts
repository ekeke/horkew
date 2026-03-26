import type { Seat, SystemRole, EnumSpecies } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'
import type { World, ObservationKey } from './types.ts'
import { hasSeat, removeSeat, popCount32, seatsFromMask } from './types.ts'
import { RoleBitIndex } from '../retar/possibilities.ts'

// --- 種族判定 ---

/** 数値roleId→霊媒結果のルックアップテーブル */
const MEDIUM_RESULT_TABLE: EnumSpecies[] = (() => {
  const table: EnumSpecies[] = new Array(11).fill('human')
  // werewolfのみwolf
  table[RoleBitIndex.werewolf] = 'wolf'
  return table
})()

/** 数値roleId→占い結果のルックアップテーブル */
const SEER_RESULT_TABLE: EnumSpecies[] = (() => {
  const table: EnumSpecies[] = new Array(11).fill('human')
  table[RoleBitIndex.werewolf] = 'wolf'
  return table
})()

export function getMediumResult(role: SystemRole): EnumSpecies {
  return systemRoles.get(role)?.mediumResult ?? 'human'
}

export function getSeerResult(role: SystemRole): EnumSpecies {
  return systemRoles.get(role)?.seerResult ?? 'human'
}

/** 数値roleIdから霊媒結果を取得（ホットパス用） */
export function getMediumResultById(roleId: number): EnumSpecies {
  return MEDIUM_RESULT_TABLE[roleId]
}

/** 数値roleIdから占い結果を取得（ホットパス用） */
export function getSeerResultById(roleId: number): EnumSpecies {
  return SEER_RESULT_TABLE[roleId]
}

// --- 勝利判定 ---

export type GameOutcome = 'village_win' | 'wolf_win' | 'hamster_win' | 'ongoing'

/**
 * 特定のワールドにおける勝利判定。
 */
export function checkOutcome(world: World, alive: number): GameOutcome {
  const aliveWolves = popCount32(world.wolfMask & alive)
  const hamsterAlive = world.hamsterSeat !== -1 && hasSeat(alive, world.hamsterSeat)
  // 妖狐を除いた非狼カウント
  let nonWolfNonHamster = popCount32(alive) - aliveWolves
  if (hamsterAlive) nonWolfNonHamster--

  if (aliveWolves === 0) {
    return hamsterAlive ? 'hamster_win' : 'village_win'
  }
  if (aliveWolves >= nonWolfNonHamster) {
    return hamsterAlive ? 'hamster_win' : 'wolf_win'
  }
  return 'ongoing'
}

export function allWorldsVillageWin(worlds: World[], alive: number): boolean {
  for (const w of worlds) {
    if (checkOutcome(w, alive) !== 'village_win') return false
  }
  return true
}

export function anyWorldVillageLoss(worlds: World[], alive: number): boolean {
  for (const w of worlds) {
    const outcome = checkOutcome(w, alive)
    if (outcome === 'wolf_win' || outcome === 'hamster_win') return true
  }
  return false
}

// --- 処刑シミュレーション ---

export function applyExecution(alive: number, target: Seat): number {
  return removeSeat(alive, target)
}

// --- 夜シミュレーション ---

const WEREHAMSTER_ID = RoleBitIndex.werehamster
const NEKOMATA_ID = RoleBitIndex.nekomata

/**
 * 1つのワールドで夜を解決する。ビットマスクベース。
 * 返値: 夜後の生存者ビットマスクと観測キー（数値パック）。
 * #7: roleIds でホットパス判定
 */
export function simulateNight(
  world: World,
  alive: number,
  wolfBiteTarget: Seat,
  bodyguardTarget: Seat | null,
  seerTarget: Seat | null,
): { nextAlive: number, obsKey: number } {
  let nextAlive = alive
  let deathMask = 0
  const targetRoleId = world.roleIds[wolfBiteTarget]

  // 占い呪殺チェック
  if (seerTarget !== null && hasSeat(alive, world.seerSeat)) {
    if (world.roleIds[seerTarget] === WEREHAMSTER_ID && hasSeat(nextAlive, seerTarget)) {
      nextAlive = removeSeat(nextAlive, seerTarget)
      deathMask |= (1 << seerTarget)
      // 背徳者後追い
      if (world.immoralistSeat !== -1 && hasSeat(nextAlive, world.immoralistSeat)) {
        nextAlive = removeSeat(nextAlive, world.immoralistSeat)
        deathMask |= (1 << world.immoralistSeat)
      }
    }
  }

  // 狼の噛み解決
  if (targetRoleId === WEREHAMSTER_ID) {
    // 妖狐は噛まれても死なない
  } else if (bodyguardTarget === wolfBiteTarget && hasSeat(alive, world.bodyguardSeat)) {
    // 護衛成功
  } else if (targetRoleId === NEKOMATA_ID) {
    // 猫又噛み: 猫又死亡 + 噛んだ狼1匹死亡
    if (hasSeat(nextAlive, wolfBiteTarget)) {
      nextAlive = removeSeat(nextAlive, wolfBiteTarget)
      deathMask |= (1 << wolfBiteTarget)
    }
    // 狼の1匹が道連れ
    const aliveWolves = world.wolfMask & nextAlive
    if (aliveWolves !== 0) {
      const lowestWolf = 31 - Math.clz32(aliveWolves & (-aliveWolves))
      nextAlive = removeSeat(nextAlive, lowestWolf)
      deathMask |= (1 << lowestWolf)
    }
  } else {
    // 通常の噛み殺し
    if (hasSeat(nextAlive, wolfBiteTarget)) {
      nextAlive = removeSeat(nextAlive, wolfBiteTarget)
      deathMask |= (1 << wolfBiteTarget)
    }
  }

  // 占い結果: 占い師がその夜を生き延びた場合のみ翌日報告できる
  let seerResultCode = 0 // 0=none, 1=human, 2=wolf
  if (seerTarget !== null && hasSeat(nextAlive, world.seerSeat)) {
    const result = SEER_RESULT_TABLE[world.roleIds[seerTarget]]
    seerResultCode = result === 'wolf' ? 2 : 1
  }

  // 観測キー: deathMask (上位ビット) + seerResult (下位2ビット)
  const obsKey = (deathMask << 2) | seerResultCode

  return { nextAlive, obsKey }
}

/**
 * 特定ワールドにおける狼の有効な噛み先を列挙。
 */
export function validBiteTargets(world: World, alive: number): Seat[] {
  // 生存中の狼がいなければ空
  if ((world.wolfMask & alive) === 0) return []

  const nonWolfAlive = alive & ~world.wolfMask
  return seatsFromMask(nonWolfAlive)
}

/**
 * #6: 噛み先をビットマスクで返す（配列alloc不要）
 */
export function validBiteTargetsMask(world: World, alive: number): number {
  if ((world.wolfMask & alive) === 0) return 0
  return alive & ~world.wolfMask
}

/**
 * 処刑後の後追い死亡を適用する。
 * 狐が死亡している場合、背徳者が後追い死亡する。
 */
export function applyFollowDeaths(alive: number, world: World): number {
  if (world.hamsterSeat !== -1 && !hasSeat(alive, world.hamsterSeat)) {
    if (world.immoralistSeat !== -1 && hasSeat(alive, world.immoralistSeat)) {
      return removeSeat(alive, world.immoralistSeat)
    }
  }
  return alive
}

// --- 観測キー変換（数値 → 文字列、出力用） ---

export function obsKeyToString(obsKey: number): ObservationKey {
  const seerCode = obsKey & 3
  const deathMask = obsKey >>> 2

  let deathPart: string
  if (deathMask === 0) {
    deathPart = 'peace'
  } else {
    const seats = seatsFromMask(deathMask)
    deathPart = `d:${seats.join(',')}`
  }

  if (seerCode === 0) return deathPart
  return deathPart + (seerCode === 2 ? '|s:wolf' : '|s:human')
}

export function executionObsKeyToString(
  mediumResult: EnumSpecies, nekomataCurseTarget: Seat | null,
): ObservationKey {
  let key = `m:${mediumResult}`
  if (nekomataCurseTarget !== null) key += `|neko:${nekomataCurseTarget}`
  return key
}

/**
 * 全ワールドで指定seatが確定村人側かチェック（枝刈り用）
 * #4: モジュールスコープ定数Set（毎回再生成しない）
 */
const villagerRoles: Set<SystemRole> = new Set([
  'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
])
export function isConfirmedVillagerInAllWorlds(worlds: World[], seat: Seat): boolean {
  for (const w of worlds) {
    if (!villagerRoles.has(w.roles[seat])) return false
  }
  return true
}
