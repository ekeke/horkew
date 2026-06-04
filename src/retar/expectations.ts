/**
 * Howl シナリオに埋め込まれた retar 推理 assertion 系アノテーションを
 * 解析・実行する helper。
 *
 * 1 シナリオ内に複数の checkpoint があり、各 checkpoint は「その行の手前まで
 * の partial game」 に対する retar.analyze() の結果を検証する。
 *
 * 対応アノテーション:
 * - `@expect <player>: [roles]`          推論された役職集合
 * - `@expect-skip`                       checkpoint を todo として skip
 * - `@expect-faction <player>: [factions]`
 * - `@expect-alignment <player>: [alignments]`
 * - `@expect-claim <player>: <role>`
 * - `@expect-deniedRoles <player>: [roles]`
 * - `@expect solve: true|false`
 * - `@assume <player>: <role>` ... `@end-assume`  checkpoint 用の前提条件
 *
 * 生存/死亡のアサーションは retar の興味外 (ゲーム処理の結果) なので扱わない。
 * 必要なら lupa engine 側の `@expect-status` (src/lupa/expectations.ts) を使う。
 */

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from './index.ts'
import type { AnalyzeOptions } from './index.ts'
import { defaultAnalyzeRegulation } from './defaults.ts'
import { resolveRegulation } from '../howl/ruleset.ts'
import type { SystemRole, Faction } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'

export const defaultAnalyzeOptions: AnalyzeOptions = {
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

export type RoleExpectation = { roles: string[], negated: string[], partial: boolean }
export type TagExpectation = { tags: string[], negated: string[] }

export type Checkpoint = {
  lineNumber: number
  skip: boolean
  solve?: boolean
  roles: Map<string, RoleExpectation>
  factions: Map<string, TagExpectation>
  alignments: Map<string, TagExpectation>
  claims: Map<string, string>
  deniedRoles: Map<string, RoleExpectation>
  assumptions: Map<string, string>
}

const expectPattern = /^#\s*@expect(?:-(skip|faction|alignment|claim|deniedRoles))?\s+(.+)$/
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
    assumptions: new Map(),
  }
}

export function extractCheckpoints(rawText: string): { frontmatter: string, bodyLines: string[], checkpoints: Checkpoint[] } {
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
          const variant = expectMatch[1]
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

export function buildAnalyzeOptions(meta: Record<string, any>): AnalyzeOptions {
  // meta.rules があれば retar default に上乗せして regulation を解決する。
  // meta.options で regulation が明示指定されていれば最終的にそちらが優先される (spread 順)。
  const regulation = meta?.rules ? resolveRegulation(meta.rules) : defaultAnalyzeRegulation
  return {
    ...defaultAnalyzeOptions,
    regulation,
    ...(meta.options || {}),
    assumptions: meta.options?.assumptions
      ? new Map(Object.entries(meta.options.assumptions))
      : defaultAnalyzeOptions.assumptions,
    hocusPocus: meta.options?.hocusPocus
      ? new Map(Object.entries(meta.options.hocusPocus))
      : defaultAnalyzeOptions.hocusPocus,
  }
}

/**
 * node:test の describe/test を発火して checkpoint を検証する。
 * 既存 retar integration runner と新 spec runner の両方から呼ぶ。
 */
export function runCheckpointTests(
  partialText: string,
  meta: Record<string, any>,
  checkpoint: Checkpoint,
  label: string,
): void {
  let options = buildAnalyzeOptions(meta)
  const { statements } = parse(partialText)
  const { vs, setup, players, assumptions: spoilerAssumptions } = buildVillageStatus(statements, meta)

  // spoiler 文 (`!プレイヤー=役職`) 由来の assumptions を options に merge
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
        const actual = status.claiming ? status.claimingRole : 'none'
        const want = expected === '' ? 'none' : expected
        assert.strictEqual(actual, want,
          `${playerName} claim: expected "${want}" but got "${actual}"`)
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
