import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { SystemRole } from '../../types/index.ts'
import { ROLE_VOCABULARY } from '../../huginn/types.ts'
import { buildKnowledgeByOther } from './knowledge.ts'

function makeCtx(retarPossibilities: Map<number, Set<SystemRole>> | null): DecisionContext {
  return { retarPossibilities } as DecisionContext
}

describe('buildKnowledgeByOther', () => {
  it('retarPossibilities null → 全員全役職', () => {
    const ctx = makeCtx(null)
    const participants = [1, 3, 5]
    const k = buildKnowledgeByOther(ctx, participants)
    assert.equal(k.length, 3)
    for (const set of k) {
      assert.equal(set.size, ROLE_VOCABULARY.length, '11 役職全て')
      for (const r of ROLE_VOCABULARY) assert.ok(set.has(r))
    }
  })

  it('per-viewer retar 反映 (相棒 singleton werewolf)', () => {
    const poss = new Map<number, Set<SystemRole>>()
    poss.set(1, new Set<SystemRole>(['werewolf']))
    poss.set(2, new Set<SystemRole>(['villager', 'seer']))
    poss.set(3, new Set<SystemRole>(['werewolf']))
    const ctx = makeCtx(poss)
    const k = buildKnowledgeByOther(ctx, [1, 2, 3])
    assert.deepEqual([...k[0]], ['werewolf'])
    assert.equal(k[1].size, 2)
    assert.ok(k[1].has('villager'))
    assert.ok(k[1].has('seer'))
    assert.deepEqual([...k[2]], ['werewolf'])
  })

  it('retarPossibilities に無い seat → 全役職', () => {
    const poss = new Map<number, Set<SystemRole>>()
    poss.set(1, new Set<SystemRole>(['werewolf']))
    const ctx = makeCtx(poss)
    const k = buildKnowledgeByOther(ctx, [1, 7])
    assert.equal(k[0].size, 1)
    assert.equal(k[1].size, ROLE_VOCABULARY.length, '未登録 seat は全役職')
  })

  it('participants 順序で index 対応', () => {
    const poss = new Map<number, Set<SystemRole>>()
    poss.set(5, new Set<SystemRole>(['villager']))
    poss.set(2, new Set<SystemRole>(['werewolf']))
    const ctx = makeCtx(poss)
    const k = buildKnowledgeByOther(ctx, [2, 5])  // sorted
    assert.deepEqual([...k[0]], ['werewolf'], 'index 0 = seat 2')
    assert.deepEqual([...k[1]], ['villager'], 'index 1 = seat 5')
  })
})
