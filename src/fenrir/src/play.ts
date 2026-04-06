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
import type { Agent } from './agents/agent.ts'
import { runGame } from '../../lupa/engine.ts'
import { fullAdapter } from './adapters/full-adapter.ts'
import { MasonTrainingAdapter } from './adapters/mason-training-adapter.ts'
import { formatHowl } from '../../lupa/format.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from './agents/rule-based-agent.ts'
import {
  createNetwork, createWolfTeamNetwork, createMasonTeamNetwork,
  DEFAULT_TRAINING_CONFIG,
} from './training.ts'
import { loadCheckpoint } from './ml/checkpoint.ts'
import { NeuralAgent } from './agents/neural-agent.ts'
import { WolfTeamAgent } from './agents/wolf-collective.ts'
import { MasonTeamAgent } from './agents/mason-collective.ts'
import type { AnyNetwork } from './ml/nn.ts'
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
  let strategyOnly = false
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
      case '--strategy-only':
        strategyOnly = true
        break
    }
  }

  return { checkpoint, mldir, seed, allMl, rolesStr, defaultModel, modelOverrides, strategyOnly }
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

const { checkpoint, mldir, seed, allMl, rolesStr, defaultModel, modelOverrides, strategyOnly } = parseArgs()

// 役職構成
const rolesConfig = rolesStr
  ? Object.fromEntries(rolesStr.split(',').map(s => {
      const [role, count] = s.split(':')
      return [role, parseInt(count)]
    }))
  : DEFAULT_TRAINING_CONFIG.roles

const roles = new Map(Object.entries(rolesConfig) as [SystemRole, number][])
const totalPlayers = Array.from(roles.values()).reduce((a, b) => a + b, 0)

const heuristic = new RuleBasedAgent()

// ネットワークとストラテジー構築
let wolfTeamAgent: WolfTeamAgent | WolfTeamRuleAgent | undefined
let masonTeamAgent: MasonTeamAgent | MasonTeamRuleAgent | undefined

if (mldir) {
  // === --mldir モード: グループ別にモデルをロード ===
  const makeNet = (): AnyNetwork => createNetwork()
  const makeWolfTeam = (): AnyNetwork => createWolfTeamNetwork()
  const makeMasonTeam = (): AnyNetwork => createMasonTeamNetwork()

  const groupNets = new Map<string, AnyNetwork>()
  const wolfTeamNet = makeWolfTeam()
  const masonTeamNet = makeMasonTeam()

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

        // チーム NW
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

  // 役割が判明してからストラテジーを割り当てる
  const agentsMap = new Map<number, Agent>()

  const onRolesAssigned = (seatRoles: Map<number, SystemRole>) => {
    for (const [seat, role] of seatRoles) {
      // --model で個別指定があるか？
      const override = modelOverrides.get(role)
      const useModel = override ?? defaultModel

      if (useModel === 'heuristic') {
        agentsMap.set(seat, heuristic)
        continue
      }

      // ML モデルを探す
      const groupName = ROLE_TO_GROUP.get(role)
      const net = groupName ? groupNets.get(groupName) : undefined
      if (net) {
        agentsMap.set(seat, new NeuralAgent(net, { explore: false, strategyOnly }))
      } else {
        agentsMap.set(seat, heuristic)
      }
    }
  }

  // チーム戦略
  const wolfOverride = modelOverrides.get('werewolf')
  const useWolfMl = wolfOverride ? wolfOverride === 'ml' : defaultModel === 'ml'
  wolfTeamAgent = useWolfMl && groupNets.has('werewolf')
    ? new WolfTeamAgent(wolfTeamNet, { explore: false })
    : new WolfTeamRuleAgent()

  const masonOverride = modelOverrides.get('mason')
  const useMasonMl = masonOverride ? masonOverride === 'ml' : defaultModel === 'ml'
  masonTeamAgent = useMasonMl && groupNets.has('mason')
    ? new MasonTeamAgent(masonTeamNet, { explore: false })
    : new MasonTeamRuleAgent()

  const gameSeed = seed ?? Math.floor(Math.random() * 100000)
  const handlers = strategyOnly
    ? new MasonTrainingAdapter({
        agents: agentsMap,
        defaultAgent: heuristic,
        wolfTeamAgent: wolfTeamAgent,
        masonTeamAgent: masonTeamAgent,
        onRolesAssigned,
        seed: gameSeed,
        enableRetar: true,
        roles,
        rules: DEFAULT_TRAINING_CONFIG.rules,
      })
    : fullAdapter({
        agents: agentsMap,
        defaultAgent: heuristic,
        wolfTeamAgent: wolfTeamAgent,
        masonTeamAgent: masonTeamAgent,
        enableRetar: true,
        onRolesAssigned,
        seed: gameSeed,
        roles,
        rules: DEFAULT_TRAINING_CONFIG.rules,
      })
  const { events, state, config } = await runGame(
    {
      roles,
      seed: gameSeed,
      hasFirstGhost: DEFAULT_TRAINING_CONFIG.hasFirstGhost,
      revoteConfig: DEFAULT_TRAINING_CONFIG.revoteConfig,
      rules: DEFAULT_TRAINING_CONFIG.rules,
    },
    handlers,
  )
  console.log(formatHowl(events as import('../../lupa/types.ts').GameEvent[], state, config as unknown as LupaConfig))

} else {
  // === --checkpoint モード (レガシー) ===
  const network = createNetwork()

  if (checkpoint) {
    const data = loadCheckpoint(network, checkpoint)
    console.error(`# Loaded checkpoint: iteration ${data.metadata.iteration} (${data.metadata.timestamp})`)
  } else {
    console.error('# No checkpoint — using untrained network')
  }

  const agentsMap = new Map<number, Agent>()
  for (let seat = 1; seat <= totalPlayers; seat++) {
    if (allMl) {
      agentsMap.set(seat, new NeuralAgent(network, { explore: false, strategyOnly }))
    } else {
      if (seat % 2 === 0) {
        agentsMap.set(seat, new NeuralAgent(network, { explore: false, strategyOnly }))
      } else {
        agentsMap.set(seat, heuristic)
      }
    }
  }

  const gameSeed = seed ?? Math.floor(Math.random() * 100000)
  const handlers = fullAdapter({
    agents: agentsMap,
    defaultAgent: heuristic,
    enableRetar: true,
    seed: gameSeed,
    roles,
    rules: DEFAULT_TRAINING_CONFIG.rules,
  })
  const { events, state, config } = await runGame(
    {
      roles,
      seed: gameSeed,
      hasFirstGhost: DEFAULT_TRAINING_CONFIG.hasFirstGhost,
      revoteConfig: DEFAULT_TRAINING_CONFIG.revoteConfig,
      rules: DEFAULT_TRAINING_CONFIG.rules,
    },
    handlers,
  )
  console.log(formatHowl(events as import('../../lupa/types.ts').GameEvent[], state, config as unknown as LupaConfig))
}
