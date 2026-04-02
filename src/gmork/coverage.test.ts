import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import type { SystemRole, VillageStatus } from '../types/index.ts'
import { findReason, findConfirmationReason } from './index.ts'
import { allCheckers } from './checkers.ts'
import { allConfirmationCheckers } from './confirmers.ts'
import { runAnalysis, getConfirmedRoles, analyzeSeer, analyzeMedium } from './analysis.ts'

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

// ── チェックポイント抽出（retar integration.test.ts と同等）──────────

type Checkpoint = {
  lineNumber: number
}

const expectPattern = /^#\s*@expect(?:-skip)?\s+/

function extractCheckpoints(rawText: string) {
  const fmMatch = rawText.match(/^(---\n[\s\S]*?\n---\n)/)
  const frontmatter = fmMatch ? fmMatch[1] : ''
  const bodyText = fmMatch ? rawText.slice(fmMatch[1].length) : rawText
  const bodyLines = bodyText.split('\n')

  const checkpoints: Checkpoint[] = []
  let inBlock = false

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i].trim()
    if (expectPattern.test(line)) {
      if (!inBlock) {
        checkpoints.push({ lineNumber: i })
        inBlock = true
      }
    } else {
      inBlock = false
    }
  }

  return { frontmatter, bodyLines, checkpoints }
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

// ── カバレッジ計測 ──────────────────────────────────────────────────

// explained:           チェッカーが理由を返し、依存検証も通過
// dependency_filtered: チェッカーが理由を返したが、依存検証で弾かれた
// no_checker:          ど��チェッカーも理由を返さなかった
type CoverageStatus = 'explained' | 'dependency_filtered' | 'no_checker'

type CoverageEntry = {
  player: string
  seat: number
  role: SystemRole
  kind: 'deny' | 'confirm'
  status: CoverageStatus
  reasonType: string | null       // explained時の理由type
  filteredType: string | null     // dependency_filtered時の理由type
}

function classifyDenial(
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
  seat: number,
  role: SystemRole,
  possibilities: Map<number, Set<SystemRole>>,
  players: Map<number, string>,
): { status: CoverageStatus, reasonType: string | null, filteredType: string | null } {
  // findReason で説明できるか
  const reason = findReason(vs, setup, seat, role, possibilities, players)
  if (reason) return { status: 'explained', reasonType: reason.type, filteredType: null }

  // nullだった場合: チェッカーを直接回して dependent が弾かれたか確認
  const status = vs.statuses.get(seat)
  if (!status) return { status: 'no_checker', reasonType: null, filteredType: null }

  const analysis = runAnalysis(vs, setup, possibilities, players)
  const input = { village: vs, setup, seat, role, status, analysis, players, possibilities }

  for (const { fn, category } of allCheckers) {
    const r = fn(input)
    if (!r) continue
    if (category === 'dependent') {
      // findReason が null を返したのにチェッカーが返した → 依存で弾かれた
      return { status: 'dependency_filtered', reasonType: null, filteredType: r.type }
    }
  }

  return { status: 'no_checker', reasonType: null, filteredType: null }
}

function classifyConfirmation(
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
  seat: number,
  role: SystemRole,
  possibilities: Map<number, Set<SystemRole>>,
  players: Map<number, string>,
): { status: CoverageStatus, reasonType: string | null, filteredType: string | null } {
  const reason = findConfirmationReason(vs, setup, seat, role, players, possibilities)
  if (reason) return { status: 'explained', reasonType: reason.type, filteredType: null }

  const status = vs.statuses.get(seat)
  if (!status) return { status: 'no_checker', reasonType: null, filteredType: null }

  const confirmed = getConfirmedRoles(possibilities)
  const seer = analyzeSeer(vs, setup, confirmed, players)
  const medium = analyzeMedium(vs, setup, confirmed, players)
  const analysis = { confirmed, seer, medium }
  const input = { village: vs, setup, seat, role, status, analysis, players, possibilities }

  for (const { fn, category } of allConfirmationCheckers) {
    const r = fn(input)
    if (!r) continue
    if (category === 'dependent') {
      return { status: 'dependency_filtered', reasonType: null, filteredType: r.type }
    }
  }

  return { status: 'no_checker', reasonType: null, filteredType: null }
}

function measureCoverage(
  partialText: string,
  meta: Record<string, any>,
): { denials: CoverageEntry[], confirmations: CoverageEntry[] } {
  const options = buildOptions(meta)
  const { statements } = parse(partialText)
  const { vs, setup, players } = buildVillageStatus(statements, meta)
  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyze()
  if (result.error) return { denials: [], confirmations: [] }

  const possibilities = result.result
  const allRoles = [...setup.keys()]
  const denials: CoverageEntry[] = []
  const confirmations: CoverageEntry[] = []

  for (const [seat, possibleRoles] of possibilities) {
    const player = players.get(seat) ?? `seat${seat}`

    for (const role of allRoles) {
      if (!possibleRoles.has(role)) {
        const c = classifyDenial(vs, setup, seat, role, possibilities, players)
        denials.push({ player, seat, role, kind: 'deny', ...c })
      }
    }

    if (possibleRoles.size === 1) {
      const role = [...possibleRoles][0]
      const c = classifyConfirmation(vs, setup, seat, role, possibilities, players)
      confirmations.push({ player, seat, role, kind: 'confirm', ...c })
    }
  }

  return { denials, confirmations }
}

// ── レポート出力 ──────────────────────────────────────────────────

type ScenarioReport = {
  title: string
  file: string
  checkpoints: CheckpointReport[]
}

type CheckpointReport = {
  label: string
  line: number | null  // null = end of game
  denials: CoverageEntry[]
  confirmations: CoverageEntry[]
}

function count(entries: CoverageEntry[], status: CoverageStatus) {
  return entries.filter(e => e.status === status).length
}

function pct(n: number, total: number) {
  return total > 0 ? (n / total * 100).toFixed(0) : '-'
}

function printReport(reports: ScenarioReport[]) {
  const allDenials: CoverageEntry[] = []
  const allConfirmations: CoverageEntry[] = []

  console.log('\n═══ Gmork Coverage Report ═══\n')

  for (const r of reports) {
    console.log(`── ${r.title} ──`)
    for (const cp of r.checkpoints) {
      const d = cp.denials, c = cp.confirmations
      const dOk = count(d, 'explained'), dFilt = count(d, 'dependency_filtered'), dNone = count(d, 'no_checker')
      const cOk = count(c, 'explained'), cFilt = count(c, 'dependency_filtered'), cNone = count(c, 'no_checker')

      console.log(`  ${cp.label}:`)
      console.log(`    deny  ${dOk}/${d.length} (${pct(dOk, d.length)}%)  filtered=${dFilt}  no_checker=${dNone}`)
      console.log(`    conf  ${cOk}/${c.length} (${pct(cOk, c.length)}%)  filtered=${cFilt}  no_checker=${cNone}`)

      for (const e of d.filter(e => e.status === 'dependency_filtered')) {
        console.log(`    ~ deny  ${e.player}/${e.role} [${e.filteredType}]`)
      }
      for (const e of d.filter(e => e.status === 'no_checker')) {
        console.log(`    ✗ deny  ${e.player}/${e.role}`)
      }
      for (const e of c.filter(e => e.status === 'dependency_filtered')) {
        console.log(`    ~ conf  ${e.player}/${e.role} [${e.filteredType}]`)
      }
      for (const e of c.filter(e => e.status === 'no_checker')) {
        console.log(`    ✗ conf  ${e.player}/${e.role}`)
      }

      allDenials.push(...d)
      allConfirmations.push(...c)
    }
  }

  const dTotal = allDenials.length, cTotal = allConfirmations.length
  const dOk = count(allDenials, 'explained'), dFilt = count(allDenials, 'dependency_filtered'), dNone = count(allDenials, 'no_checker')
  const cOk = count(allConfirmations, 'explained'), cFilt = count(allConfirmations, 'dependency_filtered'), cNone = count(allConfirmations, 'no_checker')

  console.log(`\n═══ Total ═══`)
  console.log(`  deny:    ${dOk}/${dTotal} (${pct(dOk, dTotal)}%)  filtered=${dFilt} (${pct(dFilt, dTotal)}%)  no_checker=${dNone} (${pct(dNone, dTotal)}%)`)
  console.log(`  confirm: ${cOk}/${cTotal} (${pct(cOk, cTotal)}%)  filtered=${cFilt} (${pct(cFilt, cTotal)}%)  no_checker=${cNone} (${pct(cNone, cTotal)}%)`)
  console.log()

  // no_checker エントリをJSON書き出し
  type NoCheckerEntry = {
    file: string
    title: string
    line: number | null
    label: string
    kind: 'deny' | 'confirm'
    player: string
    seat: number
    role: SystemRole
  }

  const noCheckerEntries: NoCheckerEntry[] = []
  for (const r of reports) {
    for (const cp of r.checkpoints) {
      const all = [...cp.denials, ...cp.confirmations]
      for (const e of all) {
        if (e.status !== 'no_checker') continue
        noCheckerEntries.push({
          file: r.file,
          title: r.title,
          line: cp.line,
          label: cp.label,
          kind: e.kind,
          player: e.player,
          seat: e.seat,
          role: e.role,
        })
      }
    }
  }

  const outDir = join(__dirname, '..', '..', 'tmp')
  try { mkdirSync(outDir, { recursive: true }) } catch {}
  const outPath = join(outDir, 'gmork-no-checker.json')
  writeFileSync(outPath, JSON.stringify(noCheckerEntries, null, 2))
  console.log(`  no_checker entries: ${noCheckerEntries.length} → ${outPath}`)
}

// ── テスト実行 ──────────────────────────────────────────────────

const scenarios = loadScenarios()

describe('gmork coverage', () => {
  const reports: ScenarioReport[] = []

  for (const { file, content } of scenarios) {
    const { frontmatter, bodyLines, checkpoints } = extractCheckpoints(content)
    const { meta } = parse(content)
    const title = meta.title || file

    const report: ScenarioReport = { title, file, checkpoints: [] }

    describe(title, () => {
      // チェックポイントごと
      for (let i = 0; i < checkpoints.length; i++) {
        const cp = checkpoints[i]
        const partialText = frontmatter + bodyLines.slice(0, cp.lineNumber).join('\n')
        const label = `checkpoint ${i + 1} (line ${cp.lineNumber + 1})`

        test(label, () => {
          const { denials, confirmations } = measureCoverage(partialText, meta)
          report.checkpoints.push({ label, line: cp.lineNumber + 1, denials, confirmations })
        })
      }

      // ゲーム終了時点
      test('end of game', () => {
        const { denials, confirmations } = measureCoverage(content, meta)
        report.checkpoints.push({ label: 'end of game', line: null, denials, confirmations })
      })
    })

    reports.push(report)
  }

  test('print coverage report', () => {
    printReport(reports)
    assert.ok(true)
  })
})
