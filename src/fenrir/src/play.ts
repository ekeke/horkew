#!/usr/bin/env node
/**
 * 学習済みモデルでゲームを実行し、Howl形式で出力する
 *
 * Usage:
 *   npm run play -- --mldir ./checkpoints --seed 42
 *   npm run play -- --mldir ./checkpoints --default-model ml --model seer=heuristic
 *   npm run play -- --checkpoint ./checkpoints/final.json --seed 42 --all-ml
 */

import type { SystemRole } from '../../types/index.ts'
import type { LupaConfig } from '../../lupa/types.ts'
import type { Strategy } from '../../lupa/strategy.ts'
import { runGame } from '../../lupa/engine.ts'
import { formatHowl } from '../../lupa/format.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from '../../lupa/heuristic.ts'
import { createNetwork, createWolfTeamNetwork, createMasonTeamNetwork, DEFAULT_TRAINING_CONFIG } from './training.ts'
import { loadCheckpoint } from './ml/checkpoint.ts'
import { FenrirStrategy, WolfTeamStrategy, MasonTeamStrategy } from './policy.ts'
import { NeuralNetwork } from './ml/nn.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

// ============================================================
// Model Group Definitions (orchestrate.ts と同じ)
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
  let seed: number | undefined
  let allMl = false
  let rolesStr: string | undefined
  let defaultModel: 'ml' | 'heuristic' = 'ml'
  const modelOverrides = new Map<string, 'ml' | 'heuristic'>()

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--checkpoint':
        checkpoint = args[++i]
        break
      case '--mldir':
        mldir = args[++i]
        break
      case '--seed':
        seed = parseInt(args[++i])
        break
      case '--all-ml':
        allMl = true
        break
      case '--roles':
        rolesStr = args[++i]
        break
      case '--default-model':
        defaultModel = args[++i] as 'ml' | 'heuristic'
        break
      case '--model': {
        // --model seer=heuristic
        const val = args[++i]
        const [role, model] = val.split('=')
        modelOverrides.set(role, model as 'ml' | 'heuristic')
        break
      }
    }
  }

  return { checkpoint, mldir, seed, allMl, rolesStr, defaultModel, modelOverrides }
}

// ============================================================
// Checkpoint discovery
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
// Main
// ============================================================

const { checkpoint, mldir, seed, allMl, rolesStr, defaultModel, modelOverrides } = parseArgs()

// 役職構成
const rolesConfig = rolesStr
  ? Object.fromEntries(rolesStr.split(',').map(s => {
      const [role, count] = s.split(':')
      return [role, parseInt(count)]
    }))
  : DEFAULT_TRAINING_CONFIG.roles

const roles = new Map(Object.entries(rolesConfig) as [SystemRole, number][])
const totalPlayers = Array.from(roles.values()).reduce((a, b) => a + b, 0)

const heuristic = new HeuristicStrategy()

// ネットワークとストラテジー構築
let wolfTeamStrategy: WolfTeamStrategy | WolfTeamHeuristic | undefined
let masonTeamStrategy: MasonTeamStrategy | MasonTeamHeuristic | undefined

if (mldir) {
  // === --mldir モード: グループ別にモデルをロード ===
  const groupNets = new Map<string, NeuralNetwork>()
  const wolfTeamNet = createWolfTeamNetwork()
  const masonTeamNet = createMasonTeamNetwork()

  for (const [name, def] of Object.entries(MODEL_GROUPS)) {
    const dir = `${mldir}/ckpt-${name}`
    const ckptPath = findBestCheckpoint(dir)
    if (ckptPath) {
      const net = createNetwork()
      loadCheckpoint(net, ckptPath)
      groupNets.set(name, net)
      const raw = JSON.parse(readFileSync(ckptPath, 'utf-8'))
      console.error(`# ${name}: loaded (iter ${raw.metadata?.iteration ?? '?'})`)

      // チーム NW
      if (def.teamType) {
        const teamPath = findTeamCheckpoint(dir, def.teamType)
        if (teamPath) {
          if (def.teamType === 'wolf_team') loadCheckpoint(wolfTeamNet, teamPath)
          else loadCheckpoint(masonTeamNet, teamPath)
          console.error(`#   ${def.teamType}: loaded`)
        }
      }
    } else {
      console.error(`# ${name}: no checkpoint → heuristic`)
    }
  }

  // 役割が判明してからストラテジーを割り当てる
  const strategiesMap = new Map<number, Strategy>()

  const onRolesAssigned = (seatRoles: Map<number, SystemRole>) => {
    for (const [seat, role] of seatRoles) {
      // --model で個別指定があるか？
      const override = modelOverrides.get(role)
      const useModel = override ?? defaultModel

      if (useModel === 'heuristic') {
        strategiesMap.set(seat, heuristic)
        continue
      }

      // ML モデルを探す
      const groupName = ROLE_TO_GROUP.get(role)
      const net = groupName ? groupNets.get(groupName) : undefined
      if (net) {
        strategiesMap.set(seat, new FenrirStrategy(net, { explore: false }))
      } else {
        strategiesMap.set(seat, heuristic)
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

  const config: LupaConfig = {
    roles,
    seed: seed ?? Math.floor(Math.random() * 100000),
    strategies: strategiesMap,
    defaultStrategy: heuristic,
    onRolesAssigned,
    enableRetar: true,
    hasFirstGhost: DEFAULT_TRAINING_CONFIG.hasFirstGhost,
    revoteConfig: DEFAULT_TRAINING_CONFIG.revoteConfig,
    rules: DEFAULT_TRAINING_CONFIG.rules,
    wolfTeamStrategy,
    masonTeamStrategy,
  }

  const { events, state } = runGame(config)
  console.log(formatHowl(events, state, config))

} else {
  // === --checkpoint モード (レガシー) ===
  const network = createNetwork()

  if (checkpoint) {
    const data = loadCheckpoint(network, checkpoint)
    console.error(`# Loaded checkpoint: iteration ${data.metadata.iteration} (${data.metadata.timestamp})`)
  } else {
    console.error('# No checkpoint — using untrained network')
  }

  const strategies = new Map<number, Strategy>()
  for (let seat = 1; seat <= totalPlayers; seat++) {
    if (allMl) {
      strategies.set(seat, new FenrirStrategy(network, { explore: false }))
    } else {
      if (seat % 2 === 0) {
        strategies.set(seat, new FenrirStrategy(network, { explore: false }))
      } else {
        strategies.set(seat, heuristic)
      }
    }
  }

  const config: LupaConfig = {
    roles,
    seed: seed ?? Math.floor(Math.random() * 100000),
    strategies,
    enableRetar: true,
    hasFirstGhost: DEFAULT_TRAINING_CONFIG.hasFirstGhost,
    revoteConfig: DEFAULT_TRAINING_CONFIG.revoteConfig,
    rules: DEFAULT_TRAINING_CONFIG.rules,
  }

  const { events, state } = runGame(config)
  console.log(formatHowl(events, state, config))
}
