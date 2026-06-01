/**
 * 役職動作 spec の Howl ファイルに lupa engine 実行結果を auto-annotate するツール。
 *
 * 使い方:
 *   node --experimental-strip-types scripts/spec-annotate.ts <file.howl> [...]
 *   node --experimental-strip-types scripts/spec-annotate.ts --strip <file.howl> [...]
 *
 * 各 Day / Night の終わりに `# == engine: ... # == end ==` のコメントブロックを
 * 挿入する。 既存ブロックは再生成時に置換される。
 * 著者が書いた `# @expect-*` や通常コメントは保持される。
 *
 * --strip オプションで engine アノテーションのみ削除して書き戻す (engine 実行なし)。
 *
 * 引数なしで実行すると src/spec/**\/*.howl 全てを処理。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from '../src/howl/parser.ts'
import { buildVillageStatus } from '../src/howl/bridge.ts'
import { runGame } from '../src/lupa/engine.ts'
import { buildLupaScenario } from '../src/lupa/howl-adapter.ts'
import type { GameEvent } from '../src/lupa/types.ts'
import { loadScenariosRecursive } from '../src/spec/loadScenarios.ts'

export const BEGIN_MARK = '# == engine:'
export const END_MARK = '# == end =='

export function stripAnnotations(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!inBlock && trimmed.startsWith(BEGIN_MARK)) {
      inBlock = true
      continue
    }
    if (inBlock && trimmed === END_MARK) {
      inBlock = false
      continue
    }
    if (inBlock) continue
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

type SectionKind = 'pre-day1' | 'day' | 'night' | 'final'

type Section = {
  kind: SectionKind
  index: number
  lines: string[]
}

function nameOf(seat: number, players: Map<number, string>): string {
  return players.get(seat) ?? `Seat${seat}`
}

function tallyVotes(votes: Map<number, number>, players: Map<number, string>): string {
  const counts = new Map<number, number>()
  for (const target of votes.values()) {
    counts.set(target, (counts.get(target) ?? 0) + 1)
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
  return sorted.map(([target, count]) => `${nameOf(target, players)} ${count}`).join(' / ')
}

function buildSections(
  events: GameEvent[],
  state: { result: string | null, players: Array<{ seat: number, alive: boolean }> },
  players: Map<number, string>,
): Section[] {
  const sections: Section[] = []

  // phase state machine
  type Phase = { kind: 'pre-day1' | 'day' | 'night', index: number }
  let phase: Phase = { kind: 'pre-day1', index: 0 }
  let currentVotes = new Map<number, number>()
  let revoteRounds: Array<Map<number, number>> = []
  let pendingLines: string[] = []

  const flushSection = () => {
    if (pendingLines.length === 0) return
    sections.push({ kind: phase.kind, index: phase.index, lines: pendingLines })
    pendingLines = []
  }

  const startDay = (index: number) => {
    flushSection()
    phase = { kind: 'day', index }
    currentVotes = new Map()
    revoteRounds = []
  }

  const startNight = (index: number) => {
    flushSection()
    phase = { kind: 'night', index }
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'vote': {
        if (phase.kind !== 'day') {
          // Day 開始 (最初の vote)
          startDay(phase.kind === 'night' ? phase.index + 1 : 1)
        }
        currentVotes.set(ev.voter, ev.target)
        break
      }
      case 'revote': {
        revoteRounds.push(new Map(currentVotes))
        pendingLines.push(`# revote candidates: ${ev.targets.map(s => nameOf(s, players)).join(', ')}`)
        currentVotes = new Map()
        break
      }
      case 'execution': {
        const tally = tallyVotes(currentVotes, players)
        if (revoteRounds.length > 0) {
          pendingLines.push(`# revote tally: ${tally} → execution=${nameOf(ev.target, players)}`)
        } else {
          pendingLines.push(`# vote tally: ${tally} → execution=${nameOf(ev.target, players)}`)
        }
        break
      }
      case 'curse_kill': {
        pendingLines.push(`# chain (curse_kill): ${nameOf(ev.target, players)} died`)
        break
      }
      case 'follow_kill': {
        pendingLines.push(`# chain (follow_kill): ${nameOf(ev.target, players)} died`)
        break
      }
      case 'night_kill': {
        if (phase.kind !== 'night') {
          startNight(phase.kind === 'day' ? phase.index : 0)
        }
        pendingLines.push(`# night_kill: ${nameOf(ev.target, players)}`)
        break
      }
      case 'fox_kill': {
        if (phase.kind !== 'night') {
          startNight(phase.kind === 'day' ? phase.index : 0)
        }
        pendingLines.push(`# fox_kill (divine curse): ${nameOf(ev.target, players)}`)
        break
      }
      case 'peace': {
        if (phase.kind !== 'night') {
          startNight(phase.kind === 'day' ? phase.index : 0)
        }
        pendingLines.push(`# peace (襲撃が attack-immune で無効)`)
        break
      }
      case 'game_over': {
        flushSection()
        const survivors = state.players.filter(p => p.alive).map(p => nameOf(p.seat, players)).join(', ') || '(none)'
        sections.push({
          kind: 'final',
          index: 0,
          lines: [
            `# result: ${ev.result}`,
            `# survivors: ${survivors}`,
          ],
        })
        break
      }
      default:
        // claim / forecast / comment / reveal などはアノテーション対象外
        break
    }
  }
  flushSection()

  return sections
}

function formatSection(s: Section): string {
  let title: string
  if (s.kind === 'pre-day1') title = 'Night 0'
  else if (s.kind === 'day') title = `Day ${s.index}`
  else if (s.kind === 'night') title = `Night ${s.index}`
  else title = 'Final'

  const head = `${BEGIN_MARK} ${title} ==`
  const body = s.lines.join('\n')
  return `${head}\n${body}\n${END_MARK}`
}

function insertSections(originalText: string, sections: Section[]): string {
  // 戦略:
  //   - pre-day1 と 直後の Night 0 (もしあれば) はペアで Day 1 の最初の vote 行の前に挿入
  //   - Day N section + 直後の Night N section は Day (N+1) marker の前に挿入
  //   - 最後の Day section + Final は Day marker が無いので @expect-* の前 or 末尾に挿入
  // 同じ挿入位置に複数 section が当たる場合は時系列順 (sections 配列順) に並べる

  const lines = originalText.split('\n')

  const dayMarkerRegex = /^Day\s+(\d+):/
  const expectRegex = /^#\s*@expect-/
  const voteRegex = /→|=>|->/
  const dayMarkerLineByIdx = new Map<number, number>()
  let firstVoteLine = -1
  let firstExpectLine = -1
  // frontmatter (`---` で囲まれた YAML ブロック) はスキップ。 title 内の "→" 等を誤検出しないため
  let inFrontmatter = false
  let frontmatterEnd = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === '---') {
      if (!inFrontmatter && frontmatterEnd < 0) {
        inFrontmatter = true
      } else if (inFrontmatter) {
        inFrontmatter = false
        frontmatterEnd = i
      }
      continue
    }
    if (inFrontmatter) continue
    const m = dayMarkerRegex.exec(trimmed)
    if (m) dayMarkerLineByIdx.set(parseInt(m[1], 10), i)
    if (firstVoteLine < 0 && !trimmed.startsWith('#') && !trimmed.startsWith('!') && voteRegex.test(lines[i])) {
      firstVoteLine = i
    }
    if (firstExpectLine < 0 && expectRegex.test(trimmed)) firstExpectLine = i
  }

  const tailLine = firstExpectLine >= 0 ? firstExpectLine : lines.length

  // 各 section の挿入位置を決める
  type Anchor = { lineIdx: number, order: number, section: Section }
  const anchors: Anchor[] = []
  sections.forEach((s, order) => {
    let insertAt: number
    if (s.kind === 'pre-day1') {
      insertAt = firstVoteLine >= 0 ? firstVoteLine : tailLine
    } else if (s.kind === 'day') {
      const nextMarker = dayMarkerLineByIdx.get(s.index + 1)
      insertAt = nextMarker !== undefined ? nextMarker : tailLine
    } else if (s.kind === 'night') {
      // Night N → Day (N+1) marker の前。 Night 0 は Day 1 = 最初の vote の前
      if (s.index === 0) {
        insertAt = firstVoteLine >= 0 ? firstVoteLine : tailLine
      } else {
        const nextMarker = dayMarkerLineByIdx.get(s.index + 1)
        insertAt = nextMarker !== undefined ? nextMarker : tailLine
      }
    } else {
      insertAt = tailLine
    }
    anchors.push({ lineIdx: insertAt, order, section: s })
  })

  // lineIdx でグループ化、 内部は order (時系列) 昇順
  const groupedByLine = new Map<number, Section[]>()
  for (const a of anchors.sort((x, y) => x.order - y.order)) {
    if (!groupedByLine.has(a.lineIdx)) groupedByLine.set(a.lineIdx, [])
    groupedByLine.get(a.lineIdx)!.push(a.section)
  }

  // 後ろから挿入 (line index がズレないように)
  const sortedKeys = [...groupedByLine.keys()].sort((a, b) => b - a)
  const result = [...lines]
  for (const lineIdx of sortedKeys) {
    const ss = groupedByLine.get(lineIdx)!
    const text = ss.map(formatSection).join('\n')
    result.splice(lineIdx, 0, '', text, '')
  }
  return result.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** ファイルを読んで CRLF を LF に正規化 (Windows 環境対応) */
function readNormalized(filePath: string): string {
  return readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n')
}

export async function annotateFile(filePath: string): Promise<void> {
  const original = readNormalized(filePath)
  const stripped = stripAnnotations(original)
  const { meta, statements } = parse(stripped)
  const { vs, setup, players, assumptions, spoilerActions } = buildVillageStatus(statements, meta)
  const { config, handlers } = buildLupaScenario({ assumptions, spoilerActions, vs, setup, players, meta })
  const { state, events } = await runGame(config, handlers)

  const playersForFmt = state.players.map(p => ({ seat: p.seat, alive: p.alive }))
  const sections = buildSections(events as GameEvent[], { result: state.result, players: playersForFmt }, players)
  const annotated = insertSections(stripped, sections)
  writeFileSync(filePath, annotated, 'utf-8')
  console.log(`annotated: ${filePath}`)
}

export function stripFile(filePath: string): void {
  const original = readNormalized(filePath)
  const stripped = stripAnnotations(original)
  writeFileSync(filePath, stripped, 'utf-8')
  console.log(`stripped: ${filePath}`)
}

export async function runCli(argv: string[]): Promise<void> {
  const stripMode = argv.includes('--strip')
  const fileArgs = argv.filter(a => !a.startsWith('--'))

  let targets: string[]
  if (fileArgs.length === 0) {
    const scenarios = loadScenariosRecursive(resolve('src/spec'))
    targets = scenarios.map(s => s.absPath)
  } else {
    targets = fileArgs.map(a => resolve(a))
  }

  if (stripMode) {
    for (const t of targets) stripFile(t)
  } else {
    for (const t of targets) await annotateFile(t)
  }
}
