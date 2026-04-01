#!/usr/bin/env node
/**
 * スナップショット事前生成 CLI
 *
 * Usage:
 *   node --experimental-strip-types src/fenrir/src/generate-snapshots.ts --day 3 --count 1000
 *   npm run generate-snapshots -- --day 3 --count 1000
 *
 * Options:
 *   --day <n>     スナップショットを取得する Day (デフォルト: 3)
 *   --count <n>   生成数 (デフォルト: 1000)
 *   --seed <n>    開始シード (デフォルト: 0)
 */

import { generateSnapshotsToDir, countSnapshots } from './seed-bank.ts'
import { DEFAULT_TRAINING_CONFIG } from './training.ts'

const args = process.argv.slice(2)

function argVal(name: string, def: number): number {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && idx + 1 < args.length ? parseInt(args[idx + 1]) : def
}

const day = argVal('day', 3)
const count = argVal('count', 1000)
const startSeed = argVal('seed', 0)

const existing = countSnapshots(day)
console.log(`Generating ${count} snapshots at Day ${day} (existing: ${existing}, seed: ${startSeed})`)

const result = await generateSnapshotsToDir({
  snapshotDay: day,
  count,
  trainingConfig: DEFAULT_TRAINING_CONFIG,
  startSeed,
})

const total = existing + result.generated
console.log(`Done: ${result.generated} generated, ${result.skipped} skipped, ${(result.timeMs / 1000).toFixed(1)}s`)
console.log(`Total snapshots at Day ${day}: ${total}`)
console.log(`Directory: tmp/snapshots/day${day}/`)
