import type { SystemRole } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'
import type { LupaConfig } from './types.ts'
import { runGame } from './engine.ts'
import { formatHowl } from './format.ts'

function parseArgs(args: string[]): LupaConfig {
  const roles = new Map<SystemRole, number>()
  let seed: number | undefined
  let verify = false
  let useRandomNames = false

  for (const arg of args) {
    if (arg === '--test') {
      verify = true
      continue
    }
    if (arg === '--use-random-names') {
      useRandomNames = true
      continue
    }
    if (arg.startsWith('--seed=')) {
      seed = parseInt(arg.slice(7), 10)
      continue
    }
    if (arg.startsWith('--seed')) {
      // --seed 42 形式は次の引数で処理
      continue
    }

    const match = arg.match(/^(\w+):(\d+)$/)
    if (match) {
      const role = match[1] as SystemRole
      if (!systemRoles.has(role)) {
        console.error(`不明な役職: ${role}`)
        console.error(`利用可能: ${Array.from(systemRoles.keys()).join(', ')}`)
        process.exit(1)
      }
      roles.set(role, parseInt(match[2], 10))
    }
  }

  // --seed N 形式の処理
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seed' && i + 1 < args.length) {
      seed = parseInt(args[i + 1], 10)
    }
  }

  if (roles.size === 0) {
    console.error('使用法: node --experimental-strip-types src/lupa/cli.ts <role:count>... [--seed N] [--test]')
    console.error('例: node --experimental-strip-types src/lupa/cli.ts werewolf:2 villager:5 seer:1 medium:1 bodyguard:1')
    process.exit(1)
  }

  return { roles, seed, verify, useRandomNames }
}

const config = parseArgs(process.argv.slice(2))
const { events, state } = runGame(config)
const howl = formatHowl(events, state, config)
console.log(howl)
