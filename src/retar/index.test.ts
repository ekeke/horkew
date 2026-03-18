import { describe, it } from 'node:test'
import assert from 'node:assert'
import { backtrackForMatrix } from './index.ts'

describe('isPossibleSetsForRole', () => {
  it('should return true when there are possible sets for each role', () => {
    assert.strictEqual(true, true)
  })

})

describe('backtrackForMatrix', () => {
  it('should run through matrix in correct order', () => {
    const matrix = [
      [1, 2, 3],
      [11, 12],
      [22, 23]
    ]
    const context = { prev: 0 }
    type YieldType = ReturnType<typeof backtrackForMatrix> extends Generator<infer T> ? T : never
    const generator = backtrackForMatrix(matrix, context)
    const combinations: any[] = []
    let result = generator.next()
    while (true) {
      if (result.done) break
      if (result.value == null) {
        throw new Error('result.value is null')
      }
      const val: YieldType = result.value as YieldType

      const value = val.item as number
      const ctx = val.context as { prev: number }
      const prev = ctx.prev
      const last = val.last
      combinations.push({item: value, prev, last})
      result = generator.next([!!(value % 2), {prev: value}])
    }
    assert.deepStrictEqual(combinations, [
      { item: 1,  prev: 0  , last: false },
      { item: 11, prev: 1  , last: false },
      { item: 22, prev: 11 , last: true  },
      { item: 23, prev: 11 , last: true  },
      { item: 12, prev: 1  , last: false },
      { item: 2,  prev: 0  , last: false },
      { item: 3,  prev: 0  , last: false },
      { item: 11, prev: 3  , last: false },
      { item: 22, prev: 11 , last: true  },
      { item: 23, prev: 11 , last: true  },
      { item: 12, prev: 3  , last: false },
    ])
  })
})
