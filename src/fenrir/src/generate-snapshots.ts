#!/usr/bin/env node
/**
 * スナップショット事前生成 CLI
 *
 * Usage:
 *   npm run generate-snapshots -- --day 3 --count 1000
 *   npm run generate-snapshots -- --day 3 --count 1000 --alive village --min-alive 5
 *
 * Options:
 *   --day <n>          スナップショットを取得する Day (デフォルト: 3)
 *   --count <n>        生成数 (デフォルト: 1000)
 *   --seed <n>         開始シード (デフォルト: 0)
 *   --alive <group>    生存必須の役職グループ: village, wolf, all (デフォルト: village)
 *   --min-alive <n>    最低生存席数 (デフォルト: 3)
 */

import { generateSnapshotsToDir, countSnapshots } from './seed-bank.ts'
import { DEFAULT_TRAINING_CONFIG } from './training.ts'

const args = process.argv.slice(2)

function argVal(name: string, def: number): number {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && idx + 1 < args.length ? parseInt(args[idx + 1]) : def
}

function argStr(name: string, def: string): string {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def
}

const ROLE_GROUPS: Record<string, string[]> = {
  village: ['villager', 'seer', 'medium', 'bodyguard', 'nekomata'],
  wolf: ['werewolf'],
  all: ['villager', 'seer', 'medium', 'bodyguard', 'nekomata', 'werewolf', 'mason', 'fanatic', 'werehamster', 'immoralist'],
}

const day = argVal('day', 3)
const count = argVal('count', 1000)
const startSeed = argVal('seed', 0)
const aliveGroup = argStr('alive', 'village')
const minAlive = argVal('min-alive', 3)
const aliveRoles = ROLE_GROUPS[aliveGroup] ?? aliveGroup.split(',')

import { filterDirName } from './seed-bank.ts'
const existing = countSnapshots(day, aliveRoles, minAlive)
console.log(`Generating ${count} snapshots at Day ${day}`)
console.log(`  Filter: ${aliveGroup} roles (${aliveRoles.join(', ')}) >= ${minAlive} alive`)
console.log(`  Dir: tmp/snapshots/day${day}/${filterDirName(aliveRoles, minAlive)}/`)
console.log(`  Existing: ${existing}, seed: ${startSeed}`)

const result = await generateSnapshotsToDir({
  snapshotDay: day,
  count,
  trainingConfig: DEFAULT_TRAINING_CONFIG,
  startSeed,
  aliveRoles,
  minAlive,
})

const total = existing + result.generated
console.log(`Done: ${result.generated} generated, ${result.skipped} skipped, ${(result.timeMs / 1000).toFixed(1)}s`)
console.log(`Total: ${total}`)
console.log(`Directory: tmp/snapshots/day${day}/`)
