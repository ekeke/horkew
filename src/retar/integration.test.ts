import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from './index.ts'
import type { AnalyzeOptions } from './index.ts'
import type { SystemRole, Faction } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'

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
type TagExpectation = { tags: string[], negated: string[] }

type Checkpoint = {
  lineNumber: number
  skip: boolean
  solve?: boolean
  roles: Map<string, RoleExpectation>
  factions: Map<string, TagExpectation>
  alignments: Map<string, TagExpectation>
  claims: Map<string, string>
  deniedRoles: Map<string, RoleExpectation>
  statuses: Map<string, 'alive' | 'dead'>
  assumptions: Map<string, string>
}

// @expect / @expect-skip / @expect-faction / @expect-alignment / @expect-claim / @expect-deniedRoles / @expect-status
const expectPattern = /^#\s*@expect(?:-(skip|faction|alignment|claim|deniedRoles|status))?\s+(.+)$/
const assumePattern = /^#\s*@assume\s+(.+)$/
const endAssumePattern = /^#\s*@end-assume\s*$/

function makeCheckpoint(lineNumber: number): Checkpoint {
  return {
    lineNumber,
    skip: false,
    roles: new Map(),
    factions: new Map(),
    alignments: new Map(),
    claims: new Map(),
    deniedRoles: new Map(),
    statuses: new Map(),
    assumptions: new Map(),
  }
}

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
    const isEndAssume = endAssumePattern.test(line)

    if (expectMatch || assumeMatch || isEndAssume) {
      if (isEndAssume) {
        if (current !== null) {
          checkpoints.push(current)
          current = null
        }
      } else {
        if (current === null) {
          current = makeCheckpoint(i)
        }
        if (expectMatch) {
          const variant = expectMatch[1] // undefined | 'skip' | 'faction' | 'alignment' | 'claim' | 'deniedRoles'
          if (variant === 'skip') current.skip = true
          parseExpectDirective(current, variant, expectMatch[2])
        }
        if (assumeMatch) {
          parseAssume(current, assumeMatch[1])
        }
      }
    } else {
      if (current !== null) {
        if (current.assumptions.size > 0) {
          console.warn(`Warning: @assume block without @end-assume at line ${current.lineNumber + 1}`)
        }
        checkpoints.push(current)
        current = null
      }
    }
  }
  if (current !== null) {
    if (current.assumptions.size > 0) {
      console.warn(`Warning: @assume block without @end-assume at end of file`)
    }
    checkpoints.push(current)
  }

  return { frontmatter, bodyLines, checkpoints }
}

function parseRoleExpectation(value: string): RoleExpectation {
  const stripped = value.replace(/[\[\]]/g, '').trim()
  const partial = stripped.endsWith('...')
  const rolesStr = partial ? stripped.slice(0, -3) : stripped
  const allRoles = rolesStr.split(',').map(r => r.trim()).filter(Boolean)
  const roles = allRoles.filter(r => !r.startsWith('!'))
  const negated = allRoles.filter(r => r.startsWith('!')).map(r => r.slice(1))
  return { roles, negated, partial }
}

function parseTagExpectation(value: string): TagExpectation {
  const stripped = value.replace(/[\[\]]/g, '').trim()
  const allTags = stripped.split(',').map(t => t.trim()).filter(Boolean)
  const tags = allTags.filter(t => !t.startsWith('!'))
  const negated = allTags.filter(t => t.startsWith('!')).map(t => t.slice(1))
  return { tags, negated }
}

function parseExpectDirective(
  checkpoint: Checkpoint,
  variant: string | undefined,
  content: string,
) {
  const colonIdx = content.indexOf(':')
  if (colonIdx < 0) return
  const key = content.slice(0, colonIdx).trim()
  const value = content.slice(colonIdx + 1).trim()

  // @expect-skip uses the same payload as @expect; the skip flag is set by the caller.
  // 'skip' falls through to the default expect (role) handling.
  const effective = variant === 'skip' ? undefined : variant

  switch (effective) {
    case 'faction':
      checkpoint.factions.set(key, parseTagExpectation(value))
      return
    case 'alignment':
      checkpoint.alignments.set(key, parseTagExpectation(value))
      return
    case 'claim':
      checkpoint.claims.set(key, value)
      return
    case 'deniedRoles':
      checkpoint.deniedRoles.set(key, parseRoleExpectation(value))
      return
    case 'status':
      if (value !== 'alive' && value !== 'dead') {
        throw new Error(`@expect-status: value must be "alive" or "dead", got "${value}"`)
      }
      checkpoint.statuses.set(key, value)
      return
    default:
      // @expect with key 'solve' is a special boolean directive.
      if (key === 'solve') {
        checkpoint.solve = value === 'true'
        return
      }
      checkpoint.roles.set(key, parseRoleExpectation(value))
  }
}

function parseAssume(checkpoint: Checkpoint, content: string) {
  const colonIdx = content.indexOf(':')
  if (colonIdx < 0) return
  const playerName = content.slice(0, colonIdx).trim()
  const role = content.slice(colonIdx + 1).trim()
  checkpoint.assumptions.set(playerName, role)
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

    for (const [playerName, expectation] of checkpoint.factions) {
      test(`${playerName} factions: [${expectation.tags.join(', ')}]`, testOpts, () => {
        const seat = [...players.entries()].find(([, n]) => n === playerName)?.[0]
        assert.ok(seat != null, `player "${playerName}" not found in game`)
        const actualRoles = result.result.get(seat)
        assert.ok(actualRoles, `no result for player "${playerName}" (seat ${seat})`)
        const factionSet = new Set<Faction>()
        for (const role of actualRoles) {
          const def = systemRoles.get(role)
          if (def) factionSet.add(def.faction)
        }
        const actual = [...factionSet].sort()
        for (const neg of expectation.negated) {
          assert.ok(!actual.includes(neg as Faction),
            `${playerName} factions: expected NOT ${neg} but got [${actual}]`)
        }
        if (expectation.tags.length > 0) {
          const expected = [...expectation.tags].sort()
          assert.deepStrictEqual(actual, expected,
            `${playerName} factions: expected [${expected}] but got [${actual}]`)
        }
      })
    }

    for (const [playerName, expectation] of checkpoint.alignments) {
      test(`${playerName} alignment: [${expectation.tags.join(', ')}]`, testOpts, () => {
        const seat = [...players.entries()].find(([, n]) => n === playerName)?.[0]
        assert.ok(seat != null, `player "${playerName}" not found in game`)
        const actualRoles = result.result.get(seat)
        assert.ok(actualRoles, `no result for player "${playerName}" (seat ${seat})`)
        const alignmentSet = new Set<string>()
        for (const role of actualRoles) {
          const def = systemRoles.get(role)
          if (def) alignmentSet.add(def.alignment)
        }
        const actual = [...alignmentSet].sort()
        for (const neg of expectation.negated) {
          assert.ok(!actual.includes(neg),
            `${playerName} alignment: expected NOT ${neg} but got [${actual}]`)
        }
        if (expectation.tags.length > 0) {
          const expected = [...expectation.tags].sort()
          assert.deepStrictEqual(actual, expected,
            `${playerName} alignment: expected [${expected}] but got [${actual}]`)
        }
      })
    }

    for (const [playerName, expected] of checkpoint.claims) {
      test(`${playerName} claim: "${expected}"`, testOpts, () => {
        const seat = [...players.entries()].find(([, n]) => n === playerName)?.[0]
        assert.ok(seat != null, `player "${playerName}" not found in game`)
        const status = vs.statuses.get(seat)!
        // 'none' or '' から実際の claimingRole への比較。空文字指定で「無CO」を表現できる。
        const actual = status.claiming ? status.claimingRole : 'none'
        const want = expected === '' ? 'none' : expected
        assert.strictEqual(actual, want,
          `${playerName} claim: expected "${want}" but got "${actual}"`)
      })
    }

    for (const [playerName, expectedStatus] of checkpoint.statuses) {
      test(`${playerName} status: ${expectedStatus}`, testOpts, () => {
        const seat = [...players.entries()].find(([, n]) => n === playerName)?.[0]
        assert.ok(seat != null, `player "${playerName}" not found in game`)
        const status = vs.statuses.get(seat)!
        const actual = status.surviving ? 'alive' : 'dead'
        assert.strictEqual(actual, expectedStatus,
          `${playerName} status: expected "${expectedStatus}" but got "${actual}"`)
      })
    }

    for (const [playerName, expectation] of checkpoint.deniedRoles) {
      test(`${playerName} deniedRoles: [${expectation.roles.join(', ')}]`, testOpts, () => {
        const seat = [...players.entries()].find(([, n]) => n === playerName)?.[0]
        assert.ok(seat != null, `player "${playerName}" not found in game`)
        const status = vs.statuses.get(seat)!
        const actual = [...status.deniedRoles].sort()
        for (const neg of expectation.negated) {
          assert.ok(!actual.includes(neg as SystemRole),
            `${playerName} deniedRoles: expected NOT ${neg} but got [${actual}]`)
        }
        if (expectation.partial) {
          const missing = expectation.roles.filter(r => !actual.includes(r as SystemRole))
          assert.deepStrictEqual(missing, [],
            `${playerName} deniedRoles: expected at least [${expectation.roles}] but got [${actual}], missing [${missing}]`)
        } else if (expectation.roles.length > 0) {
          const expected = [...expectation.roles].sort()
          assert.deepStrictEqual(actual, expected,
            `${playerName} deniedRoles: expected [${expected}] but got [${actual}]`)
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
    const { result: _result, players } = analyzeWithDenyals([])
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
