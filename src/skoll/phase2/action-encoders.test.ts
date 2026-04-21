import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { DayClaim } from '../../lupa/types.ts'
import {
  encodeClaim, encodeTargetSeat, encodeCommSignal, encodeLeader,
  encodePredict, encodeSeatMultiHot,
} from './action-encoders.ts'

describe('encodeClaim', () => {
  it('seer_co → 0', () => {
    assert.equal(encodeClaim({ type: 'seer_co', results: [] }), 0)
  })
  it('medium_co → 1', () => {
    assert.equal(encodeClaim({ type: 'medium_co' }), 1)
  })
  it('bodyguard_co → 2', () => {
    assert.equal(encodeClaim({ type: 'bodyguard_co', targets: [3] }), 2)
  })
  it('mason_co → 3', () => {
    assert.equal(encodeClaim({ type: 'mason_co', partner: 7 }), 3)
  })
  it('nekomata_co → 4', () => {
    assert.equal(encodeClaim({ type: 'nekomata_co' }), 4)
  })
  it('seer_result → 5', () => {
    assert.equal(encodeClaim({ type: 'seer_result', target: 5, result: 'human' }), 5)
  })
  it('medium_result → 6', () => {
    assert.equal(encodeClaim({ type: 'medium_result', result: 'wolf' }), 6)
  })
  it('forecast → 7', () => {
    assert.equal(encodeClaim({ type: 'forecast', target: 9 }), 7)
  })
  it('none → 9', () => {
    assert.equal(encodeClaim({ type: 'none' }), 9)
  })
})

describe('encodeTargetSeat', () => {
  it('forecast → target', () => {
    assert.equal(encodeTargetSeat({ type: 'forecast', target: 5 }), 5)
  })
  it('mason_co → partner', () => {
    assert.equal(encodeTargetSeat({ type: 'mason_co', partner: 12 }), 12)
  })
  it('他 claim → null', () => {
    assert.equal(encodeTargetSeat({ type: 'seer_co', results: [] }), null)
    assert.equal(encodeTargetSeat({ type: 'none' }), null)
  })
})

describe('encodeSeatMultiHot', () => {
  it('seat 配列 → multi-hot', () => {
    const out = encodeSeatMultiHot([3, 7, 14])
    assert.equal(out.length, 14)
    assert.equal(out[2], 1, 'seat 3')
    assert.equal(out[6], 1, 'seat 7')
    assert.equal(out[13], 1, 'seat 14')
    assert.equal(out[0], 0)
  })
  it('range 外 seat は無視', () => {
    const out = encodeSeatMultiHot([0, 15, 100])
    for (let i = 0; i < 14; i++) assert.equal(out[i], 0)
  })
})

describe('encodeCommSignal', () => {
  it('suspicion target=3 → 2', () => {
    assert.equal(encodeCommSignal({ type: 'suspicion', target: 3 }), 2)
  })
  it('trust target=1 → 14', () => {
    assert.equal(encodeCommSignal({ type: 'trust', target: 1 }), 14)
  })
  it('nominate_commander target=14 → 7*14+13 = 111', () => {
    assert.equal(encodeCommSignal({ type: 'nominate_commander', target: 14 }), 111)
  })
  it('demand_wolf_co → 112', () => {
    assert.equal(encodeCommSignal({ type: 'demand_wolf_co' }), 112)
  })
  it('no_signal → 118', () => {
    assert.equal(encodeCommSignal({ type: 'no_signal' }), 118)
  })
  it('confirm_human (head 未対応) → -1', () => {
    assert.equal(encodeCommSignal({ type: 'confirm_human', target: 3 } as any), -1)
  })
})

describe('encodeLeader', () => {
  it('follow → 0', () => { assert.equal(encodeLeader('follow'), 0) })
  it('defy → 1', () => { assert.equal(encodeLeader('defy'), 1) })
  it('no_response → 2', () => { assert.equal(encodeLeader('no_response'), 2) })
})

describe('encodePredict', () => {
  it('per-seat × role の multi-hot', () => {
    const predictions = new Map([
      [1, ['werewolf' as const]],
      [3, ['seer' as const, 'medium' as const]],
    ])
    const out = encodePredict(predictions)
    assert.equal(out.length, 14 * 11)
    // seat 1 werewolf: index 6 (werewolf) at seat 0
    assert.equal(out[0 * 11 + 6], 1, 'seat1 werewolf')
    // seat 3 seer: index 1
    assert.equal(out[2 * 11 + 1], 1, 'seat3 seer')
    assert.equal(out[2 * 11 + 2], 1, 'seat3 medium')
    // 非指定
    assert.equal(out[0 * 11 + 0], 0, 'seat1 villager')
  })
})
