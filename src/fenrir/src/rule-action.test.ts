import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlanIndices, PLAN_VOCAB, type PlanDayGroup } from './plan/plan-vocab.ts'
import { resolvePlanGroup } from './plan/plan-resolve.ts'

describe('parsePlanIndices', () => {
  it('single group with seats', () => {
    // seat3(=idx2), seat7(=idx6), stop
    const indices = [2, 6, PLAN_VOCAB.STOP]
    const groups = parsePlanIndices(indices)
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0].targets, [
      { type: 'seat', seat: 3 },
      { type: 'seat', seat: 7 },
    ])
  })

  it('multiple groups separated by next', () => {
    // seat3, next, seat12, next, grayran, stop
    const indices = [2, PLAN_VOCAB.OR, 11, PLAN_VOCAB.OR, PLAN_VOCAB.GRAYRAN, PLAN_VOCAB.STOP]
    const groups = parsePlanIndices(indices)
    assert.equal(groups.length, 3)
    assert.deepEqual(groups[0].targets, [{ type: 'seat', seat: 3 }])
    assert.deepEqual(groups[1].targets, [{ type: 'seat', seat: 12 }])
    assert.deepEqual(groups[2].targets, [{ type: 'grayran' }])
  })

  it('stop terminates early', () => {
    const indices = [0, PLAN_VOCAB.STOP, 5, 6]
    const groups = parsePlanIndices(indices)
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0].targets, [{ type: 'seat', seat: 1 }])
  })

  it('empty indices', () => {
    const groups = parsePlanIndices([])
    assert.equal(groups.length, 0)
  })

  it('role tokens', () => {
    // ROLE_START = SEATS = 14, seer=0, medium=1
    const indices = [PLAN_VOCAB.ROLE_START, PLAN_VOCAB.STOP]
    const groups = parsePlanIndices(indices)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].targets[0].type, 'role')
  })
})

describe('resolvePlanGroup', () => {
  it('resolves alive seat', () => {
    const group: PlanDayGroup = { targets: [{ type: 'seat', seat: 3 }] }
    assert.equal(resolvePlanGroup(group, [1, 3, 5, 7]), 3)
  })

  it('skips dead seat, picks next', () => {
    const group: PlanDayGroup = { targets: [
      { type: 'seat', seat: 3 },
      { type: 'seat', seat: 7 },
    ] }
    // seat3 is dead (not in aliveSeats)
    assert.equal(resolvePlanGroup(group, [1, 5, 7]), 7)
  })

  it('grayran picks first alive (no events)', () => {
    const group: PlanDayGroup = { targets: [{ type: 'grayran' }] }
    assert.equal(resolvePlanGroup(group, [5, 9, 12]), 5)
  })

  it('grayran excludes CO claimers when events provided', () => {
    const group: PlanDayGroup = { targets: [{ type: 'grayran' }] }
    const events = [
      { type: 'seer_claim', actor: 5 },
      { type: 'medium_claim', actor: 9 },
    ]
    // seat 5, 9 are CO → gray = [12]
    assert.equal(resolvePlanGroup(group, [5, 9, 12], events), 12)
  })

  it('grayran falls back to all alive when everyone has CO', () => {
    const group: PlanDayGroup = { targets: [{ type: 'grayran' }] }
    const events = [
      { type: 'seer_claim', actor: 5 },
      { type: 'medium_claim', actor: 9 },
    ]
    assert.equal(resolvePlanGroup(group, [5, 9], events), 5)
  })

  it('role resolves to CO claimer', () => {
    const group: PlanDayGroup = { targets: [{ type: 'role', role: 'seer' as any }] }
    const events = [
      { type: 'seer_claim', actor: 7 },
    ]
    assert.equal(resolvePlanGroup(group, [3, 7, 10], events), 7)
  })

  it('role skips dead CO claimer', () => {
    const group: PlanDayGroup = { targets: [{ type: 'role', role: 'seer' as any }] }
    const events = [
      { type: 'seer_claim', actor: 7 },
    ]
    // seat 7 is dead
    assert.equal(resolvePlanGroup(group, [3, 10], events), null)
  })

  it('role returns null without events', () => {
    const group: PlanDayGroup = { targets: [{ type: 'role', role: 'seer' as any }] }
    assert.equal(resolvePlanGroup(group, [3, 7, 10]), null)
  })

  it('returns null when no target resolves', () => {
    const group: PlanDayGroup = { targets: [{ type: 'seat', seat: 3 }] }
    assert.equal(resolvePlanGroup(group, [1, 5, 7]), null)
  })

  it('returns null for empty targets', () => {
    const group: PlanDayGroup = { targets: [] }
    assert.equal(resolvePlanGroup(group, [1, 5, 7]), null)
  })
})

describe('plan day increment (mason死亡後のplan継続)', () => {
  // minimal-adapterのキャッシュロジックをシミュレート
  function simulatePlanIncrement(
    planIndices: number[],
    dayAliveSeats: number[][],  // 各dayの生存席リスト
    masonDiesAfterDay: number,  // この日の後にmasonが死ぬ (0-indexed)
  ): (number | null)[] {
    const groups = parsePlanIndices(planIndices)
    const results: (number | null)[] = []
    let cachedGroups: PlanDayGroup[] | undefined
    let cachedIndex = 0

    for (let day = 0; day < dayAliveSeats.length; day++) {
      const alive = dayAliveSeats[day]
      const masonAlive = day <= masonDiesAfterDay

      if (masonAlive) {
        // mason生存: groups[0]を使う（実際はNNが毎日再推論するが、テスト用にgroups[day]で代用）
        // ここではキャッシュ更新のみ検証
        cachedGroups = groups
        cachedIndex = day + 1  // 今日のグループの次から
        results.push(day < groups.length ? resolvePlanGroup(groups[day], alive) : null)
      } else if (cachedGroups && cachedIndex < cachedGroups.length) {
        // mason死亡: キャッシュの次グループ
        const group = cachedGroups[cachedIndex++]
        results.push(resolvePlanGroup(group, alive))
      } else {
        // キャッシュ切れ
        results.push(null)
      }
    }
    return results
  }

  it('mason dies after day 0, plan continues for 2 more days', () => {
    // Plan: seat3, next, seat7, next, seat12, stop
    const indices = [2, PLAN_VOCAB.OR, 6, PLAN_VOCAB.OR, 11, PLAN_VOCAB.STOP]
    const alive = [
      [1, 3, 5, 7, 9, 12],  // Day 0: mason alive
      [1, 5, 7, 9, 12],     // Day 1: mason dead, seat3 executed
      [1, 5, 9, 12],        // Day 2: seat7 executed
    ]
    const results = simulatePlanIncrement(indices, alive, 0)
    assert.deepEqual(results, [3, 7, 12])
  })

  it('cached plan skips dead targets', () => {
    // Plan: seat3, next, seat7, next, seat12, stop
    const indices = [2, PLAN_VOCAB.OR, 6, PLAN_VOCAB.OR, 11, PLAN_VOCAB.STOP]
    const alive = [
      [1, 3, 5, 7, 12],  // Day 0: mason alive
      [1, 5, 12],         // Day 1: mason dead, seat3 & seat7 both dead
    ]
    const results = simulatePlanIncrement(indices, alive, 0)
    // Day 0: seat3 alive → 3
    // Day 1: groups[1]={seat7}, seat7 dead → null
    assert.equal(results[0], 3)
    assert.equal(results[1], null)
  })

  it('grayran in cached plan resolves to first alive', () => {
    // Plan: seat3, next, grayran, stop
    const indices = [2, PLAN_VOCAB.OR, PLAN_VOCAB.GRAYRAN, PLAN_VOCAB.STOP]
    const alive = [
      [1, 3, 5, 7],  // Day 0: mason alive
      [1, 5, 7],     // Day 1: mason dead
    ]
    const results = simulatePlanIncrement(indices, alive, 0)
    assert.equal(results[0], 3)
    assert.equal(results[1], 1)  // grayran → first alive
  })

  it('cache exhausted returns null', () => {
    // Plan: seat3, stop (only 1 group)
    const indices = [2, PLAN_VOCAB.STOP]
    const alive = [
      [1, 3, 5],  // Day 0: mason alive
      [1, 5],     // Day 1: mason dead
    ]
    const results = simulatePlanIncrement(indices, alive, 0)
    assert.equal(results[0], 3)
    assert.equal(results[1], null)  // no more groups
  })

  it('mason survives multiple days, cache updates each day', () => {
    // Plan: seat3, next, seat7, next, seat12, stop
    const indices = [2, PLAN_VOCAB.OR, 6, PLAN_VOCAB.OR, 11, PLAN_VOCAB.STOP]
    const alive = [
      [1, 3, 5, 7, 12],  // Day 0: mason alive
      [1, 5, 7, 12],     // Day 1: mason alive (seat3 executed)
      [1, 5, 12],        // Day 2: mason dead
    ]
    // mason dies after day 1 → cachedIndex starts at 2
    const results = simulatePlanIncrement(indices, alive, 1)
    assert.equal(results[0], 3)   // Day 0: groups[0]
    assert.equal(results[1], 7)   // Day 1: groups[1] (mason still alive, re-inferred)
    assert.equal(results[2], 12)  // Day 2: cached groups[2]
  })
})
