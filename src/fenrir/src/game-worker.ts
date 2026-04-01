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
import { minimalAdapter } from '../../lupa/adapters/minimal-adapter.ts'
import { strategyAdapter } from '../../lupa/adapters/strategy-adapter.ts'
import type { AnyNetwork } from './ml/nn.ts'
import { FenrirStrategy, FanaticStrategy, WolfTeamStrategy, MasonTeamStrategy, WolfCollectiveStrategy, MasonCollectiveStrategy } from './policy.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from '../../lupa/heuristic.ts'
import { terminalReward, intermediateReward, tsumiReward, predictAccuracyReward, buildKnownSeats, DEFAULT_REWARD_CONFIG } from './reward.ts'
import { formatHowl } from '../../lupa/format.ts'
import { parse } from '../../howl/parser.ts'
import { buildVillageStatus } from '../../howl/bridge.ts'
import { searchTsumi } from '../../hati/index.ts'
import { DEFAULT_RETAR_OPTIONS } from '../../lupa/retar-bridge.ts'
import type { TrajectoryStep } from './ml/trajectory.ts'
import { encodeTrueRoles } from './observation.ts'
import {
  buildNetworkFromShared,
  serializeStep,
  type WorkerRequest,
  type WorkerResult,
  type SerializedGameResult,
  type SharedWeights,
} from './parallel.ts'

if (!parentPort) throw new Error('game-worker must be run as a worker thread')

parentPort.on('message', async (req: WorkerRequest) => {
  const results = await runBatch(req)
  parentPort!.postMessage({ type: 'result', games: results } satisfies WorkerResult)
})

function buildNetwork(shared: SharedWeights, mode: import('./observation.ts').ObservationMode | boolean = false): AnyNetwork {
  return buildNetworkFromShared(shared, mode)
}

/** role → モデルグループ名の逆引きマップ (5モデル構成) */
const ROLE_TO_GROUP: Record<string, string> = {
  villager: 'village', seer: 'village', medium: 'village', bodyguard: 'village', nekomata: 'village',
  werewolf: 'wolf_collective',
  mason: 'mason_collective',
  fanatic: 'fanatic',
  werehamster: 'third', immoralist: 'third',
}

async function runBatch(req: WorkerRequest): Promise<SerializedGameResult[]> {
  const config = req.trainingConfig
  const multiModel = req.modelGroupWeights != null
  const network = buildNetwork(req.weights)
  const wolfTeamNet = req.wolfTeamWeights ? buildNetwork(req.wolfTeamWeights, true) : undefined
  const masonTeamNet = req.masonTeamWeights ? buildNetwork(req.masonTeamWeights, true) : undefined
  const frozenVillageNet = req.villageFrozenWeights ? buildNetwork(req.villageFrozenWeights) : undefined
  const mlRolesSet = req.mlRoles ? new Set(req.mlRoles) : null
  const useHeuristic = req.phase === 1
  const usePool = req.phase === 3
  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])
  const totalPlayers = Array.from(roles.values()).reduce((a, b) => a + b, 0)

  // マルチモデル: グループ名 → AnyNetwork
  const GROUP_MODE: Record<string, import('./observation.ts').ObservationMode> = {
    wolf_collective: 'wolf_collective',
    mason_collective: 'mason_collective',
    fanatic: 'fanatic',
  }
  const groupNets = new Map<string, AnyNetwork>()
  if (multiModel) {
    for (const [name, sw] of Object.entries(req.modelGroupWeights!)) {
      groupNets.set(name, buildNetwork(sw, GROUP_MODE[name] ?? false))
    }
  }

  // Pool用の過去ネットワーク
  const poolNets: AnyNetwork[] = []
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
          strategies.set(seat, new FenrirStrategy(pastNet, { explore: true, strategyOnly: config.strategyOnly }))
        } else {
          strategies.set(seat, new FenrirStrategy(network, { explore: true, strategyOnly: config.strategyOnly }))
        }
      }
    }

    let wolfTeamStrategy: WolfTeamStrategy | WolfCollectiveStrategy | WolfTeamHeuristic | undefined
    let masonTeamStrategy: MasonTeamStrategy | MasonCollectiveStrategy | MasonTeamHeuristic | undefined
    if (config.strategyOnly) {
      // strategy-only: チーム戦略はheuristicにフォールバック（チームNNはstrategy-only未対応）
      if (req.useTeamStrategy === 'wolf_team' || (!req.useTeamStrategy && (!useHeuristic || multiModel))) {
        wolfTeamStrategy = new WolfTeamHeuristic()
      }
      if (req.useTeamStrategy === 'mason_team' || (!req.useTeamStrategy && (!useHeuristic || multiModel))) {
        masonTeamStrategy = new MasonTeamHeuristic()
      }
    } else if (req.useTeamStrategy) {
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
      // 集団NN (wolf_collective, mason_collective) は team strategy として設定
      onRolesAssigned = (seatRoles: Map<number, SystemRole>) => {
        seatRoleMap = seatRoles

        // 集団 strategy の構築
        const wolfNet = groupNets.get('wolf_collective')
        if (wolfNet) {
          const ws = new WolfCollectiveStrategy(wolfNet, { explore: true })
          if (frozenVillageNet) ws.frozenVillageNetwork = frozenVillageNet
          wolfTeamStrategy = ws
        }
        const masonNet = groupNets.get('mason_collective')
        if (masonNet) {
          masonTeamStrategy = new MasonCollectiveStrategy(masonNet, { explore: true })
        }

        // 個人NN の割り当て (collective roles はチーム strategy 経由なのでスキップ)
        for (const [seat, role] of seatRoles) {
          const groupName = ROLE_TO_GROUP[role]
          if (groupName === 'wolf_collective' || groupName === 'mason_collective') continue
          const net = groupName ? groupNets.get(groupName) : undefined
          if (net) {
            if (groupName === 'fanatic') {
              const fs = new FanaticStrategy(net, { explore: true, strategyOnly: config.strategyOnly })
              if (frozenVillageNet) fs.frozenVillageNetwork = frozenVillageNet
              strategies.set(seat, fs)
            } else {
              strategies.set(seat, new FenrirStrategy(net, { explore: true, strategyOnly: config.strategyOnly }))
            }
          }
          // groupName が無い (possessed等) → defaultStrategy にフォールバック
        }
      }
    } else if (useHeuristic && mlRolesSet) {
      onRolesAssigned = (seatRoles: Map<number, SystemRole>) => {
        seatRoleMap = seatRoles
        // mlMaxSeats で NN 席数を制限（カリキュラム学習）
        const candidates = [...seatRoles].filter(([_, role]) => mlRolesSet.has(role))
        // seed ベースでシャッフル（再現性）
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = (seed * 7 + i * 13) % (i + 1)
          ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
        }
        const limit = req.mlMaxSeats ?? candidates.length
        for (let i = 0; i < Math.min(limit, candidates.length); i++) {
          strategies.set(candidates[i][0], new FenrirStrategy(network, { explore: true, strategyOnly: config.strategyOnly }))
        }
      }
    }

    const strategiesMap = new Map<number, Strategy>(strategies)
    // formatHowl 用の最小設定
    const lupaConfig = { roles, seed } as LupaConfig

    // Reset trajectories
    for (const s of strategies.values()) s.resetTrajectory?.()
    wolfTeamStrategy?.resetTrajectory?.()
    masonTeamStrategy?.resetTrajectory?.()

    const tGameStart = performance.now()
    let state: import('../../lupa/types.ts').GameState
    let events: import('../../lupa/types.ts').GameEvent[]
    let gameRetarMs = 0
    let gameRetarCount = 0

    const onRolesAssignedWrapped = onRolesAssigned ? (seatRoles: Map<number, SystemRole>) => {
      onRolesAssigned(seatRoles)
      for (const [seat, s] of strategies) {
        if (!strategiesMap.has(seat)) strategiesMap.set(seat, s)
      }
    } : undefined

    let tsumiCacheGetter: (() => Map<number, boolean>) | undefined

    if (config.strategyOnly) {
      // minimal-adapter: 議論フェーズ全スキップで高速化
      const handlers = minimalAdapter({
        strategies: strategiesMap,
        defaultStrategy,
        wolfTeamStrategy,
        masonTeamStrategy,
        onRolesAssigned: onRolesAssignedWrapped,
        seed,
        enableRetar: config.enableRetar,
        enableTsumi: true,
        roles,
        rules: config.rules,
      })
      tsumiCacheGetter = () => handlers.getTsumiCache()
      const result = await runGame(
        { roles, seed, hasFirstGhost: config.hasFirstGhost, revoteConfig: config.revoteConfig, rules: config.rules },
        handlers,
      )
      state = result.state
      events = result.events
      gameRetarMs = result.timing?.retarMs ?? 0
      gameRetarCount = result.timing?.retarCount ?? 0
    } else {
      // strategy-adapter: 全フェーズ実行
      const handlers = strategyAdapter({
        strategies: strategiesMap,
        defaultStrategy: defaultStrategy ?? new HeuristicStrategy(),
        wolfTeamStrategy,
        masonTeamStrategy,
        enableRetar: config.enableRetar,
        enableTsumi: true,
        onRolesAssigned: onRolesAssignedWrapped,
        seed,
        roles,
        rules: config.rules,
      })
      tsumiCacheGetter = () => handlers.getTsumiCache()
      const result = await runGame(
        { roles, seed, hasFirstGhost: config.hasFirstGhost, revoteConfig: config.revoteConfig, rules: config.rules },
        handlers,
      )
      state = result.state
      events = result.events
      gameRetarMs = result.timing?.retarMs ?? 0
      gameRetarCount = result.timing?.retarCount ?? 0
    }
    const tGameEnd = performance.now()

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

    // trueRoles注入 + 推理精度報酬
    const trueRoles = encodeTrueRoles(state.players)
    const trueRolesArray = Array.from(trueRoles)
    for (const entry of individualSteps) {
      const player = state.players.find(p => p.seat === entry.seat)
      const knownSeats = player ? buildKnownSeats(entry.seat, player.role, state) : undefined
      for (const step of entry.steps) {
        step.trueRoles = trueRolesArray
        // predict stepに推理精度報酬を付与
        if (step.actionHead === 'predict' && step.sigmoidActions) {
          step.reward += predictAccuracyReward(
            new Float32Array(step.sigmoidActions), trueRoles, entry.role, config.rewardConfig, knownSeats,
          )
        }
      }
    }

    // Hati 詰み報酬: ゲーム中のキャッシュから判定（Retar再実行なし）
    const tTsumiStart = performance.now()
    let firstTsumiDay = -1
    let tsumiCallCount = 0
    const cachedTsumi = tsumiCacheGetter?.()
    if (cachedTsumi && cachedTsumi.size > 0) {
      // 日数順にソートして最初の詰み日を探す
      const days = [...cachedTsumi.keys()].sort((a, b) => a - b)
      for (const day of days) {
        if (cachedTsumi.get(day)) {
          firstTsumiDay = day
          break
        }
      }
    } else {
      // キャッシュなし: フォールバック（howl再パース）
      const howl = formatHowl(events, state, lupaConfig)
      const howlLines = howl.split('\n')
      const execLines: number[] = []
      for (let li = 0; li < howlLines.length; li++) {
        if (howlLines[li].match(/処刑$/)) execLines.push(li + 1)
      }

      const hatiOptions = config.hasFirstGhost
        ? { ...DEFAULT_RETAR_OPTIONS, hasFirstGhost: true }
        : DEFAULT_RETAR_OPTIONS

      for (let i = 0; i < execLines.length; i++) {
        const truncated = howlLines.slice(0, execLines[i] - 1).join('\n')
        try {
          const { meta, statements } = parse(truncated)
          const { vs, setup } = buildVillageStatus(statements, meta)
          tsumiCallCount++
          const result = searchTsumi(vs, setup, hatiOptions)
          if (result.isTsumi) {
            firstTsumiDay = i + 1
            break
          }
        } catch {
          // parse error → skip
        }
      }
    }

    if (firstTsumiDay > 0) {
      const totalDays = state.executionHistory.size
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

    const tTsumiEnd = performance.now()

    // NN推論時間・回数の集計
    let totalInferMs = 0
    let totalInferCount = 0
    for (const s of strategies.values()) {
      totalInferMs += s.inferMs
      totalInferCount += s.inferCount
    }
    if (wolfTeamStrategy && 'inferMs' in wolfTeamStrategy) {
      totalInferMs += (wolfTeamStrategy as any).inferMs
      totalInferCount += (wolfTeamStrategy as any).inferCount ?? 0
    }
    if (masonTeamStrategy && 'inferMs' in masonTeamStrategy) {
      totalInferMs += (masonTeamStrategy as any).inferMs
      totalInferCount += (masonTeamStrategy as any).inferCount ?? 0
    }

    results.push({
      individualSteps,
      wolfTeamSteps: wSteps.map(serializeStep),
      masonTeamSteps: mSteps.map(serializeStep),
      result: state.result ?? 'unknown',
      timing: {
        totalMs: tTsumiEnd - tGameStart,
        gameMs: tGameEnd - tGameStart,
        retarMs: gameRetarMs ?? 0,
        retarCount: gameRetarCount,
        inferMs: totalInferMs,
        inferCount: totalInferCount,
        tsumiMs: tTsumiEnd - tTsumiStart,
        tsumiCount: tsumiCallCount,
      },
    })
  }

  return results
}
