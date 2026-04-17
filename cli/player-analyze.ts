#!/usr/bin/env -S node --experimental-strip-types
/**
 * 人狼ゲーム盤面解析 CLI
 *
 * .howl シナリオを読み込み、任意の行までで切り詰めた状態に対して
 * retar（役職可能性）と skoll（役職確率・吊り別勝率）を走らせる。
 *
 * 使い方:
 *   cli/player-analyze.ts <file.howl>
 *   cli/player-analyze.ts <file.howl> --until-line 51
 *   cli/player-analyze.ts <file.howl> --all --format=table
 */

import { readFileSync } from 'node:fs'
import type { SystemRole, VillageStatus, Seat } from '../src/types/index.ts'
import { parse } from '../src/howl/parser.ts'
import { buildVillageStatus } from '../src/howl/bridge.ts'
import { VillageRetar } from '../src/retar/index.ts'
import type { AnalyzeOptions } from '../src/retar/index.ts'
import { ROLE_COUNT, RoleBitIndex } from '../src/retar/possibilities.ts'
import { computeRoleProbabilities } from '../src/skoll/index.ts'
import { analyzeExecutionsByWorld } from '../src/skoll/world-analysis.ts'

type OutputFormat = 'json' | 'table'

type Args = {
  file: string
  untilLine: number | null
  probabilities: boolean
  winrate: boolean
  format: OutputFormat
}

function showHelp(exit: 0 | 2 = 0): never {
  const target = exit === 0 ? console.log : console.error
  target(`人狼ゲーム盤面解析 CLI

Usage:
  cli/player-analyze.ts <file.howl> [options]

Options:
  --until-line <n>    本文先頭から N 行のみを解析（途中時点の盤面を再現）
  --probabilities     skoll.computeRoleProbabilities の席×役職確率を追加出力
  --winrate           skoll.analyzeExecutionsByWorld の吊り先別村勝率を追加出力
  --all               --probabilities --winrate の両方を有効化
  --format <fmt>      出力形式: 'json'（デフォルト）または 'table'
  -h, --help          このヘルプを表示
`)
  process.exit(exit)
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const args: Args = {
    file: '',
    untilLine: null,
    probabilities: false,
    winrate: false,
    format: 'json',
  }
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') showHelp(0)
    else if (a === '--until-line') args.untilLine = parseInt(argv[++i] ?? '', 10)
    else if (a === '--probabilities') args.probabilities = true
    else if (a === '--winrate') args.winrate = true
    else if (a === '--all') { args.probabilities = true; args.winrate = true }
    else if (a === '--format') args.format = (argv[++i] ?? 'json') as OutputFormat
    else if (a.startsWith('--format=')) args.format = a.slice('--format='.length) as OutputFormat
    else if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}`)
      showHelp(2)
    } else positional.push(a)
  }

  if (positional.length === 0) {
    console.error('Error: .howl file path required')
    showHelp(2)
  }
  if (positional.length > 1) {
    console.error(`Error: too many positional arguments: ${positional.join(', ')}`)
    showHelp(2)
  }
  if (args.format !== 'json' && args.format !== 'table') {
    console.error(`Invalid --format: ${args.format} (expected 'json' or 'table')`)
    process.exit(2)
  }
  if (args.untilLine !== null && (Number.isNaN(args.untilLine) || args.untilLine < 0)) {
    console.error(`Invalid --until-line: ${args.untilLine}`)
    process.exit(2)
  }
  args.file = positional[0]
  return args
}

function readAndTruncate(filePath: string, untilLine: number | null): string {
  const raw = readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n')
  if (untilLine === null) return raw

  const fmMatch = raw.match(/^(---\n[\s\S]*?\n---\n)/)
  const frontmatter = fmMatch ? fmMatch[1] : ''
  const bodyText = fmMatch ? raw.slice(fmMatch[1].length) : raw
  const bodyLines = bodyText.split('\n')
  const truncated = bodyLines.slice(0, untilLine).join('\n')
  return frontmatter + truncated
}

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

type SeatInfo = {
  seat: Seat
  name: string
  alive: boolean
  diedDay: number | undefined
  causeOfDeath: string | undefined
}

function collectSeats(vs: VillageStatus, players: Map<number, string>): SeatInfo[] {
  const list: SeatInfo[] = []
  for (const [seat, status] of vs.statuses) {
    list.push({
      seat,
      name: players.get(seat) ?? `seat${seat}`,
      alive: status.surviving,
      diedDay: status.diedDay,
      causeOfDeath: status.surviving ? undefined : status.causeOfDeath,
    })
  }
  list.sort((a, b) => a.seat - b.seat)
  return list
}

const bitToRole: SystemRole[] = (() => {
  const arr = new Array<SystemRole>(ROLE_COUNT)
  for (const [role, bit] of Object.entries(RoleBitIndex) as [SystemRole, number][]) {
    arr[bit] = role
  }
  return arr
})()

type AnalysisOutput = {
  file: string
  untilLine: number | null
  setup: Record<string, number>
  day: number
  gameFinished: boolean
  result: string | undefined
  alive: string[]
  dead: { name: string, day: number | undefined, cause: string | undefined }[]
  possibilities: Record<string, string[]>
  probabilities?: {
    totalWorlds: number
    truncated: boolean
    perSeat: Record<string, Record<string, number>>
  }
  executionWinRates?: {
    totalWorlds: number
    truncated: boolean
    bestExecution: string
    overallWinRate: number
    candidates: { name: string, winRate: number }[]
  }
  warnings: string[]
}

function buildOutput(args: Args): AnalysisOutput {
  const text = readAndTruncate(args.file, args.untilLine)
  const { meta, statements } = parse(text)
  const warnings: string[] = []

  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) {
    console.error(`parse error — ${unknowns.length} unknown statement(s):`)
    for (const u of unknowns) {
      const line = (u as any).line
      const text = (u as any).text
      console.error(`  line ${line}: ${JSON.stringify(text)}`)
    }
    process.exit(1)
  }

  const { vs, setup, players, assumptions } = buildVillageStatus(statements, meta)
  // spoiler 由来の assumptions と frontmatter 由来の assumptions をマージ（spoiler 優先）
  const metaOptions = meta?.options ?? {}
  const mergedAssumptions = new Map<number, SystemRole>()
  if (metaOptions.assumptions instanceof Map) {
    for (const [k, v] of metaOptions.assumptions) mergedAssumptions.set(k as number, v as SystemRole)
  }
  for (const [k, v] of assumptions) mergedAssumptions.set(k, v)
  const options: AnalyzeOptions = {
    ...defaultOptions,
    ...metaOptions,
    assumptions: mergedAssumptions,
  }
  const retar = new VillageRetar(vs, setup, options)
  const analyzeResult = retar.analyze()
  if (analyzeResult.error) {
    console.error(`retar analyze error: ${analyzeResult.error.message}`)
    process.exit(1)
  }

  const seatInfos = collectSeats(vs, players)
  const nameOf = (seat: Seat) => players.get(seat) ?? `seat${seat}`

  const possibilities: Record<string, string[]> = {}
  for (const si of seatInfos) {
    const set = analyzeResult.result.get(si.seat)
    possibilities[si.name] = set ? [...set].sort() : []
  }

  const output: AnalysisOutput = {
    file: args.file,
    untilLine: args.untilLine,
    setup: Object.fromEntries(setup),
    day: vs.day,
    gameFinished: vs.finished,
    result: vs.result ?? undefined,
    alive: seatInfos.filter(s => s.alive).map(s => s.name),
    dead: seatInfos.filter(s => !s.alive).map(s => ({ name: s.name, day: s.diedDay, cause: s.causeOfDeath })),
    possibilities,
    warnings,
  }

  if (args.probabilities) {
    const pr = computeRoleProbabilities(retar.conclusions, setup)
    const perSeat: Record<string, Record<string, number>> = {}
    for (const si of seatInfos) {
      const row: Record<string, number> = {}
      for (let b = 0; b < ROLE_COUNT; b++) {
        const p = pr.probabilities[si.seat * ROLE_COUNT + b]
        if (p > 0) row[bitToRole[b]] = p
      }
      perSeat[si.name] = row
    }
    output.probabilities = { totalWorlds: pr.totalWorlds, truncated: pr.truncated, perSeat }
    if (pr.truncated) warnings.push(`role probability enumeration truncated at ${pr.totalWorlds} worlds`)
  }

  if (args.winrate) {
    const wr = analyzeExecutionsByWorld(retar.conclusions, setup, vs)
    const candidates = wr.executions
      .map(e => ({ name: nameOf(e.seat), winRate: e.winRate }))
      .sort((a, b) => b.winRate - a.winRate)
    output.executionWinRates = {
      totalWorlds: wr.totalWorlds,
      truncated: wr.truncated,
      bestExecution: nameOf(wr.bestExecution),
      overallWinRate: wr.overallWinRate,
      candidates,
    }
    if (wr.truncated) warnings.push(`execution win-rate enumeration truncated at ${wr.totalWorlds} worlds`)
  }

  return output
}

function formatTable(o: AnalysisOutput): string {
  const lines: string[] = []
  lines.push(`ファイル: ${o.file}${o.untilLine !== null ? ` (line 1..${o.untilLine})` : ''}`)
  const setupStr = Object.entries(o.setup).map(([r, n]) => `${r}=${n}`).join(' ')
  lines.push(`レギュ: ${setupStr}`)
  lines.push(`Day ${o.day}${o.gameFinished ? ` [終了: ${o.result ?? '?'}]` : ''}`)
  lines.push(``)

  lines.push(`生存 (${o.alive.length}): ${o.alive.join('、')}`)
  if (o.dead.length > 0) {
    lines.push(`死亡 (${o.dead.length}):`)
    for (const d of o.dead) lines.push(`  ${d.name}  day${d.day ?? '?'} ${d.cause ?? ''}`)
  }
  lines.push(``)

  lines.push(`役職可能性:`)
  const maxName = Math.max(...Object.keys(o.possibilities).map(n => [...n].length))
  for (const [name, roles] of Object.entries(o.possibilities)) {
    const pad = ' '.repeat(Math.max(0, maxName - [...name].length))
    lines.push(`  ${name}${pad}  [${roles.join(', ')}]`)
  }

  if (o.probabilities) {
    lines.push(``)
    lines.push(`役職確率 (totalWorlds=${o.probabilities.totalWorlds}${o.probabilities.truncated ? ', truncated' : ''}):`)
    for (const [name, row] of Object.entries(o.probabilities.perSeat)) {
      const pad = ' '.repeat(Math.max(0, maxName - [...name].length))
      const parts = Object.entries(row)
        .sort((a, b) => b[1] - a[1])
        .map(([r, p]) => `${r}:${(p * 100).toFixed(1)}%`)
      lines.push(`  ${name}${pad}  ${parts.join('  ')}`)
    }
  }

  if (o.executionWinRates) {
    lines.push(``)
    lines.push(`吊り先別村勝率 (totalWorlds=${o.executionWinRates.totalWorlds}${o.executionWinRates.truncated ? ', truncated' : ''}):`)
    lines.push(`  最善手: ${o.executionWinRates.bestExecution} (村勝率 ${(o.executionWinRates.overallWinRate * 100).toFixed(1)}%)`)
    for (const c of o.executionWinRates.candidates) {
      const pad = ' '.repeat(Math.max(0, maxName - [...c.name].length))
      lines.push(`  ${c.name}${pad}  ${(c.winRate * 100).toFixed(1)}%`)
    }
  }

  if (o.warnings.length > 0) {
    lines.push(``)
    lines.push(`warnings:`)
    for (const w of o.warnings) lines.push(`  ${w}`)
  }

  return lines.join('\n') + '\n'
}

function main(): void {
  const args = parseArgs()
  const output = buildOutput(args)
  if (args.format === 'json') {
    process.stdout.write(JSON.stringify(output, null, 2) + '\n')
  } else {
    process.stdout.write(formatTable(output))
  }
}

main()
