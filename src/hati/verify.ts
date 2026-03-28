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

import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SystemRole } from '../types/index.ts'
import type { GameEvent, GameState } from '../lupa/types.ts'
import { runGame } from '../lupa/engine.ts'
import { formatHowl } from '../lupa/format.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { searchTsumi } from './index.ts'
import { getEndgameStats, resetEndgameStats } from './search.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { VillageRetar } from '../retar/index.ts'
import { RoleBitIndex, RoleSignatureBits } from '../retar/possibilities.ts'
import { formatStrategy } from './format.ts'
import type { StrategyNode, World } from './types.ts'
import { hasSeat, removeSeat, forEachSeat, popCount32 } from './types.ts'
import {
  checkOutcome, simulateNight, validBiteTargets, getMediumResult,
  executionObsKeyToString, obsKeyToString, applyFollowDeaths,
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

    const beforeFollow = afterExec
    afterExec = applyFollowDeaths(afterExec, world)
    const followDead = beforeFollow & ~afterExec
    const followSuffix = followDead !== 0 ? `+f:${31 - Math.clz32(followDead & (-followDead))}` : ''

    const obsKey = executionObsKeyToString(mediumResult, null) + followSuffix
    const branch = branches[obsKey] ?? branches[executionObsKeyToString(mediumResult, null)] ?? branches['win']
    if (!branch) {
      return { valid: false, trace: [`処刑 ${target} の分岐 '${obsKey}' が存在しない`] }
    }

    const sub = verifyStrategy(branch, world, afterExec)
    return { valid: sub.valid, trace: [`処刑 ${target} → ${obsKey}`, ...sub.trace] }
  }

  // 夜アクション
  const { bodyguardTarget, seerTargets } = action
  const biteTargets = validBiteTargets(world, alive)

  if (biteTargets.length === 0) {
    const key = obsKeyToString(0, seerTargets.length)
    const branch = branches[key] ?? branches['win']
    if (!branch) {
      return { valid: false, trace: [`夜: 狼全滅だが分岐 '${key}' が存在しない`] }
    }
    return verifyStrategy(branch, world, alive)
  }

  for (const biteTarget of biteTargets) {
    const { nextAlive: baseAlive, obsKey: baseKey } = simulateNight(
      world, alive, biteTarget, bodyguardTarget, seerTargets,
    )

    // 猫又噛み: 道連れ狼の全分岐を検証
    const isNekoBite = world.roles[biteTarget] === 'nekomata'
      && hasSeat(alive, biteTarget)
      && (bodyguardTarget !== biteTarget || !hasSeat(alive, world.bodyguardSeat))
    const curseWolfMask = isNekoBite ? (world.wolfMask & baseAlive) : 0

    const variants: { nextAlive: number, numKey: number, label: string }[] = []
    if (curseWolfMask === 0) {
      variants.push({ nextAlive: baseAlive, numKey: baseKey, label: `噛み ${biteTarget}` })
    } else {
      const seerShift = popCount32(world.seerMask) * 2
      let wolfBits = curseWolfMask
      while (wolfBits !== 0) {
        const wolfBit = wolfBits & (-wolfBits)
        wolfBits ^= wolfBit
        const curseWolf = 31 - Math.clz32(wolfBit)
        variants.push({
          nextAlive: removeSeat(baseAlive, curseWolf),
          numKey: baseKey | ((1 << curseWolf) << seerShift),
          label: `噛み ${biteTarget} (猫又) 道連れ狼 ${curseWolf}`,
        })
      }
    }

    for (const { nextAlive, numKey, label } of variants) {
      const key = obsKeyToString(numKey, seerTargets.length)
      const branch = branches[key] ?? branches['win']
      if (!branch) {
        return { valid: false, trace: [`夜: ${label} の分岐 '${key}' が存在しない`] }
      }

      if (branch.type === 'win') {
        const outcome = checkOutcome(world, nextAlive)
        if (outcome !== 'village_win') {
          return { valid: false, trace: [`夜: ${label} → win だが勝利条件未達: ${outcome}`] }
        }
        continue
      }

      const sub = verifyStrategy(branch, world, nextAlive)
      if (!sub.valid) {
        return { valid: false, trace: [`夜: ${label}`, ...sub.trace] }
      }
    }
  }

  return { valid: true, trace: ['全噛み先で勝利確認'] }
}

// --- Retar可能性チェック ---

/**
 * 真の配役がRetarの可能性に含まれているか検証する。
 * 含まれていない席があればそのリストを返す。
 */
function checkRetarInclusion(
  state: GameState,
  possibilities: Uint16Array,
  alive: number,
): { seat: number, trueRole: SystemRole, allowed: string[] }[] {
  const excluded: { seat: number, trueRole: SystemRole, allowed: string[] }[] = []
  for (const p of state.players) {
    if (!hasSeat(alive, p.seat)) continue
    const mask = possibilities[p.seat]
    if (mask === 0) continue
    const roleBit = RoleSignatureBits[p.role]
    if (roleBit === undefined) continue
    if (!(mask & roleBit)) {
      // 真の役職がRetarの可能性に含まれていない
      const allowed: string[] = []
      for (const [role, bit] of Object.entries(RoleSignatureBits)) {
        if (mask & (bit as number)) allowed.push(role)
      }
      excluded.push({ seat: p.seat, trueRole: p.role, allowed })
    }
  }
  return excluded
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
  checkHamsterPruning: boolean
  checkFalseNegative: boolean
  maxAliveForFN: number
  tsumiDb: string | null
  noStrategy: boolean
  fnFromDb: string | null
}

function parseArgs(argv: string[]): Args {
  let outdir: string | null = null
  let scenario: string | null = null
  let seeds: [number, number] | null = null
  let checkHamsterPruning = false
  let checkFalseNegative = false
  let maxAliveForFN = 10
  let tsumiDb: string | null = null
  let noStrategy = false
  let fnFromDb: string | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--outdir' && i + 1 < argv.length) outdir = argv[++i]
    else if (arg === '--scenario' && i + 1 < argv.length) scenario = argv[++i]
    else if (arg === '--seeds' && i + 1 < argv.length) {
      const m = argv[++i].match(/^(\d+)-(\d+)$/)
      if (m) seeds = [parseInt(m[1]), parseInt(m[2])]
    } else if (arg === '--check-hamster-pruning') {
      checkHamsterPruning = true
    } else if (arg === '--check-false-negative') {
      checkFalseNegative = true
    } else if (arg === '--max-alive' && i + 1 < argv.length) {
      maxAliveForFN = parseInt(argv[++i])
    } else if (arg === '--tsumi-db' && i + 1 < argv.length) {
      tsumiDb = argv[++i]
    } else if (arg === '--no-strategy') {
      noStrategy = true
    } else if (arg === '--fn-from-db' && i + 1 < argv.length) {
      fnFromDb = argv[++i]
    } else if (arg === '--help' || arg === '-h') {
      const names = configs.map(c => c.name).join(', ')
      console.log(`Hati 詰み探索 検証スクリプト

Usage: node --experimental-strip-types src/hati/verify.ts [options]

Options:
  --scenario <name>            指定シナリオのみ実行
  --seeds <from>-<to>          seed範囲を指定
  --outdir <dir>               失敗howlファイルの出力先
  --check-hamster-pruning      狐枝刈りの偽陰性チェック
  --check-false-negative       偽陰性チェック（前日CP再探索）
  --max-alive <N>              偽陰性チェック時の生存者上限（デフォルト: 10）
  --tsumi-db <file>            詰みDBをJSONLで出力
  --no-strategy                戦略木構築をスキップ（高速、検証なし）
  --fn-from-db <file>          詰みDBから偽陰性チェック（前日CP再探索）
  --help, -h                   このヘルプ

シナリオ: ${names}`)
      process.exit(0)
    }
  }

  return { outdir, scenario, seeds, checkHamsterPruning, checkFalseNegative, maxAliveForFN, tsumiDb, noStrategy, fnFromDb }
}

function runVerify(args: Args): void {
  const selectedConfigs = args.scenario
    ? configs.filter(c => c.name === args.scenario)
    : configs

  if (selectedConfigs.length === 0) {
    console.error(`不明なシナリオ: ${args.scenario}`)
    process.exit(1)
  }

  if (args.tsumiDb) {
    const dir = args.tsumiDb.replace(/[/\\][^/\\]*$/, '')
    if (dir && dir !== args.tsumiDb) mkdirSync(dir, { recursive: true })
    writeFileSync(args.tsumiDb, '')
  }
  if (args.outdir) {
    mkdirSync(args.outdir, { recursive: true })
  }

  let totalGames = 0
  let totalCheckpoints = 0
  let totalTsumi = 0
  let totalVerified = 0
  const failures: Failure[] = []
  let totalHatiMs = 0
  let hatiCount = 0
  let totalSearchEntered = 0
  let totalSearchTsumi = 0
  let totalPrunedThreat = 0
  let totalPrunedWorlds = 0
  let totalPrunedFox = 0
  let totalFnCandidates = 0
  let totalFnSkipped = 0
  let totalFnFound = 0
  const allTimings: { ms: number, seed: number, day: number, config: string }[] = []

  for (const cfg of selectedConfigs) {
    const roles = new Map(Object.entries(cfg.roles) as [SystemRole, number][])
    const [seedFrom, seedTo] = args.seeds ?? cfg.seeds
    let gameCount = 0
    let checkpointCount = 0
    let tsumiCount = 0
    let verifiedCount = 0
    let configFailures = 0
    let retarExclusions = 0
    let falseNegatives = 0
    let searchEntered = 0
    let searchTsumiFound = 0
    let prunedByThreat = 0
    let prunedByWorlds = 0
    let prunedByFox = 0
    let maxAlive = 0
    let maxAliveSeed = -1
    let maxAliveDay = -1
    let fnCandidates = 0
    let fnSkipped = 0
    let fnFound = 0

    for (let seed = seedFrom; seed < seedTo; seed++) {
      resetEndgameStats()
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

      let prevCp: { truncated: string, day: number, aliveCount: number, wasTsumi: boolean } | null = null

      for (const cp of checkpoints) {
        checkpointCount++
        const truncated = howl.split('\n').slice(0, cp.line - 1).join('\n')

        let tsumiResult
        let alive: number
        const cpStart = performance.now()
        try {
          const { meta, statements } = parse(truncated)
          const { vs, setup } = buildVillageStatus(statements, meta)
          const opts = cfg.hasFirstGhost ? { ...ANALYZE_OPTIONS, hasFirstGhost: true } : ANALYZE_OPTIONS
          const searchOpts = args.noStrategy ? { maxDepth: 5, buildStrategy: false as const } : undefined
          tsumiResult = searchTsumi(vs, setup, opts, searchOpts)
          alive = 0
          for (const [seat, status] of vs.statuses) {
            if (status.surviving) alive |= (1 << seat)
          }
        } catch {
          prevCp = null
          continue
        }

        totalHatiMs += tsumiResult.stats.searchElapsed
        hatiCount++
        allTimings.push({ ms: tsumiResult.stats.searchElapsed, seed, day: cp.day, config: cfg.name })

        // 探索段階の分類
        if (tsumiResult.stats.worldsTotal === 0 && tsumiResult.stats.enumerateElapsed === 0) {
          prunedByThreat++
        } else if (tsumiResult.stats.worldsTotal === 0) {
          prunedByWorlds++
        } else if (tsumiResult.stats.nodesVisited === 0) {
          prunedByFox++
        } else {
          searchEntered++
          if (tsumiResult.isTsumi) searchTsumiFound++
          else {
            const ac = popCount32(alive)
            console.log(`    [探索突入・詰みなし] seed=${seed} Day${cp.day} alive=${ac} worlds=${tsumiResult.stats.worldsTotal} nodes=${tsumiResult.stats.nodesVisited} maxDepth=${tsumiResult.stats.maxDepth} search=${tsumiResult.stats.searchElapsed.toFixed(1)}ms`)
          }
        }

        const currentAliveCount = popCount32(alive)

        // 偽陰性チェック: 前日CPで詰みなし → 今日詰み → 前日を深い探索で再検証
        if (args.checkFalseNegative && tsumiResult.isTsumi
          && prevCp !== null && !prevCp.wasTsumi) {
          fnCandidates++
          if (prevCp.aliveCount > args.maxAliveForFN) {
            fnSkipped++
          } else {
            try {
              const { meta, statements } = parse(prevCp.truncated)
              const { vs, setup } = buildVillageStatus(statements, meta)
              const opts = cfg.hasFirstGhost ? { ...ANALYZE_OPTIONS, hasFirstGhost: true } : ANALYZE_OPTIONS
              const deepResult = searchTsumi(vs, setup, opts, { maxDepth: prevCp.aliveCount })
              if (deepResult.isTsumi) {
                fnFound++
                console.log(`    [偽陰性発見] seed=${seed} Day${prevCp.day} alive=${prevCp.aliveCount} worlds=${deepResult.stats.worldsTotal} nodes=${deepResult.stats.nodesVisited} search=${deepResult.stats.searchElapsed.toFixed(1)}ms`)
                const failure: Failure = {
                  config: cfg.name,
                  seed,
                  day: prevCp.day,
                  message: `偽陰性: Day${prevCp.day}(${prevCp.aliveCount}人)で詰みあり、通常探索(maxDepth=5)では見逃し`,
                  trace: [
                    `通常探索(maxDepth=5): 詰みなし`,
                    `深い探索(maxDepth=${prevCp.aliveCount}): 詰みあり (worlds=${deepResult.stats.worldsTotal}, nodes=${deepResult.stats.nodesVisited}, ${deepResult.stats.searchElapsed.toFixed(1)}ms)`,
                    `翌日Day${cp.day}(${currentAliveCount}人)では通常探索で詰み発見済み`,
                  ],
                  howl: prevCp.truncated,
                }
                failures.push(failure)
                if (args.outdir) {
                  const filename = `${cfg.name}_s${seed}_day${prevCp.day}_fn.howl`
                  const content = prevCp.truncated + '\n\n'
                    + `# [偽陰性: 通常探索で詰み見逃し]\n`
                    + `# 通常探索(maxDepth=5): 詰みなし\n`
                    + `# 深い探索(maxDepth=${prevCp.aliveCount}): 詰みあり\n`
                    + `# worlds=${deepResult.stats.worldsTotal}, nodes=${deepResult.stats.nodesVisited}, ${deepResult.stats.searchElapsed.toFixed(1)}ms\n`
                    + `# 翌日Day${cp.day}(${currentAliveCount}人)では通常探索で詰み発見\n`
                  writeFileSync(join(args.outdir, filename), content)
                }
              }
            } catch {
              // parse/build失敗は無視
            }
          }
        }

        if (!tsumiResult.isTsumi) {
          // 偽陰性チェック: 枝刈りなしで再探索し、詰みが見つかるか確認
          if (args.checkHamsterPruning && (cfg.roles.werehamster || cfg.roles.nekomata)) {
            try {
              const { meta, statements } = parse(truncated)
              const { vs, setup } = buildVillageStatus(statements, meta)
              const opts = cfg.hasFirstGhost ? { ...ANALYZE_OPTIONS, hasFirstGhost: true } : ANALYZE_OPTIONS
              const noPruneResult = searchTsumi(vs, setup, opts, { maxDepth: 5, disableHamsterPruning: true })
              if (noPruneResult.isTsumi) {
                falseNegatives++
                const failure: Failure = {
                  config: cfg.name,
                  seed,
                  day: cp.day,
                  message: `偽陰性: 狐枝刈りで詰みを見逃し (worlds=${noPruneResult.stats.worldsTotal})`,
                  trace: [`枝刈りあり: 詰みなし`, `枝刈りなし: 詰みあり (worlds=${noPruneResult.stats.worldsTotal}, ${noPruneResult.stats.searchElapsed.toFixed(1)}ms)`],
                  howl: truncated,
                }
                failures.push(failure)
                if (args.outdir) {
                  const filename = `${cfg.name}_s${seed}_day${cp.day}_false_negative.howl`
                  const content = truncated + '\n\n'
                    + `# [偽陰性: 狐枝刈りで詰みを見逃し]\n`
                    + `# 枝刈りなし: worlds=${noPruneResult.stats.worldsTotal}, ${noPruneResult.stats.searchElapsed.toFixed(1)}ms\n`
                  writeFileSync(join(args.outdir, filename), content)
                }
              }
            } catch {
              // parse/build失敗は無視（上でも同様）
            }
          }
          prevCp = { truncated, day: cp.day, aliveCount: currentAliveCount, wasTsumi: false }
          continue
        }
        tsumiCount++

        if (args.tsumiDb) {
          const cpElapsed = performance.now() - cpStart
          appendFileSync(args.tsumiDb, JSON.stringify({
            scenario: cfg.name, seed, day: cp.day,
            alive: currentAliveCount,
            worlds: tsumiResult.stats.worldsTotal,
            nodes: tsumiResult.stats.nodesVisited,
            searchMs: +tsumiResult.stats.searchElapsed.toFixed(1),
            elapsedMs: +cpElapsed.toFixed(1),
          }) + '\n')
        }

        const aliveCount = currentAliveCount
        if (aliveCount > maxAlive) {
          maxAlive = aliveCount
          maxAliveSeed = seed
          maxAliveDay = cp.day
        }

        // --no-strategy: 戦略木がないので検証スキップ
        if (!tsumiResult.strategy) {
          prevCp = { truncated, day: cp.day, aliveCount: currentAliveCount, wasTsumi: true }
          continue
        }

        const trueWorld = buildTrueWorld(state)

        // 戦略検証
        const verification = verifyStrategy(tsumiResult.strategy, trueWorld, alive)
        verifiedCount++

        if (!verification.valid) {
          // Retar排除チェック: 真の配役がRetarの可能性に含まれているか
          let retarExcluded: { seat: number, trueRole: SystemRole, allowed: string[] }[] = []
          try {
            const { meta, statements } = parse(truncated)
            const { vs, setup } = buildVillageStatus(statements, meta)
            const opts = cfg.hasFirstGhost ? { ...ANALYZE_OPTIONS, hasFirstGhost: true } : ANALYZE_OPTIONS
            const retar = new VillageRetar(vs, setup, opts)
            retar.analyze()
            retarExcluded = checkRetarInclusion(state, retar.conclusions.possibilities, alive)
          } catch { /* ignore */ }

          const isRetarBug = retarExcluded.length > 0
          if (isRetarBug) retarExclusions++
          else configFailures++

          const label = isRetarBug ? 'Retar排除' : 'Hati検証失敗'
          const retarLines = retarExcluded.map(e =>
            `# Retar排除: seat${e.seat} 真=${e.trueRole} 許可=${e.allowed.join(',')}`
          )
          const failure: Failure = {
            config: cfg.name,
            seed,
            day: cp.day,
            message: isRetarBug
              ? `Retar排除: ${retarExcluded.map(e => `seat${e.seat}(${e.trueRole})`).join(', ')}`
              : verification.trace[verification.trace.length - 1],
            trace: isRetarBug ? [...retarLines.map(l => l.slice(2)), ...verification.trace] : verification.trace,
            howl: truncated,
          }
          failures.push(failure)

          if (args.outdir) {
            const filename = `${cfg.name}_s${seed}_day${cp.day}.howl`
            const trueRoles = state.players.map(p => `${p.seat}=${p.role}`).join(', ')
            const content = truncated + '\n\n'
              + `# [${label}]\n`
              + verification.trace.map(t => `# ${t}`).join('\n') + '\n'
              + (retarLines.length > 0 ? retarLines.join('\n') + '\n' : '')
              + `# 真の配役: ${trueRoles}\n`
              + `# worlds=${tsumiResult.stats.worldsTotal}\n\n`
              + formatStrategy(tsumiResult.strategy!) + '\n'
            writeFileSync(join(args.outdir, filename), content)
          }
        }
        prevCp = { truncated, day: cp.day, aliveCount: currentAliveCount, wasTsumi: true }
      }
    }

    totalGames += gameCount
    totalCheckpoints += checkpointCount
    totalTsumi += tsumiCount
    totalVerified += verifiedCount
    totalSearchEntered += searchEntered
    totalSearchTsumi += searchTsumiFound
    totalPrunedThreat += prunedByThreat
    totalPrunedWorlds += prunedByWorlds
    totalPrunedFox += prunedByFox
    totalFnCandidates += fnCandidates
    totalFnSkipped += fnSkipped
    totalFnFound += fnFound

    console.log(`  ${cfg.name}: ${gameCount} games, ${checkpointCount} checkpoints`)
    console.log(`    詰み発見: ${tsumiCount} (${checkpointCount > 0 ? (tsumiCount / checkpointCount * 100).toFixed(1) : 0}%)`)
    if (tsumiCount > 0) {
      console.log(`    最長詰み: ${maxAlive}人生存 (seed=${maxAliveSeed} Day${maxAliveDay})`)
    }
    console.log(`    枝刈り: 脅威数=${prunedByThreat}, ワールド0=${prunedByWorlds}, 狐=${prunedByFox}`)
    console.log(`    探索突入: ${searchEntered}/${checkpointCount} → 詰み=${searchTsumiFound}, なし=${searchEntered - searchTsumiFound} (詰み率${searchEntered > 0 ? (searchTsumiFound / searchEntered * 100).toFixed(1) : '-'}%)`)
    console.log(`    戦略検証: ${configFailures === 0 && retarExclusions === 0 ? '全通過' : `Hati=${configFailures}失敗, Retar排除=${retarExclusions}`}`)
    if (args.checkHamsterPruning && (cfg.roles.werehamster || cfg.roles.nekomata)) {
      console.log(`    枝刈り偽陰性: ${falseNegatives === 0 ? 'なし' : `${falseNegatives}件`}`)
    }
    if (args.checkFalseNegative) {
      console.log(`    偽陰性チェック: 候補=${fnCandidates}, スキップ=${fnSkipped}, 発見=${fnFound}`)
    }
  }

  console.log('')
  console.log(`合計: ${totalGames} games, ${totalCheckpoints} checkpoints`)
  console.log(`詰み発見: ${totalTsumi}, 検証済み: ${totalVerified}`)
  console.log(`枝刈り合計: 脅威数=${totalPrunedThreat}, ワールド0=${totalPrunedWorlds}, 狐=${totalPrunedFox}`)
  const searchNoTsumi = totalSearchEntered - totalSearchTsumi
  console.log(`探索突入合計: ${totalSearchEntered}/${totalCheckpoints} → 詰み=${totalSearchTsumi}, なし=${searchNoTsumi} (詰み率${totalSearchEntered > 0 ? (totalSearchTsumi / totalSearchEntered * 100).toFixed(1) : '-'}%)`)
  if (allTimings.length > 0) {
    allTimings.sort((a, b) => a.ms - b.ms)
    const pct = (p: number) => {
      const idx = Math.min(Math.ceil(allTimings.length * p / 100) - 1, allTimings.length - 1)
      return allTimings[idx]
    }
    const fmt = (t: { ms: number, seed: number, day: number, config: string }) =>
      `${t.ms.toFixed(1)}ms (${t.config} seed=${t.seed} Day${t.day})`
    console.log(`時間: avg ${(totalHatiMs / hatiCount).toFixed(1)}ms`)
    console.log(`  p90: ${fmt(pct(90))}`)
    console.log(`  p95: ${fmt(pct(95))}`)
    console.log(`  p99: ${fmt(pct(99))}`)
    console.log(`  worst 10:`)
    for (const t of allTimings.slice(-10).reverse()) {
      console.log(`    ${fmt(t)}`)
    }
  }

  const eg = getEndgameStats()
  console.log(`エンドゲームテーブル: ${eg.size}エントリ, ${eg.hits}ヒット`)
  if (args.checkFalseNegative) {
    console.log(`偽陰性チェック合計: 候補=${totalFnCandidates}, スキップ=${totalFnSkipped}, 発見=${totalFnFound}`)
  }

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
  const roleIds = new Uint8Array(maxSeat + 1)
  let wolfMask = 0
  let hamsterMask = 0
  let immoralistMask = 0
  let seerMask = 0
  let bodyguardSeat = -1

  for (const p of state.players) {
    roles[p.seat] = p.role
    roleIds[p.seat] = RoleBitIndex[p.role]
    switch (p.role) {
      case 'werewolf': wolfMask |= (1 << p.seat); break
      case 'werehamster': hamsterMask |= (1 << p.seat); break
      case 'immoralist': immoralistMask |= (1 << p.seat); break
      case 'seer': seerMask |= (1 << p.seat); break
      case 'bodyguard': bodyguardSeat = p.seat; break
    }
  }

  return { roles, roleIds, wolfMask, hamsterMask, immoralistMask, seerMask, bodyguardSeat }
}

// --- 偽陰性チェック（DBベース） ---

type TsumiDbEntry = {
  scenario: string
  seed: number
  day: number
  alive: number
}

function runFalseNegativeFromDb(args: Args): void {
  const dbFile = args.fnFromDb!
  const lines = readFileSync(dbFile, 'utf-8').split('\n').filter(l => l.trim())
  const entries: TsumiDbEntry[] = lines.map(l => JSON.parse(l))

  // (scenario, seed) ごとに最小dayを取得 → day-1 が偽陰性チェック対象
  const earliestByKey = new Map<string, TsumiDbEntry>()
  for (const e of entries) {
    const key = `${e.scenario}:${e.seed}`
    const prev = earliestByKey.get(key)
    if (!prev || e.day < prev.day) earliestByKey.set(key, e)
  }

  // day=1 の詰みは前日がないのでスキップ。max-alive でフィルタ
  const candidates: TsumiDbEntry[] = []
  let skippedDay1 = 0
  let skippedAlive = 0
  for (const e of earliestByKey.values()) {
    if (e.day <= 1) { skippedDay1++; continue }
    // day-1 の alive は day の alive + 1 (処刑で1人減る、前日は1人多い) + 夜の死者
    // 正確な値は不明なので e.alive + 2 で概算（処刑+噛みで2人減）
    const estimatedPrevAlive = e.alive + 2
    if (estimatedPrevAlive > args.maxAliveForFN) { skippedAlive++; continue }
    candidates.push(e)
  }

  console.log(`偽陰性チェック (DBベース)`)
  console.log(`  DB読込: ${entries.length}エントリ → ${earliestByKey.size} seeds`)
  console.log(`  候補: ${candidates.length} (Day1スキップ=${skippedDay1}, alive超過スキップ=${skippedAlive})`)
  console.log()

  const configMap = new Map(configs.map(c => [c.name, c]))
  let found = 0
  let checked = 0

  // シナリオごとにグループ化して処理
  const byScenario = new Map<string, TsumiDbEntry[]>()
  for (const e of candidates) {
    if (!byScenario.has(e.scenario)) byScenario.set(e.scenario, [])
    byScenario.get(e.scenario)!.push(e)
  }

  const totalCandidates = candidates.length
  let globalIdx = 0
  const globalStart = performance.now()

  for (const [scenarioName, scenarioEntries] of byScenario) {
    const cfg = configMap.get(scenarioName)
    if (!cfg) { console.error(`  不明なシナリオ: ${scenarioName}`); continue }

    const roles = new Map(Object.entries(cfg.roles) as [SystemRole, number][])
    let scenarioFound = 0
    let scenarioIdx = 0

    for (const entry of scenarioEntries) {
      scenarioIdx++
      globalIdx++
      if (scenarioIdx % 100 === 0 || scenarioIdx === scenarioEntries.length) {
        const elapsed = ((performance.now() - globalStart) / 1000).toFixed(0)
        process.stdout.write(`\r  [${scenarioName}] ${scenarioIdx}/${scenarioEntries.length}  (全体 ${globalIdx}/${totalCandidates}  ${elapsed}s  FN=${found})`)
      }
      // ゲームを再生
      let howl: string
      try {
        const lupaConfig = {
          roles, seed: entry.seed,
          hasFirstGhost: cfg.hasFirstGhost,
          revoteConfig: cfg.revoteConfig ?? { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const },
        }
        const result = runGame(lupaConfig)
        const lupaConfigForFormat = {
          roles, seed: entry.seed,
          hasFirstGhost: cfg.hasFirstGhost,
          revoteConfig: cfg.revoteConfig,
        }
        howl = formatHowl(result.events, result.state, lupaConfigForFormat)
      } catch { continue }

      const checkpoints = findExecutionCheckpoints(howl)
      // entry.day の1つ前のCPを見つける
      const prevCpIdx = checkpoints.findIndex(cp => cp.day === entry.day) - 1
      if (prevCpIdx < 0) continue
      const prevCp = checkpoints[prevCpIdx]

      const truncated = howl.split('\n').slice(0, prevCp.line - 1).join('\n')

      try {
        const { meta, statements } = parse(truncated)
        const { vs, setup } = buildVillageStatus(statements, meta)
        const opts = cfg.hasFirstGhost ? { ...ANALYZE_OPTIONS, hasFirstGhost: true } : ANALYZE_OPTIONS

        let alive = 0
        for (const [seat, status] of vs.statuses) {
          if (status.surviving) alive |= (1 << seat)
        }
        const aliveCount = popCount32(alive)

        if (aliveCount > args.maxAliveForFN) { skippedAlive++; continue }

        checked++
        const deepResult = searchTsumi(vs, setup, opts, { maxDepth: aliveCount, buildStrategy: false })

        if (deepResult.isTsumi) {
          found++
          scenarioFound++
          console.log(`  [偽陰性] ${scenarioName} seed=${entry.seed} Day${prevCp.day} alive=${aliveCount} worlds=${deepResult.stats.worldsTotal} nodes=${deepResult.stats.nodesVisited} search=${deepResult.stats.searchElapsed.toFixed(1)}ms`)
          console.log(`    → Day${entry.day}(${entry.alive}人)で通常探索は詰み発見済み`)

          if (args.outdir) {
            const filename = `${scenarioName}_s${entry.seed}_day${prevCp.day}_fn.howl`
            const content = truncated + '\n\n'
              + `# [偽陰性: 通常探索で詰み見逃し]\n`
              + `# Day${prevCp.day}(${aliveCount}人): 深い探索(maxDepth=${aliveCount})で詰みあり\n`
              + `# worlds=${deepResult.stats.worldsTotal}, nodes=${deepResult.stats.nodesVisited}, ${deepResult.stats.searchElapsed.toFixed(1)}ms\n`
              + `# Day${entry.day}(${entry.alive}人): 通常探索で詰み発見\n`
            writeFileSync(join(args.outdir, filename), content)
          }
        }
      } catch { continue }
    }

    process.stdout.write('\n')
    console.log(`  ${scenarioName}: ${scenarioEntries.length}候補 → チェック済み, 偽陰性=${scenarioFound}`)
  }

  console.log()
  console.log(`結果: ${checked}件チェック, 偽陰性=${found}件`)
}

// --- 実行 ---
const args = parseArgs(process.argv.slice(2))
if (args.fnFromDb) {
  runFalseNegativeFromDb(args)
} else {
  runVerify(args)
}
