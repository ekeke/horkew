#!/usr/bin/env node
/**
 * スナップショット事前生成 CLI
 *
 * Usage:
 *   npm run generate-snapshots -- --day 1-3 --count 5000 --alive village --min-alive 3
 *   npm run generate-snapshots -- --day 1-3 --count 5000 --retire 5000
 *
 * Options:
 *   --day <range>      Day 範囲: "3" or "1-3" (デフォルト: 1-3)
 *   --count <n>        各 Day の生成数 (デフォルト: 1000)
 *   --seed <n>         開始シード (デフォルト: 0)
 *   --alive <group>    生存必須の役職グループ: village, wolf, all (デフォルト: village)
 *   --min-alive <n>    最低生存席数 (デフォルト: 3)
 *   --retire <n>       生成後、古い方から n 個を削除
 */

import { generateSnapshotsToDir, countSnapshots, filterDirName, retireSnapshots } from './seed-bank.ts'
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

function argOptVal(name: string): number | undefined {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && idx + 1 < args.length ? parseInt(args[idx + 1]) : undefined
}

function parseDayRange(s: string): number[] {
  const m = s.match(/^(\d+)-(\d+)$/)
  if (m) {
    const from = parseInt(m[1]), to = parseInt(m[2])
    return Array.from({ length: to - from + 1 }, (_, i) => from + i)
  }
  return [parseInt(s)]
}

const ROLE_GROUPS: Record<string, string[]> = {
  village: ['villager', 'seer', 'medium', 'bodyguard', 'nekomata'],
  wolf: ['werewolf'],
  all: ['villager', 'seer', 'medium', 'bodyguard', 'nekomata', 'werewolf', 'mason', 'fanatic', 'werehamster', 'immoralist'],
}

const days = parseDayRange(argStr('day', '1-3'))
const count = argVal('count', 1000)
const startSeed = argVal('seed', 0)
const aliveGroup = argStr('alive', 'village')
const minAlive = argVal('min-alive', 3)
const retire = argOptVal('retire')
const aliveRoles = ROLE_GROUPS[aliveGroup] ?? aliveGroup.split(',')
const filterDir = filterDirName(aliveRoles, minAlive)

console.log(`Generating ${count} snapshots × Day ${days.join(',')}`)
console.log(`  Filter: ${aliveGroup} (${aliveRoles.join(', ')}) >= ${minAlive} alive`)
if (retire) console.log(`  Retire: oldest ${retire} per day after generation`)
for (const day of days) {
  const existing = countSnapshots(day, aliveRoles, minAlive)
  console.log(`  Day ${day}: ${existing} existing → tmp/snapshots/day${day}/${filterDir}/`)
}

const result = await generateSnapshotsToDir({
  snapshotDays: days,
  count,
  trainingConfig: DEFAULT_TRAINING_CONFIG,
  startSeed,
  aliveRoles,
  minAlive,
})

// Retire old snapshots
if (retire) {
  for (const day of days) {
    const deleted = retireSnapshots(day, retire, aliveRoles, minAlive)
    if (deleted > 0) console.log(`  Day ${day}: retired ${deleted} old snapshots`)
  }
}

console.log(`Done in ${(result.timeMs / 1000).toFixed(1)}s (${result.skipped} games skipped)`)
for (const day of days) {
  const total = countSnapshots(day, aliveRoles, minAlive)
  console.log(`  Day ${day}: +${result.generated.get(day)} → ${total} total`)
}
