import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { endgameVoteReward, terminalReward, intermediateReward, DEFAULT_REWARD_CONFIG } from './reward.ts'
import type { SystemRole } from '../../types/index.ts'
import type { GameState, GameEvent } from '../../lupa/types.ts'

function roles(...names: SystemRole[]): Set<SystemRole> {
  return new Set(names)
}

describe('terminalReward — loseToFox', () => {
  it('village loses to fox → loseToFox penalty', () => {
    assert.equal(terminalReward('villager', 'werehamster_won'), DEFAULT_REWARD_CONFIG.loseToFox)
    assert.equal(terminalReward('seer', 'werehamster_won'), DEFAULT_REWARD_CONFIG.loseToFox)
  })

  it('wolf loses to fox → loseToFox penalty', () => {
    assert.equal(terminalReward('werewolf', 'werehamster_won'), DEFAULT_REWARD_CONFIG.loseToFox)
    assert.equal(terminalReward('fanatic', 'werehamster_won'), DEFAULT_REWARD_CONFIG.loseToFox)
  })

  it('loseToFox is harsher than lose', () => {
    assert.ok(DEFAULT_REWARD_CONFIG.loseToFox < DEFAULT_REWARD_CONFIG.lose)
  })

  it('fox wins → fox gets normal win reward', () => {
    assert.equal(terminalReward('werehamster', 'werehamster_won'), DEFAULT_REWARD_CONFIG.win)
  })

  it('village/wolf losing to each other still uses normal lose', () => {
    assert.equal(terminalReward('villager', 'werewolf_won'), DEFAULT_REWARD_CONFIG.lose)
    assert.equal(terminalReward('werewolf', 'villager_won'), DEFAULT_REWARD_CONFIG.lose)
  })
})

describe('intermediateReward — finalDayBonus', () => {
  function makeState(players: Array<{ seat: number, alive: boolean, role: string }>): GameState {
    return { players } as unknown as GameState
  }

  const executionEvent = { type: 'execution' } as GameEvent

  it('gives bonus to alive village players when alive <= 4', () => {
    const state = makeState([
      { seat: 0, alive: true, role: 'villager' },
      { seat: 1, alive: true, role: 'werewolf' },
      { seat: 2, alive: true, role: 'seer' },
      { seat: 3, alive: true, role: 'medium' },
      { seat: 4, alive: false, role: 'bodyguard' },
    ])
    const rewards = intermediateReward(executionEvent, state)
    // seat 0 (villager): finalDayBonus only
    assert.equal(rewards.get(0), DEFAULT_REWARD_CONFIG.finalDayBonus)
    // seat 1 (werewolf): lwSurvival only (wolf alignment, no finalDayBonus)
    assert.equal(rewards.get(1), DEFAULT_REWARD_CONFIG.lwSurvival)
    // seat 2 (seer): finalDayBonus
    assert.equal(rewards.get(2), DEFAULT_REWARD_CONFIG.finalDayBonus)
    // seat 4 (dead): no reward
    assert.equal(rewards.has(4), false)
  })

  it('no bonus when alive > 4', () => {
    const state = makeState([
      { seat: 0, alive: true, role: 'villager' },
      { seat: 1, alive: true, role: 'werewolf' },
      { seat: 2, alive: true, role: 'seer' },
      { seat: 3, alive: true, role: 'medium' },
      { seat: 4, alive: true, role: 'bodyguard' },
    ])
    const rewards = intermediateReward(executionEvent, state)
    // No finalDayBonus (5 alive), but lwSurvival for wolf
    assert.equal(rewards.has(0), false)
    assert.equal(rewards.get(1), DEFAULT_REWARD_CONFIG.lwSurvival)
  })

  it('wolf does not get finalDayBonus', () => {
    const state = makeState([
      { seat: 0, alive: true, role: 'villager' },
      { seat: 1, alive: true, role: 'werewolf' },
      { seat: 2, alive: true, role: 'seer' },
      { seat: 3, alive: false, role: 'medium' },
    ])
    const rewards = intermediateReward(executionEvent, state)
    // seat 1 (werewolf): lwSurvival only, no finalDayBonus
    assert.equal(rewards.get(1), DEFAULT_REWARD_CONFIG.lwSurvival)
    // seat 0 (villager): finalDayBonus only
    assert.equal(rewards.get(0), DEFAULT_REWARD_CONFIG.finalDayBonus)
  })
})

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
