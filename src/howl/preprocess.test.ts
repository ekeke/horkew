import { preprocess } from './preprocess.ts'
import assert from 'node:assert'
import test from 'node:test'

test('preprocess function - extracts frontmatter and processes lines', () => {
  const input = `---
title: Test Document
author: John Doe
---
# This is a comment
Line 1
!Spoiler line
`

  const expectedMeta = {
    title: 'Test Document',
    author: 'John Doe',
  }

  const expectedLines = [
    { number: 6, content: 'Line 1' },
    { number: 7, content: '!Spoiler line' },
  ]

  const result = preprocess(input)

  assert.deepStrictEqual(result.meta, expectedMeta, 'Meta data should match')
  assert.deepStrictEqual(result.lines, expectedLines, 'Processed lines should match')
})

test('preprocess function - handles input without frontmatter', () => {
  const input = `
Line 1
!Spoiler line
`

  const expectedMeta = {}

  const expectedLines = [
    { number: 2, content: 'Line 1' },
    { number: 3, content: '!Spoiler line' },
  ]

  const result = preprocess(input)

  assert.deepStrictEqual(result.meta, expectedMeta, 'Meta data should be empty')
  assert.deepStrictEqual(result.lines, expectedLines, 'Processed lines should match')
})

test('preprocess function - handles empty input', () => {
  const input = ``

  const expectedMeta = {}
  const expectedLines: any[] = []

  const result = preprocess(input)

  assert.deepStrictEqual(result.meta, expectedMeta, 'Meta data should be empty')
  assert.deepStrictEqual(result.lines, expectedLines, 'Processed lines should be empty')
})

test('preprocess function - hoists join lines to the top', () => {
  const input = `アリス: 占いCO ボブ白
+アリス、ボブ、チャーリー
吊り ボブ`

  const result = preprocess(input)

  assert.strictEqual(result.lines[0].content, '+アリス、ボブ、チャーリー', 'Join line should be hoisted to first position')
  assert.strictEqual(result.lines[1].content, 'アリス: 占いCO ボブ白')
  assert.strictEqual(result.lines[2].content, '吊り ボブ')
})

test('preprocess function - hoists full-width join lines', () => {
  const input = `吊り ボブ
＋アリス、ボブ`

  const result = preprocess(input)

  assert.strictEqual(result.lines[0].content, '＋アリス、ボブ', 'Full-width + join should be hoisted')
  assert.strictEqual(result.lines[1].content, '吊り ボブ')
})

test('preprocess function - preserves order among multiple join lines', () => {
  const input = `吊り ボブ
+アリス、ボブ
噛み チャーリー
+デイブ、エミリー`

  const result = preprocess(input)

  assert.strictEqual(result.lines[0].content, '+アリス、ボブ')
  assert.strictEqual(result.lines[1].content, '+デイブ、エミリー')
  assert.strictEqual(result.lines[2].content, '吊り ボブ')
  assert.strictEqual(result.lines[3].content, '噛み チャーリー')
})

// cursorLine フィルタは構造行 (join / 配役 / レギュ / レギュレーション / setup) を常に保持する。
// 配役系の prefix は CJK 始まりのため、\b ベースの判定だと word boundary が立たず
// 「cursor が配役行より前にあるとき配役行が落ち、bridge が default 配役を自動推定する」
// 不具合を起こす。look-ahead で半角/全角/タブ空白または行末を許容することで保護する。
test('preprocess - cursorLine filter preserves setup lines above cursor (各 prefix)', () => {
  for (const prefix of ['配役', 'レギュ', 'レギュレーション', 'setup']) {
    const setupLine = `${prefix} 村2 占1 狼1`
    const input = [
      '本文1',
      '本文2',
      setupLine,    // line 3
      '本文3',
    ].join('\n')
    // cursor = 2 → 本文1 / 本文2 は残るが、setup 行 (line 3) は cursorLine フィルタを通る
    const result = preprocess(input, 2)
    const contents = result.lines.map(l => l.content)
    assert.ok(contents.includes(setupLine), `${prefix} 行は cursorLine より下にあっても構造行として残るべき`)
  }
})

test('preprocess - cursorLine filter respects full-width and tab whitespace after setup prefix', () => {
  // 半角空白 / 全角空白 / タブ の 3 種について、setup prefix の直後にどの空白でも保護されること
  const variants = [
    '配役 村2 占1 狼1',
    '配役　村2 占1 狼1',
    '配役\t村2 占1 狼1',
    'setup 村2 占1 狼1',
    'setup　村2 占1 狼1',
  ]
  for (const setupLine of variants) {
    const input = ['本文1', setupLine, '本文2'].join('\n')
    const result = preprocess(input, 1)
    const contents = result.lines.map(l => l.content)
    assert.ok(contents.includes(setupLine), `${JSON.stringify(setupLine)} は構造行として残るべき`)
  }
})

test('preprocess - cursorLine filter still drops non-structural lines below cursor', () => {
  // 構造行保護のために non-structural な行までうっかり保護しないこと
  const input = ['本文1', '本文2', '本文3'].join('\n')
  const result = preprocess(input, 1)
  const contents = result.lines.map(l => l.content)
  assert.deepStrictEqual(contents, ['本文1'])
})

test('preprocess - cursorLine filter does not match prefix continuations (配役者)', () => {
  // `配役者` のような prefix continuation を構造行と誤認しないこと
  // (= cursorLine より下にあれば落ちる)
  const input = ['本文1', '配役者の説明', '本文3'].join('\n')
  const result = preprocess(input, 1)
  const contents = result.lines.map(l => l.content)
  assert.ok(!contents.includes('配役者の説明'), '配役者 で始まる行は構造行ではない')
})

// 行末コメント: 空白 + `#` 以降を行末まで除去する。
// 行頭 `#` (フルラインコメント) とは別経路で処理し、 `#1` のような空白なしハッシュ
// トークンと衝突しないようにする。
test('preprocess - strips trailing # comment after half-width space', () => {
  const input = 'アリス→ボブ # アリスの初手投票'
  const result = preprocess(input)
  assert.deepStrictEqual(result.lines, [{ number: 1, content: 'アリス→ボブ' }])
})

test('preprocess - strips trailing # comment after full-width space', () => {
  const input = 'アリス→ボブ　# 全角空白で区切ったコメント'
  const result = preprocess(input)
  assert.deepStrictEqual(result.lines, [{ number: 1, content: 'アリス→ボブ' }])
})

test('preprocess - strips trailing # comment after tab', () => {
  const input = 'アリス→ボブ\t# tab で区切ったコメント'
  const result = preprocess(input)
  assert.deepStrictEqual(result.lines, [{ number: 1, content: 'アリス→ボブ' }])
})

test('preprocess - does NOT strip # without leading whitespace', () => {
  // 空白なしの `#` はコメントではない (ハッシュタグ的トークンとの衝突を防ぐ)。
  // parser 側で unknown になるかどうかは別の話で、 preprocess はそのまま渡す。
  const input = 'アリス→ボブ#メモ'
  const result = preprocess(input)
  assert.deepStrictEqual(result.lines, [{ number: 1, content: 'アリス→ボブ#メモ' }])
})

test('preprocess - strips first # onwards even with multiple # in line', () => {
  // 1 個目の `[ws]#` 以降は全て comment (内部の `#` も含む)
  const input = 'アリス→ボブ # コメント # 内部の#も込み'
  const result = preprocess(input)
  assert.deepStrictEqual(result.lines, [{ number: 1, content: 'アリス→ボブ' }])
})

test('preprocess - trailing-only # (without comment body) is stripped', () => {
  const input = 'アリス→ボブ #'
  const result = preprocess(input)
  assert.deepStrictEqual(result.lines, [{ number: 1, content: 'アリス→ボブ' }])
})

test('preprocess - line consisting only of whitespace + # is dropped', () => {
  // 結果が空文字になる行は drop されて lines に入らない
  const input = ['アリス→ボブ', '   # インデント付きコメント', 'チャーリー→デイブ'].join('\n')
  const result = preprocess(input)
  assert.deepStrictEqual(result.lines.map(l => l.content), ['アリス→ボブ', 'チャーリー→デイブ'])
})
