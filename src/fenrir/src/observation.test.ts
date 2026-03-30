import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OBSERVATION_SIZE, SEATS, NUM_ROLES, encodeObservation, tokenize,
  PLAN_TOKEN_FEATURES, MAX_PLAN_TOKENS } from './observation.ts'
import type { DecisionContext, ExecutionPlan } from '../../lupa/strategy.ts'
import { Rng } from '../../lupa/random.ts'
import { resolveRules } from '../../howl/ruleset.ts'

// セクションサイズ定数（observation.ts内部と一致すること）
const GLOBAL_SIZE = 19
const PER_SEAT_SIZE = 25
const SEAT_SECTION_SIZE = SEATS * PER_SEAT_SIZE  // 350
const PRIVATE_SIZE = SEATS + SEATS + 1 + SEATS + 1  // 44
const REVOTE_SIZE = 1 + SEATS  // 15
const HISTORY_SIZE = 3 * SEATS * 5  // 210
const RETAR_POSSIBILITIES_SIZE = SEATS * NUM_ROLES  // 154
const GLOBAL_RETAR_SIZE = SEATS * NUM_ROLES  // 154
const FAKE_RETAR_SIZE = SEATS * NUM_ROLES  // 154
const PLAN_SIZE = SEATS * 2 + 3  // 31
const PLAN_APPROVED_SIZE = SEATS  // 14
const NEW_SIGNALS_SIZE = SEATS * 4  // 56
const PLAN_TOKENS_SIZE = 1 + MAX_PLAN_TOKENS * PLAN_TOKEN_FEATURES  // 161
const PLAN_GLOBAL_SIZE = 3

// PLANセクションの開始オフセット
const PLAN_SECTION_START = GLOBAL_SIZE + SEAT_SECTION_SIZE + PRIVATE_SIZE
  + REVOTE_SIZE + HISTORY_SIZE + RETAR_POSSIBILITIES_SIZE + GLOBAL_RETAR_SIZE + FAKE_RETAR_SIZE

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
    globalRetarPossibilities: null,
    fakeRetarPossibilities: null,
    wolfTeammates: null,
    knownWolves: null,
    knownHamster: null,
    masonPartner: null,
    revoteRound: null,
    revoteCandidates: null,
    executionPlans: [],
    rules: resolveRules(),
    ...overrides,
  }
}

describe('OBSERVATION_SIZE', () => {
  it('equals expected total', () => {
    const expected = GLOBAL_SIZE + SEAT_SECTION_SIZE + PRIVATE_SIZE
      + REVOTE_SIZE + HISTORY_SIZE + RETAR_POSSIBILITIES_SIZE
      + GLOBAL_RETAR_SIZE + FAKE_RETAR_SIZE
      + PLAN_SIZE + PLAN_APPROVED_SIZE + NEW_SIGNALS_SIZE + PLAN_TOKENS_SIZE
    assert.equal(OBSERVATION_SIZE, expected)
    assert.equal(OBSERVATION_SIZE, 1362)
  })
})

describe('encodeObservation', () => {
  it('returns correct length', () => {
    const obs = encodeObservation(makeCtx())
    assert.equal(obs.length, OBSERVATION_SIZE)
  })

  it('plan section is all zeros when no plans', () => {
    const obs = encodeObservation(makeCtx({ executionPlans: [] }))
    for (let i = PLAN_SECTION_START; i < PLAN_SECTION_START + PLAN_SIZE; i++) {
      assert.equal(obs[i], 0, `obs[${i}] should be 0 when no plan`)
    }
  })

  it('encodes plan_included correctly', () => {
    const plan: ExecutionPlan = { targets: [3, 7], type: 'roller' }
    const obs = encodeObservation(makeCtx({ executionPlans: [plan] }))

    for (let seat = 1; seat <= SEATS; seat++) {
      const expected = (seat === 3 || seat === 7) ? 1 : 0
      assert.equal(obs[PLAN_SECTION_START + seat - 1], expected, `plan_included[seat${seat}]`)
    }
  })

  it('encodes plan_position correctly', () => {
    const plan: ExecutionPlan = { targets: [3, 7], type: 'roller' }
    const obs = encodeObservation(makeCtx({ executionPlans: [plan] }))
    const posStart = PLAN_SECTION_START + SEATS

    assert.equal(obs[posStart + 3 - 1], 0.5, 'seat3 position')
    assert.equal(obs[posStart + 7 - 1], 1.0, 'seat7 position')
    assert.equal(obs[posStart + 1 - 1], 0, 'seat1 position')
  })

  it('encodes plan global features correctly', () => {
    const plan: ExecutionPlan = { targets: [3, 7], type: 'roller' }
    const obs = encodeObservation(makeCtx({ executionPlans: [plan] }))
    const globalStart = PLAN_SECTION_START + SEATS * 2

    assert.ok(Math.abs(obs[globalStart] - 2 / 14) < 1e-6, 'plan_length')
    assert.equal(obs[globalStart + 1], 0, 'plan_is_grayran')
    assert.equal(obs[globalStart + 2], 1, 'plan_active')
  })

  it('encodes grayran plan correctly', () => {
    const plan: ExecutionPlan = { targets: [], type: 'grayran' }
    const obs = encodeObservation(makeCtx({ executionPlans: [plan] }))
    const globalStart = PLAN_SECTION_START + SEATS * 2

    for (let i = 0; i < SEATS; i++) {
      assert.equal(obs[PLAN_SECTION_START + i], 0, `plan_included[${i}]`)
    }
    assert.equal(obs[globalStart], 0, 'plan_length')
    assert.equal(obs[globalStart + 1], 1, 'plan_is_grayran')
    assert.equal(obs[globalStart + 2], 1, 'plan_active')
  })

  // ========== Plan Token tests ==========

  it('plan_token_count is 0 when no plans', () => {
    const obs = encodeObservation(makeCtx({ executionPlans: [] }))
    const tokenCountOffset = PLAN_SECTION_START + PLAN_SIZE + PLAN_APPROVED_SIZE + NEW_SIGNALS_SIZE
    assert.equal(obs[tokenCountOffset], 0)
  })

  it('encodes single plan token correctly', () => {
    const plan: ExecutionPlan = { targets: [3, 7], type: 'roller' }
    const obs = encodeObservation(makeCtx({ executionPlans: [plan] }))
    const tokenCountOffset = PLAN_SECTION_START + PLAN_SIZE + PLAN_APPROVED_SIZE + NEW_SIGNALS_SIZE
    const tokenDataOffset = tokenCountOffset + 1

    assert.equal(obs[tokenCountOffset], 1, 'plan_token_count')

    // target_mask[14]: seat 3 and 7 should be 1
    assert.equal(obs[tokenDataOffset + 3 - 1], 1, 'target_mask[3]')
    assert.equal(obs[tokenDataOffset + 7 - 1], 1, 'target_mask[7]')
    assert.equal(obs[tokenDataOffset + 1 - 1], 0, 'target_mask[1]')

    // type_onehot[5]: roller = index 0
    assert.equal(obs[tokenDataOffset + SEATS + 0], 1, 'type_onehot[roller]')
    assert.equal(obs[tokenDataOffset + SEATS + 1], 0, 'type_onehot[decision]')

    // priority[1]: single plan = 0
    assert.equal(obs[tokenDataOffset + SEATS + 5], 0, 'priority')
  })

  it('encodes multiple plan tokens correctly', () => {
    const plans: ExecutionPlan[] = [
      { targets: [3, 7], type: 'roller' },
      { targets: [5, 9], type: 'endgame' },
    ]
    const obs = encodeObservation(makeCtx({ executionPlans: plans }))
    const tokenCountOffset = PLAN_SECTION_START + PLAN_SIZE + PLAN_APPROVED_SIZE + NEW_SIGNALS_SIZE
    const tokenDataOffset = tokenCountOffset + 1

    assert.equal(obs[tokenCountOffset], 2, 'plan_token_count')

    // Token 0: roller
    assert.equal(obs[tokenDataOffset + 3 - 1], 1, 'plan0 target_mask[3]')
    assert.equal(obs[tokenDataOffset + SEATS + 0], 1, 'plan0 type=roller')

    // Token 1: endgame (offset by PLAN_TOKEN_FEATURES)
    const t1 = tokenDataOffset + PLAN_TOKEN_FEATURES
    assert.equal(obs[t1 + 5 - 1], 1, 'plan1 target_mask[5]')
    assert.equal(obs[t1 + 9 - 1], 1, 'plan1 target_mask[9]')
    assert.equal(obs[t1 + SEATS + 4], 1, 'plan1 type=endgame (index 4)')

    // Priority: plan0=0, plan1=1
    assert.equal(obs[tokenDataOffset + SEATS + 5], 0, 'plan0 priority=0')
    assert.equal(obs[t1 + SEATS + 5], 1, 'plan1 priority=1')
  })
})

describe('tokenize with plan tokens', () => {
  it('extracts plan tokens from encoded observation', () => {
    const plans: ExecutionPlan[] = [
      { targets: [3, 7], type: 'roller' },
      { targets: [5], type: 'designated' },
    ]
    const obs = encodeObservation(makeCtx({ executionPlans: plans }))
    const tok = tokenize(obs, false)

    assert.equal(tok.planCount, 2, 'planCount')
    assert.equal(tok.plans.length, 2 * PLAN_TOKEN_FEATURES, 'plans array length')

    // Plan 0: target_mask[3]=1, target_mask[7]=1, type=roller (index 0)
    assert.equal(tok.plans[3 - 1], 1, 'plan0 target[3]')
    assert.equal(tok.plans[7 - 1], 1, 'plan0 target[7]')
    assert.equal(tok.plans[SEATS + 0], 1, 'plan0 type=roller')

    // Plan 1: target_mask[5]=1, type=designated (index 2)
    const p1 = PLAN_TOKEN_FEATURES
    assert.equal(tok.plans[p1 + 5 - 1], 1, 'plan1 target[5]')
    assert.equal(tok.plans[p1 + SEATS + 2], 1, 'plan1 type=designated')
  })

  it('returns planCount=0 when no plans', () => {
    const obs = encodeObservation(makeCtx({ executionPlans: [] }))
    const tok = tokenize(obs, false)
    assert.equal(tok.planCount, 0)
    assert.equal(tok.plans.length, 0)
  })
})
