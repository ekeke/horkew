import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PLAN_VOCAB, stripFirstPlanGroup, parsePlanIndices } from './plan-vocab.ts'

const { NEXT, STOP, GRAYRAN } = PLAN_VOCAB

describe('stripFirstPlanGroup', () => {
  it('strips single-seat group followed by NEXT', () => {
    const indices = [3, NEXT, 7, NEXT, GRAYRAN, STOP, STOP, STOP]
    const result = stripFirstPlanGroup(indices, 8)
    assert.deepEqual(result, [7, NEXT, GRAYRAN, STOP, STOP, STOP, STOP, STOP])
  })

  it('strips multi-seat group (roller) followed by NEXT', () => {
    const indices = [3, 5, NEXT, 7, STOP, STOP, STOP, STOP]
    const result = stripFirstPlanGroup(indices, 8)
    assert.deepEqual(result, [7, STOP, STOP, STOP, STOP, STOP, STOP, STOP])
  })

  it('returns all STOP when first group ends with STOP', () => {
    const indices = [3, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const result = stripFirstPlanGroup(indices, 8)
    assert.deepEqual(result, [STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP])
  })

  it('returns all STOP when already all STOP', () => {
    const indices = [STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const result = stripFirstPlanGroup(indices, 8)
    assert.deepEqual(result, [STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP])
  })

  it('works with 4-token endgame length', () => {
    const indices = [2, NEXT, 5, STOP]
    const result = stripFirstPlanGroup(indices, 4)
    assert.deepEqual(result, [5, STOP, STOP, STOP])
  })

  it('strips role token group (single-token group)', () => {
    // role は単独で1グループ完結
    const roleIdx = PLAN_VOCAB.ROLE_START  // seer
    const indices = [roleIdx, NEXT, 7, STOP, STOP, STOP, STOP, STOP]
    const result = stripFirstPlanGroup(indices, 8)
    assert.deepEqual(result, [7, STOP, STOP, STOP, STOP, STOP, STOP, STOP])
  })

  it('strips grayran group', () => {
    const indices = [GRAYRAN, NEXT, 3, STOP, STOP, STOP, STOP, STOP]
    const result = stripFirstPlanGroup(indices, 8)
    assert.deepEqual(result, [3, STOP, STOP, STOP, STOP, STOP, STOP, STOP])
  })

  it('consecutive strip produces correct progression', () => {
    let indices = [3, NEXT, 7, NEXT, GRAYRAN, STOP, STOP, STOP]
    indices = stripFirstPlanGroup(indices, 8)
    assert.deepEqual(parsePlanIndices(indices).length, 2) // {7}, {grayran}
    indices = stripFirstPlanGroup(indices, 8)
    assert.deepEqual(parsePlanIndices(indices).length, 1) // {grayran}
    indices = stripFirstPlanGroup(indices, 8)
    assert.deepEqual(parsePlanIndices(indices).length, 0) // all STOP
  })
})
