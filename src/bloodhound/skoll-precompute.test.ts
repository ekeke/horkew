import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeBestSeats, SKOLL_TIE_TOLERANCE } from './skoll-precompute.ts'

describe('skoll-precompute: computeBestSeats', () => {
  test('empty input returns empty array', () => {
    assert.deepEqual(computeBestSeats([]), [])
  })

  test('single seat is always best', () => {
    assert.deepEqual(computeBestSeats([{ seat: 7, winRate: 0.42 }]), [7])
  })

  test('strict best is returned alone', () => {
    const out = computeBestSeats([
      { seat: 1, winRate: 0.10 },
      { seat: 2, winRate: 0.90 },
      { seat: 3, winRate: 0.50 },
    ])
    assert.deepEqual(out, [2])
  })

  test('ties within ULP tolerance are grouped (ascending seat order)', () => {
    const out = computeBestSeats([
      { seat: 5, winRate: 0.500000000001 },
      { seat: 2, winRate: 0.5 },
      { seat: 9, winRate: 0.499999999999 },
      { seat: 3, winRate: 0.10 },
    ])
    assert.deepEqual(out, [2, 5, 9])
  })

  test('seats just outside tolerance are excluded', () => {
    // tolerance is SKOLL_TIE_TOLERANCE = 1e-9.
    const max = 0.8
    const out = computeBestSeats([
      { seat: 1, winRate: max },
      { seat: 2, winRate: max - SKOLL_TIE_TOLERANCE / 2 },     // within
      { seat: 3, winRate: max - SKOLL_TIE_TOLERANCE * 10 },    // outside
      { seat: 4, winRate: max - SKOLL_TIE_TOLERANCE },         // boundary (within)
    ])
    assert.deepEqual(out, [1, 2, 4])
  })

  test('handles negative win rates (fox-win penalties)', () => {
    const out = computeBestSeats([
      { seat: 1, winRate: -1.0 },
      { seat: 2, winRate: -0.5 },
      { seat: 3, winRate: -1.0 + SKOLL_TIE_TOLERANCE / 2 },
    ])
    assert.deepEqual(out, [2])
  })
})
