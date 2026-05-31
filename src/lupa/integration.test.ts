/**
 * Lupa engine-driven integration test
 *
 * src/lupa/scenarios/*.howl を読み込み、howl-adapter で GameHandlers を生成、
 * runGame で engine を駆動して結果 state / events を annotation で verify する。
 * Annotation 解析・検証は [src/lupa/expectations.ts](./expectations.ts) の helper を流用。
 */

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { runGame } from './engine.ts'
import { buildLupaScenario } from './howl-adapter.ts'
import type { GameEvent } from './types.ts'
import { extractExpectations, verifyExpectations } from './expectations.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scenariosDir = join(__dirname, 'scenarios')

function loadScenarios() {
  if (!existsSync(scenariosDir)) return []
  const files = readdirSync(scenariosDir).filter(f => f.endsWith('.howl'))
  return files.map(file => {
    const content = readFileSync(join(scenariosDir, file), 'utf-8').replace(/\r\n/g, '\n')
    return { file, content }
  })
}

const scenarios = loadScenarios()

if (scenarios.length === 0) {
  describe('lupa engine integration (no scenarios)', () => {
    test('waiting for scenario files in src/lupa/scenarios/*.howl', () => {
      assert.ok(true, 'no scenarios to run')
    })
  })
} else {
  describe('lupa engine integration', () => {
    for (const { file, content } of scenarios) {
      const { meta } = parse(content)
      const title = meta.title || file
      describe(title, () => {
        test('engine runs and matches expectations', async () => {
          const { statements } = parse(content)
          const { vs, setup, players, assumptions, spoilerActions } = buildVillageStatus(statements, meta)
          const { config, handlers } = buildLupaScenario({
            assumptions, spoilerActions, vs, setup, players,
          })
          const { state, events } = await runGame(config, handlers)
          const exps = extractExpectations(content)
          verifyExpectations(exps, state, events as GameEvent[], players)
        })
      })
    }
  })
}
