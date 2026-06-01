/**
 * Spec suite runner — lupa engine の振る舞い仕様テスト。
 *
 * src/spec/**\/*.howl を再帰発見し、1 ファイルを lupa engine で駆動して最終
 * state / events に対する `@expect-*` 系アサーションを検証する。
 *
 * retar 推理アサーションはここでは扱わない (retar 自身の関心事は
 * src/retar/scenarios/ + src/retar/integration.test.ts で完結)。
 */

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { runGame } from '../lupa/engine.ts'
import { buildLupaScenario } from '../lupa/howl-adapter.ts'
import type { GameEvent } from '../lupa/types.ts'
import { extractExpectations, verifyExpectations, hasAnyExpectations } from '../lupa/expectations.ts'
import { loadScenariosRecursive } from './loadScenarios.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const specDir = __dirname

const scenarios = loadScenariosRecursive(specDir)

if (scenarios.length === 0) {
  describe('spec suite (no scenarios)', () => {
    test('waiting for scenario files in src/spec/**/*.howl', () => {
      assert.ok(true, 'no scenarios to run')
    })
  })
} else {
  describe('spec suite', () => {
    for (const { relPath, content } of scenarios) {
      const { meta } = parse(content)
      const title = meta.title || relPath

      describe(`${relPath} — ${title}`, () => {
        const lupaExps = extractExpectations(content)
        if (hasAnyExpectations(lupaExps)) {
          test('lupa engine runs and matches expectations', async () => {
            const { statements } = parse(content)
            const { vs, setup, players, assumptions, spoilerActions } = buildVillageStatus(statements, meta)
            const { config, handlers } = buildLupaScenario({
              assumptions, spoilerActions, vs, setup, players, meta,
            })
            const { state, events } = await runGame(config, handlers)
            verifyExpectations(lupaExps, state, events as GameEvent[], players)
          })
        }
      })
    }
  })
}
