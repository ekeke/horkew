import { preprocess } from '../src/preprocess.ts'
import assert from 'node:assert'
import test from 'node:test'

test('preprocess function - extracts frontmatter and processes lines', () => {
  const input = `---
title: Test Document
author: John Doe
---
# This is a comment
Line 1
Line 2 with !spoiler
!Another spoiler
`

  const expectedMeta = {
    title: 'Test Document',
    author: 'John Doe',
  }

  const expectedLines = [
    { number: 6, content: 'Line 1' },
    { number: 7, content: 'Line 2 with' },
    { number: 7, content: '!spoiler' },
    { number: 8, content: '!Another spoiler' },
  ]

  const result = preprocess(input)

  assert.deepStrictEqual(result.meta, expectedMeta, 'Meta data should match')
  assert.deepStrictEqual(result.lines, expectedLines, 'Processed lines should match')
})

test('preprocess function - handles input without frontmatter', () => {
  const input = `
Line 1
Line 2 with !spoiler
!Another spoiler
`

  const expectedMeta = {}

  const expectedLines = [
    { number: 2, content: 'Line 1' },
    { number: 3, content: 'Line 2 with' },
    { number: 3, content: '!spoiler' },
    { number: 4, content: '!Another spoiler' },
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

