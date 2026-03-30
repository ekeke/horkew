import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { endgameVoteReward, DEFAULT_REWARD_CONFIG } from './reward.ts'
import type { SystemRole } from '../../types/index.ts'

function roles(...names: SystemRole[]): Set<SystemRole> {
  return new Set(names)
}

describe('endgameVoteReward', () => {
  it('returns 0 when aliveCount > 6', () => {
    assert.equal(endgameVoteReward(7, roles('werewolf')), 0)
    assert.equal(endgameVoteReward(10, roles('werehamster', 'villager')), 0)
  })

  it('returns 0 when targetPossibilities is undefined', () => {
    assert.equal(endgameVoteReward(4, undefined), 0)
    assert.equal(endgameVoteReward(6, undefined), 0)
  })

  // 最終日前日 (4 < alive <= 6)
  describe('pre-final day (alive 5-6)', () => {
    it('fox candidate → positive reward', () => {
      const r = endgameVoteReward(6, roles('werehamster', 'villager'))
      assert.equal(r, DEFAULT_REWARD_CONFIG.endgamePreFinalFoxTarget)
      assert.ok(r > 0)
    })

    it('fox + wolf candidate → positive reward (fox takes priority)', () => {
      const r = endgameVoteReward(5, roles('werewolf', 'werehamster'))
      assert.equal(r, DEFAULT_REWARD_CONFIG.endgamePreFinalFoxTarget)
      assert.ok(r > 0)
    })

    it('confirmed wolf (LW candidate) → negative penalty', () => {
      const r = endgameVoteReward(6, roles('werewolf'))
      assert.equal(r, DEFAULT_REWARD_CONFIG.endgamePreFinalLWTarget)
      assert.ok(r < 0)
    })

    it('wolf among multiple possibilities → 0 (not confirmed LW)', () => {
      assert.equal(endgameVoteReward(6, roles('werewolf', 'villager')), 0)
    })

    it('no wolf/fox → 0', () => {
      assert.equal(endgameVoteReward(6, roles('villager', 'seer')), 0)
    })
  })

  // 最終日 (alive <= 4)
  describe('final day (alive 3-4)', () => {
    it('confirmed wolf (single role) → big positive', () => {
      const r = endgameVoteReward(4, roles('werewolf'))
      assert.equal(r, DEFAULT_REWARD_CONFIG.endgameFinalConfirmedWolf)
      assert.ok(r > DEFAULT_REWARD_CONFIG.endgameFinalWolfTarget)
    })

    it('fox candidate → big negative', () => {
      const r = endgameVoteReward(3, roles('werehamster', 'villager'))
      assert.equal(r, DEFAULT_REWARD_CONFIG.endgameFinalFoxTarget)
      assert.ok(r < 0)
    })

    it('wolf candidate (no fox) → positive', () => {
      const r = endgameVoteReward(4, roles('werewolf', 'villager'))
      assert.equal(r, DEFAULT_REWARD_CONFIG.endgameFinalWolfTarget)
      assert.ok(r > 0)
    })

    it('wolf + fox → negative (fox takes priority)', () => {
      const r = endgameVoteReward(4, roles('werewolf', 'werehamster'))
      assert.equal(r, DEFAULT_REWARD_CONFIG.endgameFinalFoxTarget)
      assert.ok(r < 0)
    })

    it('no wolf/fox → 0', () => {
      assert.equal(endgameVoteReward(4, roles('seer', 'medium')), 0)
    })
  })
})
