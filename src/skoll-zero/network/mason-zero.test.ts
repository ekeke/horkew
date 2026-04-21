import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { MasonZeroNetwork } from './mason-zero.ts'
import { loadSkollSupervisedWeights } from './warm-start.ts'
import { createSimState } from '../simulator/world-state.ts'
import { MASON_COLLECTIVE_OBSERVATION_SIZE } from '../../fenrir/src/observation.ts'
import {
  SKOLL_ZERO_NETWORK_CONFIG,
  STANDARD_ZERO_NETWORK_CONFIG,
  WOLF_ZERO_NETWORK_CONFIG,
  createSkollZeroNetwork,
  createStandardZeroNetwork,
  createWolfZeroNetwork,
} from './config.ts'
import { loadCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'

const SKOLL_SL_CKPT = 'tmp/skoll-mb-large-v2/phases/00-skoll-supervised/ckpt-mason_collective/collective_final.json'

function aliveOf(seats: number[]): number {
  let mask = 0
  for (const s of seats) mask |= (1 << s)
  return mask
}

function zeroObs(): Float32Array {
  return new Float32Array(MASON_COLLECTIVE_OBSERVATION_SIZE)
}

describe('MasonZeroNetwork: 基本 forward', () => {
  it('forward が policy Map + value scalar を返す', () => {
    const net = new MasonZeroNetwork()
    const state = createSimState({} as any, aliveOf([1, 2, 3, 4, 5]))
    const out = net.forward(zeroObs(), state, 1)
    assert.ok(out.policy instanceof Map)
    assert.equal(typeof out.value, 'number')
  })

  it('合法 action のみが policy Map に入る（mason 自席と dead は除外）', () => {
    const net = new MasonZeroNetwork()
    const state = createSimState({} as any, aliveOf([1, 2, 3, 5, 8]))
    const masonSeat = 3
    const out = net.forward(zeroObs(), state, masonSeat)
    assert.ok(!out.policy.has(masonSeat), '自席を含まない')
    assert.ok(!out.policy.has(4), '非 alive は含まない')
    assert.ok(!out.policy.has(6), '非 alive は含まない')
    for (const seat of out.policy.keys()) {
      assert.ok([1, 2, 5, 8].includes(seat), `seat ${seat} は alive 非自席`)
    }
    // 合計確率 ≈ 1
    let sum = 0
    for (const p of out.policy.values()) sum += p
    assert.ok(Math.abs(sum - 1) < 1e-5, `policy 合計 = 1 (実測 ${sum})`)
  })

  it('value head zero init → 初回 forward の value === 0', () => {
    const net = new MasonZeroNetwork()
    const state = createSimState({} as any, aliveOf([1, 2, 3, 4, 5]))
    const out = net.forward(zeroObs(), state, 1)
    assert.equal(out.value, 0, 'value head zero init → tanh(0) = 0')
  })

  it('全席生存 → policy Map.size = 13 (mason 自席のみ除外)', () => {
    const net = new MasonZeroNetwork()
    let alive = 0
    for (let s = 1; s <= 14; s++) alive |= (1 << s)
    const state = createSimState({} as any, alive)
    const out = net.forward(zeroObs(), state, 7)
    assert.equal(out.policy.size, 13)
    assert.ok(!out.policy.has(7))
  })

  it('policy は非負、値域 [0, 1]', () => {
    const net = new MasonZeroNetwork()
    const state = createSimState({} as any, aliveOf([1, 2, 3, 4, 5]))
    const out = net.forward(zeroObs(), state, 2)
    for (const p of out.policy.values()) {
      assert.ok(p >= 0 && p <= 1, `probability in [0,1]: ${p}`)
    }
  })
})

describe('Phase 2 network config: 全 head が定義されている', () => {
  const PHASE2_EXPECTED_HEADS = ['claim', 'comm', 'leader', 'target'] as const
  const PHASE2_EXPECTED_SIGMOID = ['propose', 'predict'] as const

  for (const [name, config] of Object.entries({
    MASON: SKOLL_ZERO_NETWORK_CONFIG,
    STANDARD: STANDARD_ZERO_NETWORK_CONFIG,
    WOLF: WOLF_ZERO_NETWORK_CONFIG,
  })) {
    it(`${name} config: Phase 2 heads が含まれる`, () => {
      for (const h of PHASE2_EXPECTED_HEADS) {
        assert.ok(h in config.heads, `${name}.heads に ${h} が必要`)
      }
      for (const h of PHASE2_EXPECTED_SIGMOID) {
        assert.ok(h in (config.sigmoidHeads ?? {}), `${name}.sigmoidHeads に ${h} が必要`)
      }
      // target は perSeatHeads に入る (per-seat softmax)
      assert.ok(config.transformer.perSeatHeads.includes('target'), `${name} target は per-seat`)
      // propose/predict は perSeatSigmoidHeads
      assert.ok(config.transformer.perSeatSigmoidHeads?.includes('propose'), `${name} propose は per-seat sigmoid`)
      assert.ok(config.transformer.perSeatSigmoidHeads?.includes('predict'), `${name} predict は per-seat sigmoid`)
    })
  }

  it('全 config で forward 出力に全 head 名が含まれる', () => {
    const nets = [
      { name: 'MASON', net: createSkollZeroNetwork(), obsSize: SKOLL_ZERO_NETWORK_CONFIG.inputSize },
      { name: 'STANDARD', net: createStandardZeroNetwork(), obsSize: STANDARD_ZERO_NETWORK_CONFIG.inputSize },
      { name: 'WOLF', net: createWolfZeroNetwork(), obsSize: WOLF_ZERO_NETWORK_CONFIG.inputSize },
    ]
    for (const { name, net, obsSize } of nets) {
      const obs = new Float32Array(obsSize)
      const r = net.forward(obs)
      for (const h of ['vote', 'claim', 'comm', 'leader', 'target', 'propose', 'predict']) {
        assert.ok(r.policies.has(h), `${name}.forward に ${h} が出力される (got keys: ${[...r.policies.keys()].join(',')})`)
      }
      // shape 確認
      assert.equal(r.policies.get('claim')!.length, 10, `${name} claim = 10`)
      assert.equal(r.policies.get('comm')!.length, 14 * 8 + 7, `${name} comm = 119`)
      assert.equal(r.policies.get('leader')!.length, 3, `${name} leader = 3`)
      assert.equal(r.policies.get('target')!.length, 14, `${name} target = 14`)
      assert.equal(r.policies.get('propose')!.length, 14, `${name} propose = 14`)
      assert.equal(r.policies.get('predict')!.length, 14 * 11, `${name} predict = 154`)
    }
  })
})

describe('Phase 2: 旧 (Phase 1) checkpoint を partial load できる', () => {
  const MASON_PHASE1_CKPT = 'tmp/orch-skollz-v2-headsep/phases/00-skoll-zero/mason/final.json'
  const skipIfMissing = !existsSync(MASON_PHASE1_CKPT)
  if (skipIfMissing) {
    it.skip(`Phase 1 checkpoint 不在のためスキップ: ${MASON_PHASE1_CKPT}`, () => {})
    return
  }

  it('v2-headsep mason final.json を Phase 2 config 上に partial load できる', () => {
    // Phase 2 config は vote + claim + comm + leader + target + propose + predict を持つが、
    // Phase 1 checkpoint は vote のみ。残り head は random init のまま。
    const net = createSkollZeroNetwork()
    const freshVote = new Float32Array(net.forward(new Float32Array(SKOLL_ZERO_NETWORK_CONFIG.inputSize)).policies.get('vote')!)
    loadCheckpoint(net, MASON_PHASE1_CKPT)
    const warmVote = new Float32Array(net.forward(new Float32Array(SKOLL_ZERO_NETWORK_CONFIG.inputSize)).policies.get('vote')!)
    // vote が load で書き換わる (全次元 0 でも、trunk がランダムから Phase 1 学習済みに変わるので output 差分あり)
    let anyDiff = false
    for (let i = 0; i < freshVote.length; i++) {
      if (Math.abs(freshVote[i] - warmVote[i]) > 1e-6) { anyDiff = true; break }
    }
    assert.ok(anyDiff, 'warm start で vote output が変わる')
  })
})

describe('warm-start: skoll-supervised checkpoint', () => {
  const skipIfMissing = !existsSync(SKOLL_SL_CKPT)
  if (skipIfMissing) {
    it.skip(`checkpoint 不在のためスキップ: ${SKOLL_SL_CKPT}`, () => {})
    return
  }

  it('SL checkpoint load が shape error なしで成功、value head は zero 維持', () => {
    const net = new MasonZeroNetwork()
    const result = loadSkollSupervisedWeights(net, SKOLL_SL_CKPT)
    assert.equal(result.checkpointPath, SKOLL_SL_CKPT)
    assert.ok(typeof result.metadata.iteration === 'number')

    // Warm start 後も value head は zero init（上書き済み）
    const state = createSimState({} as any, aliveOf([1, 2, 3, 4, 5]))
    const out = net.forward(zeroObs(), state, 1)
    assert.equal(out.value, 0, 'warm start 後も value head は zero')
  })

  it('warm start 後の policy は fresh ネットと異なる（trunk + vote head が上書きされた）', () => {
    const freshNet = new MasonZeroNetwork()
    const warmNet = new MasonZeroNetwork()
    loadSkollSupervisedWeights(warmNet, SKOLL_SL_CKPT)

    const state = createSimState({} as any, aliveOf([1, 2, 3, 4, 5]))
    // 非ゼロ観測（各次元に異なる値）— trunk が zero でなければ seat 間で差が出る
    const obs = new Float32Array(MASON_COLLECTIVE_OBSERVATION_SIZE)
    for (let i = 0; i < obs.length; i++) obs[i] = Math.sin(i * 0.1) * 0.3

    const freshOut = freshNet.forward(obs, state, 1)
    const warmOut = warmNet.forward(obs, state, 1)

    // 少なくとも 1 seat で policy が異なる（trunk/vote head の重み上書きを検出）
    let anyDiff = false
    for (const seat of warmOut.policy.keys()) {
      const fp = freshOut.policy.get(seat) ?? 0
      const wp = warmOut.policy.get(seat) ?? 0
      if (Math.abs(fp - wp) > 1e-6) { anyDiff = true; break }
    }
    assert.ok(anyDiff, 'warm start 後の policy は fresh と異なる（重み上書きを確認）')
  })
})
