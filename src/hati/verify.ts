/**
 * Hati 詰み探索 検証スクリプト
 *
 * Lupaで生成したゲームをHatiに通し、
 * 「詰み」と判定された戦略が真の役職配置で実際に勝てるかを検証する。
 *
 * 実行:
 *   node --experimental-strip-types src/hati/verify.ts
 *   node --experimental-strip-types src/hati/verify.ts --outdir tmp/verify-hati
 *   node --experimental-strip-types src/hati/verify.ts --scenario small-8p
 *   node --experimental-strip-types src/hati/verify.ts --scenario small-8p --seeds 0-50
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SystemRole } from '../types/index.ts'
import type { GameEvent, GameState } from '../lupa/types.ts'
import { runGame } from '../lupa/engine.ts'
import { formatHowl } from '../lupa/format.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { searchTsumi } from './index.ts'
import { getEndgameStats } from './search.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import type { StrategyNode, World } from './types.ts'
import { hasSeat, removeSeat, forEachSeat } from './types.ts'
import {
  checkOutcome, simulateNight, validBiteTargets, getMediumResult,
  executionObsKeyToString, obsKeyToString,
} from './simulate.ts'

const ANALYZE_OPTIONS: AnalyzeOptions = {
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

// --- 戦略検証 ---

type VerifyTrace = { valid: boolean, trace: string[] }

/**
 * 真の役職配置で戦略木を辿り、村勝利に到達するか検証する。
 * alive はビットマスク。
 */
function verifyStrategy(
  node: StrategyNode,
  world: World,
  alive: number,
): VerifyTrace {
  if (node.type === 'win') {
    const outcome = checkOutcome(world, alive)
    if (outcome === 'village_win') {
      return { valid: true, trace: ['村勝利 (確認済み)'] }
    }
    return { valid: false, trace: [`win ノードだが勝利条件未達: ${outcome}`] }
  }

  const { action, branches } = node

  if (action.execute !== -1) {
    const target = action.execute
    if (!hasSeat(alive, target)) {
      return { valid: false, trace: [`処刑対象 ${target} が生存していない`] }
    }

    let afterExec = removeSeat(alive, target)
    const trueRole = world.roles[target]
    const mediumResult = getMediumResult(trueRole)

    if (trueRole === 'nekomata') {
      // 猫又処刑: 各道連れ先で検証
      let allOk = true
      const failTrace: string[] = []
      forEachSeat(afterExec, curseTarget => {
        if (!allOk) return
        let afterCurse = removeSeat(afterExec, curseTarget)
        afterCurse = applyFollowDeaths(afterCurse, world)
        const obsKey = executionObsKeyToString(mediumResult, curseTarget)
        const branch = branches[obsKey] ?? branches['win']
        if (!branch) {
          allOk = false
          failTrace.push(`猫又道連れ ${curseTarget} の分岐 '${obsKey}' が存在しない`)
          return
        }
        const sub = verifyStrategy(branch, world, afterCurse)
        if (!sub.valid) {
          allOk = false
          failTrace.push(`処刑 ${target} (猫又) 道連れ ${curseTarget}`, ...sub.trace)
        }
      })
      return allOk
        ? { valid: true, trace: [`処刑 ${target} (猫又) 全道連れ先で勝利確認`] }
        : { valid: false, trace: failTrace }
    }

    afterExec = applyFollowDeaths(afterExec, world)

    const obsKey = executionObsKeyToString(mediumResult, null)
    const branch = branches[obsKey] ?? branches['win']
    if (!branch) {
      return { valid: false, trace: [`処刑 ${target} の分岐 '${obsKey}' が存在しない`] }
    }

    const sub = verifyStrategy(branch, world, afterExec)
    return { valid: sub.valid, trace: [`処刑 ${target} → ${obsKey}`, ...sub.trace] }
  }

  // 夜アクション
  const { bodyguardTarget, seerTarget } = action
  const biteTargets = validBiteTargets(world, alive)

  if (biteTargets.length === 0) {
    const key = obsKeyToString(0)
    const branch = branches[key] ?? branches['win']
    if (!branch) {
      return { valid: false, trace: [`夜: 狼全滅だが分岐 '${key}' が存在しない`] }
    }
    return verifyStrategy(branch, world, alive)
  }

  for (const biteTarget of biteTargets) {
    const { nextAlive, obsKey: numKey } = simulateNight(
      world, alive, biteTarget, bodyguardTarget, seerTarget,
    )
    const key = obsKeyToString(numKey)
    const branch = branches[key] ?? branches['win']
    if (!branch) {
      return { valid: false, trace: [`夜: 噛み ${biteTarget} の分岐 '${key}' が存在しない`] }
    }

    if (branch.type === 'win') {
      const outcome = checkOutcome(world, nextAlive)
      if (outcome !== 'village_win') {
        return { valid: false, trace: [`夜: 噛み ${biteTarget} → win だが勝利条件未達: ${outcome}`] }
      }
      continue
    }

    const sub = verifyStrategy(branch, world, nextAlive)
    if (!sub.valid) {
      return { valid: false, trace: [`夜: 噛み ${biteTarget}`, ...sub.trace] }
    }
  }

  return { valid: true, trace: ['全噛み先で勝利確認'] }
}

function applyFollowDeaths(alive: number, world: World): number {
  if (world.hamsterSeat !== -1 && !hasSeat(alive, world.hamsterSeat)) {
    if (world.immoralistSeat !== -1 && hasSeat(alive, world.immoralistSeat)) {
      return removeSeat(alive, world.immoralistSeat)
    }
  }
  return alive
}

// --- チェックポイント検出 ---

function findExecutionCheckpoints(howl: string): { line: number, day: number }[] {
  const lines = howl.split('\n')
  const result: { line: number, day: number }[] = []
  let day = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/処刑$/)) {
      day++
      result.push({ line: i + 1, day })
    }
  }
  return result
}

// --- メインパイプライン ---

type GameConfig = {
  name: string
  roles: Record<string, number>
  seeds: [number, number]
  hasFirstGhost?: boolean
  revoteConfig?: import('../lupa/types.ts').RevoteConfig
}

const configs: GameConfig[] = [
  { name: 'small-8p', roles: { werewolf: 1, villager: 4, seer: 1, mason: 2 }, seeds: [0, 500] },
  { name: 'medium-10p', roles: { werewolf: 2, villager: 3, seer: 1, medium: 1, bodyguard: 1, mason: 2 }, seeds: [0, 200] },
  { name: 'mason-8p', roles: { werewolf: 1, villager: 3, seer: 1, medium: 1, mason: 2 }, seeds: [0, 500] },
  { name: 'guard-8p', roles: { werewolf: 1, villager: 3, seer: 1, bodyguard: 1, mason: 2 }, seeds: [0, 500] },
  { name: 'nekomata-8p', roles: { werewolf: 1, villager: 3, seer: 1, nekomata: 1, mason: 2 }, seeds: [0, 300] },
  { name: '14d-neko', roles: { werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1, mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1 }, seeds: [0, 200], hasFirstGhost: true },
]

type Failure = {
  config: string
  seed: number
  day: number
  message: string
  trace: string[]
  howl: string
}

type Args = {
  outdir: string | null
  scenario: string | null
  seeds: [number, number] | null
}

function parseArgs(argv: string[]): Args {
  let outdir: string | null = null
  let scenario: string | null = null
  let seeds: [number, number] | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--outdir' && i + 1 < argv.length) outdir = argv[++i]
    else if (arg === '--scenario' && i + 1 < argv.length) scenario = argv[++i]
    else if (arg === '--seeds' && i + 1 < argv.length) {
      const m = argv[++i].match(/^(\d+)-(\d+)$/)
      if (m) seeds = [parseInt(m[1]), parseInt(m[2])]
    } else if (arg === '--help' || arg === '-h') {
      const names = configs.map(c => c.name).join(', ')
      console.log(`Hati 詰み探索 検証スクリプト

Usage: node --experimental-strip-types src/hati/verify.ts [options]

Options:
  --scenario <name>   指定シナリオのみ実行
  --seeds <from>-<to> seed範囲を指定
  --outdir <dir>      失敗howlファイルの出力先
  --help, -h          このヘルプ

シナリオ: ${names}`)
      process.exit(0)
    }
  }

  return { outdir, scenario, seeds }
}

function runVerify(args: Args): void {
  const selectedConfigs = args.scenario
    ? configs.filter(c => c.name === args.scenario)
    : configs

  if (selectedConfigs.length === 0) {
    console.error(`不明なシナリオ: ${args.scenario}`)
    process.exit(1)
  }

  if (args.outdir) {
    mkdirSync(args.outdir, { recursive: true })
  }

  let totalGames = 0
  let totalCheckpoints = 0
  let totalTsumi = 0
  let totalVerified = 0
  const failures: Failure[] = []
  let maxHatiMs = 0
  let totalHatiMs = 0
  let hatiCount = 0

  for (const cfg of selectedConfigs) {
    const roles = new Map(Object.entries(cfg.roles) as [SystemRole, number][])
    const [seedFrom, seedTo] = args.seeds ?? cfg.seeds
    let gameCount = 0
    let checkpointCount = 0
    let tsumiCount = 0
    let verifiedCount = 0
    let configFailures = 0

    for (let seed = seedFrom; seed < seedTo; seed++) {
      let events: GameEvent[]
      let state: GameState
      try {
        const lupaConfig = {
          roles, seed,
          hasFirstGhost: cfg.hasFirstGhost,
          revoteConfig: cfg.revoteConfig ?? { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const },
        }
        const result = runGame(lupaConfig)
        events = result.events
        state = result.state
      } catch {
        continue
      }
      gameCount++

      const lupaConfigForFormat = {
        roles, seed,
        hasFirstGhost: cfg.hasFirstGhost,
        revoteConfig: cfg.revoteConfig,
      }
      const howl = formatHowl(events, state, lupaConfigForFormat)
      const checkpoints = findExecutionCheckpoints(howl)

      for (const cp of checkpoints) {
        checkpointCount++
        const truncated = howl.split('\n').slice(0, cp.line - 1).join('\n')

        let tsumiResult
        let alive: number
        try {
          const { meta, statements } = parse(truncated)
          const { vs, setup } = buildVillageStatus(statements, meta)
          const opts = cfg.hasFirstGhost ? { ...ANALYZE_OPTIONS, hasFirstGhost: true } : ANALYZE_OPTIONS
          tsumiResult = searchTsumi(vs, setup, opts)
          alive = 0
          for (const [seat, status] of vs.statuses) {
            if (status.surviving) alive |= (1 << seat)
          }
        } catch {
          continue
        }

        totalHatiMs += tsumiResult.stats.searchElapsed
        hatiCount++
        if (tsumiResult.stats.searchElapsed > maxHatiMs) maxHatiMs = tsumiResult.stats.searchElapsed

        if (!tsumiResult.isTsumi || !tsumiResult.strategy) continue
        tsumiCount++

        const trueWorld = buildTrueWorld(state)

        // 戦略検証
        const verification = verifyStrategy(tsumiResult.strategy, trueWorld, alive)
        verifiedCount++

        if (!verification.valid) {
          configFailures++
          const failure: Failure = {
            config: cfg.name,
            seed,
            day: cp.day,
            message: verification.trace[verification.trace.length - 1],
            trace: verification.trace,
            howl: truncated,
          }
          failures.push(failure)

          if (args.outdir) {
            const filename = `${cfg.name}_s${seed}_day${cp.day}.howl`
            const content = truncated + '\n\n'
              + `# [Hati検証失敗]\n`
              + verification.trace.map(t => `# ${t}`).join('\n') + '\n'
            writeFileSync(join(args.outdir, filename), content)
          }
        }
      }
    }

    totalGames += gameCount
    totalCheckpoints += checkpointCount
    totalTsumi += tsumiCount
    totalVerified += verifiedCount

    console.log(`  ${cfg.name}: ${gameCount} games, ${checkpointCount} checkpoints`)
    console.log(`    詰み発見: ${tsumiCount} (${checkpointCount > 0 ? (tsumiCount / checkpointCount * 100).toFixed(1) : 0}%)`)
    console.log(`    戦略検証: ${configFailures === 0 ? '全通過' : `${configFailures}失敗`}`)
  }

  console.log('')
  console.log(`合計: ${totalGames} games, ${totalCheckpoints} checkpoints`)
  console.log(`詰み発見: ${totalTsumi}, 検証済み: ${totalVerified}`)
  if (hatiCount > 0) {
    console.log(`時間: hati avg ${(totalHatiMs / hatiCount).toFixed(1)}ms / max ${maxHatiMs.toFixed(1)}ms`)
  }

  const eg = getEndgameStats()
  console.log(`エンドゲームテーブル: ${eg.size}エントリ, ${eg.hits}ヒット`)

  if (failures.length === 0) {
    console.log('検証結果: 全通過')
  } else {
    console.log(`検証結果: ${failures.length}失敗`)
    for (const f of failures) {
      console.log(`  [${f.config} seed=${f.seed} Day${f.day}] ${f.message}`)
    }
  }
}

function buildTrueWorld(state: GameState): World {
  const maxSeat = Math.max(...state.players.map(p => p.seat))
  const roles: SystemRole[] = new Array(maxSeat + 1)
  let wolfMask = 0
  let hamsterSeat = -1
  let immoralistSeat = -1
  let seerSeat = -1
  let bodyguardSeat = -1
  let nekomataSeat = -1
  let mediumSeat = -1

  for (const p of state.players) {
    roles[p.seat] = p.role
    switch (p.role) {
      case 'werewolf': wolfMask |= (1 << p.seat); break
      case 'werehamster': hamsterSeat = p.seat; break
      case 'immoralist': immoralistSeat = p.seat; break
      case 'seer': seerSeat = p.seat; break
      case 'bodyguard': bodyguardSeat = p.seat; break
      case 'nekomata': nekomataSeat = p.seat; break
      case 'medium': mediumSeat = p.seat; break
    }
  }

  return { roles, wolfMask, hamsterSeat, immoralistSeat, seerSeat, bodyguardSeat, nekomataSeat, mediumSeat }
}

// --- 実行 ---
const args = parseArgs(process.argv.slice(2))
runVerify(args)
