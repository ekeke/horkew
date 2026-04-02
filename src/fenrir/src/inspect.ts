#!/usr/bin/env node
/**
 * 学習内容の可視化: ゲームをサンプリングして observation, 展開, 報酬を JSON 出力
 *
 * Usage:
 *   node --experimental-strip-types src/fenrir/src/inspect.ts --seed 42 --count 3 --transformer --strategy-only
 *   node --experimental-strip-types src/fenrir/src/inspect.ts --mldir ./tmp/orch-test5 --seed 42 --transformer --strategy-only
 */

import type { SystemRole } from '../../types/index.ts'
import type { LupaConfig } from '../../lupa/types.ts'
import type { Strategy } from './strategy.ts'
import { runGame } from '../../lupa/engine.ts'
import { fullAdapter } from './lupaAdapters/full-adapter.ts'
import { minimalAdapter } from './lupaAdapters/minimal-adapter.ts'
import { formatHowl } from '../../lupa/format.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from '../../lupa/heuristic.ts'
import {
  createNetwork, createWolfTeamNetwork, createMasonTeamNetwork,
  createTransformerNetwork, createWolfTeamTransformerNetwork, createMasonTeamTransformerNetwork,
  DEFAULT_TRAINING_CONFIG,
} from './training.ts'
import { loadCheckpoint } from './ml/checkpoint.ts'
import { FenrirStrategy, WolfTeamStrategy, MasonTeamStrategy } from './policy.ts'
import type { AnyNetwork } from './ml/nn.ts'
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { decodeObservation } from './decode-observation.ts'
import { parsePlanIndices, PLAN_VOCAB } from './rule-action.ts'
import { CO_ROLES } from './observation.ts'

// ============================================================
// Model Group Definitions (play.ts と同じ)
// ============================================================

const MODEL_GROUPS: Record<string, { roles: SystemRole[], teamType?: 'wolf_team' | 'mason_team' }> = {
  mason:      { roles: ['mason'], teamType: 'mason_team' },
  village:    { roles: ['villager', 'seer', 'medium', 'bodyguard', 'nekomata'] },
  werewolf:   { roles: ['werewolf'], teamType: 'wolf_team' },
  fanatic:    { roles: ['fanatic'] },
  hamster:    { roles: ['werehamster'] },
  immoralist: { roles: ['immoralist'] },
}

const ROLE_TO_GROUP = new Map<SystemRole, string>()
for (const [name, def] of Object.entries(MODEL_GROUPS)) {
  for (const role of def.roles) ROLE_TO_GROUP.set(role, name)
}

// ============================================================
// CLI
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2)
  let checkpoint: string | undefined
  let mldir: string | undefined
  let seed = 42
  let count = 1
  let outdir = 'demo/public/inspect'
  let allMl = false
  let defaultModel: 'ml' | 'heuristic' = 'ml'
  let transformer = false
  let strategyOnly = false
  const modelOverrides = new Map<string, 'ml' | 'heuristic'>()

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--checkpoint': checkpoint = args[++i]; break
      case '--mldir': mldir = args[++i]; break
      case '--seed': seed = parseInt(args[++i]); break
      case '--count': count = parseInt(args[++i]); break
      case '--outdir': outdir = args[++i]; break
      case '--all-ml': allMl = true; break
      case '--default-model': defaultModel = args[++i] as 'ml' | 'heuristic'; break
      case '--model': {
        const val = args[++i]
        const [role, model] = val.split('=')
        modelOverrides.set(role, model as 'ml' | 'heuristic')
        break
      }
      case '--transformer': transformer = true; break
      case '--strategy-only': strategyOnly = true; break
    }
  }
  return { checkpoint, mldir, seed, count, outdir, allMl, defaultModel, modelOverrides, transformer, strategyOnly }
}

// ============================================================
// Checkpoint discovery (play.ts と同じ)
// ============================================================

function findBestCheckpoint(dir: string): string | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
  if (files.includes('final.json')) return `${dir}/final.json`
  let maxIter = 0
  for (const f of files) {
    const m = f.match(/^checkpoint_(\d+)\.json$/)
    if (m) { const n = parseInt(m[1]); if (n > maxIter) maxIter = n }
  }
  if (maxIter === 0) return null
  return `${dir}/checkpoint_${maxIter}.json`
}

function findTeamCheckpoint(dir: string, teamType: 'wolf_team' | 'mason_team'): string | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
  const finalName = `${teamType}_final.json`
  if (files.includes(finalName)) return `${dir}/${finalName}`
  let maxIter = 0
  for (const f of files) {
    const m = f.match(new RegExp(`^${teamType}_(\\d+)\\.json$`))
    if (m) { const n = parseInt(m[1]); if (n > maxIter) maxIter = n }
  }
  if (maxIter === 0) return null
  return `${dir}/${teamType}_${maxIter}.json`
}

// ============================================================
// Plan token → human-readable description
// ============================================================

function describePlanIndex(idx: number): string {
  if (idx >= PLAN_VOCAB.SEAT_START && idx < PLAN_VOCAB.SEAT_END) return `seat${idx + 1}`
  if (idx >= PLAN_VOCAB.ROLE_START && idx < PLAN_VOCAB.ROLE_END) return CO_ROLES[idx - PLAN_VOCAB.ROLE_START]
  if (idx === PLAN_VOCAB.GRAYRAN) return 'grayran'
  if (idx === PLAN_VOCAB.NEXT) return 'NEXT'
  if (idx === PLAN_VOCAB.STOP) return 'STOP'
  return `?${idx}`
}

function describePlanIndices(indices: number[]): string {
  return indices.map(describePlanIndex).join(' ')
}

// ============================================================
// Action description
// ============================================================

function describeAction(actionHead: string, actionIdx: number): string {
  switch (actionHead) {
    case 'vote': return `vote → seat${actionIdx + 1}`
    case 'night': return actionIdx < 14 ? `night → seat${actionIdx + 1}` : 'night → skip'
    case 'claim': return `claim: ${actionIdx}`
    case 'comm': return `comm: ${actionIdx}`
    case 'leader': return `leader: ${actionIdx}`
    case 'target': return `target → seat${actionIdx + 1}`
    case 'strategy': return 'strategy (plan tokens)'
    default: return `${actionHead}: ${actionIdx}`
  }
}

// ============================================================
// Main
// ============================================================

const config = parseArgs()
const { checkpoint, mldir, seed, count, outdir, allMl, defaultModel, modelOverrides, transformer, strategyOnly } = config

// 出力ディレクトリ作成
mkdirSync(outdir, { recursive: true })

const rolesConfig = DEFAULT_TRAINING_CONFIG.roles
const roles = new Map(Object.entries(rolesConfig) as [SystemRole, number][])
const heuristic = new HeuristicStrategy()

// ネットワーク構築
const makeNet = (): AnyNetwork => transformer ? createTransformerNetwork() : createNetwork()
const makeWolfTeam = (): AnyNetwork => transformer ? createWolfTeamTransformerNetwork() : createWolfTeamNetwork()
const makeMasonTeam = (): AnyNetwork => transformer ? createMasonTeamTransformerNetwork() : createMasonTeamNetwork()

const groupNets = new Map<string, AnyNetwork>()
const wolfTeamNet = makeWolfTeam()
const masonTeamNet = makeMasonTeam()

// チェックポイント読み込み
if (mldir) {
  for (const [name, def] of Object.entries(MODEL_GROUPS)) {
    const dir = `${mldir}/ckpt-${name}`
    const ckptPath = findBestCheckpoint(dir)
    if (ckptPath) {
      try {
        const net = makeNet()
        loadCheckpoint(net, ckptPath)
        groupNets.set(name, net)
        const raw = JSON.parse(readFileSync(ckptPath, 'utf-8'))
        console.error(`# ${name}: loaded (iter ${raw.metadata?.iteration ?? '?'})`)
        if (def.teamType) {
          const teamPath = findTeamCheckpoint(dir, def.teamType)
          if (teamPath) {
            if (def.teamType === 'wolf_team') loadCheckpoint(wolfTeamNet, teamPath)
            else loadCheckpoint(masonTeamNet, teamPath)
            console.error(`#   ${def.teamType}: loaded`)
          }
        }
      } catch (e) {
        console.error(`# ${name}: checkpoint incompatible, skipping (${(e as Error).message})`)
      }
    } else {
      console.error(`# ${name}: no checkpoint → heuristic`)
    }
  }
} else if (checkpoint) {
  const net = makeNet()
  loadCheckpoint(net, checkpoint)
  groupNets.set('village', net)
  const raw = JSON.parse(readFileSync(checkpoint, 'utf-8'))
  console.error(`# Loaded checkpoint: iteration ${raw.metadata?.iteration ?? '?'}`)
} else {
  console.error('# No checkpoint — using untrained network')
}

// ============================================================
// ゲーム実行ループ
// ============================================================

const results: Array<{ seed: number, result: string, file: string }> = []

for (let g = 0; g < count; g++) {
  const gameSeed = seed + g

  // Strategy 構築（ゲームごとに新規作成して trajectory をリセット）
  const strategiesMap = new Map<number, Strategy>()
  const fenrirStrategies = new Map<number, FenrirStrategy>()

  let wolfTeamStrategy: WolfTeamStrategy | WolfTeamHeuristic
  let masonTeamStrategy: MasonTeamStrategy | MasonTeamHeuristic

  const onRolesAssigned = (seatRoles: Map<number, SystemRole>) => {
    for (const [seat, role] of seatRoles) {
      const override = modelOverrides.get(role)
      const useModel = override ?? defaultModel

      if (useModel === 'heuristic' && !allMl) {
        strategiesMap.set(seat, heuristic)
        continue
      }

      const groupName = ROLE_TO_GROUP.get(role)
      const net = groupName ? groupNets.get(groupName) : undefined
      if (net) {
        const strat = new FenrirStrategy(net, { explore: false, strategyOnly })
        strategiesMap.set(seat, strat)
        fenrirStrategies.set(seat, strat)
      } else {
        // 未学習 NN でもトラジェクトリを取りたい場合
        const fallbackNet = makeNet()
        const strat = new FenrirStrategy(fallbackNet, { explore: false, strategyOnly })
        strategiesMap.set(seat, strat)
        fenrirStrategies.set(seat, strat)
      }
    }
  }

  // チーム戦略
  const wolfOverride = modelOverrides.get('werewolf')
  const useWolfMl = wolfOverride ? wolfOverride === 'ml' : defaultModel === 'ml'
  wolfTeamStrategy = useWolfMl && groupNets.has('werewolf')
    ? new WolfTeamStrategy(wolfTeamNet, { explore: false })
    : new WolfTeamHeuristic()

  const masonOverride = modelOverrides.get('mason')
  const useMasonMl = masonOverride ? masonOverride === 'ml' : defaultModel === 'ml'
  masonTeamStrategy = useMasonMl && groupNets.has('mason')
    ? new MasonTeamStrategy(masonTeamNet, { explore: false })
    : new MasonTeamHeuristic()

  const handlers = strategyOnly
    ? minimalAdapter({
        strategies: strategiesMap,
        defaultStrategy: heuristic,
        wolfTeamStrategy,
        masonTeamStrategy,
        onRolesAssigned,
        seed: gameSeed,
        enableRetar: true,
        roles,
        rules: DEFAULT_TRAINING_CONFIG.rules,
      })
    : fullAdapter({
        strategies: strategiesMap,
        defaultStrategy: heuristic,
        wolfTeamStrategy,
        masonTeamStrategy,
        enableRetar: true,
        onRolesAssigned,
        seed: gameSeed,
        roles,
        rules: DEFAULT_TRAINING_CONFIG.rules,
      })

  const { events, state, config: gameConfig } = await runGame(
    {
      roles,
      seed: gameSeed,
      hasFirstGhost: DEFAULT_TRAINING_CONFIG.hasFirstGhost,
      revoteConfig: DEFAULT_TRAINING_CONFIG.revoteConfig,
      rules: DEFAULT_TRAINING_CONFIG.rules,
      nameStyle: 'seat' as const,
    },
    handlers,
  )

  // Howl テキスト
  const howl = formatHowl(events as import('../../lupa/types.ts').GameEvent[], state, gameConfig as unknown as LupaConfig)

  // ゲーム結果
  const gameOverEvent = events.find(e => e.type === 'game_over')
  const result = gameOverEvent && 'result' in gameOverEvent ? String(gameOverEvent.result) : 'unknown'

  // プレイヤー情報
  const players: Array<{ seat: number, role: string, alive: boolean }> = []
  for (const player of state.players) {
    players.push({ seat: player.seat, role: player.role, alive: player.alive })
  }
  players.sort((a, b) => a.seat - b.seat)

  // タイムライン: 全 FenrirStrategy からトラジェクトリを収集
  const timeline: Array<Record<string, unknown>> = []
  for (const [seat, strat] of fenrirStrategies) {
    const role = players.find(p => p.seat === seat)?.role ?? 'unknown'
    for (const step of strat.trajectory) {
      const decoded = decodeObservation(step.observation)
      const entry: Record<string, unknown> = {
        seat,
        role,
        day: decoded.global.day,
        phase: decoded.global.phase,
        actionHead: step.actionHead,
        actionDescription: describeAction(step.actionHead, step.actionIdx),
        actionIdx: step.actionIdx,
        logProb: step.logProb,
        reward: step.reward,
        value: step.value,
        done: step.done,
        observation: decoded,
      }

      // Plan tokens
      if (step.planForwardActions) {
        const groups = parsePlanIndices(step.planForwardActions)
        entry.planForward = {
          indices: step.planForwardActions,
          description: describePlanIndices(step.planForwardActions),
          groups,
        }
      }
      if (step.planEndgameActions) {
        const groups = parsePlanIndices(step.planEndgameActions)
        entry.planEndgame = {
          indices: step.planEndgameActions,
          description: describePlanIndices(step.planEndgameActions),
          groups,
        }
      }

      // Predict (sigmoid)
      if (step.sigmoidActions) {
        const predictions: Array<{ seat: number, roles: Array<{ role: string, value: number }> }> = []
        for (let s = 0; s < 14; s++) {
          const seatPreds: Array<{ role: string, value: number }> = []
          for (let r = 0; r < 11; r++) {
            const val = step.sigmoidActions[s * 11 + r]
            seatPreds.push({ role: ['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'werewolf', 'possessed', 'fanatic', 'werehamster', 'immoralist'][r], value: Math.round(val * 100) / 100 })
          }
          if (seatPreds.length > 0) predictions.push({ seat: s + 1, roles: seatPreds })
        }
        entry.predict = predictions
      }

      timeline.push(entry)
    }
  }

  // seat + step 順でソート (day → phase → seat)
  timeline.sort((a, b) => {
    const da = a.day as number, db = b.day as number
    if (da !== db) return da - db
    const pa = a.phase === 'night' ? 0 : 1, pb = b.phase === 'night' ? 0 : 1
    if (pa !== pb) return pa - pb
    return (a.seat as number) - (b.seat as number)
  })

  const gameLength = state.day

  const inspectData = { seed: gameSeed, result, gameLength, howl, players, timeline }
  const fileName = `game_${gameSeed}.json`
  const filePath = `${outdir}/${fileName}`
  writeFileSync(filePath, JSON.stringify(inspectData, null, 2))

  results.push({ seed: gameSeed, result, file: filePath })
  console.error(`# Game ${g + 1}/${count}: seed=${gameSeed} result=${result} length=${gameLength} → ${filePath}`)
}

// index.json 更新（既存エントリとマージ）
type IndexEntry = { file: string, seed: number, result: string, gameLength: number }
const indexPath = `${outdir}/index.json`
let indexEntries: IndexEntry[] = []
if (existsSync(indexPath)) {
  try { indexEntries = JSON.parse(readFileSync(indexPath, 'utf-8')) } catch {}
}
// seed で重複排除（新しい方を優先）
const byFile = new Map(indexEntries.map(e => [e.file, e]))
for (const r of results) {
  const fileName = `game_${r.seed}.json`
  byFile.set(fileName, { file: fileName, seed: r.seed, result: r.result, gameLength: (JSON.parse(readFileSync(r.file, 'utf-8')) as { gameLength: number }).gameLength })
}
const finalIndex = [...byFile.values()].sort((a, b) => a.seed - b.seed)
writeFileSync(indexPath, JSON.stringify(finalIndex, null, 2))

// サマリ
console.error(`\n# Summary: ${count} game(s) generated in ${outdir}/`)
console.error(`# index.json: ${finalIndex.length} entries`)
for (const r of results) {
  console.error(`#   seed=${r.seed} ${r.result} → ${r.file}`)
}
