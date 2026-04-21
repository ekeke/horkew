/**
 * knowledge config + observation feature の env テスト.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { AbstractGame } from './abstract-env.ts'
import { Rng } from './rng.ts'
import { encodeObservation, AGENT_FEATURE_DIMS } from './observation.ts'
import { ROLE_VOCABULARY, DESIRE_HIGH_BASE } from './types.ts'

describe('knowledge config (役職可能性集合)', () => {
  it('未指定なら全 seat に全 role 可能 (default 全 1)', () => {
    const env = new AbstractGame({
      numAgents: 3,
      desireCorrelation: 1.0,
      kRounds: 1,
    }, new Rng(1))
    const inputs = env.reset()
    for (const input of inputs) {
      assert.strictEqual(input.knowledgeByOther.length, 3)
      for (const set of input.knowledgeByOther) {
        for (const role of ROLE_VOCABULARY) {
          assert.ok(set.has(role), `default knowledge should include ${role}`)
        }
      }
    }
  })

  it('明示指定で specified set が入る', () => {
    const env = new AbstractGame({
      numAgents: 5,
      desireCorrelation: 1.0,
      kRounds: 1,
      knowledge: {
        2: {
          3: ['werewolf'],
          4: ['villager', 'fanatic'],
        },
      },
    }, new Rng(1))
    const inputs = env.reset()
    // viewer s2 視点
    const s2view = inputs[2].knowledgeByOther
    assert.deepStrictEqual([...s2view[3]].sort(), ['werewolf'])
    assert.deepStrictEqual([...s2view[4]].sort(), ['fanatic', 'villager'])
    // 未指定 (s0, s1) は default 全 role
    assert.strictEqual(s2view[0].size, ROLE_VOCABULARY.length)
    assert.strictEqual(s2view[1].size, ROLE_VOCABULARY.length)
    // viewer s3 視点 (knowledge 未指定 → 全部 default)
    const s3view = inputs[3].knowledgeByOther
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(s3view[i].size, ROLE_VOCABULARY.length, `s3 view of ${i} should be default full`)
    }
  })

  it('randomize あり でも論理→実 seat 変換が正しい', () => {
    const env = new AbstractGame({
      numAgents: 5,
      desireCorrelation: 1.0,
      kRounds: 1,
      randomizeRolesPerGame: true,
      knowledge: {
        2: { 3: ['werewolf'] },
      },
    }, new Rng(7))
    const inputs = env.reset()
    const actual2 = env.getActualSeat(2)
    const actual3 = env.getActualSeat(3)
    const view = inputs[actual2].knowledgeByOther
    assert.deepStrictEqual([...view[actual3]].sort(), ['werewolf'])
  })

  it('未知 role 名は throw', () => {
    assert.throws(() => {
      const env = new AbstractGame({
        numAgents: 3,
        desireCorrelation: 1.0,
        kRounds: 1,
        knowledge: {
          0: { 1: ['unknown_role' as 'villager'] },
        },
      }, new Rng(1))
      env.reset()
    }, /unknown role/)
  })
})

describe('knowledge mode の desire 生成 (primary-only)', () => {
  it('knowledge 未設定: 既存 teams ベース desire (teammate=LOW)', () => {
    const env = new AbstractGame({
      numAgents: 4,
      desireCorrelation: 1.0,                 // ノイズ 0
      kRounds: 1,
      teams: [[0, 1], [2, 3]],
      // primary は default primaryByTeam で team0 enemies = {2, 3}, shared random
    }, new Rng(1))
    const inputs = env.reset()
    // s0 視点 (team 0): s1 = teammate LOW, s2/s3 のいずれか primary HIGH, 残り MID
    const d = inputs[0].desire
    // s1 (teammate) は LOW = 0.00 付近
    assert.ok(d[1] < 0.025, `s1 should be LOW, got ${d[1]}`)
  })

  it('knowledge 設定時: primary-only mode で teammate も MID', () => {
    const env = new AbstractGame({
      numAgents: 4,
      desireCorrelation: 1.0,                 // ノイズ 0
      kRounds: 1,
      teams: [[0, 1], [2, 3]],
      knowledge: {                             // knowledge 設定 → primary-only mode
        0: { 1: ['villager'], 2: ['werewolf'], 3: ['werewolf'] },
      },
      fixedPrimaries: { 0: 2 },                // s0 の primary = s2
    }, new Rng(1))
    const inputs = env.reset()
    const d = inputs[0].desire
    // s2 = primary → HIGH = 0.10
    assert.ok(d[2] > 0.075 && d[2] < 0.125, `s2 should be HIGH, got ${d[2]}`)
    // s1 (teams 上は teammate) → primary-only mode では MID (LOW にならない)
    assert.ok(d[1] > 0.025 && d[1] < 0.075, `s1 should be MID (no team leak), got ${d[1]}`)
    // s3 (敵 non-primary) → MID
    assert.ok(d[3] > 0.025 && d[3] < 0.075, `s3 should be MID, got ${d[3]}`)
  })
})

describe('observation feature 12-14: knowledge multi-hot', () => {
  it('未指定 (default 全 role 可能) → 全 seat で features 12-14 が 1', () => {
    const env = new AbstractGame({
      numAgents: 3,
      desireCorrelation: 1.0,
      kRounds: 1,
    }, new Rng(1))
    const inputs = env.reset()
    const mid = encodeObservation({
      input: inputs[0],
      roundNumber: 0,
      messageHistory: [],
      pastCommitViolations: new Map(),
    }, 1)
    for (let i = 0; i < 3; i++) {
      for (let r = 0; r < ROLE_VOCABULARY.length; r++) {
        const feat = mid.agents[i * AGENT_FEATURE_DIMS + 12 + r]
        assert.strictEqual(feat, 1, `seat ${i} role ${ROLE_VOCABULARY[r]} should be 1, got ${feat}`)
      }
    }
  })

  it('明示指定で multi-hot が反映される (Hidden 想定)', () => {
    const env = new AbstractGame({
      numAgents: 5,
      desireCorrelation: 1.0,
      kRounds: 1,
      knowledge: {
        2: {
          3: ['werewolf'],
          4: ['villager', 'fanatic'],
        },
      },
    }, new Rng(1))
    const inputs = env.reset()
    const mid = encodeObservation({
      input: inputs[2],
      roundNumber: 0,
      messageHistory: [],
      pastCommitViolations: new Map(),
    }, 1)
    // s3 = 確定 werewolf
    const off3 = 3 * AGENT_FEATURE_DIMS
    assert.strictEqual(mid.agents[off3 + 12], 0)  // villager
    assert.strictEqual(mid.agents[off3 + 13], 1)  // werewolf
    assert.strictEqual(mid.agents[off3 + 14], 0)  // fanatic
    // s4 = villager か fanatic 不明
    const off4 = 4 * AGENT_FEATURE_DIMS
    assert.strictEqual(mid.agents[off4 + 12], 1)  // villager
    assert.strictEqual(mid.agents[off4 + 13], 0)  // werewolf
    assert.strictEqual(mid.agents[off4 + 14], 1)  // fanatic
  })
})
