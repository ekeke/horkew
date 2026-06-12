import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import type { AnalyzeOptions } from './index.ts'
import { defaultAnalyzeRegulation } from './defaults.ts'
import type { SystemRole, Seat } from '../types/index.ts'
// @ts-ignore
import { analyze as wasmAnalyze } from '../retar-rs/pkg/retar.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scenariosDir = join(__dirname, 'scenarios')

const defaultOptions: AnalyzeOptions = {
  regulation: defaultAnalyzeRegulation,
  seerClaimingDueDate: 2,
  mediumClaimingDueDate: 2,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
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
  assumptions: Map<string, string>
  wolfPairDenyals: [string, string][]
}

const expectPattern = /^#\s*@expect(?:-skip)?\s+(.+)$/
const expectSkipPattern = /^#\s*@expect-skip\s/
const assumePattern = /^#\s*@assume\s+(.+)$/
const endAssumePattern = /^#\s*@end-assume\s*$/
const denyWolfPairPattern = /^#\s*@deny-wolf-pair\s+(.+)$/

function extractCheckpoints(rawText: string) {
  const fmMatch = rawText.match(/^(---\n[\s\S]*?\n---\n)/)
  const frontmatter = fmMatch ? fmMatch[1] : ''
  const bodyText = fmMatch ? rawText.slice(fmMatch[1].length) : rawText
  const bodyLines = bodyText.split('\n')

  const checkpoints: Checkpoint[] = []
  let current: Checkpoint | null = null

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i].trim()
    const expectMatch = expectPattern.exec(line)
    const assumeMatch = assumePattern.exec(line)
    const denyMatch = denyWolfPairPattern.exec(line)
    const isEndAssume = endAssumePattern.test(line)

    if (expectMatch || assumeMatch || denyMatch || isEndAssume) {
      if (isEndAssume) {
        if (current !== null) {
          checkpoints.push(current)
          current = null
        }
        continue
      }
      if (current === null) {
        current = { lineNumber: i, skip: false, roles: new Map(), assumptions: new Map(), wolfPairDenyals: [] }
      }
      if (expectMatch) {
        if (expectSkipPattern.test(line)) {
          current.skip = true
        }
        parseDirective(current, expectMatch[1])
      }
      if (assumeMatch) {
        const content = assumeMatch[1]
        const colonIdx = content.indexOf(':')
        if (colonIdx >= 0) {
          current.assumptions.set(content.slice(0, colonIdx).trim(), content.slice(colonIdx + 1).trim())
        }
      }
      if (denyMatch) {
        const names = denyMatch[1].split(',').map(n => n.trim()).filter(Boolean)
        if (names.length === 2) {
          current.wolfPairDenyals.push([names[0], names[1]])
        }
      }
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

// Serialize Map/Set to plain objects for JSON
function serializeVillageStatus(vs: any): any {
  const obj: any = { ...vs }
  obj.statuses = Object.fromEntries(
    [...vs.statuses.entries()].map(([k, v]: [any, any]) => [
      String(k),
      {
        ...v,
        actions: Object.fromEntries(v.actions),
        assertions: Object.fromEntries(
          [...v.assertions.entries()].map(([day, a]: [any, any]) => [String(day), a])
        ),
        forecasts: Object.fromEntries(
          [...v.forecasts.entries()].map(([day, s]: [any, any]) => [String(day), s])
        ),
        previousAssertions: v.previousAssertions
          ? Object.fromEntries(
              [...v.previousAssertions.entries()].map(([day, a]: [any, any]) => [String(day), a])
            )
          : undefined,
        previousClaims: v.previousClaims?.map((pc: any) => ({
          ...pc,
          assertions: Object.fromEntries(
            [...pc.assertions.entries()].map(([day, a]: [any, any]) => [String(day), a])
          ),
          actions: Object.fromEntries(pc.actions),
          forecasts: Object.fromEntries(
            [...pc.forecasts.entries()].map(([day, s]: [any, any]) => [String(day), s])
          ),
        })),
      },
    ])
  )
  obj.executions = Object.fromEntries(
    [...vs.executions.entries()].map(([k, v]: [any, any]) => [String(k), v])
  )
  obj.kills = Object.fromEntries(
    [...vs.kills.entries()].map(([k, v]: [any, any]) => [String(k), v])
  )
  obj.voteHistory = Object.fromEntries(
    [...vs.voteHistory.entries()].map(([k, v]: [any, any]) => [String(k), v])
  )
  obj.revoteTargets = [...vs.revoteTargets]
  obj.multiVoteDays = [...vs.multiVoteDays]
  delete obj.roles
  delete obj.claims
  return obj
}

function serializeOptions(options: AnalyzeOptions): any {
  // regulation は Rust 側が知らない型なので除外。 hasFirstGhost を JSON に詰めて互換性を保つ。
  const { regulation, ...rest } = options
  const hasFirstGhost = regulation['general.first-victim'] !== 'none'
  return {
    ...rest,
    hasFirstGhost,
    assumptions: Object.fromEntries(options.assumptions),
    hocusPocus: Object.fromEntries(options.hocusPocus),
  }
}

function analyzeViaWasm(
  vs: any,
  setup: Map<SystemRole, number>,
  options: AnalyzeOptions,
): { result: Map<Seat, Set<SystemRole>>, error?: string } {
  const vsJson = JSON.stringify(serializeVillageStatus(vs))
  const setupJson = JSON.stringify(Object.fromEntries(setup))
  const optJson = JSON.stringify(serializeOptions(options))
  const resultJson = wasmAnalyze(vsJson, setupJson, optJson) as string
  const parsed = JSON.parse(resultJson)
  if (parsed.error) {
    return { result: new Map(), error: parsed.error }
  }
  const possObj = parsed.result ?? parsed.possibilities ?? parsed
  const result = new Map<Seat, Set<SystemRole>>()
  for (const [seatStr, roles] of Object.entries(possObj)) {
    result.set(Number(seatStr), new Set(roles as SystemRole[]))
  }
  return { result }
}

function runCheckpoint(
  partialText: string,
  meta: Record<string, any>,
  checkpoint: Checkpoint,
  label: string
) {
  let options = buildOptions(meta)
  const { statements } = parse(partialText)
  const { vs, setup, players, assumptions: spoilerAssumptions } = buildVillageStatus(statements, meta)

  // spoiler 文 (`!プレイヤー=役職`) 由来の assumptions を options に merge
  // production .howl 表記で paparazzi 等の役職を pin できる
  if (spoilerAssumptions.size > 0) {
    options = {
      ...options,
      assumptions: new Map([...options.assumptions, ...spoilerAssumptions]),
    }
  }

  // @assume <Player>: <role> 構文を options.assumptions に merge (TS integration と同じ).
  if (checkpoint.assumptions.size > 0) {
    const merged = new Map(options.assumptions)
    for (const [playerName, role] of checkpoint.assumptions) {
      const seat = [...players.entries()].find(([, n]) => n === playerName)?.[0]
      if (seat == null) {
        throw new Error(`@assume: player "${playerName}" not found in game`)
      }
      merged.set(seat, role as SystemRole)
    }
    options = { ...options, assumptions: merged }
  }

  // @deny-wolf-pair <A>, <B> 構文を options.wolfPairDenyals に merge (TS integration と同じ).
  if (checkpoint.wolfPairDenyals.length > 0) {
    const resolveSeat = (playerName: string): Seat => {
      const seat = [...players.entries()].find(([, n]) => n === playerName)?.[0]
      if (seat == null) {
        throw new Error(`@deny-wolf-pair: player "${playerName}" not found in game`)
      }
      return seat
    }
    options = {
      ...options,
      wolfPairDenyals: [
        ...options.wolfPairDenyals,
        ...checkpoint.wolfPairDenyals.map(([a, b]): [Seat, Seat] => [resolveSeat(a), resolveSeat(b)]),
      ],
    }
  }

  const { result: wasmResult, error } = analyzeViaWasm(vs, setup, options)

  const testOpts = checkpoint.skip ? { todo: 'not yet implemented' } : {}

  describe(label, () => {
    test('wasm analyze completes without error', () => {
      assert.ok(!error, `wasm analyze() should not error: ${error}`)
      assert.ok(wasmResult.size > 0, 'wasm analyze() should return results')
    })

    // solve: tests require debugStash — skip in WASM version

    for (const [playerName, expectation] of checkpoint.roles) {
      const suffix = expectation.partial ? ', ...' : ''
      test(`${playerName}: [${expectation.roles.join(', ')}${suffix}]`, testOpts, () => {
        const seat = [...players.entries()].find(([, n]) => n === playerName)?.[0]
        assert.ok(seat != null, `player "${playerName}" not found in game`)

        const actualRoles = wasmResult.get(seat)
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

const scenarios = loadScenarios()

if (scenarios.length === 0) {
  describe('retar-wasm integration (no scenarios)', () => {
    test('waiting for scenario files in src/retar/scenarios/*.howl', () => {
      assert.ok(true, 'no scenarios to run')
    })
  })
} else {
  describe('retar-wasm integration', () => {
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
        const { result: wasmResult, error } = analyzeViaWasm(vs, setup, options)

        test('wasm analyze completes without error', () => {
          assert.ok(!error, `wasm analyze() should not error: ${error}`)
          assert.ok(wasmResult.size > 0, 'wasm analyze() should return results')
        })
      })
    }
  })
}
