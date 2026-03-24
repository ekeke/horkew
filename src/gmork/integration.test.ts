import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import type { SystemRole } from '../types/index.ts'
import { findReason, findConfirmationReason } from './index.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scenariosDir = join(__dirname, '..', 'retar', 'scenarios')

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

// ── アノテーション解析 ──────────────────────────────────────────────

type GmorkDirective = {
  kind: 'deny' | 'confirm'
  playerName: string
  role: SystemRole
  expectedType: string | null | undefined  // null = 理由なし, undefined = 何でもよい(存在すればOK)
  expectedInnerType?: string  // bustReason.type等の内部type (> で指定)
  negated?: boolean  // !prefix: この理由が返ってこないことを検証
}

type GmorkCheckpoint = {
  lineNumber: number
  directives: GmorkDirective[]
}

const gmorkPattern = /^#\s*@gmork-(deny|confirm)\s+(.+)$/

function extractGmorkCheckpoints(rawText: string) {
  const fmMatch = rawText.match(/^(---\n[\s\S]*?\n---\n)/)
  const frontmatter = fmMatch ? fmMatch[1] : ''
  const bodyText = fmMatch ? rawText.slice(fmMatch[1].length) : rawText
  const bodyLines = bodyText.split('\n')

  const checkpoints: GmorkCheckpoint[] = []
  let current: GmorkCheckpoint | null = null

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i].trim()
    const m = gmorkPattern.exec(line)

    if (m) {
      if (current === null) {
        current = { lineNumber: i, directives: [] }
      }
      const directive = parseGmorkDirective(m[1] as 'deny' | 'confirm', m[2])
      if (directive) current.directives.push(directive)
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

function parseGmorkDirective(kind: 'deny' | 'confirm', content: string): GmorkDirective | null {
  // Format: PlayerName/role: reason_type or PlayerName/role: outer > inner
  const colonIdx = content.indexOf(':')
  if (colonIdx < 0) return null
  const left = content.slice(0, colonIdx).trim()
  const rawType = content.slice(colonIdx + 1).trim()

  const slashIdx = left.lastIndexOf('/')
  if (slashIdx < 0) return null
  const playerName = left.slice(0, slashIdx).trim()
  const role = left.slice(slashIdx + 1).trim() as SystemRole

  let expectedType: string | null | undefined
  let expectedInnerType: string | undefined
  let negated = false

  let typeStr = rawType
  if (typeStr.startsWith('!')) {
    negated = true
    typeStr = typeStr.slice(1).trim()
  }

  if (typeStr === 'null') {
    expectedType = null
  } else if (typeStr === '') {
    expectedType = undefined
  } else if (typeStr.includes('>')) {
    const parts = typeStr.split('>').map(s => s.trim())
    expectedType = parts[0]
    expectedInnerType = parts[1]
  } else {
    expectedType = typeStr
  }

  return { kind, playerName, role, expectedType, expectedInnerType, negated }
}

// ── テスト実行 ──────────────────────────────────────────────────────

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

function runGmorkCheckpoint(
  partialText: string,
  meta: Record<string, any>,
  checkpoint: GmorkCheckpoint,
  label: string,
) {
  const options = buildOptions(meta)
  const { statements } = parse(partialText)
  const { vs, setup, players } = buildVillageStatus(statements, meta)
  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyze()
  const possibilities = result.result

  const seatOf = (name: string) => {
    for (const [seat, n] of players) {
      if (n === name || n.includes(name)) return seat
    }
    throw new Error(`player "${name}" not found`)
  }

  describe(label, () => {
    for (const d of checkpoint.directives) {
      const innerLabel = d.expectedInnerType ? ` > ${d.expectedInnerType}` : ''
      const negLabel = d.negated ? '!' : ''
      const typeLabel = d.expectedType === undefined ? '(TODO)' : negLabel + (d.expectedType ?? 'null') + innerLabel
      const testName = `@gmork-${d.kind} ${d.playerName}/${d.role}: ${typeLabel}`

      test(testName, () => {
        const seat = seatOf(d.playerName)

        if (d.kind === 'deny') {
          const reason = findReason(vs, setup, seat, d.role, possibilities, players)
          if (d.negated) {
            // !type: この理由が返ってこないことを検証
            if (reason && reason.type === d.expectedType) {
              const inner = d.expectedInnerType && 'bustReason' in reason
                ? (reason as any).bustReason?.type : undefined
              if (!d.expectedInnerType || inner === d.expectedInnerType) {
                assert.fail(`expected denial reason NOT to be "${d.expectedType}" for ${d.playerName}/${d.role}, but it was`)
              }
            }
          } else if (d.expectedType === null) {
            assert.strictEqual(reason, null,
              `expected no denial reason for ${d.playerName}/${d.role}, got ${reason?.type}`)
          } else if (d.expectedType === undefined) {
            if (reason) {
              const inner = 'bustReason' in reason ? ` > ${(reason as any).bustReason.type}` : ''
              assert.fail(`アノテーション修正可: 理由は出せたがアノテーションに理由が未記入です。実際の理由: ${reason.type}${inner}`)
            } else {
              assert.fail(`理由が出せませんでした: ${d.playerName}/${d.role} の否定理由が見つかりません`)
            }
          } else {
            assert.ok(reason,
              `expected denial reason "${d.expectedType}" for ${d.playerName}/${d.role}, got null`)
            assert.strictEqual(reason.type, d.expectedType,
              `expected "${d.expectedType}" but got "${reason.type}"`)
            if (d.expectedInnerType) {
              const inner = (reason as any).bustReason
              assert.ok(inner,
                `expected inner reason "${d.expectedInnerType}" but reason has no bustReason`)
              assert.strictEqual(inner.type, d.expectedInnerType,
                `expected inner "${d.expectedInnerType}" but got "${inner.type}"`)
            }
          }
        } else {
          const reason = findConfirmationReason(vs, setup, seat, d.role, players, possibilities)
          if (d.negated) {
            // !type: この理由が返ってこないことを検証
            if (reason && reason.type === d.expectedType) {
              assert.fail(`expected confirmation reason NOT to be "${d.expectedType}" for ${d.playerName}/${d.role}, but it was`)
            }
          } else if (d.expectedType === null) {
            assert.strictEqual(reason, null,
              `expected no confirmation reason for ${d.playerName}/${d.role}, got ${reason?.type}`)
          } else if (d.expectedType === undefined) {
            if (reason) {
              assert.fail(`アノテーション修正可: 理由は出せたがアノテーションに理由が未記入です。実際の理由: ${reason.type}`)
            } else {
              assert.fail(`理由が出せませんでした: ${d.playerName}/${d.role} の確定理由が見つかりません`)
            }
          } else {
            assert.ok(reason,
              `expected confirmation reason "${d.expectedType}" for ${d.playerName}/${d.role}, got null`)
            assert.strictEqual(reason.type, d.expectedType,
              `expected "${d.expectedType}" but got "${reason.type}"`)
          }
        }
      })
    }
  })
}

// ── シナリオ読み込み・実行 ──────────────────────────────────────────

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

const gmorkFilterPattern = /^#\s*@gmork-(deny|confirm)\s/m
const withGmork = scenarios.filter(s => gmorkFilterPattern.test(s.content))

if (withGmork.length === 0) {
  describe('gmork integration (no annotations)', () => {
    test('waiting for @gmork-deny/@gmork-confirm annotations in scenario files', () => {
      assert.ok(true, 'no gmork annotations to test')
    })
  })
} else {
  describe('gmork integration', () => {
    for (const { file, content } of withGmork) {
      const { frontmatter, bodyLines, checkpoints } = extractGmorkCheckpoints(content)
      const { meta } = parse(content)
      const title = meta.title || file

      describe(title, () => {
        for (let i = 0; i < checkpoints.length; i++) {
          const cp = checkpoints[i]
          const partialText = frontmatter + bodyLines.slice(0, cp.lineNumber).join('\n')
          const label = checkpoints.length === 1
            ? `gmork checkpoint (line ${cp.lineNumber + 1})`
            : `gmork checkpoint ${i + 1} (line ${cp.lineNumber + 1})`
          runGmorkCheckpoint(partialText, meta, cp, label)
        }
      })
    }
  })
}
