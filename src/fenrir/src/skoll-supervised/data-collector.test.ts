/**
 * data-collector の単体テスト
 *
 * makeSoftLabel と JSONL 入出力の動作確認。
 * ゲーム生成は重いので integration test は別ファイル（または smoke run）で。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeSoftLabel, writeSamplesAsJsonl, type SkollSample } from './data-collector.ts'
import { SEATS } from '../observation.ts'

test('makeSoftLabel: basic distribution sums to 1 over alive seats', () => {
  const executions = [
    { seat: 1, winRate: 0.5 },
    { seat: 2, winRate: 0.7 },
    { seat: 3, winRate: 0.3 },
  ]
  const { label, mask, topMargin } = makeSoftLabel(executions, 0.3)

  assert.equal(label.length, SEATS)
  assert.equal(mask.length, SEATS)

  let sum = 0
  for (let i = 0; i < SEATS; i++) sum += label[i]
  assert.ok(Math.abs(sum - 1.0) < 1e-5, `label sum should be 1, got ${sum}`)

  // alive seats (1, 2, 3) は mask = 0
  assert.equal(mask[0], 0)
  assert.equal(mask[1], 0)
  assert.equal(mask[2], 0)
  // dead seats は mask < 0
  for (let i = 3; i < SEATS; i++) {
    assert.ok(mask[i] < -1e6, `dead seat ${i + 1} should be masked, got ${mask[i]}`)
  }

  // top margin = 0.7 - 0.5 = 0.2
  assert.ok(Math.abs(topMargin - 0.2) < 1e-9)

  // seat 2 (highest winRate) は最大確率を持つ
  assert.ok(label[1] > label[0])
  assert.ok(label[1] > label[2])
})

test('makeSoftLabel: tied winRates produce uniform distribution', () => {
  const executions = [
    { seat: 1, winRate: 0.5 },
    { seat: 2, winRate: 0.5 },
    { seat: 3, winRate: 0.5 },
  ]
  const { label, topMargin } = makeSoftLabel(executions, 0.3)

  const expected = 1 / 3
  for (const seat of [1, 2, 3]) {
    assert.ok(Math.abs(label[seat - 1] - expected) < 1e-5, `seat ${seat}: expected ${expected}, got ${label[seat - 1]}`)
  }
  assert.equal(topMargin, 0)
})

test('makeSoftLabel: low temperature sharpens toward argmax', () => {
  const executions = [
    { seat: 1, winRate: 0.3 },
    { seat: 2, winRate: 0.7 },
  ]
  const sharp = makeSoftLabel(executions, 0.05)
  const soft = makeSoftLabel(executions, 1.0)

  // 低温は seat 2 に集中
  assert.ok(sharp.label[1] > 0.99, `sharp should concentrate on seat 2, got ${sharp.label[1]}`)
  // 高温はより均等
  assert.ok(soft.label[1] < sharp.label[1], `soft should be flatter than sharp`)
})

test('makeSoftLabel: empty executions returns zero label', () => {
  const { label, mask, topMargin } = makeSoftLabel([], 0.3)
  for (let i = 0; i < SEATS; i++) {
    assert.equal(label[i], 0)
    assert.ok(mask[i] < -1e6)
  }
  assert.equal(topMargin, 0)
})

test('writeSamplesAsJsonl: roundtrip preserves data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skoll-collector-test-'))
  const path = join(dir, 'samples.jsonl')

  const obs = new Float32Array(SEATS).fill(0.5)
  const label = new Float32Array(SEATS)
  label[3] = 1.0
  const mask = new Float32Array(SEATS)

  const samples: SkollSample[] = [
    {
      observation: obs,
      label,
      mask,
      metadata: {
        gameId: 0, day: 2, seat: 5, role: 'villager',
        aliveCount: 12, topMargin: 0.15,
        rawWinRates: [{ seat: 4, winRate: 0.7 }, { seat: 5, winRate: 0.55 }],
        bestExecution: 4,
      },
    },
  ]

  try {
    writeSamplesAsJsonl(samples, path)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const parsed = JSON.parse(lines[0])
    assert.equal(parsed.observation.length, SEATS)
    assert.equal(parsed.label[3], 1.0)
    assert.equal(parsed.metadata.gameId, 0)
    assert.equal(parsed.metadata.bestExecution, 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
