import { describe, test } from 'node:test'
import assert from 'node:assert'
import { renamePlayer } from './rename.ts'

describe('renamePlayer', () => {
  test('vote の voter / target を置換する', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    assert.match(lines[0], /Alice/)
    assert.strictEqual(lines[1], '+ ボブ')
    assert.strictEqual(lines[2], 'Alice→ボブ')
  })

  test('FlexibleDictionary 経由で表記揺れにマッチする', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      'ありす→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'ありす', 'Alice')
    const lines = out.split('\n').filter(l => l.length > 0)
    assert.match(lines[0], /Alice/)
    // ありす は serializer で canonical 形 (Alice) に置換される
    assert.strictEqual(lines[2], 'Alice→ボブ')
  })

  test('リネーム対象を含まない vote は文字列として完全保存される', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      '+ チャーリー',
      'ボブ  →  チャーリー',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    // 関係ない vote の不規則な空白が保持される
    assert.strictEqual(lines[3], 'ボブ  →  チャーリー')
  })

  test('コメント行は原文のまま保持される', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      '# アリス を疑っている',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    // コメントは触らない
    assert.strictEqual(lines[2], '# アリス を疑っている')
  })

  test('frontmatter は完全保存される (players: も触らない)', () => {
    const input = [
      '---',
      'title: Test',
      'players:',
      '  - アリス',
      '  - ボブ',
      '---',
      '+ アリス',
      '+ ボブ',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const frontmatterEnd = out.indexOf('---\n', 4) + 4
    const frontmatter = out.slice(0, frontmatterEnd)
    assert.match(frontmatter, /^---\ntitle: Test\nplayers:\n  - アリス\n  - ボブ\n---\n/)
  })

  test('存在しない oldName は no-op', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'マロリー', 'Mallory')
    // 全部が文字列として保持される
    assert.strictEqual(out, input)
  })

  test('attack / lynch の target を置換する', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      '噛み アリス',
      'アリス処刑',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    assert.match(lines[2], /Alice/)
    assert.match(lines[3], /Alice/)
    // アリス が残っていないこと (置換対象行のみ)
    assert.doesNotMatch(lines[2], /アリス/)
    assert.doesNotMatch(lines[3], /アリス/)
  })

  test('占いCO の actor / target を置換する', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      '+ チャーリー',
      'アリス 占いCO ボブ○',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    assert.match(lines[3], /^Alice/)
  })

  test('占い結果の target をリネームできる', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      'アリス 占いCO ボブ○',
    ].join('\n')
    const out = renamePlayer(input, 'ボブ', 'Bob')
    const lines = out.split('\n')
    assert.match(lines[2], /Bob/)
    assert.doesNotMatch(lines[2], /ボブ/)
  })

  test('joinMulti の特定プレイヤーのみ置換される', () => {
    const input = [
      '++ アリス, ボブ, チャーリー',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    // joinMulti は serialize で `+ Alice, ボブ, チャーリー` 形式になる
    assert.match(lines[0], /Alice/)
    assert.match(lines[0], /ボブ/)
    assert.match(lines[0], /チャーリー/)
  })

  test('join の aliases / shortName は保持される', () => {
    const input = [
      '+ アリス(あ) あり ア',
      '+ ボブ',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    // name は置換、aliases (あり, ア) は historical reference として保持
    assert.match(lines[0], /Alice/)
    assert.match(lines[0], /あり/)
    assert.match(lines[0], /ア/)
  })

  test('unknown statement は触らない', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      'なんだかよくわからない文字列 アリス',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    // unknown は parse 失敗扱いで原文保持
    assert.strictEqual(lines[2], 'なんだかよくわからない文字列 アリス')
    assert.strictEqual(lines[3], 'Alice→ボブ')
  })

  test('inline @MM:SS timestamp は再 serialize 行でも末尾に保持される', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      'アリス→ボブ @1:23',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    assert.strictEqual(lines[2], 'Alice→ボブ @1:23')
  })
})
