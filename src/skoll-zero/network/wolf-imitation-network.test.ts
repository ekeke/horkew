/**
 * WolfImitationNetwork の mix 計算 unit test。
 *
 * 検証項目:
 * - mixClaimDecision: α=0 で village base、α=1 で wolf 完全 + 確率分布の正規化、4 viewer の skip 平均
 * - mixMorning: α=0 で target が divine と一致、α=1 で target が wolf 寄り、Σ=1
 * - 退化ケース
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { SystemRole } from '../../types/index.ts'
import type { ForwardResult } from '../../fenrir/src/ml/nn.ts'
import { mixClaimDecision, mixMorning } from './wolf-imitation-network.ts'

const SEATS = 14
const ROLES: readonly SystemRole[] = ['seer', 'medium', 'bodyguard', 'nekomata']
const CLAIM_DECISION_SIZE = 1 + ROLES.length * SEATS  // 57

/** test 用 fake ForwardResult builder */
function fakeResult(headLogits: Record<string, number[]>): ForwardResult {
  const policies = new Map<string, Float32Array>()
  for (const [name, arr] of Object.entries(headLogits)) {
    policies.set(name, new Float32Array(arr))
  }
  return { policies, value: 0 }
}

/** policy Map の合計値 (確率分布として 1 か検証) */
function sumPolicy(policy: Map<number, number>): number {
  let s = 0
  for (const v of policy.values()) s += v
  return s
}

/** softmax([a, b]) — 2 要素 softmax の helper */
function softmax2(a: number, b: number): [number, number] {
  const m = Math.max(a, b)
  const ea = Math.exp(a - m), eb = Math.exp(b - m)
  return [ea / (ea + eb), eb / (ea + eb)]
}

/** 4 viewer 全員に同じ claim_true logits を持たせた village bundle 作る helper */
function uniformVillage(claimTrueLogits: number[]): Record<SystemRole, ForwardResult> {
  const result: Partial<Record<SystemRole, ForwardResult>> = {}
  for (const role of ROLES) {
    result[role] = fakeResult({ claim_true: claimTrueLogits })
  }
  return result as Record<SystemRole, ForwardResult>
}

describe('mixClaimDecision', () => {
  // wolf claim_decision_dev: 57-dim 全 0 → softmax は uniform (1/57)
  const wolfDevUniform = new Array(CLAIM_DECISION_SIZE).fill(0)
  // village claim_true: [skip=1.0, co=0.0] → π_v_co = softmax([1, 0]) ≈ [0.731, 0.269]
  const villageClaimTrueSkipBias = [1.0, 0.0]

  it('α_claim ≈ 0: skip は village 4 viewer の skip 平均、claimer 部分は co/(4×14)', () => {
    // 4 viewer 全員に skip-bias の claim_true を持たせる
    const wolf = fakeResult({
      claim_decision_dev: wolfDevUniform,
      alpha_claim: [10, -10],  // α ≈ 0
    })
    const village = uniformVillage(villageClaimTrueSkipBias)
    const policy = mixClaimDecision(wolf, village)

    const expectedSkip = softmax2(1.0, 0.0)[0]  // ≈ 0.731 (4 viewer 平均でも同値)
    assert.ok(Math.abs(policy.get(0)! - expectedSkip) < 1e-3,
      `skip=${policy.get(0)} should ≈ ${expectedSkip}`)
    // role × claimer 部分: 各 role の co prob (≈ 0.269) を (4 役職 × 14 claimer) = 56 で割った値
    const expectedCo = softmax2(1.0, 0.0)[1] / (ROLES.length * SEATS)
    for (let roleIdx = 0; roleIdx < ROLES.length; roleIdx++) {
      const offset = 1 + roleIdx * SEATS
      for (let i = 0; i < SEATS; i++) {
        assert.ok(Math.abs(policy.get(offset + i)! - expectedCo) < 1e-4,
          `role=${ROLES[roleIdx]} claimer=${i + 1} should ≈ ${expectedCo}`)
      }
    }
    assert.ok(Math.abs(sumPolicy(policy) - 1.0) < 1e-5)
  })

  it('α_claim ≈ 1: 全 entry が wolf 完全 (uniform 1/57)', () => {
    const wolf = fakeResult({
      claim_decision_dev: wolfDevUniform,
      alpha_claim: [-10, 10],  // α ≈ 1
    })
    const village = uniformVillage(villageClaimTrueSkipBias)
    const policy = mixClaimDecision(wolf, village)

    const expected = 1 / CLAIM_DECISION_SIZE
    for (let i = 0; i < CLAIM_DECISION_SIZE; i++) {
      assert.ok(Math.abs(policy.get(i)! - expected) < 1e-3,
        `entry ${i}=${policy.get(i)} should ≈ ${expected}`)
    }
    assert.ok(Math.abs(sumPolicy(policy) - 1.0) < 1e-5)
  })

  it('α_claim 中間値: village と wolf の凸結合', () => {
    const wolf = fakeResult({
      claim_decision_dev: wolfDevUniform,
      alpha_claim: [0, 0],  // α = 0.5
    })
    const village = uniformVillage(villageClaimTrueSkipBias)
    const policy = mixClaimDecision(wolf, village)

    const piVSkip = softmax2(1.0, 0.0)[0]
    const piWSkip = 1 / CLAIM_DECISION_SIZE
    const expected = 0.5 * piVSkip + 0.5 * piWSkip
    assert.ok(Math.abs(policy.get(0)! - expected) < 1e-3)
    assert.ok(Math.abs(sumPolicy(policy) - 1.0) < 1e-5)
  })

  it('viewer 別 claim_true の差が反映される (seer 強い skip / medium 強い co)', () => {
    // seer viewer は skip 強い、medium viewer は co 強い、bg/nekomata は中立
    const wolf = fakeResult({
      claim_decision_dev: wolfDevUniform,
      alpha_claim: [10, -10],  // α ≈ 0 (village 完全採用)
    })
    const village: Record<SystemRole, ForwardResult> = {
      seer: fakeResult({ claim_true: [3, 0] }),     // skip ≈ 0.953
      medium: fakeResult({ claim_true: [0, 3] }),   // co ≈ 0.953
      bodyguard: fakeResult({ claim_true: [0, 0] }),// co ≈ 0.5
      nekomata: fakeResult({ claim_true: [0, 0] }), // co ≈ 0.5
    } as Record<SystemRole, ForwardResult>
    const policy = mixClaimDecision(wolf, village)

    // skip = avg(seer.skip + medium.skip + bg.skip + neko.skip)
    const expectedSkip = (softmax2(3, 0)[0] + softmax2(0, 3)[0] + 0.5 + 0.5) / ROLES.length
    assert.ok(Math.abs(policy.get(0)! - expectedSkip) < 1e-3,
      `skip=${policy.get(0)} should ≈ ${expectedSkip}`)
    // medium 部分の合計 = medium.co / 4 (各 role は 1/4 weight)
    let mediumSum = 0
    for (let i = 0; i < SEATS; i++) mediumSum += policy.get(1 + 1 * SEATS + i)!
    const expectedMediumSum = softmax2(0, 3)[1] / ROLES.length
    assert.ok(Math.abs(mediumSum - expectedMediumSum) < 1e-3,
      `medium sum=${mediumSum} should ≈ ${expectedMediumSum}`)
    // seer 部分の合計 = seer.co / 4
    let seerSum = 0
    for (let i = 0; i < SEATS; i++) seerSum += policy.get(1 + 0 * SEATS + i)!
    const expectedSeerSum = softmax2(3, 0)[1] / ROLES.length
    assert.ok(Math.abs(seerSum - expectedSeerSum) < 1e-3,
      `seer sum=${seerSum} should ≈ ${expectedSeerSum}`)
    assert.ok(Math.abs(sumPolicy(policy) - 1.0) < 1e-5)
  })

  it('全 57 entry が出力される', () => {
    const wolf = fakeResult({
      claim_decision_dev: wolfDevUniform,
      alpha_claim: [0, 0],
    })
    const village = uniformVillage([1, 0])
    const policy = mixClaimDecision(wolf, village)
    assert.equal(policy.size, CLAIM_DECISION_SIZE)
    for (let i = 0; i < CLAIM_DECISION_SIZE; i++) {
      assert.ok(policy.has(i), `missing entry ${i}`)
      assert.ok(policy.get(i)! >= 0, `entry ${i} negative: ${policy.get(i)}`)
    }
  })
})

describe('mixMorning', () => {
  // village divine: seat 1 が 圧倒的 (logit 5)、他 0
  const villageDivine = [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  // wolf morning_tgt_dev: seat 14 が圧倒的、他 0
  const wolfMorningTgtDev = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]
  // wolf morning_res: 全席 white logit=0 → white prob=0.5
  const wolfMorningRes = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

  it('α_morning ≈ 0: target は divine と一致 (seat 1 集中)', () => {
    const wolf = fakeResult({
      morning_tgt_dev: wolfMorningTgtDev,
      morning_res: wolfMorningRes,
      alpha_morning: [10, -10],  // α ≈ 0
    })
    const village = fakeResult({ divine: villageDivine })
    const policy = mixMorning(wolf, village)

    // seat 1 (target_idx=0) の合計 = white(0) + black(1) = π_v_target[0]
    const target0 = (policy.get(0)! + policy.get(1)!)
    // π_v_target[0] = softmax([5, 0×13])[0] = exp(5)/(exp(5)+13) ≈ 0.919
    const expected = Math.exp(5) / (Math.exp(5) + 13)
    assert.ok(Math.abs(target0 - expected) < 1e-3,
      `target[0]=${target0} should ≈ ${expected}`)
    // white/black 比率は 1:1 (logit=0)
    assert.ok(Math.abs(policy.get(0)! - policy.get(1)!) < 1e-5,
      `white(${policy.get(0)}) and black(${policy.get(1)}) should be equal`)
    assert.ok(Math.abs(sumPolicy(policy) - 1.0) < 1e-5)
  })

  it('α_morning ≈ 1: target は wolf と一致 (seat 14 集中)', () => {
    const wolf = fakeResult({
      morning_tgt_dev: wolfMorningTgtDev,
      morning_res: wolfMorningRes,
      alpha_morning: [-10, 10],  // α ≈ 1
    })
    const village = fakeResult({ divine: villageDivine })
    const policy = mixMorning(wolf, village)

    const target13 = (policy.get(26)! + policy.get(27)!)  // target_idx=13 (seat 14)
    const expected = Math.exp(5) / (Math.exp(5) + 13)
    assert.ok(Math.abs(target13 - expected) < 1e-3,
      `target[13]=${target13} should ≈ ${expected}`)
    assert.ok(Math.abs(sumPolicy(policy) - 1.0) < 1e-5)
  })

  it('white_prob: morning_res が大きい seat は white が多い', () => {
    const wolf = fakeResult({
      morning_tgt_dev: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],  // uniform
      morning_res: [10, -10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],   // seat1=white、seat2=black
      alpha_morning: [-10, 10],
    })
    const village = fakeResult({ divine: villageDivine })
    const policy = mixMorning(wolf, village)

    // seat 1: white >> black
    assert.ok(policy.get(0)! > policy.get(1)! * 100,
      `seat1 white=${policy.get(0)} should >> black=${policy.get(1)}`)
    // seat 2: black >> white
    assert.ok(policy.get(3)! > policy.get(2)! * 100,
      `seat2 black=${policy.get(3)} should >> white=${policy.get(2)}`)
    assert.ok(Math.abs(sumPolicy(policy) - 1.0) < 1e-5)
  })

  it('全 28 entry が出力される', () => {
    const wolf = fakeResult({
      morning_tgt_dev: wolfMorningTgtDev,
      morning_res: wolfMorningRes,
      alpha_morning: [0, 0],
    })
    const village = fakeResult({ divine: villageDivine })
    const policy = mixMorning(wolf, village)

    assert.equal(policy.size, SEATS * 2)
    for (let i = 0; i < SEATS * 2; i++) {
      assert.ok(policy.has(i), `missing entry ${i}`)
      assert.ok(policy.get(i)! >= 0, `entry ${i} negative: ${policy.get(i)}`)
    }
  })
})
