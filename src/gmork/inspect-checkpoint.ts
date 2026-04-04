/**
 * チェックポイント時点のゲーム状態を表示する CLI スクリプト
 *
 * Usage:
 *   node --experimental-strip-types src/gmork/inspect-checkpoint.ts <filename> <line|end>
 *
 * Example:
 *   node --experimental-strip-types src/gmork/inspect-checkpoint.ts mada4.howl 34
 *   node --experimental-strip-types src/gmork/inspect-checkpoint.ts mada4.howl end
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'

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

function main() {
  const args = process.argv.slice(2)
  if (args.length < 1) {
    console.error('Usage: inspect-checkpoint.ts <filename> [line|end]')
    process.exit(1)
  }

  const filename = args[0]
  const lineArg = args[1] ?? 'end'
  const isEnd = lineArg === 'end' || lineArg === 'null'

  // シナリオ読み込み
  const filePath = join(scenariosDir, filename)
  let rawText: string
  try {
    rawText = readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n')
  } catch {
    console.error(`ファイルが見つかりません: ${filePath}`)
    process.exit(1)
  }

  // frontmatter 分離
  const fmMatch = rawText.match(/^(---\n[\s\S]*?\n---\n)/)
  const frontmatter = fmMatch ? fmMatch[1] : ''
  const bodyText = fmMatch ? rawText.slice(frontmatter.length) : rawText
  const bodyLines = bodyText.split('\n')

  // 部分テキスト構築
  let partialText: string
  let checkpointLine: number
  if (isEnd) {
    partialText = rawText
    checkpointLine = bodyLines.length
  } else {
    checkpointLine = parseInt(lineArg, 10)
    if (isNaN(checkpointLine) || checkpointLine < 1) {
      console.error(`無効な行番号: ${lineArg}`)
      process.exit(1)
    }
    // line は 1-indexed body line。slice(0, line - 1) でチェックポイント行の手前まで
    partialText = frontmatter + bodyLines.slice(0, checkpointLine - 1).join('\n')
  }

  // パース & 分析
  const { statements, meta } = parse(partialText)
  const { vs, setup, players } = buildVillageStatus(statements, meta)

  const options: AnalyzeOptions = {
    ...defaultOptions,
    ...(meta.options || {}),
    assumptions: meta.options?.assumptions
      ? new Map(Object.entries(meta.options.assumptions))
      : defaultOptions.assumptions,
    hocusPocus: meta.options?.hocusPocus
      ? new Map(Object.entries(meta.options.hocusPocus))
      : defaultOptions.hocusPocus,
  }

  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyze()

  // 出力
  console.log(`=== ${filename}:${isEnd ? 'end' : checkpointLine} ===`)
  console.log(`Day: ${vs.day}  Finished: ${vs.finished}  Result: ${vs.result ?? '-'}`)
  console.log()

  console.log('=== Players ===')
  for (const [seat, name] of players) {
    const s = vs.statuses.get(seat)
    const alive = s?.surviving
      ? 'alive'
      : `dead(${s?.causeOfDeath} d${s?.diedDay})`
    const claim = s?.claimingRole || '-'
    const possibilities = [...(result.result.get(seat) || [])].sort().join(', ')
    console.log(`  ${seat} ${name}  ${alive}  CO:${claim}  poss:[${possibilities}]`)
  }
  console.log()

  // チェックポイント周辺行
  console.log('=== Scenario lines around checkpoint ===')
  const targetLine = isEnd ? bodyLines.length : checkpointLine
  const start = Math.max(0, targetLine - 8)
  const end = Math.min(bodyLines.length, targetLine + 3)
  for (let i = start; i < end; i++) {
    const marker = (i === targetLine - 1) ? ' >>>' : '    '
    console.log(`${marker} ${i + 1}: ${bodyLines[i]}`)
  }
}

main()
