/**
 * UnifiedVoteAnalysis converter / NN-inference のユニットテスト。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SEATS } from '../fenrir/src/observation.ts'
import type { AnyNetwork, ForwardResult, NetworkConfig } from '../fenrir/src/ml/nn.ts'
import {
  unifyVillageAnalysis, unifyWolfAnalysis, unifyHamsterAnalysis, nnInferVote,
} from './unified.ts'

// ──────────────────────────────────────────────
// Mock network: 任意の logits を返すだけ
// ──────────────────────────────────────────────
function mockNetwork(voteLogits: Float32Array): AnyNetwork {
  const config = {} as NetworkConfig
  return {
    config,
    forward(_input: Float32Array): ForwardResult {
      return {
        policies: new Map([['vote', voteLogits]]),
        sigmoidPolicies: new Map(),
        value: 0,
      } as unknown as ForwardResult
    },
    getParams() { return [] },
    cloneWeights() { return new Map() },
    loadWeights() {},
    get totalParams() { return 0 },
  }
}

// ──────────────────────────────────────────────
// unifyVillageAnalysis
// ──────────────────────────────────────────────
test('unifyVillageAnalysis: bestExecution が自席でなければそのまま', () => {
  const u = unifyVillageAnalysis({
    totalWorlds: 100, truncated: false,
    executions: [{ seat: 1, winRate: 0.3 }, { seat: 2, winRate: 0.7 }, { seat: 3, winRate: 0.5 }],
    bestExecution: 2, overallWinRate: 0.5,
  }, /*mySeat*/ 1, /*partnerSeat*/ null)
  assert.equal(u.source, 'skoll-exact')
  assert.equal(u.bestVote, 2)
  assert.equal(u.totalWorlds, 100)
  assert.equal(u.candidates.find(c => c.seat === 1)?.excluded, true)
  assert.equal(u.candidates.find(c => c.seat === 2)?.excluded, false)
})

test('unifyVillageAnalysis: bestExecution が自席なら次善手を選ぶ', () => {
  const u = unifyVillageAnalysis({
    totalWorlds: 50, truncated: false,
    executions: [{ seat: 1, winRate: 0.9 }, { seat: 2, winRate: 0.7 }, { seat: 3, winRate: 0.5 }],
    bestExecution: 1, overallWinRate: 0.5,
  }, /*mySeat*/ 1, null)
  assert.equal(u.bestVote, 2, '自席除外で次点 seat 2 が選ばれる')
})

test('unifyVillageAnalysis: mason 時は partner も除外', () => {
  const u = unifyVillageAnalysis({
    totalWorlds: 50, truncated: false,
    executions: [{ seat: 1, winRate: 0.9 }, { seat: 2, winRate: 0.7 }, { seat: 3, winRate: 0.5 }],
    bestExecution: 2, overallWinRate: 0.5,
  }, /*mySeat*/ 1, /*partner*/ 2)
  assert.equal(u.bestVote, 3, '自席+partner 除外で seat 3')
  assert.equal(u.candidates.find(c => c.seat === 2)?.excluded, true)
})

test('unifyVillageAnalysis: truncated → source=skoll-truncated', () => {
  const u = unifyVillageAnalysis({
    totalWorlds: 1_000_000, truncated: true,
    executions: [{ seat: 2, winRate: 0.6 }],
    bestExecution: 2, overallWinRate: 0.6,
  }, 1, null)
  assert.equal(u.source, 'skoll-truncated')
})

// ──────────────────────────────────────────────
// unifyWolfAnalysis
// ──────────────────────────────────────────────
test('unifyWolfAnalysis: isTeammate を excluded に伝搬、ppAlreadyAchieved を保持', () => {
  const u = unifyWolfAnalysis({
    totalWorlds: 200, truncated: false,
    candidates: [
      { seat: 1, wolfWinRate: 0.2, isTeammate: true },
      { seat: 2, wolfWinRate: 0.8, isTeammate: false },
    ],
    bestVote: 2, ppAlreadyAchieved: true, ppByExecution: [],
  })
  assert.equal(u.source, 'skoll-exact')
  assert.equal(u.bestVote, 2)
  assert.equal(u.ppAlreadyAchieved, true)
  assert.equal(u.candidates.find(c => c.seat === 1)?.excluded, true)
  assert.equal(u.candidates.find(c => c.seat === 2)?.excluded, false)
  assert.equal(u.candidates.find(c => c.seat === 2)?.score, 0.8)
})

// ──────────────────────────────────────────────
// unifyHamsterAnalysis
// ──────────────────────────────────────────────
test('unifyHamsterAnalysis: isSelf を excluded に', () => {
  const u = unifyHamsterAnalysis({
    totalWorlds: 80, truncated: false,
    candidates: [
      { seat: 1, hamsterWinRate: 0.0, isSelf: true },
      { seat: 2, hamsterWinRate: 0.4, isSelf: false },
    ],
    bestVote: 2, overallHamsterWinRate: 0.2,
  })
  assert.equal(u.bestVote, 2)
  assert.equal(u.candidates.find(c => c.seat === 1)?.excluded, true)
  assert.equal(u.candidates.find(c => c.seat === 2)?.score, 0.4)
})

// ──────────────────────────────────────────────
// nnInferVote
// ──────────────────────────────────────────────
test('nnInferVote: excluded 外の最大 logit を bestVote に', () => {
  const logits = new Float32Array(SEATS)
  logits[0] = 5  // seat 1: 除外
  logits[1] = 3  // seat 2: 候補
  logits[2] = 4  // seat 3: 候補, 最大
  const net = mockNetwork(logits)
  const u = nnInferVote(net, new Float32Array(10), [1, 2, 3], new Set([1]))
  assert.equal(u.source, 'nn')
  assert.equal(u.bestVote, 3)
  assert.equal(u.candidates.length, 3)
  assert.equal(u.candidates[0].excluded, true)
  // softmax 確率は alive 内で正規化されている
  const sum = u.candidates.reduce((s, c) => s + c.score, 0)
  assert.ok(Math.abs(sum - 1.0) < 1e-5, `softmax sum=${sum}`)
})

test('nnInferVote: 全 alive seat が excluded なら bestVote=null', () => {
  const logits = new Float32Array(SEATS)
  const net = mockNetwork(logits)
  const u = nnInferVote(net, new Float32Array(10), [1, 2], new Set([1, 2]))
  assert.equal(u.bestVote, null)
})

test('nnInferVote: vote logits が無ければ candidates 空', () => {
  const net: AnyNetwork = {
    config: {} as NetworkConfig,
    forward: () => ({ policies: new Map(), sigmoidPolicies: new Map(), value: 0 } as unknown as ForwardResult),
    getParams: () => [],
    cloneWeights: () => new Map(),
    loadWeights: () => {},
    get totalParams() { return 0 },
  }
  const u = nnInferVote(net, new Float32Array(10), [1, 2], new Set())
  assert.equal(u.bestVote, null)
  assert.equal(u.candidates.length, 0)
})
