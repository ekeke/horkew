import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { MasonZeroNetwork } from './mason-zero.ts'
import { loadSkollSupervisedWeights } from './warm-start.ts'
import { createSimState } from '../simulator/world-state.ts'
import { MASON_COLLECTIVE_OBSERVATION_SIZE } from '../../fenrir/src/observation.ts'

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
