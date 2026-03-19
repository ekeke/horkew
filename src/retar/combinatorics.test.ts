import { describe, it } from 'node:test'
import assert from 'node:assert'
import { selectCombinationsFromArray, selectOne, generateCombinations, backtrackForMatrix } from './combinatorics.ts'

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

describe('selectOne', () => {
  it('yields each element with left/right partitions', () => {
    const results = collect(selectOne([1, 2, 3]))
    // pops from right, so order is 3, 2, 1
    assert.strictEqual(results.length, 3)
    assert.strictEqual(results[0][0], 3)
    assert.strictEqual(results[1][0], 2)
    assert.strictEqual(results[2][0], 1)
  })

  it('left accumulates previously yielded items', () => {
    const results: [number, number[], number[]][] = []
    for (const r of selectOne([1, 2, 3])) {
      // snapshot left and right since they mutate
      results.push([r[0], [...r[1]], [...r[2]]])
    }
    assert.deepStrictEqual(results, [
      [3, [],     [1, 2]],
      [2, [3],    [1]],
      [1, [3, 2], []],
    ])
  })

  it('prepends additionalLeft to left partition', () => {
    const results: [number, number[], number[]][] = []
    for (const r of selectOne([10, 20], [99])) {
      results.push([r[0], [...r[1]], [...r[2]]])
    }
    assert.deepStrictEqual(results, [
      [20, [99],     [10]],
      [10, [99, 20], []],
    ])
  })

  it('yields nothing for empty array', () => {
    const results = collect(selectOne([]))
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

describe('backtrackForMatrix', () => {
  it('yields nothing for empty matrix', () => {
    const gen = backtrackForMatrix([], {})
    assert.strictEqual(gen.next().done, true)
  })

  it('traverses all items when all pass', () => {
    const matrix = [[1, 2], [3, 4]]
    const gen = backtrackForMatrix(matrix, null)
    const items: number[] = []
    let r = gen.next()
    while (!r.done) {
      items.push(r.value.item)
      r = gen.next([true, null])
    }
    // 1→3, 1→4, 2→3, 2→4
    assert.deepStrictEqual(items, [1, 3, 4, 2, 3, 4])
  })

  it('skips deeper levels when test fails', () => {
    const matrix = [[1, 2], [3, 4]]
    const gen = backtrackForMatrix(matrix, null)
    const items: number[] = []
    let r = gen.next()
    while (!r.done) {
      const pass = r.value.item !== 1 // fail item 1
      items.push(r.value.item)
      r = gen.next([pass, null])
    }
    // 1 fails → skip depth 1, try 2 → 3, 4
    assert.deepStrictEqual(items, [1, 2, 3, 4])
  })

  it('propagates context through levels', () => {
    const matrix = [['a'], ['b']]
    const gen = backtrackForMatrix(matrix, 'start')
    const r1 = gen.next()
    assert.strictEqual(r1.value!.context, 'start')
    const r2 = gen.next([true, 'after-a'])
    assert.strictEqual(r2.value!.context, 'after-a')
  })

  it('reports last flag correctly', () => {
    const matrix = [[1], [2], [3]]
    const gen = backtrackForMatrix(matrix, null)
    const flags: boolean[] = []
    let r = gen.next()
    while (!r.done) {
      flags.push(r.value.last)
      r = gen.next([true, null])
    }
    assert.deepStrictEqual(flags, [false, false, true])
  })

  it('runs through matrix in correct order (from index.test.ts)', () => {
    const matrix = [
      [1, 2, 3],
      [11, 12],
      [22, 23]
    ]
    const context = { prev: 0 }
    const gen = backtrackForMatrix(matrix, context)
    const combinations: any[] = []
    let result = gen.next()
    while (!result.done) {
      const val = result.value!
      const value = val.item as number
      const ctx = val.context as { prev: number }
      combinations.push({ item: value, prev: ctx.prev, last: val.last })
      result = gen.next([!!(value % 2), { prev: value }])
    }
    assert.deepStrictEqual(combinations, [
      { item: 1,  prev: 0,  last: false },
      { item: 11, prev: 1,  last: false },
      { item: 22, prev: 11, last: true  },
      { item: 23, prev: 11, last: true  },
      { item: 12, prev: 1,  last: false },
      { item: 2,  prev: 0,  last: false },
      { item: 3,  prev: 0,  last: false },
      { item: 11, prev: 3,  last: false },
      { item: 22, prev: 11, last: true  },
      { item: 23, prev: 11, last: true  },
      { item: 12, prev: 3,  last: false },
    ])
  })
})
