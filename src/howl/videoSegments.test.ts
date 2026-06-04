import { describe, test } from 'node:test'
import assert from 'node:assert'
import { buildVideoSegments } from './videoSegments.ts'
import { parse } from './parser.ts'
import type { Statement } from './statement.ts'

describe('buildVideoSegments', () => {
  test('単一 @URL + 単独/インライン timestamp 混在 → 1 セグメント、seconds 昇順', () => {
    const statements: Statement[] = [
      { type: 'videoSource', line: 1, url: 'https://youtu.be/abc' } as Statement,
      // インライン timestamp (assert などに付く)
      { type: 'assert', line: 3, timestamp: 90 } as Statement,
      // 単独 timestamp
      { type: 'timestamp', line: 5, seconds: 30, raw: '0:30' } as Statement,
      // さらにインライン
      { type: 'vote', line: 7, timestamp: 120 } as Statement,
    ]
    const segments = buildVideoSegments(statements)
    assert.equal(segments.length, 1)
    assert.equal(segments[0].url, 'https://youtu.be/abc')
    assert.equal(segments[0].line, 1)
    assert.deepEqual(segments[0].timestamps, [
      { line: 5, seconds: 30 },
      { line: 3, seconds: 90 },
      { line: 7, seconds: 120 },
    ])
  })

  test('複数 @URL → URL ごとにセグメント分割、各 timestamp が直近の URL に属する', () => {
    const statements: Statement[] = [
      { type: 'videoSource', line: 1, url: 'https://youtu.be/part1' } as Statement,
      { type: 'timestamp', line: 2, seconds: 10, raw: '0:10' } as Statement,
      { type: 'assert', line: 3, timestamp: 20 } as Statement,
      { type: 'videoSource', line: 5, url: 'https://youtu.be/part2' } as Statement,
      { type: 'timestamp', line: 6, seconds: 40, raw: '0:40' } as Statement,
      { type: 'vote', line: 7, timestamp: 50 } as Statement,
    ]
    const segments = buildVideoSegments(statements)
    assert.equal(segments.length, 2)
    assert.equal(segments[0].url, 'https://youtu.be/part1')
    assert.equal(segments[0].line, 1)
    assert.deepEqual(segments[0].timestamps, [
      { line: 2, seconds: 10 },
      { line: 3, seconds: 20 },
    ])
    assert.equal(segments[1].url, 'https://youtu.be/part2')
    assert.equal(segments[1].line, 5)
    assert.deepEqual(segments[1].timestamps, [
      { line: 6, seconds: 40 },
      { line: 7, seconds: 50 },
    ])
  })

  test('最初の @URL より前の timestamp は無視される', () => {
    const statements: Statement[] = [
      { type: 'timestamp', line: 1, seconds: 5, raw: '0:05' } as Statement,
      { type: 'assert', line: 2, timestamp: 8 } as Statement,
      { type: 'videoSource', line: 3, url: 'https://youtu.be/main' } as Statement,
      { type: 'timestamp', line: 4, seconds: 60, raw: '1:00' } as Statement,
    ]
    const segments = buildVideoSegments(statements)
    assert.equal(segments.length, 1)
    assert.equal(segments[0].url, 'https://youtu.be/main')
    assert.deepEqual(segments[0].timestamps, [{ line: 4, seconds: 60 }])
  })

  test('@URL も timestamp も無い → 空配列', () => {
    const statements: Statement[] = [
      { type: 'join', line: 1 } as Statement,
      { type: 'vote', line: 2 } as Statement,
    ]
    assert.deepEqual(buildVideoSegments(statements), [])
  })

  test('完全に空の statements → 空配列', () => {
    assert.deepEqual(buildVideoSegments([]), [])
  })

  test('parse() の出力と接続できる (end-to-end)', () => {
    const text = [
      '+Alice +Bob +Carol',
      '@https://youtu.be/game1',
      '@0:30',
      'Alice→Bob @1:00',
      '@https://youtu.be/game2',
      '@2:00',
    ].join('\n')
    const { statements } = parse(text)
    const segments = buildVideoSegments(statements)
    assert.equal(segments.length, 2)
    assert.equal(segments[0].url, 'https://youtu.be/game1')
    assert.equal(segments[1].url, 'https://youtu.be/game2')
    // game1 に 2 つの timestamp が属する (単独 0:30 + インライン 1:00)
    assert.equal(segments[0].timestamps.length, 2)
    assert.deepEqual(
      segments[0].timestamps.map(t => t.seconds),
      [30, 60],
    )
    assert.deepEqual(
      segments[1].timestamps.map(t => t.seconds),
      [120],
    )
  })
})
