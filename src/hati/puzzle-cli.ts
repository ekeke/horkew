/**
 * 詰め人狼 puzzle 生成 CLI.
 *
 * 使い方:
 *   npm run puzzle -- <seed> [--max-games K]
 *   npm run puzzle -- --seed <seed> [--max-games K]
 *
 * - 詰み発見 → stdout に .howl を出力、exit 0
 * - 詰み未発見 → stderr に通知、exit 1
 */

import { findTsumiPuzzle } from './puzzle.ts'

type CliArgs = {
  seed: number
  maxGames: number
}

function parseArgs(argv: string[]): CliArgs {
  let seed: number | undefined
  let maxGames = 1

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--seed' && i + 1 < argv.length) {
      seed = Number(argv[++i])
      continue
    }
    if (a === '--max-games' && i + 1 < argv.length) {
      maxGames = Number(argv[++i])
      continue
    }
    if (a === '-h' || a === '--help') {
      printUsage()
      process.exit(0)
    }
    if (seed === undefined && /^-?\d+$/.test(a)) {
      seed = Number(a)
      continue
    }
  }

  if (seed === undefined) {
    seed = Math.floor(Math.random() * 0x7FFFFFFF)
    console.error(`# generated seed: ${seed}`)
  } else if (!Number.isFinite(seed)) {
    console.error(`error: invalid seed`)
    printUsage()
    process.exit(2)
  }
  if (!Number.isFinite(maxGames) || maxGames < 1) {
    console.error('error: --max-games must be a positive integer')
    process.exit(2)
  }

  return { seed, maxGames }
}

function printUsage(): void {
  console.error('usage: npm run puzzle -- [<seed>] [--max-games <K>]')
}

async function main(): Promise<void> {
  const { seed, maxGames } = parseArgs(process.argv.slice(2))
  const howl = await findTsumiPuzzle(seed, { maxGames })
  if (howl === null) {
    console.error(`no tsumi found for seed=${seed}, maxGames=${maxGames}`)
    process.exit(1)
  }
  process.stdout.write(howl)
  if (!howl.endsWith('\n')) process.stdout.write('\n')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
