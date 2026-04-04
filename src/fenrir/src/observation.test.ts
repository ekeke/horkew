import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OBSERVATION_SIZE, SEATS, NUM_ROLES, encodeObservation, tokenize,
  NUM_PLAN_FORWARD, NUM_PLAN_ENDGAME, RAW_PLAN_START,
  FANATIC_OBSERVATION_SIZE, FANATIC_SEAT_FEATURES, FANATIC_CLS_FEATURES,
  encodeFanaticObservation, type VillageNNOutput } from './observation.ts'
import type { DecisionContext } from './agents/agent.ts'
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
const PLAN_APPROVED_SIZE = SEATS  // 14
const NEW_SIGNALS_SIZE = SEATS * 4  // 56
const RAW_PLAN_SIZE = NUM_PLAN_FORWARD + NUM_PLAN_ENDGAME  // 12
const TSUMI_SIZE = 1

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

    wolfTeammates: null,
    knownWolves: null,
    knownHamster: null,
    masonPartner: null,
    revoteRound: null,
    revoteCandidates: null,
    executionPlans: [],
    planForwardIndices: null,
    planEndgameIndices: null,
    tsumiTarget: null,
    rules: resolveRules(),
    ...overrides,
  }
}

describe('OBSERVATION_SIZE', () => {
  it('equals expected total', () => {
    const expected = GLOBAL_SIZE + SEAT_SECTION_SIZE + PRIVATE_SIZE
      + REVOTE_SIZE + HISTORY_SIZE + RETAR_POSSIBILITIES_SIZE
      + GLOBAL_RETAR_SIZE
      + PLAN_APPROVED_SIZE + NEW_SIGNALS_SIZE + RAW_PLAN_SIZE + TSUMI_SIZE
    assert.equal(OBSERVATION_SIZE, expected)
    assert.equal(OBSERVATION_SIZE, 1029)
  })
})

describe('encodeObservation', () => {
  it('returns correct length', () => {
    const obs = encodeObservation(makeCtx())
    assert.equal(obs.length, OBSERVATION_SIZE)
  })

  it('raw plan indices default to STOP (21) when no planForwardIndices', () => {
    const obs = encodeObservation(makeCtx({ planForwardIndices: null, planEndgameIndices: null }))
    for (let i = 0; i < NUM_PLAN_FORWARD + NUM_PLAN_ENDGAME; i++) {
      assert.equal(obs[RAW_PLAN_START + i], 21, `obs[RAW_PLAN_START+${i}] should be STOP(21)`)
    }
  })

  it('encodes raw plan forward indices correctly', () => {
    const indices = [2, 5, 14, 21, 0, 0, 0, 0]
    const obs = encodeObservation(makeCtx({ planForwardIndices: indices }))
    for (let i = 0; i < NUM_PLAN_FORWARD; i++) {
      assert.equal(obs[RAW_PLAN_START + i], indices[i], `forward index ${i}`)
    }
  })

  it('encodes raw plan endgame indices correctly', () => {
    const indices = [3, 10, 0, 0]
    const obs = encodeObservation(makeCtx({ planEndgameIndices: indices }))
    for (let i = 0; i < NUM_PLAN_ENDGAME; i++) {
      assert.equal(obs[RAW_PLAN_START + NUM_PLAN_FORWARD + i], indices[i], `endgame index ${i}`)
    }
  })
})

describe('tokenize with raw plan indices', () => {
  it('extracts planForward and planEndgame from encoded observation', () => {
    const fwdIndices = [2, 5, 14, 21, 0, 0, 0, 0]
    const egIndices = [3, 10, 0, 0]
    const obs = encodeObservation(makeCtx({ planForwardIndices: fwdIndices, planEndgameIndices: egIndices }))
    const tok = tokenize(obs, false)

    assert.equal(tok.planForward.length, NUM_PLAN_FORWARD, 'planForward length')
    assert.equal(tok.planEndgame.length, NUM_PLAN_ENDGAME, 'planEndgame length')

    for (let i = 0; i < NUM_PLAN_FORWARD; i++) {
      assert.equal(tok.planForward[i], fwdIndices[i], `planForward[${i}]`)
    }
    for (let i = 0; i < NUM_PLAN_ENDGAME; i++) {
      assert.equal(tok.planEndgame[i], egIndices[i], `planEndgame[${i}]`)
    }
  })

  it('returns STOP (21) plan indices when no plans', () => {
    const obs = encodeObservation(makeCtx({ planForwardIndices: null, planEndgameIndices: null }))
    const tok = tokenize(obs, false)
    for (let i = 0; i < NUM_PLAN_FORWARD; i++) {
      assert.equal(tok.planForward[i], 21, `planForward[${i}]`)
    }
    for (let i = 0; i < NUM_PLAN_ENDGAME; i++) {
      assert.equal(tok.planEndgame[i], 21, `planEndgame[${i}]`)
    }
  })
})

// ============================================================
// encodeFanaticObservation
// ============================================================

describe('encodeFanaticObservation', () => {
  it('produces correct size', () => {
    const ctx = makeCtx({ myRole: 'fanatic' })
    const obs = encodeFanaticObservation(ctx)
    assert.equal(obs.length, FANATIC_OBSERVATION_SIZE)
  })

  it('base observation matches individual encoding', () => {
    const ctx = makeCtx({ myRole: 'fanatic' })
    const individual = encodeObservation(ctx)
    const fanatic = encodeFanaticObservation(ctx)
    // First OBSERVATION_SIZE elements should be identical
    for (let i = 0; i < OBSERVATION_SIZE; i++) {
      assert.equal(fanatic[i], individual[i], `mismatch at offset ${i}`)
    }
  })

  it('injects village NN output at correct offsets', () => {
    const ctx = makeCtx({ myRole: 'fanatic' })
    const villageOutput: VillageNNOutput = {
      predict: new Float32Array(SEATS * NUM_ROLES),
      trust: new Float32Array(SEATS),
    }
    // Set some distinctive values
    villageOutput.predict[0] = 0.9   // seat 1, role 0
    villageOutput.predict[11] = 0.7  // seat 2, role 0
    villageOutput.trust[0] = 0.8     // seat 1
    villageOutput.trust[1] = 0.6     // seat 2

    const obs = encodeFanaticObservation(ctx, villageOutput)
    assert.equal(obs.length, FANATIC_OBSERVATION_SIZE)

    // village_predict starts at OBSERVATION_SIZE
    assert.ok(Math.abs(obs[OBSERVATION_SIZE] - 0.9) < 1e-6, 'village_predict seat1 role0')
    assert.ok(Math.abs(obs[OBSERVATION_SIZE + 11] - 0.7) < 1e-6, 'village_predict seat2 role0')

    // village_trust starts at OBSERVATION_SIZE + SEATS * NUM_ROLES
    const trustStart = OBSERVATION_SIZE + SEATS * NUM_ROLES
    assert.ok(Math.abs(obs[trustStart] - 0.8) < 1e-6, 'village_trust seat1')
    assert.ok(Math.abs(obs[trustStart + 1] - 0.6) < 1e-6, 'village_trust seat2')
  })

  it('without village NN output, extension is zeros', () => {
    const ctx = makeCtx({ myRole: 'fanatic' })
    const obs = encodeFanaticObservation(ctx)
    for (let i = OBSERVATION_SIZE; i < FANATIC_OBSERVATION_SIZE; i++) {
      assert.equal(obs[i], 0, `non-zero at offset ${i}`)
    }
  })
})

// ============================================================
// tokenize('fanatic')
// ============================================================

describe('tokenize fanatic mode', () => {
  it('produces correct dimensions', () => {
    const obs = new Float32Array(FANATIC_OBSERVATION_SIZE)
    const tok = tokenize(obs, 'fanatic')
    assert.equal(tok.seatFeatures, FANATIC_SEAT_FEATURES, 'seatFeatures')
    assert.equal(tok.clsFeatures, FANATIC_CLS_FEATURES, 'clsFeatures')
    assert.equal(tok.seats.length, SEATS * FANATIC_SEAT_FEATURES, 'seats array length')
    assert.equal(tok.cls.length, FANATIC_CLS_FEATURES, 'cls array length')
  })

  it('includes village_predict and village_trust in seat tokens', () => {
    const obs = new Float32Array(FANATIC_OBSERVATION_SIZE)
    // Set village_predict for seat 1, role 0
    obs[OBSERVATION_SIZE] = 0.5
    // Set village_trust for seat 1
    obs[OBSERVATION_SIZE + SEATS * NUM_ROLES] = 0.3

    const tok = tokenize(obs, 'fanatic')
    // Last 12 features of seat 1 token: village_predict(11) + village_trust(1)
    const sf = FANATIC_SEAT_FEATURES
    const baseSf = sf - NUM_ROLES - 1  // individual base features
    assert.ok(Math.abs(tok.seats[baseSf] - 0.5) < 1e-6, 'village_predict[0] in seat 1 token')
    assert.ok(Math.abs(tok.seats[baseSf + NUM_ROLES] - 0.3) < 1e-6, 'village_trust in seat 1 token')
  })
})
