import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { MCTSResult } from '../mcts/ISMCTS.ts'
import { buildDesire } from './desire.ts'

function makeCtx(overrides: Partial<DecisionContext>): DecisionContext {
  return {
    mySeat: 1,
    myRole: 'villager',
    wolfTeammates: null,
    knownWolves: null,
    knownHamster: null,
    masonPartner: null,
    ...overrides,
  } as DecisionContext
}

function mctsFrom(visits: [number, number][]): MCTSResult {
  return { root: null as any, visits: new Map(visits), abortReason: null }
}

describe('buildDesire', () => {
  it('MCTS null → 全員 MID の flat', () => {
    const d = buildDesire(null, makeCtx({ mySeat: 3 }), [1, 2, 3, 4, 5])
    for (const v of d) assert.equal(v, 0.05)
  })

  it('MCTS visits 空 → flat MID', () => {
    const d = buildDesire(mctsFrom([]), makeCtx({ mySeat: 1 }), [1, 2, 3])
    for (const v of d) assert.equal(v, 0.05)
  })

  it('MCTS top-1 → HIGH、teammate (self) → LOW、残り MID', () => {
    const ctx = makeCtx({ mySeat: 2 })
    const d = buildDesire(
      mctsFrom([[1, 10], [4, 50], [5, 20]]),  // top-1 = seat 4
      ctx,
      [1, 2, 3, 4, 5],
    )
    assert.equal(d[0], 0.05, 'seat 1 = MID')
    assert.equal(d[1], 0.00, 'seat 2 (self) = LOW')
    assert.equal(d[2], 0.05, 'seat 3 = MID')
    assert.equal(d[3], 0.10, 'seat 4 (top-1) = HIGH')
    assert.equal(d[4], 0.05, 'seat 5 = MID')
  })

  it('狼視点: wolfTeammates は LOW', () => {
    const ctx = makeCtx({ mySeat: 1, myRole: 'werewolf', wolfTeammates: [7, 11] })
    const d = buildDesire(
      mctsFrom([[3, 100]]),
      ctx,
      [1, 3, 7, 11],
    )
    assert.equal(d[0], 0.00, 'self LOW')
    assert.equal(d[1], 0.10, 'top-1 HIGH')
    assert.equal(d[2], 0.00, 'teammate 7 LOW')
    assert.equal(d[3], 0.00, 'teammate 11 LOW')
  })

  it('top-1 が teammate → その席は LOW (primary 不在扱い)', () => {
    const ctx = makeCtx({ mySeat: 1, wolfTeammates: [4] })
    const d = buildDesire(
      mctsFrom([[4, 100], [3, 5]]),  // top-1 は teammate の seat 4
      ctx,
      [1, 3, 4, 5],
    )
    assert.equal(d[0], 0.00, 'self LOW')
    assert.equal(d[1], 0.05, 'seat 3 MID')
    assert.equal(d[2], 0.00, 'seat 4 は teammate なので LOW が優先')
    assert.equal(d[3], 0.05, 'seat 5 MID')
  })

  it('共有視点: masonPartner は LOW', () => {
    const ctx = makeCtx({ mySeat: 2, myRole: 'mason', masonPartner: 8 })
    const d = buildDesire(mctsFrom([[5, 10]]), ctx, [2, 5, 8])
    assert.equal(d[0], 0.00, 'self LOW')
    assert.equal(d[1], 0.10, 'top-1 HIGH')
    assert.equal(d[2], 0.00, 'masonPartner LOW')
  })

  it('背徳視点: knownHamster は LOW', () => {
    const ctx = makeCtx({ mySeat: 3, myRole: 'immoralist', knownHamster: 9 })
    const d = buildDesire(mctsFrom([[6, 20]]), ctx, [3, 6, 9])
    assert.equal(d[0], 0.00)
    assert.equal(d[1], 0.10)
    assert.equal(d[2], 0.00, 'knownHamster LOW')
  })
})
