import { test, describe } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  stripAnnotations,
  annotateFile,
  stripFile,
  BEGIN_MARK,
  END_MARK,
} from './spec-annotate.ts'

const SAMPLE_SPEC = `---
title: test scenario
setup: { kogitsune: 1, werewolf: 1, villager: 2 }
rules:
  first-victim: none
---
# comment line

++Alice、Bob、Carol、Dave
!Alice=子狐
!Bob=人狼
!Carol=村人
!Dave=村人

Alice→Bob
Carol→Bob
Dave→Bob
Bob→Alice

# @expect-status Alice: alive
`

describe('stripAnnotations', () => {
  test('text without annotations returns unchanged structure', () => {
    const text = `++Alice、Bob\nAlice→Bob\n# @expect-status Alice: alive\n`
    assert.strictEqual(stripAnnotations(text), text)
  })

  test('removes a single annotation block', () => {
    const text = `++Alice、Bob\n${BEGIN_MARK} Day 1 ==\n# vote tally: Bob 1 → execution=Bob\n${END_MARK}\nAlice→Bob\n`
    const out = stripAnnotations(text)
    assert.ok(!out.includes(BEGIN_MARK), 'BEGIN_MARK should be removed')
    assert.ok(!out.includes(END_MARK), 'END_MARK should be removed')
    assert.ok(out.includes('++Alice、Bob'), 'non-annotation content preserved')
    assert.ok(out.includes('Alice→Bob'), 'non-annotation content preserved')
  })

  test('removes multiple annotation blocks while preserving @expect comments', () => {
    const text = `++Alice、Bob\n${BEGIN_MARK} Day 1 ==\n# vote\n${END_MARK}\nAlice→Bob\n${BEGIN_MARK} Final ==\n# result: villager_won\n${END_MARK}\n# @expect-status Alice: alive\n`
    const out = stripAnnotations(text)
    assert.ok(!out.includes(BEGIN_MARK))
    assert.ok(out.includes('# @expect-status Alice: alive'), '@expect comment preserved')
  })

  test('preserves user written # comments (non-annotation)', () => {
    const text = `# user comment\n++Alice、Bob\n${BEGIN_MARK} Day 1 ==\n# vote\n${END_MARK}\n# @expect-status Alice: alive\n`
    const out = stripAnnotations(text)
    assert.ok(out.includes('# user comment'))
    assert.ok(out.includes('# @expect-status Alice: alive'))
    assert.ok(!out.includes('# vote'))
  })

  test('idempotent: applying twice gives same result', () => {
    const text = `++Alice、Bob\n${BEGIN_MARK} Day 1 ==\n# vote\n${END_MARK}\nAlice→Bob\n`
    const once = stripAnnotations(text)
    const twice = stripAnnotations(once)
    assert.strictEqual(once, twice)
  })
})

describe('annotateFile + stripFile (in-place roundtrip)', () => {
  function makeTempSpec(): { path: string, cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'spec-annotate-test-'))
    const path = join(dir, 'sample.howl')
    writeFileSync(path, SAMPLE_SPEC, 'utf-8')
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  test('annotateFile inserts engine annotation blocks', async () => {
    const { path, cleanup } = makeTempSpec()
    try {
      await annotateFile(path)
      const after = readFileSync(path, 'utf-8')
      assert.ok(after.includes(BEGIN_MARK), 'BEGIN_MARK inserted')
      assert.ok(after.includes(END_MARK), 'END_MARK inserted')
      assert.ok(after.includes('vote tally'), 'tally line inserted')
      assert.ok(after.includes('result:'), 'final result inserted')
      // 原文の重要部分は保持されている
      assert.ok(after.includes('++Alice、Bob、Carol、Dave'), 'join preserved')
      assert.ok(after.includes('# @expect-status Alice: alive'), '@expect preserved')
    } finally {
      cleanup()
    }
  })

  test('stripFile removes annotations after annotateFile', async () => {
    const { path, cleanup } = makeTempSpec()
    try {
      await annotateFile(path)
      stripFile(path)
      const after = readFileSync(path, 'utf-8')
      assert.ok(!after.includes(BEGIN_MARK), 'BEGIN_MARK removed')
      assert.ok(!after.includes(END_MARK), 'END_MARK removed')
      assert.ok(after.includes('++Alice、Bob、Carol、Dave'), 'join preserved')
      assert.ok(after.includes('# @expect-status Alice: alive'), '@expect preserved')
      assert.ok(after.includes('# comment line'), 'user comment preserved')
    } finally {
      cleanup()
    }
  })

  test('annotate -> strip roundtrip preserves non-annotation content', async () => {
    const { path, cleanup } = makeTempSpec()
    try {
      const before = readFileSync(path, 'utf-8')
      await annotateFile(path)
      stripFile(path)
      const after = readFileSync(path, 'utf-8')
      // 改行正規化分の差を吸収して比較
      const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd()
      assert.strictEqual(norm(after), norm(before),
        `roundtrip should return content to original (excluding whitespace normalization)`)
    } finally {
      cleanup()
    }
  })

  test('annotate is idempotent (running twice produces same output)', async () => {
    const { path, cleanup } = makeTempSpec()
    try {
      await annotateFile(path)
      const first = readFileSync(path, 'utf-8')
      await annotateFile(path)
      const second = readFileSync(path, 'utf-8')
      assert.strictEqual(first, second)
    } finally {
      cleanup()
    }
  })
})
