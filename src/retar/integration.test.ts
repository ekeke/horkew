import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from './index.ts'
import type { AnalyzeOptions } from './index.ts'

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
  hocusPocus: new Map(),
  id: 0,
  batches: 1,
  batch: 0,
}

type Checkpoint = {
  lineNumber: number
  skip: boolean
  solve?: boolean
  roles: Map<string, string[]>
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
    const roles = value.replace(/[\[\]]/g, '').split(',').map(r => r.trim()).filter(Boolean)
    checkpoint.roles.set(key, roles)
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

    for (const [playerName, expectedRoles] of checkpoint.roles) {
      test(`${playerName}: [${expectedRoles.join(', ')}]`, testOpts, () => {
        const seat = [...players.entries()].find(([, n]) => n === playerName)?.[0]
        assert.ok(seat != null, `player "${playerName}" not found in game`)

        const actualRoles = result.result.get(seat)
        assert.ok(actualRoles, `no result for player "${playerName}" (seat ${seat})`)

        const actual = [...actualRoles].sort()
        const expected = [...expectedRoles].sort()
        assert.deepStrictEqual(actual, expected,
          `${playerName}: expected [${expected}] but got [${actual}]`)
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
