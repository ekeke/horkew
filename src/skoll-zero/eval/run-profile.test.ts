import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RUN_PROFILES, type RunProfileName } from './run-profile.ts'

test('exactly 2 profiles: training and eval', () => {
  const keys = Object.keys(RUN_PROFILES).sort()
  assert.deepEqual(keys, ['eval', 'training'])
})

test('training profile uses sample for trajectory diversity', () => {
  assert.equal(RUN_PROFILES.training.selectionMode, 'sample')
})

test('eval profile uses policy_argmax for pure NN benchmark', () => {
  assert.equal(RUN_PROFILES.eval.selectionMode, 'policy_argmax')
})

test('all profile names are usable as RunProfileName', () => {
  // 型レベルでの確認 + 全 profile に selectionMode がある
  const names: RunProfileName[] = ['training', 'eval']
  for (const name of names) {
    const p = RUN_PROFILES[name]
    assert.ok(p)
    assert.ok(typeof p.selectionMode === 'string')
  }
})
