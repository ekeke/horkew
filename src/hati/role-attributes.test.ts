import { describe, it } from 'node:test'
import assert from 'node:assert'
import type { SystemRole } from '../types/index.ts'
import {
  ATTR, RoleAttributeBits, roleAttributeBits,
  possibilityHasAttribute, setupCountByAttribute,
} from './role-attributes.ts'
import { RoleBitIndex, RoleSignatureBits } from '../retar/possibilities.ts'

describe('hati/role-attributes', () => {
  describe('RoleAttributeBits', () => {
    it('werewolf has WOLF_FACTION + ACTION_ATTACK', () => {
      const bits = RoleAttributeBits[RoleBitIndex.werewolf]
      assert.ok((bits & ATTR.WOLF_FACTION) !== 0)
      assert.ok((bits & ATTR.ACTION_ATTACK) !== 0)
      assert.ok((bits & ATTR.FOX_FACTION) === 0)
    })

    it('paparazzi has WOLF_FACTION + ACTION_DIVINE but not ACTION_ATTACK', () => {
      const bits = RoleAttributeBits[RoleBitIndex.paparazzi]
      assert.ok((bits & ATTR.WOLF_FACTION) !== 0)
      assert.ok((bits & ATTR.ACTION_DIVINE) !== 0)
      assert.ok((bits & ATTR.ACTION_ATTACK) === 0)
    })

    it('seer has ACTION_DIVINE but not WOLF_FACTION', () => {
      const bits = RoleAttributeBits[RoleBitIndex.seer]
      assert.ok((bits & ATTR.ACTION_DIVINE) !== 0)
      assert.ok((bits & ATTR.WOLF_FACTION) === 0)
    })

    it('werehamster has FOX_FACTION + PASSIVE_*', () => {
      const bits = RoleAttributeBits[RoleBitIndex.werehamster]
      assert.ok((bits & ATTR.FOX_FACTION) !== 0)
      assert.ok((bits & ATTR.PASSIVE_ATTACK_IMMUNE) !== 0)
      assert.ok((bits & ATTR.PASSIVE_DIE_WHEN_DIVINED) !== 0)
    })

    it('immoralist has FOX_FACTION + REACTIVE_FOLLOW_FOX_DEATH', () => {
      const bits = RoleAttributeBits[RoleBitIndex.immoralist]
      assert.ok((bits & ATTR.FOX_FACTION) !== 0)
      assert.ok((bits & ATTR.REACTIVE_FOLLOW_FOX_DEATH) !== 0)
      assert.ok((bits & ATTR.PASSIVE_DIE_WHEN_DIVINED) === 0)
    })

    it('nekomata has both curse-on-* reactive attrs', () => {
      const bits = RoleAttributeBits[RoleBitIndex.nekomata]
      assert.ok((bits & ATTR.REACTIVE_CURSE_ON_EXECUTED) !== 0)
      assert.ok((bits & ATTR.REACTIVE_CURSE_ON_KILLED) !== 0)
    })

    it('medium has AUTO_INFO_EXECUTION_SPECIES', () => {
      const bits = RoleAttributeBits[RoleBitIndex.medium]
      assert.ok((bits & ATTR.AUTO_INFO_EXECUTION_SPECIES) !== 0)
    })

    it('bodyguard has ACTION_GUARD', () => {
      const bits = RoleAttributeBits[RoleBitIndex.bodyguard]
      assert.ok((bits & ATTR.ACTION_GUARD) !== 0)
    })

    it('villager has no attribute bits set', () => {
      const bits = RoleAttributeBits[RoleBitIndex.villager]
      assert.strictEqual(bits, 0)
    })

    it('possessed/fanatic have WOLF_FACTION but no ACTION_ATTACK', () => {
      const possessed = RoleAttributeBits[RoleBitIndex.possessed]
      const fanatic = RoleAttributeBits[RoleBitIndex.fanatic]
      assert.ok((possessed & ATTR.WOLF_FACTION) !== 0)
      assert.ok((possessed & ATTR.ACTION_ATTACK) === 0)
      assert.ok((fanatic & ATTR.WOLF_FACTION) !== 0)
      assert.ok((fanatic & ATTR.ACTION_ATTACK) === 0)
    })
  })

  describe('roleAttributeBits()', () => {
    it('returns same value as direct index lookup', () => {
      assert.strictEqual(roleAttributeBits('seer'), RoleAttributeBits[RoleBitIndex.seer])
      assert.strictEqual(roleAttributeBits('paparazzi'), RoleAttributeBits[RoleBitIndex.paparazzi])
    })
  })

  describe('possibilityHasAttribute()', () => {
    it('detects ACTION_DIVINE in {seer}', () => {
      const p = RoleSignatureBits.seer
      assert.strictEqual(possibilityHasAttribute(p, ATTR.ACTION_DIVINE), true)
      assert.strictEqual(possibilityHasAttribute(p, ATTR.ACTION_ATTACK), false)
    })

    it('detects ACTION_DIVINE in {paparazzi}', () => {
      const p = RoleSignatureBits.paparazzi
      assert.strictEqual(possibilityHasAttribute(p, ATTR.ACTION_DIVINE), true)
      assert.strictEqual(possibilityHasAttribute(p, ATTR.WOLF_FACTION), true)
    })

    it('detects WOLF_FACTION in {villager, werewolf} mixed possibility', () => {
      const p = RoleSignatureBits.villager | RoleSignatureBits.werewolf
      assert.strictEqual(possibilityHasAttribute(p, ATTR.WOLF_FACTION), true)
    })

    it('returns false when no role in possibility has the attribute', () => {
      const p = RoleSignatureBits.villager | RoleSignatureBits.mason
      assert.strictEqual(possibilityHasAttribute(p, ATTR.ACTION_ATTACK), false)
      assert.strictEqual(possibilityHasAttribute(p, ATTR.WOLF_FACTION), false)
    })

    it('returns false for empty possibility (0)', () => {
      assert.strictEqual(possibilityHasAttribute(0, ATTR.WOLF_FACTION), false)
    })
  })

  describe('setupCountByAttribute()', () => {
    it('counts werewolf+paparazzi as WOLF_FACTION', () => {
      const setup = new Map<SystemRole, number>([
        ['werewolf', 2], ['paparazzi', 1], ['villager', 5],
      ])
      assert.strictEqual(setupCountByAttribute(setup, ATTR.WOLF_FACTION), 3)
    })

    it('counts only seer+paparazzi as ACTION_DIVINE', () => {
      const setup = new Map<SystemRole, number>([
        ['seer', 1], ['paparazzi', 1], ['werewolf', 2],
      ])
      assert.strictEqual(setupCountByAttribute(setup, ATTR.ACTION_DIVINE), 2)
    })

    it('counts werehamster+immoralist as FOX_FACTION', () => {
      const setup = new Map<SystemRole, number>([
        ['werehamster', 1], ['immoralist', 2], ['villager', 3],
      ])
      assert.strictEqual(setupCountByAttribute(setup, ATTR.FOX_FACTION), 3)
    })

    it('returns 0 for non-existent attribute in setup', () => {
      const setup = new Map<SystemRole, number>([['villager', 5]])
      assert.strictEqual(setupCountByAttribute(setup, ATTR.ACTION_ATTACK), 0)
    })
  })
})
