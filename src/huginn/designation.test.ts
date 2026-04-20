/**
 * 指定進行 (designatedTargets) の env + observation テスト.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { AbstractGame, type EnvConfig } from './abstract-env.ts'
import type { Trace, AgentTrace } from './protocol.ts'
import type { HuginnInput, Message } from './types.ts'
import { DESIGNATION_VIOLATION_PENALTY } from './types.ts'
import { Rng } from './rng.ts'
import { encodeObservation, AGENT_FEATURE_DIMS } from './observation.ts'

function makeTrace(inputs: HuginnInput[], finalVoteIdxBySelf: number[]): Trace {
  const perAgent: AgentTrace[] = inputs.map((input) => ({
    agent: input.self,
    steps: [],
    messages: [] as Message[],
    finalVoteIdx: finalVoteIdxBySelf[input.self],
    finalVoteLogProb: 0,
    finalVoteValue: 0,
  }))
  return { perAgent, messageHistory: [] }
}

describe('designation (指定進行)', () => {
  it('未指定なら HuginnInput.isDesignationTarget は全 false', () => {
    const env = new AbstractGame({
      numAgents: 4,
      desireCorrelation: 1.0,
      kRounds: 1,
    }, new Rng(1))
    const inputs = env.reset()
    for (const input of inputs) {
      assert.strictEqual(input.isDesignationTarget.length, 4)
      for (const b of input.isDesignationTarget) assert.strictEqual(b, false)
    }
  })

  it('指定あり (randomize なし) で isDesignationTarget が論理 seat 位置に立つ', () => {
    const env = new AbstractGame({
      numAgents: 5,
      desireCorrelation: 1.0,
      kRounds: 1,
      designatedTargets: [2, 3],
    }, new Rng(1))
    const inputs = env.reset()
    for (const input of inputs) {
      assert.strictEqual(input.isDesignationTarget[0], false)
      assert.strictEqual(input.isDesignationTarget[1], false)
      assert.strictEqual(input.isDesignationTarget[2], true)
      assert.strictEqual(input.isDesignationTarget[3], true)
      assert.strictEqual(input.isDesignationTarget[4], false)
    }
  })

  it('randomize あり でも論理→実 seat 変換が正しい', () => {
    const config: EnvConfig = {
      numAgents: 5,
      desireCorrelation: 1.0,
      kRounds: 1,
      designatedTargets: [3, 4],
      randomizeRolesPerGame: true,
    }
    const env = new AbstractGame(config, new Rng(42))
    const inputs = env.reset()
    const actual3 = env.getActualSeat(3)
    const actual4 = env.getActualSeat(4)
    for (const input of inputs) {
      for (let i = 0; i < 5; i++) {
        const expected = (i === actual3 || i === actual4)
        assert.strictEqual(input.isDesignationTarget[i], expected, `seat ${i}: expected ${expected}`)
      }
    }
  })

  it('step: 集合外投票で learner にペナルティ発火、集合内では発火しない', () => {
    const env = new AbstractGame({
      numAgents: 4,
      desireCorrelation: 1.0,
      kRounds: 1,
      agentRoles: ['learning', 'learning', { type: 'fixedVote', target: 2 }, { type: 'fixedVote', target: 2 }],
      designatedTargets: [2],  // 指定対象 = s2 のみ
      outcomeRewards: {
        // desire shaping を消してペナルティだけ観察したい. 該当 outcome key に reward=0 を入れる.
        '2': { reward: 0, label: 'test' },
        '3': { reward: 0, label: 'test' },
        '0': { reward: 0, label: 'test' },
        '1': { reward: 0, label: 'test' },
      },
    }, new Rng(1))
    const inputs = env.reset()
    // s0 (learner) → s3 (集合外)
    // s1 (learner) → s2 (集合内)
    // s2, s3 (bot) → 影響外
    const trace = makeTrace(inputs, [3, 2, 2, 2])
    const result = env.step(trace)
    assert.strictEqual(result.rewards[0], DESIGNATION_VIOLATION_PENALTY)
    assert.strictEqual(result.rewards[1], 0)
  })

  it('step: designatedTargets 未指定なら penalty 加算なし', () => {
    const env = new AbstractGame({
      numAgents: 3,
      desireCorrelation: 1.0,
      kRounds: 1,
      agentRoles: ['learning', 'learning', { type: 'fixedVote', target: 0 }],
      outcomeRewards: {
        '2': { reward: 0.5, label: 'test' },
        '0,2': { reward: 0, label: 'test' },
      },
    }, new Rng(1))
    const inputs = env.reset()
    // learner 2 名が s2 に投票、bot が s0 に投票 → s2 eliminated
    const trace = makeTrace(inputs, [2, 2, 0])
    const result = env.step(trace)
    assert.strictEqual(result.rewards[0], 0.5)
    assert.strictEqual(result.rewards[1], 0.5)
  })

  it('step: outcomeRewards override 経路でも penalty 加算', () => {
    const env = new AbstractGame({
      numAgents: 4,
      desireCorrelation: 1.0,
      kRounds: 1,
      agentRoles: ['learning', 'learning', { type: 'fixedVote', target: 2 }, { type: 'fixedVote', target: 2 }],
      designatedTargets: [2],
      outcomeRewards: {
        '2': { reward: 1.0, label: 's2 吊り成功' },
      },
    }, new Rng(1))
    const inputs = env.reset()
    // s0 (learner) → s3 (集合外); s1 (learner) → s2 (集合内)
    // bot s2, s3 → s2. 結果: s2=3 票、s3=1 票 → s2 eliminated、outcome key='2' → reward=1.0
    const trace = makeTrace(inputs, [3, 2, 2, 2])
    const result = env.step(trace)
    assert.strictEqual(result.outcomeKey, '2')
    assert.strictEqual(result.rewards[0], 1.0 + DESIGNATION_VIOLATION_PENALTY)
    assert.strictEqual(result.rewards[1], 1.0)
  })

  it('step: bot (非 learner) は penalty 対象外', () => {
    const env = new AbstractGame({
      numAgents: 3,
      desireCorrelation: 1.0,
      kRounds: 1,
      agentRoles: ['learning', { type: 'fixedVote', target: 2 }, { type: 'fixedVote', target: 0 }],
      designatedTargets: [1],  // s1 のみ指定. bot s1 は s2 に、bot s2 は s0 に投票 (どちらも集合外)
      outcomeRewards: {
        '0': { reward: 0, label: 'test' },
        '2': { reward: 0, label: 'test' },
        '0,2': { reward: 0, label: 'test' },
      },
    }, new Rng(1))
    const inputs = env.reset()
    const trace = makeTrace(inputs, [1, 2, 0])
    const result = env.step(trace)
    // learner s0 は s1 (集合内) に投票 → penalty なし
    assert.strictEqual(result.rewards[0], 0)
    // bot s1, s2 は learner でないので penalty 対象外
    assert.strictEqual(result.rewards[1], 0)
    assert.strictEqual(result.rewards[2], 0)
  })

  it('observation: feature 11 に isDesignationTarget が乗る', () => {
    const env = new AbstractGame({
      numAgents: 4,
      desireCorrelation: 1.0,
      kRounds: 1,
      designatedTargets: [1, 3],
    }, new Rng(1))
    const inputs = env.reset()
    const mid = encodeObservation({
      input: inputs[0],
      roundNumber: 0,
      messageHistory: [],
      pastCommitViolations: new Map(),
    }, 1)
    for (let i = 0; i < 4; i++) {
      const feat = mid.agents[i * AGENT_FEATURE_DIMS + 11]
      const expected = (i === 1 || i === 3) ? 1 : 0
      assert.strictEqual(feat, expected, `feature 11 at seat ${i}: expected ${expected}, got ${feat}`)
    }
  })
})
