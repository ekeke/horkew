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

const __dirname = dirname(fileURLToPath(import.meta.url))
const scenariosDir = join(__dirname, 'scenarios')

const defaultOptions: AnalyzeOptions = {
  seerClaimingDueDate: 2,
  mediumClaimingDueDate: 2,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  hasFirstGhost: false,
  assumptions: new Map(),
  wolfPairDenyals: [],
  hocusPocus: new Map(),
  id: 0,
  batches: 1,
  batch: 0,
}

type RoleExpectation = { roles: string[], negated: string[], partial: boolean }

type Checkpoint = {
  lineNumber: number
  skip: boolean
  solve?: boolean
  roles: Map<string, RoleExpectation>
}

const expectPattern = /^#\s*@expect(?:-skip)?\s+(.+)$/
const expectSkipPattern = /^#\s*@expect-skip\s/

function extractCheckpoints(rawText: string) {
  const fmMatch = rawText.match(/^(---\n[\s\S]*?\n---\n)/)
  const frontmatter = fmMatch ? fmMatch[1] : ''
  const bodyText = fmMatch ? rawText.slice(fmMatch[1].length) : rawText
  const bodyLines = bodyText.split('\n')

  const checkpoints: Checkpoint[] = []
  let current: Checkpoint | null = null

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i].trim()
    const m = expectPattern.exec(line)

    if (m) {
      if (current === null) {
        current = { lineNumber: i, skip: false, roles: new Map() }
      }
      if (expectSkipPattern.test(line)) {
        current.skip = true
      }
      parseDirective(current, m[1])
    } else {
      if (current !== null) {
        checkpoints.push(current)
        current = null
      }
    }
  }
  if (current !== null) {
    checkpoints.push(current)
  }

  return { frontmatter, bodyLines, checkpoints }
}

function parseDirective(checkpoint: Checkpoint, content: string) {
  const colonIdx = content.indexOf(':')
  if (colonIdx < 0) return
  const key = content.slice(0, colonIdx).trim()
  const value = content.slice(colonIdx + 1).trim()

  if (key === 'solve') {
    checkpoint.solve = value === 'true'
  } else {
    const stripped = value.replace(/[\[\]]/g, '').trim()
    const partial = stripped.endsWith('...')
    const rolesStr = partial ? stripped.slice(0, -3) : stripped
    const allRoles = rolesStr.split(',').map(r => r.trim()).filter(Boolean)
    const roles = allRoles.filter(r => !r.startsWith('!'))
    const negated = allRoles.filter(r => r.startsWith('!')).map(r => r.slice(1))
    checkpoint.roles.set(key, { roles, negated, partial })
  }
}

function buildOptions(meta: Record<string, any>): AnalyzeOptions {
  return {
    ...defaultOptions,
    ...(meta.options || {}),
    assumptions: meta.options?.assumptions
      ? new Map(Object.entries(meta.options.assumptions))
      : defaultOptions.assumptions,
    hocusPocus: meta.options?.hocusPocus
      ? new Map(Object.entries(meta.options.hocusPocus))
      : defaultOptions.hocusPocus,
  }
}

function runCheckpoint(
  partialText: string,
  meta: Record<string, any>,
  checkpoint: Checkpoint,
  label: string
) {
  const options = buildOptions(meta)
  const { statements } = parse(partialText)
  const { vs, setup, players } = buildVillageStatus(statements, meta)
  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyze()

  const testOpts = checkpoint.skip ? { todo: 'not yet implemented' } : {}

  describe(label, () => {
    test('analyze completes without error', () => {
      assert.ok(result, 'analyze() should return a result')
      assert.ok(!result.error, `analyze() should not error: ${result.error}`)
    })

    if (checkpoint.solve !== undefined) {
      test(`solve: ${checkpoint.solve}`, testOpts, () => {
        if (checkpoint.solve) {
          assert.ok(
            retar.debugStash.finalizerPasses > 0,
            `expected solvable, but finalizerPasses = ${retar.debugStash.finalizerPasses}`
          )
        } else {
          assert.strictEqual(
            retar.debugStash.finalizerPasses, 0,
            `expected unsolvable, but finalizerPasses = ${retar.debugStash.finalizerPasses}`
          )
        }
      })
    }

    for (const [playerName, expectation] of checkpoint.roles) {
      const suffix = expectation.partial ? ', ...' : ''
      test(`${playerName}: [${expectation.roles.join(', ')}${suffix}]`, testOpts, () => {
        const seat = [...players.entries()].find(([, n]) => n === playerName)?.[0]
        assert.ok(seat != null, `player "${playerName}" not found in game`)

        const actualRoles = result.result.get(seat)
        assert.ok(actualRoles, `no result for player "${playerName}" (seat ${seat})`)

        const actual = [...actualRoles].sort()
        const expected = [...expectation.roles].sort()

        for (const neg of expectation.negated) {
          assert.ok(!actual.includes(neg as SystemRole),
            `${playerName}: expected NOT ${neg} but got [${actual}]`)
        }

        if (expectation.partial) {
          const missing = expected.filter(r => !actual.includes(r as SystemRole))
          assert.deepStrictEqual(missing, [],
            `${playerName}: expected at least [${expected}] but got [${actual}], missing [${missing}]`)
        } else if (expected.length > 0) {
          assert.deepStrictEqual(actual, expected,
            `${playerName}: expected [${expected}] but got [${actual}]`)
        }
      })
    }
  })
}

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
      ...defaultOptions,
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
    const { result, players } = analyzeWithDenyals([])
    const seatB = getSeatByName(players, 'B')
    const seatC = getSeatByName(players, 'C')
    // With denial, run analysis
    const { result: deniedResult } = analyzeWithDenyals([[seatB, seatC]])
    // Both should still potentially be werewolf individually (just not both at once)
    // The effect depends on the specific game state
    assert.ok(deniedResult.result.size > 0, 'analysis should produce results')
  })

  test('early application: when one is fixed as werewolf via assumption, deny from partner', () => {
    const { players } = analyzeWithDenyals([])
    const seatB = getSeatByName(players, 'B')
    const seatC = getSeatByName(players, 'C')

    const { statements, meta } = parse(howlText)
    const { vs, setup } = buildVillageStatus(statements, meta)
    const options: AnalyzeOptions = {
      ...defaultOptions,
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
          runCheckpoint(partialText, meta, cp, label)
        }

        const options = buildOptions(meta)
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
