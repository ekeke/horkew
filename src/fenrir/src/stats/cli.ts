/**
 * Eval howl 統計ビルダー CLI
 *
 * 使用例:
 *   node --experimental-strip-types src/fenrir/src/stats/cli.ts \
 *     --base tmp/orch-test28 [--out tmp/stats.json]
 *
 * --out を省略すると stdout に JSON を書き出す。
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parseEvalHowl } from './parse-eval-howl.ts'
import { aggregateByIter, buildPhaseOracle } from './aggregate.ts'
import type { ParsedGame } from './types.ts'

type Args = { base: string, out?: string }

function parseArgs(argv: string[]): Args {
  let base: string | undefined
  let out: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') base = argv[++i]
    else if (argv[i] === '--out') out = argv[++i]
  }
  if (!base) throw new Error('--base <checkpointBase> is required')
  return { base, out }
}

/** iter_{N}/seed_{S}.howl 構造から (iter → ParsedGame[]) を構築 */
function loadGamesByIter(base: string): Map<number, ParsedGame[]> {
  const evalDir = join(base, 'eval-howl')
  const result = new Map<number, ParsedGame[]>()
  if (!existsSync(evalDir)) return result

  for (const dirName of readdirSync(evalDir)) {
    const m = dirName.match(/^iter_(\d+)$/)
    if (!m) continue
    const iter = parseInt(m[1], 10)
    const iterDir = join(evalDir, dirName)
    const games: ParsedGame[] = []
    for (const fileName of readdirSync(iterDir)) {
      if (!fileName.endsWith('.howl')) continue
      const howl = readFileSync(join(iterDir, fileName), 'utf-8')
      games.push(parseEvalHowl(howl))
    }
    result.set(iter, games)
  }
  return result
}

function loadProgressJson(base: string): unknown {
  const path = join(base, 'train-progress.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const gamesByIter = loadGamesByIter(args.base)
  const progress = loadProgressJson(args.base)
  const oracle = buildPhaseOracle(progress)
  const stats = aggregateByIter(gamesByIter, args.base, oracle)

  const json = JSON.stringify(stats, null, 2)
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true })
    writeFileSync(args.out, json)
    process.stderr.write(`wrote ${stats.totalGames} games across ${stats.buckets.length} buckets → ${args.out}\n`)
  } else {
    process.stdout.write(json + '\n')
  }
}

main()
