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
import { systemRoles } from '../types/index.ts'
import type { SystemRole } from '../types/index.ts'

type CliArgs = {
  seed: number
  maxGames: number
  scenario?: string
  minAlive?: number
  aliveRoles?: SystemRole[]
}

function parseArgs(argv: string[]): CliArgs {
  let seed: number | undefined
  let maxGames = 1
  let scenario: string | undefined
  let minAlive: number | undefined
  const aliveRoles: SystemRole[] = []

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
    if (a === '--scenario' && i + 1 < argv.length) {
      scenario = argv[++i]
      continue
    }
    if (a === '--min-alive' && i + 1 < argv.length) {
      minAlive = Number(argv[++i])
      continue
    }
    if (a === '--alive-role' && i + 1 < argv.length) {
      const role = argv[++i] as SystemRole
      if (!systemRoles.has(role)) {
        console.error(`error: unknown role "${role}". valid: ${Array.from(systemRoles.keys()).join(', ')}`)
        process.exit(2)
      }
      aliveRoles.push(role)
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

  if (minAlive !== undefined && (!Number.isFinite(minAlive) || minAlive < 0)) {
    console.error('error: --min-alive must be a non-negative integer')
    process.exit(2)
  }

  return { seed, maxGames, scenario, minAlive, aliveRoles: aliveRoles.length > 0 ? aliveRoles : undefined }
}

function printUsage(): void {
  console.error('usage: npm run puzzle -- [<seed>] [--max-games <K>] [--scenario <name>] [--min-alive <N>] [--alive-role <role>]...')
}

async function main(): Promise<void> {
  const { seed, maxGames, scenario, minAlive, aliveRoles } = parseArgs(process.argv.slice(2))
  const howl = await findTsumiPuzzle(seed, { maxGames, scenario, minAlive, aliveRoles })
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
