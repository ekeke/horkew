/**
 * ゲーム生成ワーカースレッド
 *
 * メインスレッドから SharedWeights + seeds を受け取り、
 * ゲームを生成して trajectory を返す。
 */

import { parentPort, threadId } from 'node:worker_threads'
import { type SystemRole, systemRoles } from '../../types/index.ts'
import type { LupaConfig } from '../../lupa/types.ts'
import type { Agent } from './agents/agent.ts'
import { runGame, resumeGame } from '../../lupa/engine.ts'
import { MasonTrainingAdapter } from './adapters/mason-training-adapter.ts'
import { fullAdapter } from './adapters/full-adapter.ts'
import type { AnyNetwork } from './ml/nn.ts'
import { NeuralAgent } from './agents/neural-agent.ts'
import { FanaticAgent } from './agents/fanatic-agent.ts'
import { WolfTeamAgent, WolfCollective } from './agents/wolf-collective.ts'
import { MasonTeamAgent, MasonCollective } from './agents/mason-collective.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from './agents/rule-based-agent.ts'
import { terminalReward, intermediateReward, tsumiReward } from './reward.ts'
import { formatHowl } from '../../lupa/format.ts'
import { parse } from '../../howl/parser.ts'
import { buildVillageStatus } from '../../howl/bridge.ts'
import { searchTsumi } from '../../hati/index.ts'
import { DEFAULT_RETAR_OPTIONS } from './retar-bridge.ts'
import { encodeTrueRoles } from './observation.ts'
import {
  buildNetworkFromShared,
  unpackWreWeights,
  serializeStep,
  type WorkerRequest,
  type WorkerResult,
  type SerializedGameResult,
  type SharedWeights,
} from './parallel.ts'

if (!parentPort) throw new Error('game-worker must be run as a worker thread')

// worker 起動時に一度だけ出力（env 継承確認用）
if (process.env.DESIGNATION_DEBUG) {
  console.warn(`[game-worker] DESIGNATION_DEBUG=${process.env.DESIGNATION_DEBUG} (threadId=${threadId})`)
}

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
  const frozenMasonNet = req.frozenMasonWeights ? buildNetwork(req.frozenMasonWeights) : undefined
  const wreNet = req.wreWeights ? unpackWreWeights(req.wreWeights) : undefined
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

  for (let seedIdx = 0; seedIdx < req.seeds.length; seedIdx++) {
    const seed = req.seeds[seedIdx]
    const snapshot = req.snapshots?.[seedIdx]
    const neuralAgents = new Map<number, NeuralAgent>()
    // seat → role マッピング (role フィールド出力用)
    let seatRoleMap: Map<number, SystemRole> | undefined

    if (multiModel) {
      // マルチモデルモード: onRolesAssigned で割り当てるので事前には何もしない
    } else if (!useHeuristic || !mlRolesSet) {
      for (let seat = 1; seat <= totalPlayers; seat++) {
        if (useHeuristic && seat % 2 !== 0) continue

        if (usePool && poolNets.length > 0 && seat % 3 === 0) {
          const pastNet = poolNets[Math.floor(Math.random() * poolNets.length)]
          neuralAgents.set(seat, new NeuralAgent(pastNet, { explore: true, strategyOnly: config.strategyOnly, activeFromDay: req.mlStartDay }))
        } else {
          neuralAgents.set(seat, new NeuralAgent(network, { explore: true, strategyOnly: config.strategyOnly, activeFromDay: req.mlStartDay }))
        }
      }
    }

    let wolfTeamAgent: WolfTeamAgent | WolfCollective | WolfTeamRuleAgent | undefined
    let masonTeamAgent: MasonTeamAgent | MasonCollective | MasonTeamRuleAgent | undefined
    if (config.strategyOnly && !multiModel) {
      // strategy-only (単一モデル): チーム戦略はheuristicにフォールバック
      if (req.useTeamStrategy === 'wolf_team' || (!req.useTeamStrategy && !useHeuristic)) {
        wolfTeamAgent = new WolfTeamRuleAgent()
      }
      if (req.useTeamStrategy === 'mason_team' || (!req.useTeamStrategy && !useHeuristic)) {
        masonTeamAgent = new MasonTeamRuleAgent()
      }
    } else if (req.useTeamStrategy) {
      // orchestrator: 指定チームだけML
      if (req.useTeamStrategy === 'wolf_team' && wolfTeamNet) {
        wolfTeamAgent = new WolfTeamAgent(wolfTeamNet, { explore: true })
      }
      if (req.useTeamStrategy === 'mason_team' && masonTeamNet) {
        masonTeamAgent = new MasonTeamAgent(masonTeamNet, { explore: true })
      }
    } else if (!useHeuristic || multiModel) {
      if (multiModel) {
        // マルチモデル: groupNets から集団エージェントを事前構築
        // adapter に渡す前に作る必要がある（adapter はコンストラクタ時にキャプチャするため）
        const wolfNet = groupNets.get('wolf_collective')
        if (wolfNet) {
          const ws = new WolfCollective(wolfNet, { explore: true })
          if (frozenVillageNet) ws.frozenVillageNetwork = frozenVillageNet
          wolfTeamAgent = ws
        }
        const masonNet = groupNets.get('mason_collective')
        if (masonNet) {
          masonTeamAgent = new MasonCollective(masonNet, { explore: true })
        }
      } else {
        if (wolfTeamNet) wolfTeamAgent = new WolfTeamAgent(wolfTeamNet, { explore: true })
        if (masonTeamNet) masonTeamAgent = new MasonTeamAgent(masonTeamNet, { explore: true })
      }
    }

    const defaultAgent = (useHeuristic || multiModel) ? new RuleBasedAgent() : undefined

    let onRolesAssigned: ((seatRoles: Map<number, SystemRole>) => void) | undefined

    if (multiModel) {
      // マルチモデル: role に応じたグループの network を割り当て
      // 集団NN (wolf_collective, mason_collective) は team strategy として設定
      onRolesAssigned = (seatRoles: Map<number, SystemRole>) => {
        seatRoleMap = seatRoles

        // 個人NN の割り当て (collective roles はチーム strategy 経由なのでスキップ)
        // 集団NN (wolf_collective, mason_collective) は adapter 作成前に構築済み
        for (const [seat, role] of seatRoles) {
          const groupName = ROLE_TO_GROUP[role]
          if (groupName === 'wolf_collective' || groupName === 'mason_collective') continue
          const net = groupName ? groupNets.get(groupName) : undefined
          if (net) {
            if (groupName === 'fanatic') {
              const fs = new FanaticAgent(net, { explore: true, strategyOnly: config.strategyOnly })
              if (frozenVillageNet) fs.frozenVillageNetwork = frozenVillageNet
              neuralAgents.set(seat, fs)
            } else {
              neuralAgents.set(seat, new NeuralAgent(net, { explore: true, strategyOnly: config.strategyOnly, activeFromDay: req.mlStartDay }))
            }
          }
          // groupName が無い (possessed等) → defaultAgent にフォールバック
        }
      }
    } else if (useHeuristic && mlRolesSet) {
      onRolesAssigned = (seatRoles: Map<number, SystemRole>) => {
        seatRoleMap = seatRoles
        // frozen mason NN: mason 席に frozen 戦略を注入（trajectory は記録しない）
        if (frozenMasonNet) {
          for (const [seat, role] of seatRoles) {
            if (role === 'mason') {
              neuralAgents.set(seat, new NeuralAgent(frozenMasonNet, { explore: false, strategyOnly: config.strategyOnly }))
            }
          }
        }
        // mlMaxSeats で NN 席数を制限（カリキュラム学習）
        const candidates = [...seatRoles].filter(([_, role]) => mlRolesSet.has(role))
        // seed ベースでシャッフル（再現性）
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = (seed * 7 + i * 13) % (i + 1)
          ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
        }
        const limit = req.mlMaxSeats ?? candidates.length
        for (let i = 0; i < Math.min(limit, candidates.length); i++) {
          neuralAgents.set(candidates[i][0], new NeuralAgent(network, { explore: true, strategyOnly: config.strategyOnly, activeFromDay: req.mlStartDay }))
        }
      }
    }

    const agentsMap = new Map<number, Agent>(neuralAgents)
    // formatHowl 用の最小設定
    const lupaConfig = { roles, seed } as LupaConfig

    // Reset trajectories
    for (const s of neuralAgents.values()) s.resetTrajectory?.()
    ;(wolfTeamAgent as any)?.resetTrajectory?.()
    ;(masonTeamAgent as any)?.resetTrajectory?.()

    const tGameStart = performance.now()
    let state: import('../../lupa/types.ts').GameState
    let events: (import('../../lupa/types.ts').GameEvent | import('./events.ts').FenrirExtEvent)[]
    let gameRetarMs = 0
    let gameRetarCount = 0

    const onRolesAssignedWrapped = onRolesAssigned ? (seatRoles: Map<number, SystemRole>) => {
      onRolesAssigned(seatRoles)
      for (const [seat, s] of neuralAgents) {
        if (!agentsMap.has(seat)) agentsMap.set(seat, s)
      }
    } : undefined

    let tsumiCacheGetter: (() => Map<number, boolean>) | undefined
    const isInspectGame = req.inspectSeeds != null && req.inspectSeeds.includes(seed)
    let observationGetter: (() => import('./adapters/adapter-types.ts').CapturedObservation[]) | undefined

    // Mason takeover callback: ML mason 死亡時に neuralAgents マップを更新
    const onMasonTakeover = req.enableMasonTakeover ? (deadSeat: number, newSeat: number) => {
      const agent = neuralAgents.get(deadSeat)
      if (agent) {
        neuralAgents.delete(deadSeat)
        neuralAgents.set(newSeat, agent)
      }
    } : undefined

    if (snapshot) {
      // Seed Bank リプレイ: inspect時は名前を role+seat 形式に上書き
      if (isInspectGame) {
        for (const p of snapshot.state.players) {
          const shortName = systemRoles.get(p.role as SystemRole)?.shortName ?? p.role
          p.name = `${shortName}${p.seat}`
        }
      }
      const handlers = config.strategyOnly
        ? new MasonTrainingAdapter({
            agents: agentsMap,
            defaultAgent: defaultAgent,
            wolfTeamAgent: wolfTeamAgent,
            masonTeamAgent: masonTeamAgent,
            onRolesAssigned: onRolesAssignedWrapped,
            seed,
            enableRetar: config.enableRetar,
            enableTsumi: true,
            roles,
            rules: config.rules,
            captureObservations: isInspectGame,
            onMasonTakeover,
          })
        : fullAdapter({
            agents: agentsMap,
            defaultAgent: defaultAgent ?? new RuleBasedAgent(),
            wolfTeamAgent: wolfTeamAgent,
            masonTeamAgent: masonTeamAgent,
            enableRetar: config.enableRetar,
            enableTsumi: true,
            onRolesAssigned: onRolesAssignedWrapped,
            seed,
            roles,
            rules: config.rules,
          })
      tsumiCacheGetter = () => handlers.getTsumiCache!()
      if (isInspectGame && 'getCapturedObservations' in handlers) observationGetter = () => (handlers as any).getCapturedObservations()
      const result = await resumeGame(snapshot, handlers)
      state = result.state
      events = result.events
      gameRetarMs = result.timing?.retarMs ?? 0
      gameRetarCount = result.timing?.retarCount ?? 0
    } else if (config.strategyOnly) {
      // minimal-adapter: 議論フェーズ全スキ��プで高速化
      const handlers = new MasonTrainingAdapter({
        agents: agentsMap,
        defaultAgent: defaultAgent,
        wolfTeamAgent: wolfTeamAgent,
        masonTeamAgent: masonTeamAgent,
        onRolesAssigned: onRolesAssignedWrapped,
        seed,
        enableRetar: config.enableRetar,
        enableTsumi: true,
        retarStartDay: req.mlStartDay,
        roles,
        rules: config.rules,
        captureObservations: isInspectGame,
        onMasonTakeover,
      })
      tsumiCacheGetter = () => handlers.getTsumiCache!()
      if (isInspectGame && handlers.getCapturedObservations) observationGetter = () => handlers.getCapturedObservations!()
      const result = await runGame(
        { roles, seed, hasFirstGhost: config.hasFirstGhost, revoteConfig: config.revoteConfig, rules: config.rules, nameStyle: isInspectGame ? 'seat' as const : undefined },
        handlers,
      )
      state = result.state
      events = result.events
      gameRetarMs = result.timing?.retarMs ?? 0
      gameRetarCount = result.timing?.retarCount ?? 0
    } else {
      // full-adapter: 全フェーズ実行
      const handlers = fullAdapter({
        agents: agentsMap,
        defaultAgent: defaultAgent ?? new RuleBasedAgent(),
        wolfTeamAgent: wolfTeamAgent,
        masonTeamAgent: masonTeamAgent,
        enableRetar: config.enableRetar,
        enableTsumi: true,
        retarStartDay: req.mlStartDay,
        onRolesAssigned: onRolesAssignedWrapped,
        seed,
        roles,
        rules: config.rules,
      })
      tsumiCacheGetter = () => handlers.getTsumiCache!()
      const result = await runGame(
        { roles, seed, hasFirstGhost: config.hasFirstGhost, revoteConfig: config.revoteConfig, rules: config.rules, nameStyle: isInspectGame ? 'seat' as const : undefined },
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
    for (const [seat, agent] of neuralAgents) {
      const steps = agent.trajectory
      if (!steps) continue
      if (steps.length > 0) {
        steps[steps.length - 1].done = true
        const player = state.players.find(p => p.seat === seat)!
        steps[steps.length - 1].reward += terminalReward(player.role, state.result ?? '', config.rewardConfig)
      }
      const role = seatRoleMap?.get(seat) ?? state.players.find(p => p.seat === seat)?.role ?? 'unknown'
      individualSteps.push({ seat, role, steps: steps.map(serializeStep) })
    }

    const wSteps = (wolfTeamAgent as any)?.trajectory ?? []
    if (wSteps.length > 0) {
      wSteps[wSteps.length - 1].done = true
      wSteps[wSteps.length - 1].reward += terminalReward('werewolf', state.result ?? '', config.rewardConfig)
    }

    const mSteps = (masonTeamAgent as any)?.trajectory ?? []
    if (mSteps.length > 0) {
      mSteps[mSteps.length - 1].done = true
      mSteps[mSteps.length - 1].reward += terminalReward('mason', state.result ?? '', config.rewardConfig)
    }

    // Intermediate rewards
    for (const event of events) {
      const rewards = intermediateReward(event as import('../../lupa/types.ts').GameEvent, state, config.rewardConfig)
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

    // trueRoles注入（BCE auxiliary loss 用）
    const trueRoles = encodeTrueRoles(state.players)
    const trueRolesArray = Array.from(trueRoles)
    for (const entry of individualSteps) {
      for (const step of entry.steps) {
        step.trueRoles = trueRolesArray
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
      const howl = formatHowl(events as import('../../lupa/types.ts').GameEvent[], state, lupaConfig)
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

    // WRE Potential-Based Reward Shaping
    if (wreNet) {
      const gamma = config.gamma ?? 0.99
      // Individual agents (SerializedStep[] — observation is number[])
      for (const entry of individualSteps) {
        if (entry.steps.length < 2) continue
        const fIdx = wreFactionIndex(entry.role)
        const potentials = entry.steps.map(s =>
          wreNet.forward(new Float32Array(s.observation))[fIdx]
        )
        for (let t = 0; t < entry.steps.length - 1; t++) {
          entry.steps[t].reward += gamma * potentials[t + 1] - potentials[t]
        }
        entry.steps[entry.steps.length - 1].reward += -potentials[potentials.length - 1]
      }
      // Wolf collective (TrajectoryStep[] — observation is Float32Array)
      if (wSteps.length >= 2) {
        const potentials = wSteps.map((s: { observation: Float32Array }) => wreNet.forward(s.observation)[1])
        for (let t = 0; t < wSteps.length - 1; t++) {
          wSteps[t].reward += gamma * potentials[t + 1] - potentials[t]
        }
        wSteps[wSteps.length - 1].reward += -potentials[potentials.length - 1]
      }
      // Mason collective (TrajectoryStep[] — village faction)
      if (mSteps.length >= 2) {
        const potentials = mSteps.map((s: { observation: Float32Array }) => wreNet.forward(s.observation)[0])
        for (let t = 0; t < mSteps.length - 1; t++) {
          mSteps[t].reward += gamma * potentials[t + 1] - potentials[t]
        }
        mSteps[mSteps.length - 1].reward += -potentials[potentials.length - 1]
      }
    }

    // NN推論時間・回数の集計
    let totalInferMs = 0
    let totalInferCount = 0
    for (const s of neuralAgents.values()) {
      totalInferMs += s.inferMs
      totalInferCount += s.inferCount
    }
    if (wolfTeamAgent && 'inferMs' in wolfTeamAgent) {
      totalInferMs += (wolfTeamAgent as any).inferMs
      totalInferCount += (wolfTeamAgent as any).inferCount ?? 0
    }
    if (masonTeamAgent && 'inferMs' in masonTeamAgent) {
      totalInferMs += (masonTeamAgent as any).inferMs
      totalInferCount += (masonTeamAgent as any).inferCount ?? 0
    }

    const gameResult: SerializedGameResult = {
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
    }

    // inspect サンプリング: 対象 seed のゲームは howl + players + 全員の observation も返す
    if (isInspectGame) {
      gameResult.seed = seed
      gameResult.gameLength = state.day
      gameResult.howl = formatHowl(events as import('../../lupa/types.ts').GameEvent[], state, lupaConfig)
      gameResult.players = state.players.map(p => ({ seat: p.seat, role: p.role, alive: p.alive }))
      if (observationGetter) {
        gameResult.allObservations = observationGetter().map(o => ({
          seat: o.seat, role: o.role, day: o.day,
          observation: o.observation,
          proposals: o.proposals,
        }))
      }
    }

    results.push(gameResult)
  }

  return results
}

/** 役職 → WRE出力のインデックス (0=village_win, 1=wolf_win, 2=fox_win) */
function wreFactionIndex(role: string): number {
  if (role === 'werewolf' || role === 'fanatic') return 1
  if (role === 'werehamster' || role === 'immoralist') return 2
  return 0
}
