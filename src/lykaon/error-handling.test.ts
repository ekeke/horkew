/*
 * AnalysisContext.svelte.ts 内の preprocess / parse / bridge の握りつぶし回避ロジックの unit test。
 *
 * かつて 3 段全て catch して null/空配列を返すだけだったため、 構文エラーや spoiler 矛盾で
 * 解析 UI (combined pane) が黙って空になり、 ユーザーが原因に気付けなかった。
 * このテストは catch した Error を呼び出し側へ伝播させる挙動を担保する。
 */
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert'
import { safeParse, safeBuildVillage, normalizePreprocess } from './parseHelpers.ts'

// console.error は API 利用者への通知経路として残してあるが、 テスト出力を汚すので抑制。
let originalConsoleError: typeof console.error
before(() => {
  originalConsoleError = console.error
  console.error = () => {}
})
after(() => {
  console.error = originalConsoleError
})

describe('safeParse', () => {
  test('正常 .howl は error=null を返す', () => {
    const result = safeParse('+アリス\n+ボブ\n')
    assert.strictEqual(result.error, null)
    assert.ok(result.statements.length > 0)
  })

  test('throw 入力でも例外を上に投げず error に保持する', () => {
    // setup 無し / JOIN 無しで数字席番号を使うと parser が throw する
    const result = safeParse('1 → 2\n')
    assert.ok(result.error instanceof Error, 'error は Error インスタンス')
    assert.match(result.error!.message, /setup も JOIN/)
    assert.deepStrictEqual(result.statements, [])
  })
})

describe('safeBuildVillage', () => {
  test('正常 statements は error=null + bridge 返却', () => {
    const parsed = safeParse('+アリス\n+ボブ\n!アリス=seer\n')
    const result = safeBuildVillage(parsed)
    assert.strictEqual(result.error, null)
    assert.ok(result.bridge !== null)
  })

  test('空 statements は error=null + bridge=null (黙って空でよい正常ケース)', () => {
    const parsed = safeParse('')
    const result = safeBuildVillage(parsed)
    assert.strictEqual(result.error, null)
    assert.strictEqual(result.bridge, null)
  })

  test('spoiler 矛盾 (alias deny に含まれる pin) は error に保持される', () => {
    // hostile alias は seer を deny するので、 後続の `!アリス=seer` は矛盾
    const parsed = safeParse('+アリス\n+ボブ\n!アリス=人外\n!アリス=seer\n')
    const result = safeBuildVillage(parsed)
    assert.ok(result.error instanceof Error, 'bridge エラーが error に入る')
    assert.match(result.error!.message, /矛盾する仮定/)
    assert.match(result.error!.message, /line/, 'メッセージには line ヒントが含まれる')
    assert.strictEqual(result.bridge, null)
  })
})

describe('normalizePreprocess', () => {
  test('undefined hook は原文を error=null で返す', () => {
    const { result, error } = normalizePreprocess(undefined, 'abc')
    assert.deepStrictEqual(result, { text: 'abc', lineOffset: 0 })
    assert.strictEqual(error, null)
  })

  test('string 戻り値の hook は lineOffset=0 に揃える', () => {
    const { result, error } = normalizePreprocess((_: string) => 'transformed', 'abc')
    assert.deepStrictEqual(result, { text: 'transformed', lineOffset: 0 })
    assert.strictEqual(error, null)
  })

  test('hook が throw しても上に投げず error に保持、 原文 fallback', () => {
    const buggyHook = () => { throw new Error('preprocess buggy') }
    const { result, error } = normalizePreprocess(buggyHook, 'abc')
    assert.deepStrictEqual(result, { text: 'abc', lineOffset: 0 })
    assert.ok(error instanceof Error)
    assert.strictEqual(error!.message, 'preprocess buggy')
  })
})
