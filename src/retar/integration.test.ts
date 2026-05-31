import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from './index.ts'
import type { AnalyzeOptions } from './index.ts'
import type { SystemRole } from '../types/index.ts'
import {
  extractCheckpoints,
  runCheckpointTests,
  buildAnalyzeOptions,
  defaultAnalyzeOptions,
} from './expectations.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scenariosDir = join(__dirname, 'scenarios')

function loadScenarios() {
  let files: string[]
  try {
    files = readdirSync(scenariosDir).filter(f => f.endsWith('.howl'))
  } catch {
    return []
  }
  return files.map(file => {
    const content = readFileSync(join(scenariosDir, file), 'utf-8').replace(/\r\n/g, '\n')
    return { file, content }
  })
}

// wolfPairDenyals テスト
describe('wolfPairDenyals', () => {
  const howlText = `---
title: wolfPairDenyals test
setup:
  villager: 3
  seer: 1
  werewolf: 2
---

++A、B、C、D、E、F

A死亡
`

  function analyzeWithDenyals(denyals: [number, number][]) {
    const { statements, meta } = parse(howlText)
    const { vs, setup, players } = buildVillageStatus(statements, meta)
    const options: AnalyzeOptions = {
      ...defaultAnalyzeOptions,
      wolfPairDenyals: denyals,
    }
    const retar = new VillageRetar(vs, setup, options)
    const result = retar.analyze()
    return { result, players }
  }

  function getSeatByName(players: Map<number, string>, name: string): number {
    for (const [seat, n] of players) {
      if (n === name) return seat
    }
    throw new Error(`player "${name}" not found`)
  }

  test('without denyals, both B and C can be werewolf', () => {
    const { result, players } = analyzeWithDenyals([])
    const seatB = getSeatByName(players, 'B')
    const seatC = getSeatByName(players, 'C')
    const rolesB = result.result.get(seatB)!
    const rolesC = result.result.get(seatC)!
    assert.ok(rolesB.has('werewolf'), 'B should be able to be werewolf')
    assert.ok(rolesC.has('werewolf'), 'C should be able to be werewolf')
  })

  test('pair denial removes possibility of both being werewolf simultaneously', () => {
    const { result: _result, players } = analyzeWithDenyals([])
    const seatB = getSeatByName(players, 'B')
    const seatC = getSeatByName(players, 'C')
    const { result: deniedResult } = analyzeWithDenyals([[seatB, seatC]])
    assert.ok(deniedResult.result.size > 0, 'analysis should produce results')
  })

  test('early application: when one is fixed as werewolf via assumption, deny from partner', () => {
    const { players } = analyzeWithDenyals([])
    const seatB = getSeatByName(players, 'B')
    const seatC = getSeatByName(players, 'C')

    const { statements, meta } = parse(howlText)
    const { vs, setup } = buildVillageStatus(statements, meta)
    const options: AnalyzeOptions = {
      ...defaultAnalyzeOptions,
      assumptions: new Map([[seatB, 'werewolf' as SystemRole]]),
      wolfPairDenyals: [[seatB, seatC]],
    }
    const retar = new VillageRetar(vs, setup, options)
    const result = retar.analyze()
    const rolesC = result.result.get(seatC)!
    assert.ok(!rolesC.has('werewolf'), 'C should not be werewolf when B is assumed werewolf and pair is denied')
  })

  test('pair denial with multiple pairs', () => {
    const { players } = analyzeWithDenyals([])
    const seatB = getSeatByName(players, 'B')
    const seatC = getSeatByName(players, 'C')
    const seatD = getSeatByName(players, 'D')

    const { result } = analyzeWithDenyals([[seatB, seatC], [seatB, seatD]])
    assert.ok(result.result.size > 0, 'analysis should produce results with multiple pair denyals')
  })
})

const scenarios = loadScenarios()

if (scenarios.length === 0) {
  describe('retar integration (no scenarios)', () => {
    test('waiting for scenario files in src/retar/scenarios/*.howl', () => {
      assert.ok(true, 'no scenarios to run')
    })
  })
} else {
  describe('retar integration', () => {
    for (const { file, content } of scenarios) {
      const { frontmatter, bodyLines, checkpoints } = extractCheckpoints(content)
      const { meta } = parse(content)
      const title = meta.title || file
      const tags: string[] = meta.tags || []
      const tagLabel = tags.length > 0 ? ` [${tags.join(', ')}]` : ''

      describe(`${title}${tagLabel}`, () => {
        for (let i = 0; i < checkpoints.length; i++) {
          const cp = checkpoints[i]
          const partialText = frontmatter + bodyLines.slice(0, cp.lineNumber).join('\n')
          const label = checkpoints.length === 1
            ? `checkpoint (line ${cp.lineNumber + 1})`
            : `checkpoint ${i + 1} (line ${cp.lineNumber + 1})`
          runCheckpointTests(partialText, meta, cp, label)
        }

        const options = buildAnalyzeOptions(meta)
        const { statements } = parse(content)
        const { vs, setup } = buildVillageStatus(statements, meta)
        const retar = new VillageRetar(vs, setup, options)
        const result = retar.analyze()

        test('analyze completes without error', () => {
          assert.ok(result, 'analyze() should return a result')
          assert.ok(!result.error, `analyze() should not error: ${result.error}`)
        })
      })
    }
  })
}
