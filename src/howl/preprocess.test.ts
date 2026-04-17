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
