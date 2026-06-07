/**
 * meta.rules → buildAnalyzeOptions → AnalyzeOptions.regulation の伝達経路を保障する。
 *
 * Phase 0 で構築した「scenario の `meta.rules:` 指定が retar 推論まで透過する」
 * 経路に対する unit test。 scenario 経由の動作確認は retar 解析範囲の習熟が要るため、
 * ここでは経路の存在と meta.options 優先順位だけを保証する。
 */

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { buildAnalyzeOptions, defaultAnalyzeOptions } from './expectations.ts'
import { defaultAnalyzeRegulation, firstGhostAnalyzeRegulation } from './defaults.ts'
import { resolveRegulation } from '../howl/ruleset.ts'

describe('buildAnalyzeOptions: meta.rules → regulation の伝達', () => {
  test('meta.rules 未指定で defaultAnalyzeRegulation を採用する', () => {
    const options = buildAnalyzeOptions({})
    assert.strictEqual(options.regulation, defaultAnalyzeRegulation)
  })

  test('meta.rules.general.first-victim を regulation に反映する', () => {
    const options = buildAnalyzeOptions({ rules: { 'general.first-victim': 'random' } })
    assert.strictEqual(options.regulation['general.first-victim'], 'random')
  })

  test('meta.rules.role.seer.first-seek を regulation に反映する', () => {
    const options = buildAnalyzeOptions({ rules: { 'role.seer.first-seek': 'no-wolf' } })
    assert.strictEqual(options.regulation['role.seer.first-seek'], 'no-wolf')
  })

  test('meta.rules 部分指定でも他フィールドは default 値を保つ', () => {
    const options = buildAnalyzeOptions({ rules: { 'general.first-victim': 'random' } })
    assert.strictEqual(options.regulation['role.seer.first-seek'], 'all')
    assert.strictEqual(options.regulation['vote.style'], 'free')
    assert.strictEqual(options.regulation['vote.final'], 'revote')
    assert.strictEqual(options.regulation['vote.tiebreaker'], 'draw')
    assert.strictEqual(options.regulation['phase.lastwill'], true)
  })

  test('meta.options.regulation を指定すると meta.rules より優先される', () => {
    const customRegulation = resolveRegulation({ 'general.first-victim': 'villager-only' })
    const options = buildAnalyzeOptions({
      rules: { 'general.first-victim': 'random' },
      options: { regulation: customRegulation },
    })
    assert.strictEqual(options.regulation['general.first-victim'], 'villager-only')
  })

  test('meta.options で部分的に上書きしても retar 固有フィールドは保たれる', () => {
    const options = buildAnalyzeOptions({
      options: { seerClaimingDueDate: 99 },
    })
    assert.strictEqual(options.seerClaimingDueDate, 99)
    assert.strictEqual(options.dayCountFrom, defaultAnalyzeOptions.dayCountFrom)
    assert.strictEqual(options.regulation, defaultAnalyzeRegulation)
  })
})

describe('defaultAnalyzeRegulation / firstGhostAnalyzeRegulation: retar test default', () => {
  test('defaultAnalyzeRegulation は初日犠牲なし、 seer 初夜は無制約', () => {
    assert.strictEqual(defaultAnalyzeRegulation['general.first-victim'], 'none')
    assert.strictEqual(defaultAnalyzeRegulation['role.seer.first-seek'], 'all')
  })

  test('firstGhostAnalyzeRegulation は初日犠牲ありで lupa engine 本番と整合する', () => {
    assert.strictEqual(firstGhostAnalyzeRegulation['general.first-victim'], 'random')
    assert.strictEqual(firstGhostAnalyzeRegulation['role.seer.first-seek'], 'all')
  })
})
