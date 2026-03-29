import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OBSERVATION_SIZE, SEATS, NUM_ROLES, encodeObservation } from './observation.ts'
import type { DecisionContext, ExecutionPlan } from '../../lupa/strategy.ts'
import { Rng } from '../../lupa/random.ts'

// セクションサイズ定数（observation.ts内部と一致すること）
const GLOBAL_SIZE = 19
const PER_SEAT_SIZE = 25
const SEAT_SECTION_SIZE = SEATS * PER_SEAT_SIZE  // 350
const PRIVATE_SIZE = SEATS + SEATS + 1 + SEATS + 1  // 44
const REVOTE_SIZE = 1 + SEATS  // 15
const HISTORY_SIZE = 3 * SEATS * 5  // 210
const RETAR_POSSIBILITIES_SIZE = SEATS * NUM_ROLES  // 154
const PLAN_SIZE = SEATS * 2 + 3  // 31

/** テスト用の最小DecisionContext */
function makeCtx(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    mySeat: 1,
    myRole: 'villager',
    myPlayer: {
      seat: 1, role: 'villager', alive: true, claimed: null,
      divineHistory: new Map(), guardHistory: new Map(), fakeDivineHistory: null,
    } as any,
    day: 2,
    phase: 'day',
    alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    publicEvents: [],
    signals: [],
    commander: null,
    proposals: [],
    rng: new Rng(42),
    gameState: { day: 2, phase: 'day', players: [], commander: null } as any,
    lastExecutedSeat: null,
    retarPossibilities: null,
    maxSurvivingNV: null,
    wolfTeammates: null,
    knownWolves: null,
    knownHamster: null,
    masonPartner: null,
    revoteRound: null,
    revoteCandidates: null,
    executionPlan: null,
    ...overrides,
  }
}

describe('OBSERVATION_SIZE', () => {
  it('equals expected total', () => {
    const expected = GLOBAL_SIZE + SEAT_SECTION_SIZE + PRIVATE_SIZE
      + REVOTE_SIZE + HISTORY_SIZE + RETAR_POSSIBILITIES_SIZE + PLAN_SIZE
    assert.equal(OBSERVATION_SIZE, expected)
    assert.equal(OBSERVATION_SIZE, 823)
  })
})

describe('encodeObservation', () => {
  it('returns correct length', () => {
    const obs = encodeObservation(makeCtx())
    assert.equal(obs.length, OBSERVATION_SIZE)
  })

  it('plan section is all zeros when executionPlan is null', () => {
    const obs = encodeObservation(makeCtx({ executionPlan: null }))
    const planStart = OBSERVATION_SIZE - PLAN_SIZE
    for (let i = planStart; i < OBSERVATION_SIZE; i++) {
      assert.equal(obs[i], 0, `obs[${i}] should be 0 when no plan`)
    }
  })

  it('encodes plan_included correctly', () => {
    const plan: ExecutionPlan = { targets: [3, 7], isGrayran: false }
    const obs = encodeObservation(makeCtx({ executionPlan: plan }))
    const planStart = OBSERVATION_SIZE - PLAN_SIZE

    // plan_included: 14次元 (seats 1..14)
    for (let seat = 1; seat <= SEATS; seat++) {
      const expected = (seat === 3 || seat === 7) ? 1 : 0
      assert.equal(obs[planStart + seat - 1], expected, `plan_included[seat${seat}]`)
    }
  })

  it('encodes plan_position correctly', () => {
    const plan: ExecutionPlan = { targets: [3, 7], isGrayran: false }
    const obs = encodeObservation(makeCtx({ executionPlan: plan }))
    const posStart = OBSERVATION_SIZE - PLAN_SIZE + SEATS  // after plan_included

    // seat3 = targets[0] → position = 1/2 = 0.5
    assert.equal(obs[posStart + 3 - 1], 0.5, 'seat3 position')
    // seat7 = targets[1] → position = 2/2 = 1.0
    assert.equal(obs[posStart + 7 - 1], 1.0, 'seat7 position')
    // seat1 not in plan → 0
    assert.equal(obs[posStart + 1 - 1], 0, 'seat1 position')
  })

  it('encodes plan global features correctly', () => {
    const plan: ExecutionPlan = { targets: [3, 7], isGrayran: false }
    const obs = encodeObservation(makeCtx({ executionPlan: plan }))
    const globalStart = OBSERVATION_SIZE - PLAN_GLOBAL_SIZE

    // plan_length = 2/14
    assert.ok(Math.abs(obs[globalStart] - 2 / 14) < 1e-6, 'plan_length')
    // plan_is_grayran = 0
    assert.equal(obs[globalStart + 1], 0, 'plan_is_grayran')
    // plan_active = 1
    assert.equal(obs[globalStart + 2], 1, 'plan_active')
  })

  it('encodes grayran plan correctly', () => {
    const plan: ExecutionPlan = { targets: [], isGrayran: true }
    const obs = encodeObservation(makeCtx({ executionPlan: plan }))
    const planStart = OBSERVATION_SIZE - PLAN_SIZE
    const globalStart = OBSERVATION_SIZE - PLAN_GLOBAL_SIZE

    // all plan_included should be 0
    for (let i = 0; i < SEATS; i++) {
      assert.equal(obs[planStart + i], 0, `plan_included[${i}]`)
    }
    // plan_length = 0
    assert.equal(obs[globalStart], 0, 'plan_length')
    // plan_is_grayran = 1
    assert.equal(obs[globalStart + 1], 1, 'plan_is_grayran')
    // plan_active = 1
    assert.equal(obs[globalStart + 2], 1, 'plan_active')
  })
})

const PLAN_GLOBAL_SIZE = 3
