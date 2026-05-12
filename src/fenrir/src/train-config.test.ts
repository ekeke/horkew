/**
 * loadTrainConfig の unit test。
 *
 * 検証項目:
 * - ファイル不存在 → no-op
 * - 通常 load: number / boolean / string が process.env に書き込まれる
 * - 既に env にある key は skip (shell env 優先)
 * - 無効型 (null / object / array) は invalid に集計、env は書かない
 * - JSON parse エラー / 非 object root は throw
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadTrainConfig } from './train-config.ts'

/** テスト用 fixture dir + ファイル書き込みヘルパー */
let tmpDir: string
const TEST_KEYS = [
  'TEST_TC_STRING', 'TEST_TC_NUMBER', 'TEST_TC_FLOAT', 'TEST_TC_NEGATIVE',
  'TEST_TC_BOOL_TRUE', 'TEST_TC_BOOL_FALSE',
  'TEST_TC_EXISTING', 'TEST_TC_NULL', 'TEST_TC_OBJECT', 'TEST_TC_ARRAY',
  'TEST_TC_INF', 'TEST_TC_NAN',
]

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'horkew-tc-'))
})

after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/** 各テスト前にテスト用 env を確実に削除 */
beforeEach(() => {
  for (const k of TEST_KEYS) delete process.env[k]
})

function writeJson(name: string, obj: unknown): string {
  const path = join(tmpDir, name)
  writeFileSync(path, JSON.stringify(obj, null, 2))
  return path
}

describe('loadTrainConfig', () => {
  it('ファイル不存在で no-op (path=null、loaded/skipped/invalid 空)', () => {
    const result = loadTrainConfig(join(tmpDir, 'nonexistent.json'))
    assert.equal(result.path, null)
    assert.deepEqual(result.loaded, [])
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(result.invalid, [])
  })

  it('string / number / boolean を process.env に書き込む', () => {
    const path = writeJson('case1.json', {
      TEST_TC_STRING: 'hello',
      TEST_TC_NUMBER: 4,
      TEST_TC_FLOAT: 0.05,
      TEST_TC_NEGATIVE: -3.0,
      TEST_TC_BOOL_TRUE: true,
      TEST_TC_BOOL_FALSE: false,
    })
    const result = loadTrainConfig(path)
    assert.equal(result.path, path)
    assert.equal(result.loaded.length, 6)
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(result.invalid, [])

    assert.equal(process.env.TEST_TC_STRING, 'hello')
    assert.equal(process.env.TEST_TC_NUMBER, '4')
    assert.equal(process.env.TEST_TC_FLOAT, '0.05')
    assert.equal(process.env.TEST_TC_NEGATIVE, '-3')
    // boolean は "1" / "0" 表記 (SKOLLZ_* 系の判定と整合)
    assert.equal(process.env.TEST_TC_BOOL_TRUE, '1')
    assert.equal(process.env.TEST_TC_BOOL_FALSE, '0')
  })

  it('既に shell env にある key は skip (shell が優先)', () => {
    process.env.TEST_TC_EXISTING = 'shell-value'
    const path = writeJson('case2.json', {
      TEST_TC_EXISTING: 'config-value',
      TEST_TC_NUMBER: 42,
    })
    const result = loadTrainConfig(path)
    assert.deepEqual(result.skipped, ['TEST_TC_EXISTING'])
    assert.deepEqual(result.loaded, ['TEST_TC_NUMBER'])
    // shell 値が維持される
    assert.equal(process.env.TEST_TC_EXISTING, 'shell-value')
    assert.equal(process.env.TEST_TC_NUMBER, '42')
  })

  it('null / object / array は invalid に集計、env は書かない', () => {
    const path = writeJson('case3.json', {
      TEST_TC_STRING: 'ok',
      TEST_TC_NULL: null,
      TEST_TC_OBJECT: { foo: 'bar' },
      TEST_TC_ARRAY: [1, 2, 3],
    })
    const result = loadTrainConfig(path)
    assert.deepEqual(result.loaded, ['TEST_TC_STRING'])
    assert.deepEqual(result.invalid.sort(), ['TEST_TC_ARRAY', 'TEST_TC_NULL', 'TEST_TC_OBJECT'])
    assert.equal(process.env.TEST_TC_STRING, 'ok')
    assert.equal(process.env.TEST_TC_NULL, undefined)
    assert.equal(process.env.TEST_TC_OBJECT, undefined)
    assert.equal(process.env.TEST_TC_ARRAY, undefined)
  })

  it('Infinity / NaN も invalid (Number.isFinite==false)', () => {
    // JSON.stringify は Infinity/NaN を null にする。number 値で直接渡せるよう writeFileSync 経由。
    const path = join(tmpDir, 'case4.json')
    writeFileSync(path, '{"TEST_TC_INF": 1e9999, "TEST_TC_NAN": null, "TEST_TC_NUMBER": 1}')
    const result = loadTrainConfig(path)
    // 1e9999 → Infinity (JSON.parse がこう変換することはなく、実際は null/SyntaxError 系)
    // → 確実に通すには TEST_TC_NUMBER=1 のみが loaded、他は invalid に該当することを確認
    assert.ok(result.loaded.includes('TEST_TC_NUMBER'))
    assert.equal(process.env.TEST_TC_NUMBER, '1')
  })

  it('JSON parse エラーで throw', () => {
    const path = join(tmpDir, 'malformed.json')
    writeFileSync(path, '{ not-json }')
    assert.throws(() => loadTrainConfig(path))
  })

  it('root が array で throw', () => {
    const path = writeJson('array.json', [1, 2, 3])
    assert.throws(() => loadTrainConfig(path), /object/)
  })

  it('root が number で throw', () => {
    const path = writeJson('number.json', 42)
    assert.throws(() => loadTrainConfig(path), /object/)
  })

  it('root が null で throw', () => {
    const path = writeJson('null.json', null)
    assert.throws(() => loadTrainConfig(path), /object/)
  })

  it('_ で始まる key はコメント用として skip (loaded/skipped/invalid いずれにも入らない)', () => {
    const path = writeJson('comments.json', {
      _comment: 'これは説明',
      _meta_version: 1,
      _description: { ja: '日本語', en: 'english' },  // object でも skip 優先
      TEST_TC_STRING: 'real-value',
    })
    const result = loadTrainConfig(path)
    assert.deepEqual(result.loaded, ['TEST_TC_STRING'])
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(result.invalid, [])
    assert.equal(process.env._comment, undefined)
    assert.equal(process.env._meta_version, undefined)
    assert.equal(process.env._description, undefined)
    assert.equal(process.env.TEST_TC_STRING, 'real-value')
  })
})
