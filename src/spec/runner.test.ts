/**
 * Spec suite runner.
 *
 * src/spec/**\/*.howl を再帰発見し、1 ファイルから lupa engine assertion
 * (`@expect-*`) と retar 推理 assertion (`@expect`, `@expect-faction` 等) を
 * 両方検査する。
 *
 * - retar checkpoint loop: アノテーションが見つかった各 checkpoint で
 *   partial game に対する retar.analyze() を実行
 * - lupa final run: シナリオ全体を engine に流して最終 state / events を検証
 *
 * 同名アノテーション `@expect-status` は両方で検証される (両者の意味論が
 * 一致すべきという前提)。
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
import { extractCheckpoints, runCheckpointTests } from '../retar/expectations.ts'
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
      const { frontmatter, bodyLines, checkpoints } = extractCheckpoints(content)
      const { meta } = parse(content)
      const title = meta.title || relPath

      describe(`${relPath} — ${title}`, () => {
        // retar checkpoints
        for (let i = 0; i < checkpoints.length; i++) {
          const cp = checkpoints[i]
          const partialText = frontmatter + bodyLines.slice(0, cp.lineNumber).join('\n')
          const label = checkpoints.length === 1
            ? `retar checkpoint (line ${cp.lineNumber + 1})`
            : `retar checkpoint ${i + 1} (line ${cp.lineNumber + 1})`
          runCheckpointTests(partialText, meta, cp, label)
        }

        // lupa final run
        const lupaExps = extractExpectations(content)
        if (hasAnyExpectations(lupaExps)) {
          test('lupa engine runs and matches expectations', async () => {
            const { statements } = parse(content)
            const { vs, setup, players, assumptions, spoilerActions } = buildVillageStatus(statements, meta)
            const { config, handlers } = buildLupaScenario({
              assumptions, spoilerActions, vs, setup, players,
            })
            const { state, events } = await runGame(config, handlers)
            verifyExpectations(lupaExps, state, events as GameEvent[], players)
          })
        }
      })
    }
  })
}
