import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PLAN_VOCAB, parsePlanSlots, parsePlanIndices } from './plan-vocab.ts'

const { OR, STOP, GRAYRAN } = PLAN_VOCAB

describe('parsePlanSlots', () => {
  it('parses single-seat slot', () => {
    const indices = [3, STOP]
    const slots = parsePlanSlots(indices)
    assert.equal(slots.length, 1)
    assert.deepEqual(slots[0].targets, [{ type: 'seat', seat: 4 }])
  })

  it('parses multiple slots (adjacent targets = separate slots)', () => {
    // seat4, seat8, grayran → 3 separate slots (no OR between them)
    const indices = [3, 7, GRAYRAN, STOP, STOP, STOP]
    const slots = parsePlanSlots(indices)
    assert.equal(slots.length, 3)
    assert.deepEqual(slots[0].targets, [{ type: 'seat', seat: 4 }])
    assert.deepEqual(slots[1].targets, [{ type: 'seat', seat: 8 }])
    assert.deepEqual(slots[2].targets, [{ type: 'grayran' }])
  })

  it('returns empty for all-STOP', () => {
    const indices = [STOP, STOP, STOP, STOP]
    const slots = parsePlanSlots(indices)
    assert.equal(slots.length, 0)
  })

  it('parses OR alternatives within a slot', () => {
    // seat4 OR seat6 = 1 slot with 2 alternatives, then seat8 = separate slot
    const indices = [3, OR, 5, 7, STOP]
    const slots = parsePlanSlots(indices)
    assert.equal(slots.length, 2)
    assert.deepEqual(slots[0].targets, [
      { type: 'seat', seat: 4 },
      { type: 'seat', seat: 6 },
    ])
    assert.deepEqual(slots[1].targets, [{ type: 'seat', seat: 8 }])
  })

  it('parses role OR seat as single slot', () => {
    // seer OR seat8 = 1 slot
    const roleIdx = PLAN_VOCAB.ROLE_START  // seer
    const indices = [roleIdx, OR, 7, STOP]
    const slots = parsePlanSlots(indices)
    assert.equal(slots.length, 1)
    assert.equal(slots[0].targets[0].type, 'role')
    assert.deepEqual(slots[0].targets[1], { type: 'seat', seat: 8 })
  })

  it('parses grayran OR seat as single slot', () => {
    // grayran OR seat4 = 1 slot
    const indices = [GRAYRAN, OR, 3, STOP]
    const slots = parsePlanSlots(indices)
    assert.equal(slots.length, 1)
    assert.deepEqual(slots[0].targets[0], { type: 'grayran' })
    assert.deepEqual(slots[0].targets[1], { type: 'seat', seat: 4 })
  })

  it('parsePlanIndices (deprecated) still works as group separator', () => {
    // deprecated: OR acts as group separator (like old NEXT)
    const indices = [3, OR, 7, STOP]
    const groups = parsePlanIndices(indices)
    assert.equal(groups.length, 2)
    assert.deepEqual(groups[0].targets, [{ type: 'seat', seat: 4 }])
    assert.deepEqual(groups[1].targets, [{ type: 'seat', seat: 8 }])
  })
})
