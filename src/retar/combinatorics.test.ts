import { describe, it } from 'node:test'
import assert from 'node:assert'
import { selectCombinationsFromArray, generateCombinations } from './combinatorics.ts'

const collect = <T>(gen: Generator<T> | IterableIterator<T>): T[] => [...gen]

describe('selectCombinationsFromArray', () => {
  it('generates all C(4,2) combinations with correct selected/remaining split', () => {
    const results = collect(selectCombinationsFromArray(['a', 'b', 'c', 'd'], 2, 2))
    assert.strictEqual(results.length, 6) // C(4,2) = 6
    for (const [selected, remaining] of results) {
      assert.strictEqual(selected.length, 2)
      assert.strictEqual(remaining.length, 2)
      // selected + remaining should cover the original array
      assert.deepStrictEqual([...selected, ...remaining].sort(), ['a', 'b', 'c', 'd'])
    }
  })

  it('generates combinations for a range of sizes', () => {
    const results = collect(selectCombinationsFromArray([1, 2, 3], 1, 2))
    // C(3,1) + C(3,2) = 3 + 3 = 6
    assert.strictEqual(results.length, 6)
    const size1 = results.filter(([s]) => s.length === 1)
    const size2 = results.filter(([s]) => s.length === 2)
    assert.strictEqual(size1.length, 3)
    assert.strictEqual(size2.length, 3)
  })

  it('yields nothing when min > array length', () => {
    const results = collect(selectCombinationsFromArray([1, 2], 3, 3))
    assert.strictEqual(results.length, 0)
  })

  it('clamps max to array length', () => {
    const results = collect(selectCombinationsFromArray([1, 2], 2, 10))
    assert.strictEqual(results.length, 1) // C(2,2) = 1
    assert.deepStrictEqual(results[0], [[1, 2], []])
  })

  it('handles empty array', () => {
    const results = collect(selectCombinationsFromArray([], 0, 0))
    assert.strictEqual(results.length, 0)
  })
})

describe('generateCombinations', () => {
  it('generates cartesian product of arrays', () => {
    const results = collect(generateCombinations<string | number>([['a', 'b'], [1, 2]]))
    assert.deepStrictEqual(results, [
      ['a', 1], ['a', 2], ['b', 1], ['b', 2]
    ])
  })

  it('handles single array', () => {
    const results = collect(generateCombinations([[1, 2, 3]]))
    assert.deepStrictEqual(results, [[1], [2], [3]])
  })

  it('handles empty outer array', () => {
    const results = collect(generateCombinations([]))
    assert.deepStrictEqual(results, [[]])
  })

  it('handles inner empty array (yields nothing)', () => {
    const results = collect(generateCombinations([[1, 2], []]))
    assert.strictEqual(results.length, 0)
  })

  it('three arrays produce correct count', () => {
    const results = collect(generateCombinations([[1, 2], [3, 4], [5, 6]]))
    assert.strictEqual(results.length, 8) // 2 * 2 * 2
  })
})

