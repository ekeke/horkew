import type { SystemRole, RoleTrait } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'
import { RoleBitIndex, ROLE_COUNT } from '../retar/possibilities.ts'

/**
 * 役職の属性（trait + faction）をビットフラグとして扱うための定数とルックアップ。
 *
 * Hati の判定・探索ロジックは役職名（'werewolf' / 'werehamster' など）を直接参照
 * せず、ここで定義する ATTR.* フラグ経由で役職の能力・陣営を問い合わせる。
 * 役職名を増やしても能力一覧が trait に乗っていれば Hati コードに変更不要。
 */
export const ATTR = {
  WOLF_FACTION:                1 << 0,
  FOX_FACTION:                 1 << 1,
  ACTION_ATTACK:               1 << 2,
  ACTION_DIVINE:               1 << 3,
  ACTION_GUARD:                1 << 4,
  PASSIVE_ATTACK_IMMUNE:       1 << 5,
  PASSIVE_DIE_WHEN_DIVINED:    1 << 6,
  REACTIVE_CURSE_ON_EXECUTED:  1 << 7,
  REACTIVE_CURSE_ON_KILLED:    1 << 8,
  REACTIVE_FOLLOW_FOX_DEATH:   1 << 9,
  AUTO_INFO_EXECUTION_SPECIES: 1 << 10,
} as const

function traitToAttrBit(trait: RoleTrait): number {
  switch (trait.kind) {
    case 'action':
      if (trait.sub === 'attack') return ATTR.ACTION_ATTACK
      if (trait.sub === 'divine') return ATTR.ACTION_DIVINE
      if (trait.sub === 'guard')  return ATTR.ACTION_GUARD
      return 0
    case 'passive':
      if (trait.sub === 'attack-immune')    return ATTR.PASSIVE_ATTACK_IMMUNE
      if (trait.sub === 'die-when-divined') return ATTR.PASSIVE_DIE_WHEN_DIVINED
      return 0
    case 'reactive':
      if (trait.sub === 'curse-on-executed') return ATTR.REACTIVE_CURSE_ON_EXECUTED
      if (trait.sub === 'curse-on-killed')   return ATTR.REACTIVE_CURSE_ON_KILLED
      if (trait.sub === 'follow-fox-death')  return ATTR.REACTIVE_FOLLOW_FOX_DEATH
      return 0
    case 'auto-info':
      if (trait.sub === 'execution-species') return ATTR.AUTO_INFO_EXECUTION_SPECIES
      return 0
    case 'knowledge':
    case 'channel':
      return 0
  }
}

/**
 * RoleBitIndex で引ける、役職ごとの属性ビット集合。
 * 起動時 1 回だけ構築し、ホットパスでは index アクセスのみ。
 */
export const RoleAttributeBits: Uint32Array = (() => {
  const arr = new Uint32Array(ROLE_COUNT)
  for (const [role, def] of systemRoles) {
    let bits = 0
    if (def.faction === 'wolf') bits |= ATTR.WOLF_FACTION
    if (def.faction === 'fox')  bits |= ATTR.FOX_FACTION
    for (const t of def.traits) bits |= traitToAttrBit(t)
    arr[RoleBitIndex[role]] = bits
  }
  return arr
})()

/** 役職の属性ビット集合を返す */
export function roleAttributeBits(role: SystemRole): number {
  return RoleAttributeBits[RoleBitIndex[role]]
}

/**
 * 属性ビット → RoleSignatureBits の集合（その属性を持つ役職の possibility-bit 和）。
 * `attr` は ATTR.* のいずれか1つ（複数 OR ではない）。
 * 例: rolePossibilityForAttribute(ATTR.ACTION_DIVINE) = RoleSignatureBits.seer | RoleSignatureBits.paparazzi
 */
export function rolePossibilityForAttribute(attr: number): number {
  let bits = 0
  for (let i = 0; i < ROLE_COUNT; i++) {
    if ((RoleAttributeBits[i] & attr) !== 0) bits |= (1 << i)
  }
  return bits
}

/** Retar の RolePossibility に attr 属性を持つ役職が含まれるか */
export function possibilityHasAttribute(possibility: number, attr: number): boolean {
  return (possibility & rolePossibilityForAttribute(attr)) !== 0
}

/**
 * 「全ての requireAttrs を満たし、excludeAttrs を全て満たさない」役職が possibility に含まれるか。
 * 例: requireAttrs=WOLF_FACTION, excludeAttrs=ACTION_ATTACK → fanatic/possessed/paparazzi の判定。
 */
export function possibilityHasAttributePattern(
  possibility: number, requireAttrs: number, excludeAttrs: number,
): boolean {
  let bits = 0
  for (let i = 0; i < ROLE_COUNT; i++) {
    const ra = RoleAttributeBits[i]
    if ((ra & requireAttrs) === requireAttrs && (ra & excludeAttrs) === 0) {
      bits |= (1 << i)
    }
  }
  return (possibility & bits) !== 0
}

/**
 * possibility が単一役職に確定し、その役職が attr 属性を持つか。
 * 旧 isActualRole(seat, role) の属性版。
 */
export function isActualAttribute(possibility: number, attr: number): boolean {
  if (possibility === 0 || (possibility & (possibility - 1)) !== 0) return false
  return (possibility & rolePossibilityForAttribute(attr)) !== 0
}

/** setup の合計から、attr 属性を持つ役職の総人数を返す */
export function setupCountByAttribute(setup: Map<SystemRole, number>, attr: number): number {
  let total = 0
  for (const [role, n] of setup) {
    if ((RoleAttributeBits[RoleBitIndex[role]] & attr) !== 0) total += n
  }
  return total
}

/**
 * setup の合計から、「全 requireAttrs を満たし excludeAttrs を全て満たさない」役職の総人数を返す。
 * 例: (WOLF_FACTION, ACTION_ATTACK) → fanatic + possessed + paparazzi 合計。
 */
export function setupCountByAttributePattern(
  setup: Map<SystemRole, number>, requireAttrs: number, excludeAttrs: number,
): number {
  let total = 0
  for (const [role, n] of setup) {
    const ra = RoleAttributeBits[RoleBitIndex[role]]
    if ((ra & requireAttrs) === requireAttrs && (ra & excludeAttrs) === 0) total += n
  }
  return total
}
