import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPlan, formatPlanLabel } from './execution-plan.ts'
import type { ExecutionPlan } from '../agents/agent.ts'
import type { SystemRole } from '../../../types/index.ts'

describe('classifyPlan', () => {
  it('grayran', () => {
    const plan: ExecutionPlan = { targets: [], type: 'grayran' }
    const label = classifyPlan(plan, new Map())
    assert.equal(label.type, 'grayran')
  })

  it('empty targets without grayran → none', () => {
    const plan: ExecutionPlan = { targets: [], type: 'designated' }
    const label = classifyPlan(plan, new Map())
    assert.equal(label.type, 'none')
  })

  it('endgame: candidates', () => {
    const plan: ExecutionPlan = { targets: [5, 9], type: 'endgame' }
    const label = classifyPlan(plan, new Map())
    assert.equal(label.type, 'endgame')
    if (label.type === 'endgame') {
      assert.deepEqual(label.candidates, [5, 9])
    }
  })

  it('roller: 2 medium claimants both in targets', () => {
    const claims = new Map<number, SystemRole>([[3, 'medium'], [7, 'medium']])
    const plan: ExecutionPlan = { targets: [3, 7], type: 'roller' }
    const label = classifyPlan(plan, claims)
    assert.equal(label.type, 'roller')
    assert.equal(label.type === 'roller' && label.role, 'medium')
    assert.deepEqual(label.type === 'roller' && label.seats, [3, 7])
  })

  it('decision: 3 medium claimants, 2 in targets', () => {
    const claims = new Map<number, SystemRole>([[3, 'medium'], [7, 'medium'], [12, 'medium']])
    const plan: ExecutionPlan = { targets: [3, 7], type: 'roller' }
    const label = classifyPlan(plan, claims)
    assert.equal(label.type, 'decision')
    if (label.type === 'decision') {
      assert.equal(label.role, 'medium')
      assert.deepEqual(label.targets, [3, 7])
      assert.deepEqual(label.trusted, [12])
    }
  })

  it('decision: 2 medium claimants, 1 in targets', () => {
    const claims = new Map<number, SystemRole>([[3, 'medium'], [7, 'medium']])
    const plan: ExecutionPlan = { targets: [3], type: 'decision' }
    const label = classifyPlan(plan, claims)
    assert.equal(label.type, 'decision')
    if (label.type === 'decision') {
      assert.equal(label.role, 'medium')
      assert.deepEqual(label.targets, [3])
      assert.deepEqual(label.trusted, [7])
    }
  })

  it('designated: single target, no CO match', () => {
    const plan: ExecutionPlan = { targets: [5], type: 'designated' }
    const label = classifyPlan(plan, new Map())
    assert.equal(label.type, 'designated')
    assert.equal(label.type === 'designated' && label.seat, 5)
  })

  it('mixed: multiple targets with different COs', () => {
    const claims = new Map<number, SystemRole>([[3, 'seer'], [7, 'medium']])
    const plan: ExecutionPlan = { targets: [3, 7], type: 'designated' }
    const label = classifyPlan(plan, claims)
    assert.equal(label.type, 'mixed')
  })
})

describe('formatPlanLabel', () => {
  it('roller', () => {
    assert.equal(
      formatPlanLabel({ type: 'roller', role: 'medium', seats: [3, 7] }),
      '霊能ローラー（3→7）',
    )
  })

  it('decision', () => {
    assert.equal(
      formatPlanLabel({ type: 'decision', role: 'medium', targets: [3], trusted: [7] }),
      '霊能決め打ち（3処刑、7を真と判断）',
    )
  })

  it('designated', () => {
    assert.equal(formatPlanLabel({ type: 'designated', seat: 5 }), '5吊り指定')
  })

  it('grayran', () => {
    assert.equal(formatPlanLabel({ type: 'grayran' }), 'グレラン')
  })

  it('endgame', () => {
    assert.equal(
      formatPlanLabel({ type: 'endgame', candidates: [5, 9] }),
      '最終日決選（5or9）',
    )
  })

  it('mixed', () => {
    assert.equal(
      formatPlanLabel({ type: 'mixed', seats: [3, 7, 12] }),
      '3→7→12処刑提案',
    )
  })

  it('none', () => {
    assert.equal(formatPlanLabel({ type: 'none' }), '処刑プランなし')
  })
})
