import type { Seat, SystemRole, EnumSpecies } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'
import type { World, ObservationKey } from './types.ts'
import { hasSeat, removeSeat, popCount32, seatsFromMask } from './types.ts'
import { ROLE_COUNT, RoleSignatureBitsReverseMap } from '../retar/possibilities.ts'

// --- 種族判定 ---

/** 数値roleId→霊媒結果のルックアップテーブル（systemRoles の mediumResult から構築） */
const MEDIUM_RESULT_TABLE: EnumSpecies[] = (() => {
  const table: EnumSpecies[] = new Array(ROLE_COUNT).fill('human')
  for (let i = 0; i < ROLE_COUNT; i++) {
    const role = RoleSignatureBitsReverseMap.get(1 << i)
    if (role) table[i] = systemRoles.get(role)!.mediumResult
  }
  return table
})()

/** 数値roleId→占い結果のルックアップテーブル（systemRoles の seerResult から構築） */
const SEER_RESULT_TABLE: EnumSpecies[] = (() => {
  const table: EnumSpecies[] = new Array(ROLE_COUNT).fill('human')
  for (let i = 0; i < ROLE_COUNT; i++) {
    const role = RoleSignatureBitsReverseMap.get(1 << i)
    if (role) table[i] = systemRoles.get(role)!.seerResult
  }
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
 *
 * 標準人狼ルールに従う:
 * - 「人狼」=攻撃能力 (action:attack) を持つ生存者 = attackCapableMask
 * - 「狐」=占いで死ぬ (passive:die-when-divined) 生存者 = dieWhenDivinedMask
 *   (狐陣営の follower (背徳者) は判定で「村人扱い」、勝敗の主体ではない)
 * - 攻撃者=0 → 村勝 (or 狐勝)
 * - 攻撃者 ≥ 非攻撃者かつ非狐核心 → 狼勝 (or 狐勝)
 */
export function checkOutcome(world: World, alive: number): GameOutcome {
  const aliveAttackers = popCount32(world.attackCapableMask & alive)
  const aliveFoxCore = popCount32(world.dieWhenDivinedMask & alive)
  const foxAlive = aliveFoxCore !== 0
  const nonAttackerNonFoxCore = popCount32(alive) - aliveAttackers - aliveFoxCore

  if (aliveAttackers === 0) {
    return foxAlive ? 'hamster_win' : 'village_win'
  }
  if (aliveAttackers >= nonAttackerNonFoxCore) {
    return foxAlive ? 'hamster_win' : 'wolf_win'
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

/**
 * 1つのワールドで夜を解決する。ビットマスクベース。
 * 返値: 夜後の生存者ビットマスクと観測キー（数値パック）。
 *
 * 役職参照は属性マスク経由:
 * - 占い対象の死亡 = dieWhenDivinedMask
 * - 噛みに免疫 = attackImmuneMask
 * - 噛みで道連れ = curseOnKilledMask
 * - 護衛能力 = guardCapableMask（生存している guard target が指定されているか）
 * - 狐全滅で後追い = followFoxDeathMask
 */
export function simulateNight(
  world: World,
  alive: number,
  wolfBiteTarget: Seat,
  bodyguardTarget: Seat | null,
  seerTargets: Seat[],
): { nextAlive: number, obsKey: number } {
  let nextAlive = alive
  let deathMask = 0
  const targetBit = 1 << wolfBiteTarget

  // 占い呪殺チェック（各占い師が独立に実行）
  let seerIdx = 0
  let curseBits = world.divineCapableMask & alive  // 生存占い師
  while (curseBits !== 0) {
    const bit = curseBits & (-curseBits)
    curseBits ^= bit
    const target = seerTargets[seerIdx++]
    if (target !== undefined
      && (world.dieWhenDivinedMask & (1 << target)) !== 0
      && hasSeat(nextAlive, target)) {
      nextAlive = removeSeat(nextAlive, target)
      deathMask |= (1 << target)
      // 全狐核心死亡 → followFoxDeath 持ちが後追い
      if ((world.dieWhenDivinedMask & nextAlive) === 0) {
        const dyingFollowers = world.followFoxDeathMask & nextAlive
        nextAlive &= ~dyingFollowers
        deathMask |= dyingFollowers
      }
    }
  }

  // 狼の噛み解決
  // 護衛成功: bodyguardTarget が wolfBiteTarget と一致し、護衛能力者が生存している
  const guardActive = bodyguardTarget === wolfBiteTarget
    && (world.guardCapableMask & alive) !== 0
  if ((world.attackImmuneMask & targetBit) !== 0) {
    // 噛み無効（例: 妖狐）
  } else if (guardActive) {
    // 護衛成功
  } else if ((world.curseOnKilledMask & targetBit) !== 0) {
    // 噛みで道連れ発動者（猫又）: 本人死亡（道連れ狼は呼び出し側で分岐）
    if (hasSeat(nextAlive, wolfBiteTarget)) {
      nextAlive = removeSeat(nextAlive, wolfBiteTarget)
      deathMask |= targetBit
    }
  } else {
    // 通常の噛み殺し
    if (hasSeat(nextAlive, wolfBiteTarget)) {
      nextAlive = removeSeat(nextAlive, wolfBiteTarget)
      deathMask |= targetBit
    }
  }

  // 占い結果: 各占い師が夜を生き延びた場合のみ報告
  // obsKey: deathMask を上位に、各占い師の結果(2bit)を低ビットから詰める
  let seerResultBits = 0
  let resultIdx = 0
  let resultBits = world.divineCapableMask  // 全占い師（割り当て順序を保持）
  while (resultBits !== 0) {
    const bit = resultBits & (-resultBits)
    const seerSeat = 31 - Math.clz32(bit)
    resultBits ^= bit
    const target = seerTargets[resultIdx]
    let code = 0 // 0=報告なし(死亡), 1=human, 2=wolf
    if (target !== undefined && hasSeat(nextAlive, seerSeat)) {
      code = SEER_RESULT_TABLE[world.roleIds[target]] === 'wolf' ? 2 : 1
    }
    seerResultBits |= (code << (resultIdx * 2))
    resultIdx++
  }

  // obsKey: deathMask を seerCount*2 ビット分シフトして結果を下位に配置
  const seerCount = resultIdx
  const obsKey = (deathMask << (seerCount * 2)) | seerResultBits

  return { nextAlive, obsKey }
}

/**
 * 特定ワールドにおける狼の有効な噛み先を列挙。
 */
export function validBiteTargets(world: World, alive: number): Seat[] {
  if ((world.attackCapableMask & alive) === 0) return []
  return seatsFromMask(validBiteTargetsMask(world, alive))
}

/**
 * 噛み先をビットマスクで返す（配列alloc不要）
 * LW（最後の攻撃者）は curse-on-killed 持ちを噛まない: 道連れで攻撃者全滅し自陣営敗北のため。
 * 攻撃者が2匹以上いる場合は道連れ持ちを噛む選択肢を残す（1匹犠牲にしても残りが戦える）。
 *
 * 噛み先候補は「攻撃能力者以外」（=元の semantic を保持。狼陣営の non-attacker
 * (狂人/狂信者/パパラッチ) も噛み先候補に含まれる）。
 */
export function validBiteTargetsMask(world: World, alive: number): number {
  const aliveAttackers = world.attackCapableMask & alive
  if (aliveAttackers === 0) return 0
  let targets = alive & ~world.attackCapableMask
  // LW（攻撃者が1匹のみ）の場合、curse-on-killed 持ちを除外
  if (popCount32(aliveAttackers) === 1) {
    targets &= ~world.curseOnKilledMask
  }
  return targets
}

/**
 * 処刑後の後追い死亡を適用する。
 * 狐核心 (die-when-divined 持ち = 妖狐) が全滅している場合、follow-fox-death 持ちが後追い。
 */
export function applyFollowDeaths(alive: number, world: World): number {
  if (world.dieWhenDivinedMask !== 0 && (world.dieWhenDivinedMask & alive) === 0) {
    return alive & ~world.followFoxDeathMask
  }
  return alive
}

// --- 観測キー変換（数値 → 文字列、出力用） ---

export function obsKeyToString(obsKey: number, seerCount: number = 1): ObservationKey {
  const seerBitWidth = seerCount * 2
  const seerBits = obsKey & ((1 << seerBitWidth) - 1)
  const deathMask = obsKey >>> seerBitWidth

  let deathPart: string
  if (deathMask === 0) {
    deathPart = 'peace'
  } else {
    const seats = seatsFromMask(deathMask)
    deathPart = `d:${seats.join(',')}`
  }

  if (seerBits === 0) return deathPart

  // 各占い師の結果を復元
  const seerParts: string[] = []
  for (let i = 0; i < seerCount; i++) {
    const code = (seerBits >>> (i * 2)) & 3
    if (code === 2) seerParts.push('wolf')
    else if (code === 1) seerParts.push('human')
    // code === 0: 報告なし（占い師死亡）→ 省略
  }
  if (seerParts.length === 0) return deathPart
  if (seerParts.length === 1) return deathPart + `|s:${seerParts[0]}`
  return deathPart + `|s:${seerParts.join(',')}`
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
 * 「村人側」= 狼陣営にも狐陣営にも属していない (faction='village')。
 */
export function isConfirmedVillagerInAllWorlds(worlds: World[], seat: Seat): boolean {
  const bit = 1 << seat
  for (const w of worlds) {
    if (((w.wolfFactionMask | w.foxFactionMask) & bit) !== 0) return false
  }
  return true
}
