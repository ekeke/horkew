/**
 * ゲーム生成ワーカースレッド
 *
 * メインスレッドから SharedWeights + seeds を受け取り、
 * ゲームを生成して trajectory を返す。
 */

import { parentPort } from 'node:worker_threads'
import type { SystemRole } from '../../types/index.ts'
import type { LupaConfig } from '../../lupa/types.ts'
import type { Strategy } from '../../lupa/strategy.ts'
import { runGame } from '../../lupa/engine.ts'
import { NeuralNetwork } from './ml/nn.ts'
import { FenrirStrategy, WolfTeamStrategy, MasonTeamStrategy } from './policy.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from '../../lupa/heuristic.ts'
import { terminalReward, intermediateReward, tsumiReward, DEFAULT_REWARD_CONFIG } from './reward.ts'
import { formatHowl } from '../../lupa/format.ts'
import { parse } from '../../howl/parser.ts'
import { buildVillageStatus } from '../../howl/bridge.ts'
import { searchTsumi } from '../../hati/index.ts'
import { DEFAULT_RETAR_OPTIONS } from '../../lupa/retar-bridge.ts'
import type { TrajectoryStep } from './ml/trajectory.ts'
import {
  unpackWeights,
  serializeStep,
  type WorkerRequest,
  type WorkerResult,
  type SerializedGameResult,
  type SharedWeights,
} from './parallel.ts'

if (!parentPort) throw new Error('game-worker must be run as a worker thread')

parentPort.on('message', (req: WorkerRequest) => {
  const results = runBatch(req)
  parentPort!.postMessage({ type: 'result', games: results } satisfies WorkerResult)
})

function buildNetwork(shared: SharedWeights): NeuralNetwork {
  const net = new NeuralNetwork(shared.config)
  unpackWeights(net, shared)
  return net
}

/** role → モデルグループ名の逆引きマップ (コンパイル時定数相当) */
const ROLE_TO_GROUP: Record<string, string> = {
  mason: 'mason',
  villager: 'village', seer: 'village', medium: 'village', bodyguard: 'village', nekomata: 'village',
  werewolf: 'werewolf',
  fanatic: 'fanatic',
  werehamster: 'hamster',
  immoralist: 'immoralist',
}

function runBatch(req: WorkerRequest): SerializedGameResult[] {
  const config = req.trainingConfig
  const multiModel = req.modelGroupWeights != null
  const network = buildNetwork(req.weights)
  const wolfTeamNet = req.wolfTeamWeights ? buildNetwork(req.wolfTeamWeights) : undefined
  const masonTeamNet = req.masonTeamWeights ? buildNetwork(req.masonTeamWeights) : undefined
  const mlRolesSet = req.mlRoles ? new Set(req.mlRoles) : null
  const useHeuristic = req.phase === 1
  const usePool = req.phase === 3
  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])
  const totalPlayers = Array.from(roles.values()).reduce((a, b) => a + b, 0)

  // マルチモデル: グループ名 → NeuralNetwork
  const groupNets = new Map<string, NeuralNetwork>()
  if (multiModel) {
    for (const [name, sw] of Object.entries(req.modelGroupWeights!)) {
      groupNets.set(name, buildNetwork(sw))
    }
  }

  // Pool用の過去ネットワーク
  const poolNets: NeuralNetwork[] = []
  if (req.poolWeights) {
    for (const pw of req.poolWeights) {
      poolNets.push(buildNetwork(pw))
    }
  }

  const results: SerializedGameResult[] = []

  for (const seed of req.seeds) {
    const strategies = new Map<number, FenrirStrategy>()
    // seat → role マッピング (role フィールド出力用)
    let seatRoleMap: Map<number, SystemRole> | undefined

    if (multiModel) {
      // マルチモデルモード: onRolesAssigned で割り当てるので事前には何もしない
    } else if (!useHeuristic || !mlRolesSet) {
      for (let seat = 1; seat <= totalPlayers; seat++) {
        if (useHeuristic && seat % 2 !== 0) continue

        if (usePool && poolNets.length > 0 && seat % 3 === 0) {
          const pastNet = poolNets[Math.floor(Math.random() * poolNets.length)]
          strategies.set(seat, new FenrirStrategy(pastNet, { explore: true }))
        } else {
          strategies.set(seat, new FenrirStrategy(network, { explore: true }))
        }
      }
    }

    let wolfTeamStrategy: WolfTeamStrategy | undefined
    let masonTeamStrategy: MasonTeamStrategy | undefined
    if (req.useTeamStrategy) {
      // orchestrator: 指定チームだけML
      if (req.useTeamStrategy === 'wolf_team' && wolfTeamNet) {
        wolfTeamStrategy = new WolfTeamStrategy(wolfTeamNet, { explore: true })
      }
      if (req.useTeamStrategy === 'mason_team' && masonTeamNet) {
        masonTeamStrategy = new MasonTeamStrategy(masonTeamNet, { explore: true })
      }
    } else if (!useHeuristic || multiModel) {
      if (wolfTeamNet) wolfTeamStrategy = new WolfTeamStrategy(wolfTeamNet, { explore: true })
      if (masonTeamNet) masonTeamStrategy = new MasonTeamStrategy(masonTeamNet, { explore: true })
    }

    const defaultStrategy = (useHeuristic || multiModel) ? new HeuristicStrategy() : undefined

    let onRolesAssigned: ((seatRoles: Map<number, SystemRole>) => void) | undefined

    if (multiModel) {
      // マルチモデル: role に応じたグループの network を割り当て
      onRolesAssigned = (seatRoles: Map<number, SystemRole>) => {
        seatRoleMap = seatRoles
        for (const [seat, role] of seatRoles) {
          const groupName = ROLE_TO_GROUP[role]
          const net = groupName ? groupNets.get(groupName) : undefined
          if (net) {
            strategies.set(seat, new FenrirStrategy(net, { explore: true }))
          }
          // groupName が無い (possessed等) → defaultStrategy にフォールバック
        }
      }
    } else if (useHeuristic && mlRolesSet) {
      onRolesAssigned = (seatRoles: Map<number, SystemRole>) => {
        seatRoleMap = seatRoles
        for (const [seat, role] of seatRoles) {
          if (mlRolesSet.has(role)) {
            strategies.set(seat, new FenrirStrategy(network, { explore: true }))
          }
        }
      }
    }

    // Build LupaConfig
    const strategiesMap = new Map<number, Strategy>(strategies)
    const lupaConfig: LupaConfig = {
      roles,
      seed,
      strategies: strategiesMap,
      defaultStrategy,
      onRolesAssigned: onRolesAssigned ? (seatRoles) => {
        onRolesAssigned(seatRoles)
        for (const [seat, s] of strategies) {
          if (!strategiesMap.has(seat)) strategiesMap.set(seat, s)
        }
      } : undefined,
      enableRetar: config.enableRetar,
      hasFirstGhost: config.hasFirstGhost,
      revoteConfig: config.revoteConfig,
      wolfTeamStrategy,
      masonTeamStrategy,
    }

    // Reset trajectories
    for (const s of strategies.values()) s.resetTrajectory?.()
    wolfTeamStrategy?.resetTrajectory()
    masonTeamStrategy?.resetTrajectory()

    const { state, events } = runGame(lupaConfig)

    // Collect trajectories
    const individualSteps: SerializedGameResult['individualSteps'] = []
    for (const [seat, strategy] of strategies) {
      const steps = strategy.trajectory
      if (!steps) continue
      if (steps.length > 0) {
        steps[steps.length - 1].done = true
        const player = state.players.find(p => p.seat === seat)!
        steps[steps.length - 1].reward += terminalReward(player.role, state.result ?? '', config.rewardConfig)
      }
      const role = seatRoleMap?.get(seat) ?? state.players.find(p => p.seat === seat)?.role ?? 'unknown'
      individualSteps.push({ seat, role, steps: steps.map(serializeStep) })
    }

    const wSteps = wolfTeamStrategy?.trajectory ?? []
    if (wSteps.length > 0) {
      wSteps[wSteps.length - 1].done = true
      wSteps[wSteps.length - 1].reward += terminalReward('werewolf', state.result ?? '', config.rewardConfig)
    }

    const mSteps = masonTeamStrategy?.trajectory ?? []
    if (mSteps.length > 0) {
      mSteps[mSteps.length - 1].done = true
      mSteps[mSteps.length - 1].reward += terminalReward('mason', state.result ?? '', config.rewardConfig)
    }

    // Intermediate rewards
    for (const event of events) {
      const rewards = intermediateReward(event, state, config.rewardConfig)
      for (const [seat, reward] of rewards) {
        const entry = individualSteps.find(e => e.seat === seat)
        if (entry && entry.steps.length > 0) {
          entry.steps[entry.steps.length - 1].reward += reward
        }
        const player = state.players.find(p => p.seat === seat)
        if (player?.role === 'werewolf' && wSteps.length > 0) {
          wSteps[wSteps.length - 1].reward += reward
        }
        if (player?.role === 'mason' && mSteps.length > 0) {
          mSteps[mSteps.length - 1].reward += reward
        }
      }
    }

    // Hati 詰み報酬: ゲーム終了後に遡って判定
    const howl = formatHowl(events, state, lupaConfig)
    const howlLines = howl.split('\n')
    const execLines: number[] = []
    for (let li = 0; li < howlLines.length; li++) {
      if (howlLines[li].match(/処刑$/)) execLines.push(li + 1)
    }

    const hatiOptions = config.hasFirstGhost
      ? { ...DEFAULT_RETAR_OPTIONS, hasFirstGhost: true }
      : DEFAULT_RETAR_OPTIONS

    let firstTsumiDay = -1
    for (let i = 0; i < execLines.length; i++) {
      const truncated = howlLines.slice(0, execLines[i] - 1).join('\n')
      try {
        const { meta, statements } = parse(truncated)
        const { vs, setup } = buildVillageStatus(statements, meta)
        const result = searchTsumi(vs, setup, hatiOptions, { buildStrategy: false })
        if (result.isTsumi) {
          firstTsumiDay = i + 1
          break
        }
      } catch {
        // parse error → skip
      }
    }

    if (firstTsumiDay > 0) {
      const totalDays = execLines.length
      const tsumiDays = totalDays - firstTsumiDay + 1
      const tRewards = tsumiReward(state, tsumiDays, config.rewardConfig)
      for (const [seat, reward] of tRewards) {
        const entry = individualSteps.find(e => e.seat === seat)
        if (entry && entry.steps.length > 0) {
          entry.steps[entry.steps.length - 1].reward += reward
        }
        const player = state.players.find(p => p.seat === seat)
        if (player?.role === 'werewolf' && wSteps.length > 0) {
          wSteps[wSteps.length - 1].reward += reward
        }
        if (player?.role === 'mason' && mSteps.length > 0) {
          mSteps[mSteps.length - 1].reward += reward
        }
      }
    }

    results.push({
      individualSteps,
      wolfTeamSteps: wSteps.map(serializeStep),
      masonTeamSteps: mSteps.map(serializeStep),
      result: state.result ?? 'unknown',
    })
  }

  return results
}
