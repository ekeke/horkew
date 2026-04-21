/**
 * knowledge config + observation feature の env テスト.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { AbstractGame } from './abstract-env.ts'
import { Rng } from './rng.ts'
import { encodeObservation, AGENT_FEATURE_DIMS } from './observation.ts'
import { ROLE_VOCABULARY, type RoleName } from './types.ts'

// 全 seat を villager 扱いする test 用 roles (viewerRole の具体値が本質でない mechanism test 向け).
function allVillager(n: number): Record<number, RoleName> {
  const r: Record<number, RoleName> = {}
  for (let i = 0; i < n; i++) r[i] = 'villager'
  return r
}

describe('knowledge config (役職可能性集合)', () => {
  it('未指定なら全 seat に全 role 可能 (default 全 1)', () => {
    const env = new AbstractGame({
      numAgents: 3,
      roles: allVillager(3),
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
      roles: allVillager(5),
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
      roles: allVillager(5),
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
        roles: allVillager(3),
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
      roles: allVillager(4),
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
      roles: allVillager(4),
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

describe('observation feature 12..(12+|vocab|-1): knowledge multi-hot', () => {
  it('未指定 (default 全 role 可能) → 全 seat で role multi-hot が全 1', () => {
    const env = new AbstractGame({
      numAgents: 3,
      roles: allVillager(3),
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
      roles: allVillager(5),
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
    // ROLE_VOCABULARY 順に対応する feature index を role 名で参照 (vocab 拡張耐性).
    const featOf = (role: typeof ROLE_VOCABULARY[number]) => 12 + ROLE_VOCABULARY.indexOf(role)
    // s3 = 確定 werewolf
    const off3 = 3 * AGENT_FEATURE_DIMS
    assert.strictEqual(mid.agents[off3 + featOf('villager')], 0)
    assert.strictEqual(mid.agents[off3 + featOf('werewolf')], 1)
    assert.strictEqual(mid.agents[off3 + featOf('fanatic')], 0)
    // s3 は他役職すべて 0 のはず
    for (const role of ROLE_VOCABULARY) {
      if (role === 'werewolf') continue
      assert.strictEqual(mid.agents[off3 + featOf(role)], 0, `s3 ${role} should be 0`)
    }
    // s4 = villager か fanatic 不明 (他役職すべて 0)
    const off4 = 4 * AGENT_FEATURE_DIMS
    assert.strictEqual(mid.agents[off4 + featOf('villager')], 1)
    assert.strictEqual(mid.agents[off4 + featOf('werewolf')], 0)
    assert.strictEqual(mid.agents[off4 + featOf('fanatic')], 1)
    for (const role of ROLE_VOCABULARY) {
      if (role === 'villager' || role === 'fanatic') continue
      assert.strictEqual(mid.agents[off4 + featOf(role)], 0, `s4 ${role} should be 0`)
    }
  })
})

describe('CLS viewer role one-hot', () => {
  it('viewerRole が CLS feature 8+roleIdx に one-hot encode される', () => {
    const env = new AbstractGame({
      numAgents: 4,
      roles: { 0: 'werewolf', 1: 'villager', 2: 'fanatic', 3: 'werehamster' },
      desireCorrelation: 1.0,
      kRounds: 1,
    }, new Rng(1))
    const inputs = env.reset()
    for (let self = 0; self < 4; self++) {
      const mid = encodeObservation({
        input: inputs[self],
        roundNumber: 0,
        messageHistory: [],
        pastCommitViolations: new Map(),
      }, 1)
      const expectedIdx = ROLE_VOCABULARY.indexOf(inputs[self].viewerRole)
      for (let r = 0; r < ROLE_VOCABULARY.length; r++) {
        const expected = r === expectedIdx ? 1 : 0
        assert.strictEqual(
          mid.cls[8 + r], expected,
          `self=${self} role=${inputs[self].viewerRole} cls[8+${r}]=${mid.cls[8 + r]} expected ${expected}`,
        )
      }
    }
  })

  it('randomize あり でも viewerRole は論理 seat の role を実 seat に持ち込む', () => {
    const logicalRoles: Record<number, RoleName> = { 0: 'werewolf', 1: 'villager', 2: 'fanatic', 3: 'werehamster' }
    const env = new AbstractGame({
      numAgents: 4,
      roles: logicalRoles,
      desireCorrelation: 1.0,
      kRounds: 1,
      randomizeRolesPerGame: true,
    }, new Rng(42))
    const inputs = env.reset()
    for (let logical = 0; logical < 4; logical++) {
      const actual = env.getActualSeat(logical)
      assert.strictEqual(inputs[actual].viewerRole, logicalRoles[logical], `logical ${logical} → actual ${actual}`)
    }
  })

  it('roles 未指定で throw', () => {
    // roles 必須: 型エラー回避で unknown 経由で config を渡し、run-time 検証のみ走らせる.
    const config = {
      numAgents: 3,
      desireCorrelation: 1.0,
      kRounds: 1,
    }
    assert.throws(() => {
      const env = new AbstractGame(config as unknown as ConstructorParameters<typeof AbstractGame>[0], new Rng(1))
      env.reset()
    }, /roles\[0\] is required|Cannot read/)
  })
})
