/**
 * WolfImitationNetwork の mix 計算 unit test。
 *
 * 検証項目:
 * - mixClaimFake: α=0 で village 完全コピー、α=1 で wolf 完全 + 確率分布の正規化
 * - mixMorning: α=0 で target が divine と一致、α=1 で target が wolf 寄り、Σ=1
 * - 退化ケース (wolf が skip 100% など)
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { ForwardResult } from '../../fenrir/src/ml/nn.ts'
import { mixClaimFake, mixMorning } from './wolf-imitation-network.ts'

const SEATS = 14

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

describe('mixClaimFake', () => {
  // wolf claim_fake_dev: skip=2.0 (確率 ≈ exp(2)/Σ = 0.5 弱)、claimer i=1..14 はそれぞれ logit=0
  const wolfClaimFakeDev = [2.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  // village claim_true: [skip=1.0, co=0.0] → π_v_co = softmax([1, 0]) ≈ [0.731, 0.269]
  const villageClaimTrue = [1.0, 0.0]

  it('α_claim ≈ 0: skip は village 完全コピー (≈ 0.731)', () => {
    // alpha_claim = softmax([10, -10])[1] ≈ 0 (= "village を強く採用")
    const wolf = fakeResult({
      claim_fake_dev: wolfClaimFakeDev,
      alpha_claim: [10, -10],
    })
    const village = fakeResult({ claim_true: villageClaimTrue })
    const policy = mixClaimFake(wolf, village)

    const piVCoSkip = softmax2(1.0, 0.0)[0]  // ≈ 0.731
    assert.ok(Math.abs(policy.get(0)! - piVCoSkip) < 1e-3,
      `skip=${policy.get(0)} should ≈ ${piVCoSkip}`)
    // 確率分布: Σ = 1
    assert.ok(Math.abs(sumPolicy(policy) - 1.0) < 1e-5)
  })

  it('α_claim ≈ 1: skip は wolf 完全 (= 純 wolf)', () => {
    // alpha_claim = softmax([-10, 10])[1] ≈ 1
    const wolf = fakeResult({
      claim_fake_dev: wolfClaimFakeDev,
      alpha_claim: [-10, 10],
    })
    const village = fakeResult({ claim_true: villageClaimTrue })
    const policy = mixClaimFake(wolf, village)

    // π_w[skip] = softmax([2, 0×14])[0] = exp(2)/(exp(2)+14) ≈ 0.345
    const wolfSkipExpected = Math.exp(2) / (Math.exp(2) + 14)
    assert.ok(Math.abs(policy.get(0)! - wolfSkipExpected) < 1e-3,
      `skip=${policy.get(0)} should ≈ ${wolfSkipExpected}`)
    assert.ok(Math.abs(sumPolicy(policy) - 1.0) < 1e-5)
  })

  it('α_claim 中間値: skip が village と wolf の中間', () => {
    const wolf = fakeResult({
      claim_fake_dev: wolfClaimFakeDev,
      alpha_claim: [0, 0],  // α = 0.5
    })
    const village = fakeResult({ claim_true: villageClaimTrue })
    const policy = mixClaimFake(wolf, village)

    const piVSkip = softmax2(1.0, 0.0)[0]
    const piWSkip = Math.exp(2) / (Math.exp(2) + 14)
    const expected = 0.5 * piVSkip + 0.5 * piWSkip
    assert.ok(Math.abs(policy.get(0)! - expected) < 1e-3)
    assert.ok(Math.abs(sumPolicy(policy) - 1.0) < 1e-5)
  })

  it('退化ケース: wolf が skip 100% に近い → claimer 部分は uniform', () => {
    const wolf = fakeResult({
      claim_fake_dev: [100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],  // skip 圧倒的
      alpha_claim: [-10, 10],  // α=1 で wolf 採用
    })
    const village = fakeResult({ claim_true: villageClaimTrue })
    const policy = mixClaimFake(wolf, village)

    assert.ok(Math.abs(sumPolicy(policy) - 1.0) < 1e-5)
    // claimer i=1..14 はそれぞれ ≈ 0 (skip ≈ 1)
    for (let i = 1; i <= SEATS; i++) {
      assert.ok(policy.get(i)! < 0.01, `claimer ${i} should be near 0, got ${policy.get(i)}`)
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
