/**
 * Lupa × Retar 検証スクリプト
 *
 * Lupaで生成したゲームをRetarに通し、
 * 真の役職がRetarの可能性集合から除外されていないことを検証する。
 *
 * Retarの前提条件:
 * - 村役職(占い/霊能/狩人/共有/猫又)がCOせずに処刑された場合、その役職を否定する
 * - 誰もCOしていない役職はテスト対象外とする
 * これらの前提に反するチェックポイントはスキップされる（連鎖的な影響があるため）
 *
 * 実行:
 *   node --experimental-strip-types src/lupa/verify.ts
 *   node --experimental-strip-types src/lupa/verify.ts --outdir tmp/verify
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SystemRole } from '../types/index.ts'
import type { LupaConfig, GameEvent, GameState } from './types.ts'
import { runGame } from './engine.ts'
import { formatHowl } from './format.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'

const lupaOptions: AnalyzeOptions = {
  seerClaimingDueDate: 99,
  mediumClaimingDueDate: 99,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 99,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  hasFirstGhost: false,
  assumptions: new Map(),
  hocusPocus: new Map(),
  id: 0,
  batches: 1,
  batch: 0,
}

const VILLAGE_ROLES: SystemRole[] = ['seer', 'medium', 'bodyguard', 'mason', 'nekomata']

type CheckpointType = 'post-execution' | 'post-morning'

type Checkpoint = {
  index: number
  type: CheckpointType
}

function findCheckpoints(events: GameEvent[]): Checkpoint[] {
  const checkpoints: Checkpoint[] = []
  const seen = new Set<number>()

  for (let i = 0; i < events.length; i++) {
    const e = events[i]

    if (e.type === 'execution') {
      let j = i + 1
      if (j < events.length && events[j].type === 'comment') j++
      while (j < events.length && (events[j].type === 'curse_kill' || events[j].type === 'follow_kill')) j++
      if (j < events.length && events[j].type === 'game_over') j++
      if (!seen.has(j)) {
        checkpoints.push({ index: j, type: 'post-execution' })
        seen.add(j)
      }
    }

    if (e.type === 'night_kill' || e.type === 'fox_kill' || e.type === 'peace') {
      let j = i + 1
      while (j < events.length && (
        events[j].type === 'night_kill' ||
        events[j].type === 'fox_kill' ||
        events[j].type === 'curse_kill' ||
        events[j].type === 'follow_kill'
      )) j++
      if (j < events.length && events[j].type === 'game_over') j++
      if (!seen.has(j)) {
        checkpoints.push({ index: j, type: 'post-morning' })
        seen.add(j)
      }
    }
  }

  return checkpoints
}

type FailedCheckpoint = {
  config: string
  seed: number
  checkpoint: Checkpoint
  howl: string
  players: { name: string, message: string }[]
}

type VerifyResult = {
  failure: FailedCheckpoint | null
  skipped: boolean
}

function verifyCheckpoint(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
  checkpoint: Checkpoint,
  configName: string,
  seed: number,
): VerifyResult {
  const partialEvents = events.slice(0, checkpoint.index)
  const partialHowl = formatHowl(partialEvents, state, config)

  // パースチェック
  const { meta, statements } = parse(partialHowl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) {
    const annotatedHowl = partialHowl.trimEnd() + '\n\n'
      + `# パース失敗: ${unknowns.map((s: any) => s.raw).join(', ')}\n`
    return {
      failure: {
        config: configName, seed, checkpoint, howl: annotatedHowl,
        players: [{ name: '(parse)', message: `unknown statements: ${unknowns.map((s: any) => s.raw).join(', ')}` }],
      },
      skipped: false,
    }
  }

  const { vs, setup } = buildVillageStatus(statements, meta)

  // Retarの前提条件チェック
  for (const player of state.players) {
    if (!VILLAGE_ROLES.includes(player.role)) continue
    const seatStatus = vs.statuses.get(player.seat)
    if (!seatStatus) continue
    if (!seatStatus.surviving && seatStatus.causeOfDeath === 'execution' && !seatStatus.claiming) {
      return { failure: null, skipped: true }
    }
  }

  const retar = new VillageRetar(vs, setup, lupaOptions)
  const result = retar.analyze()

  if (result.error) {
    const annotatedHowl = partialHowl.trimEnd() + '\n\n'
      + `# analyze()エラー: ${result.error}\n`
    return {
      failure: {
        config: configName, seed, checkpoint, howl: annotatedHowl,
        players: [{ name: '(analyze)', message: `${result.error}` }],
      },
      skipped: false,
    }
  }

  // 真の役職が可能性に含まれているか検証
  const failedPlayers: { name: string, trueRole: SystemRole, possibilities: Set<SystemRole> | undefined }[] = []

  for (const player of state.players) {
    const possibilities = result.result.get(player.seat)
    if (!possibilities || possibilities.size === 0) {
      failedPlayers.push({ name: player.name, trueRole: player.role, possibilities })
    } else if (!possibilities.has(player.role)) {
      failedPlayers.push({ name: player.name, trueRole: player.role, possibilities })
    }
  }

  if (failedPlayers.length === 0) {
    return { failure: null, skipped: false }
  }

  // アノテーション付きhowlを生成
  const annotationLines: string[] = []
  const playerMessages: { name: string, message: string }[] = []
  for (const p of failedPlayers) {
    annotationLines.push(`# @expect ${p.name}: [${p.trueRole}...]`)
    if (p.possibilities && p.possibilities.size > 0) {
      annotationLines.push(`# 実際: [${[...p.possibilities].join(', ')}]`)
      playerMessages.push({ name: p.name, message: `真の役職 ${p.trueRole} が可能性 [${[...p.possibilities].join(', ')}] に含まれていない` })
    } else {
      annotationLines.push(`# 実際: 空`)
      playerMessages.push({ name: p.name, message: '可能性が空' })
    }
  }
  const annotatedHowl = partialHowl.trimEnd() + '\n\n' + annotationLines.join('\n') + '\n'

  return {
    failure: { config: configName, seed, checkpoint, howl: annotatedHowl, players: playerMessages },
    skipped: false,
  }
}

type GameConfig = {
  name: string
  roles: Record<string, number>
  seeds: [number, number]
}

const configs: GameConfig[] = [
  { name: 'basic-5p', roles: { werewolf: 1, villager: 3, seer: 1 }, seeds: [0, 20] },
  { name: 'standard-10p', roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, bodyguard: 1, possessed: 1 }, seeds: [0, 15] },
  { name: 'mason-10p', roles: { werewolf: 2, villager: 3, seer: 1, medium: 1, mason: 2, possessed: 1 }, seeds: [0, 10] },
  { name: 'nekomata-6p', roles: { werewolf: 1, villager: 3, seer: 1, nekomata: 1 }, seeds: [0, 15] },
  { name: 'hamster-11p', roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, bodyguard: 1, werehamster: 1, possessed: 1 }, seeds: [0, 10] },
  { name: 'full-15p', roles: { werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1, mason: 2, nekomata: 1, possessed: 1, fanatic: 1, werehamster: 1, immoralist: 1 }, seeds: [0, 5] },
]

function parseArgs(): { outdir: string | null } {
  const args = process.argv.slice(2)
  const idx = args.indexOf('--outdir')
  if (idx >= 0 && idx + 1 < args.length) {
    return { outdir: args[idx + 1] }
  }
  return { outdir: null }
}

function main() {
  const { outdir } = parseArgs()
  const allFailures: FailedCheckpoint[] = []
  let totalGames = 0
  let totalCheckpoints = 0
  let totalSkipped = 0

  for (const gc of configs) {
    const lupaConfig: LupaConfig = {
      roles: new Map(Object.entries(gc.roles) as [SystemRole, number][]),
    }
    let configCheckpoints = 0
    let configSkipped = 0

    for (let seed = gc.seeds[0]; seed < gc.seeds[1]; seed++) {
      lupaConfig.seed = seed
      const { events, state } = runGame(lupaConfig)
      totalGames++

      const checkpoints = findCheckpoints(events)
      for (const cp of checkpoints) {
        totalCheckpoints++
        configCheckpoints++
        const { failure, skipped } = verifyCheckpoint(events, state, lupaConfig, cp, gc.name, seed)
        if (failure) allFailures.push(failure)
        if (skipped) {
          configSkipped++
          totalSkipped++
        }
      }
    }

    const skippedStr = configSkipped > 0 ? ` (${configSkipped} skipped)` : ''
    console.log(`  ${gc.name}: ${gc.seeds[1] - gc.seeds[0]} games, ${configCheckpoints} checkpoints${skippedStr}`)
  }

  console.log(`\n合計: ${totalGames} games, ${totalCheckpoints} checkpoints, ${totalSkipped} skipped`)

  const verified = totalCheckpoints - totalSkipped
  if (allFailures.length === 0) {
    console.log(`検証済み ${verified} checkpoints: 全通過`)
    return
  }

  console.error(`\n検証済み ${verified} checkpoints: ${allFailures.length} チェックポイントで失敗`)

  if (outdir) {
    mkdirSync(outdir, { recursive: true })
    const nameCount = new Map<string, number>()
    for (const f of allFailures) {
      const base = `${f.config}_s${f.seed}_${f.checkpoint.type}`
      const count = nameCount.get(base) ?? 0
      nameCount.set(base, count + 1)
      const suffix = count > 0 ? `_${count + 1}` : ''
      const filename = `${base}${suffix}.howl`
      const filepath = join(outdir, filename)
      writeFileSync(filepath, f.howl, 'utf-8')
    }
    console.log(`${allFailures.length} 件の .howl ファイルを ${outdir}/ に出力しました`)
  }

  // コンソールにもサマリー表示
  for (const f of allFailures) {
    const players = f.players.map(p => `${p.name}: ${p.message}`).join(', ')
    console.error(`  [${f.config} seed=${f.seed} ${f.checkpoint.type}] ${players}`)
  }

  process.exit(1)
}

main()
