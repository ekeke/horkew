import { describe, test } from 'node:test'
import assert from 'node:assert'
import { buildDayLineMap } from './dayLineMap.ts'
import { parse } from './parser.ts'
import type { Statement } from './statement.ts'

describe('buildDayLineMap', () => {
  test('各 Day の最初の行を拾う', () => {
    const statements: Statement[] = [
      { type: 'join', line: 1, day: 0 } as Statement,
      { type: 'assert', line: 5, day: 1 } as Statement,
      { type: 'vote', line: 7, day: 1 } as Statement,
      { type: 'lynch', line: 9, day: 1 } as Statement,
      { type: 'assert', line: 11, day: 2 } as Statement,
      { type: 'vote', line: 13, day: 2 } as Statement,
    ]
    const map = buildDayLineMap(statements)
    assert.equal(map.size, 3)
    assert.equal(map.get(0), 1)
    assert.equal(map.get(1), 5)
    assert.equal(map.get(2), 11)
  })

  test('同じ day を持つ後続 statement は無視される', () => {
    const statements: Statement[] = [
      { type: 'assert', line: 3, day: 1 } as Statement,
      { type: 'vote', line: 4, day: 1 } as Statement,
      { type: 'lynch', line: 5, day: 1 } as Statement,
    ]
    const map = buildDayLineMap(statements)
    assert.equal(map.size, 1)
    assert.equal(map.get(1), 3)
  })

  test('day が undefined の statement は無視される', () => {
    const statements: Statement[] = [
      { type: 'join', line: 1 } as Statement,           // day なし
      { type: 'videoSource', line: 2 } as Statement,    // day なし
      { type: 'assert', line: 3, day: 1 } as Statement,
    ]
    const map = buildDayLineMap(statements)
    assert.equal(map.size, 1)
    assert.equal(map.get(1), 3)
  })

  test('空の statements → 空の Map', () => {
    const map = buildDayLineMap([])
    assert.equal(map.size, 0)
  })

  test('day が飛んでいてもそのまま登録される', () => {
    const statements: Statement[] = [
      { type: 'assert', line: 1, day: 1 } as Statement,
      { type: 'assert', line: 2, day: 3 } as Statement,
      { type: 'assert', line: 3, day: 5 } as Statement,
    ]
    const map = buildDayLineMap(statements)
    assert.equal(map.size, 3)
    assert.equal(map.get(1), 1)
    assert.equal(map.get(3), 2)
    assert.equal(map.get(5), 3)
    assert.equal(map.get(2), undefined)
  })

  test('parse() の出力と接続できる (end-to-end)', () => {
    const text = [
      '+Alice +Bob +Carol +Dave',
      '',
      '1d',
      'Alice→Bob',
      'Bob吊',
      '',
      '2d',
      'Carol→Dave',
      'Dave吊',
    ].join('\n')
    const { statements } = parse(text)
    const map = buildDayLineMap(statements)
    // 1 day = day 1 (1d 表記)、2 day = day 2
    // Map のキーは parser が assignDays で割り当てた day 値に従う
    assert.ok(map.size >= 1, 'day エントリが 1 件以上ある')
    // 全エントリの値は statement の line 範囲内
    const totalLines = text.split('\n').length
    for (const line of map.values()) {
      assert.ok(line >= 1 && line <= totalLines, `line ${line} が範囲内`)
    }
  })
})
