import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MasonZeroNetwork } from './mason-zero.ts'
import { createSimState } from '../simulator/world-state.ts'
import { MASON_COLLECTIVE_OBSERVATION_SIZE } from '../../fenrir/src/observation.ts'

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
