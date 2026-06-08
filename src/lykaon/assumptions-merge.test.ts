import { describe, test } from 'node:test'
import assert from 'node:assert'
import type { SystemRole } from '../types/index.ts'
import { mergeAssumptions } from './assumptions-merge.ts'

describe('mergeAssumptions', () => {
  test('spoiler only — そのまま返る', () => {
    const spoiler = new Map<number, SystemRole>([[1, 'seer']])
    const ui = new Map<number, SystemRole>()
    const merged = mergeAssumptions(spoiler, ui)
    assert.deepStrictEqual([...merged], [[1, 'seer']])
  })

  test('UI only — そのまま返る', () => {
    const spoiler = new Map<number, SystemRole>()
    const ui = new Map<number, SystemRole>([[2, 'werewolf']])
    const merged = mergeAssumptions(spoiler, ui)
    assert.deepStrictEqual([...merged], [[2, 'werewolf']])
  })

  test('異なる席 — 両方含む', () => {
    const spoiler = new Map<number, SystemRole>([[1, 'seer']])
    const ui = new Map<number, SystemRole>([[2, 'werewolf']])
    const merged = mergeAssumptions(spoiler, ui)
    assert.strictEqual(merged.size, 2)
    assert.strictEqual(merged.get(1), 'seer')
    assert.strictEqual(merged.get(2), 'werewolf')
  })

  test('同じ席で衝突 — spoiler が勝つ', () => {
    const spoiler = new Map<number, SystemRole>([[1, 'seer']])
    const ui = new Map<number, SystemRole>([[1, 'werewolf']])
    const merged = mergeAssumptions(spoiler, ui)
    assert.strictEqual(merged.get(1), 'seer')
  })

  test('入力 Map を破壊しない', () => {
    const spoiler = new Map<number, SystemRole>([[1, 'seer']])
    const ui = new Map<number, SystemRole>([[2, 'werewolf']])
    mergeAssumptions(spoiler, ui)
    assert.deepStrictEqual([...spoiler], [[1, 'seer']])
    assert.deepStrictEqual([...ui], [[2, 'werewolf']])
  })
})
