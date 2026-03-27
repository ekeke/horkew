/**
 * PPO Training Loop
 *
 * 自己対戦でゲームを生成し、PPOで重みを更新する。
 */

import type { SystemRole } from '../../types/index.ts'
import type { LupaConfig, RevoteConfig } from '../../lupa/types.ts'
import type { Strategy } from '../../lupa/strategy.ts'
import { runGame, runGameAsync } from '../../lupa/engine.ts'
import { analyzeFromEventsParallel, initRetarWorkerPool, terminateRetarWorkerPool } from '../../lupa/retar-node-bridge.ts'
import { NeuralNetwork } from './ml/nn.ts'
import { TfNeuralNetwork } from './ml/nn-tf.ts'
import { OBSERVATION_SIZE, TEAM_OBSERVATION_SIZE } from './observation.ts'
import { HEAD_SIZES, TEAM_HEAD_SIZES } from './action.ts'
import { FenrirStrategy, WolfTeamStrategy, MasonTeamStrategy } from './policy.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from '../../lupa/heuristic.ts'
import { terminalReward, intermediateReward, type RewardConfig, DEFAULT_REWARD_CONFIG } from './reward.ts'
import { processTrajectories, normalizeAdvantages, computeGAE, type TrajectoryStep, type ProcessedStep } from './ml/trajectory.ts'
import { saveCheckpoint, loadCheckpoint } from './ml/checkpoint.ts'
import { packWeights, initGameWorkerPool, terminateGameWorkerPool, gameWorkerPoolSize, generateGamesParallel, deserializeStep, type SharedWeights } from './parallel.ts'

// ============================================================
// Training Config
// ============================================================

export type TrainingConfig = {
  /** ゲーム構成 */
  roles: Record<string, number>
  /** バッチあたりのゲーム数 */
  gamesPerBatch: number
  /** PPOエポック数 */
  ppoEpochs: number
  /** ミニバッチサイズ */
  miniBatchSize: number
  /** PPOクリッピング */
  clipEpsilon: number
  /** Value loss係数 */
  valueLossCoeff: number
  /** Entropy bonus係数 */
  entropyCoeff: number
  /** 割引率 */
  gamma: number
  /** GAE lambda */
  lambda: number
  /** 総イテレーション数 */
  totalIterations: number
  /** 評価間隔 */
  evalInterval: number
  /** チェックポイント保存間隔 */
  checkpointInterval: number
  /** チェックポイント保存先 */
  checkpointDir: string
  /** 報酬設定 */
  rewardConfig: RewardConfig
  /** カリキュラムフェーズ切替 */
  phase1End: number   // ヒューリスティック相手フェーズ終了
  phase2End: number   // 自己対戦フェーズ終了
  /** 学習率 */
  learningRate: number
  /** Retar論理推論を有効化 */
  enableRetar: boolean
  /** 初日犠牲者あり */
  hasFirstGhost: boolean
  /** 再投票設定 */
  revoteConfig?: RevoteConfig
  /** ゲーム生成の並列ワーカー数（0で直列、未指定でauto） */
  numWorkers?: number
  /** Phase 1でMLにする役職（未指定時は偶数seat） */
  mlRoles?: SystemRole[]
}

export const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  // 14D猫: 14人、初日犠牲者あり、完全再投票→引き分け
  roles: {
    werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1,
    mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1,
  },
  hasFirstGhost: true,
  revoteConfig: { maxRevotes: 2, style: 'full_revote', tiebreaker: 'draw' },
  gamesPerBatch: 64,
  ppoEpochs: 4,
  miniBatchSize: 256,
  clipEpsilon: 0.2,
  valueLossCoeff: 0.5,
  entropyCoeff: 0.01,
  gamma: 0.99,
  lambda: 0.95,
  totalIterations: 100000,
  evalInterval: 1000,
  checkpointInterval: 5000,
  checkpointDir: './checkpoints',
  rewardConfig: DEFAULT_REWARD_CONFIG,
  phase1End: 10000,
  phase2End: 50000,
  learningRate: 3e-4,
  enableRetar: true,
}

// ============================================================
// Network Configuration
// ============================================================

const NETWORK_CONFIG = {
  inputSize: OBSERVATION_SIZE,
  hiddenSizes: [512, 256],
  heads: {
    night: HEAD_SIZES.night,
    claim: HEAD_SIZES.claim,
    vote: HEAD_SIZES.vote,
    comm: HEAD_SIZES.comm,
    leader: HEAD_SIZES.leader,
    target: HEAD_SIZES.target,
  },
  sigmoidHeads: {
    propose: HEAD_SIZES.propose,
    predict: HEAD_SIZES.predict,
  },
}

// 狼チームネットワーク: attack_target + attacker + 昼行動ヘッド
const WOLF_TEAM_NETWORK_CONFIG = {
  inputSize: TEAM_OBSERVATION_SIZE,
  hiddenSizes: [512, 256],
  heads: {
    attack_target: TEAM_HEAD_SIZES.attack_target,
    attacker: TEAM_HEAD_SIZES.attacker,
    claim: HEAD_SIZES.claim,
    vote: HEAD_SIZES.vote,
    comm: HEAD_SIZES.comm,
    leader: HEAD_SIZES.leader,
    target: HEAD_SIZES.target,
  },
  sigmoidHeads: {
    propose: HEAD_SIZES.propose,
    predict: HEAD_SIZES.predict,
  },
}

// 共有者チームネットワーク: 昼行動ヘッドのみ
const MASON_TEAM_NETWORK_CONFIG = {
  inputSize: TEAM_OBSERVATION_SIZE,
  hiddenSizes: [512, 256],
  heads: {
    claim: HEAD_SIZES.claim,
    vote: HEAD_SIZES.vote,
    comm: HEAD_SIZES.comm,
    leader: HEAD_SIZES.leader,
    target: HEAD_SIZES.target,
  },
  sigmoidHeads: {
    propose: HEAD_SIZES.propose,
    predict: HEAD_SIZES.predict,
  },
}

/** 推論用（ゲーム内、ピュアJS — 単一forward が速い） */
export function createNetwork(): NeuralNetwork {
  return new NeuralNetwork(NETWORK_CONFIG)
}

export function createWolfTeamNetwork(): NeuralNetwork {
  return new NeuralNetwork(WOLF_TEAM_NETWORK_CONFIG)
}

export function createMasonTeamNetwork(): NeuralNetwork {
  return new NeuralNetwork(MASON_TEAM_NETWORK_CONFIG)
}

/** 学習用（PPOバッチ更新、tf.js GPU加速） */
export function createTfNetwork(lr: number = 3e-4): TfNeuralNetwork {
  return new TfNeuralNetwork(NETWORK_CONFIG, lr)
}

export function createWolfTeamTfNetwork(lr: number = 3e-4): TfNeuralNetwork {
  return new TfNeuralNetwork(WOLF_TEAM_NETWORK_CONFIG, lr)
}

export function createMasonTeamTfNetwork(lr: number = 3e-4): TfNeuralNetwork {
  return new TfNeuralNetwork(MASON_TEAM_NETWORK_CONFIG, lr)
}

// ============================================================
// Game Generation
// ============================================================

type GameTrajectories = {
  /** 個人エージェントのトラジェクトリ: seat → steps */
  steps: Map<number, TrajectoryStep[]>
  /** 狼チームのトラジェクトリ (チーム全体で1つ) */
  wolfTeamSteps: TrajectoryStep[]
  /** 共有者チームのトラジェクトリ (チーム全体で1つ) */
  masonTeamSteps: TrajectoryStep[]
  result: string
}

type GameAgents = {
  strategies: Map<number, FenrirStrategy>
  defaultStrategy?: Strategy
  onRolesAssigned?: (seatRoles: Map<number, SystemRole>) => void
  wolfTeamStrategy?: WolfTeamStrategy
  masonTeamStrategy?: MasonTeamStrategy
}

function generateGame(
  config: TrainingConfig,
  agents: GameAgents,
  seed: number,
): GameTrajectories {
  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])

  const strategiesMap = new Map<number, Strategy>(agents.strategies)
  const lupaConfig: LupaConfig = {
    roles,
    seed,
    strategies: strategiesMap,
    defaultStrategy: agents.defaultStrategy,
    onRolesAssigned: agents.onRolesAssigned ? (seatRoles) => {
      agents.onRolesAssigned!(seatRoles)
      // フックが agents.strategies に追加した分を lupaConfig.strategies にも反映
      for (const [seat, s] of agents.strategies) {
        if (!strategiesMap.has(seat)) strategiesMap.set(seat, s)
      }
    } : undefined,
    enableRetar: config.enableRetar,
    hasFirstGhost: config.hasFirstGhost,
    revoteConfig: config.revoteConfig,
    wolfTeamStrategy: agents.wolfTeamStrategy,
    masonTeamStrategy: agents.masonTeamStrategy,
  }

  // Reset trajectories
  for (const s of agents.strategies.values()) s.resetTrajectory?.()
  agents.wolfTeamStrategy?.resetTrajectory()
  agents.masonTeamStrategy?.resetTrajectory()

  const { state, events } = runGame(lupaConfig)

  // Collect individual trajectories and add terminal rewards
  const allSteps = new Map<number, TrajectoryStep[]>()
  for (const [seat, strategy] of agents.strategies) {
    const steps = strategy.trajectory
    if (steps.length > 0) {
      steps[steps.length - 1].done = true
      const player = state.players.find(p => p.seat === seat)!
      const reward = terminalReward(player.role, state.result ?? '', config.rewardConfig)
      steps[steps.length - 1].reward += reward
    }
    allSteps.set(seat, steps)
  }

  // Collect wolf team trajectories
  const wolfTeamSteps = agents.wolfTeamStrategy?.trajectory ?? []
  if (wolfTeamSteps.length > 0) {
    wolfTeamSteps[wolfTeamSteps.length - 1].done = true
    // 狼チーム報酬: 狼陣営の結果
    const wolfReward = terminalReward('werewolf', state.result ?? '', config.rewardConfig)
    wolfTeamSteps[wolfTeamSteps.length - 1].reward += wolfReward
  }

  // Collect mason team trajectories
  const masonTeamSteps = agents.masonTeamStrategy?.trajectory ?? []
  if (masonTeamSteps.length > 0) {
    masonTeamSteps[masonTeamSteps.length - 1].done = true
    // 共有者チーム報酬: 村陣営の結果
    const masonReward = terminalReward('mason', state.result ?? '', config.rewardConfig)
    masonTeamSteps[masonTeamSteps.length - 1].reward += masonReward
  }

  // Add intermediate rewards
  for (const event of events) {
    const rewards = intermediateReward(event, state, config.rewardConfig)
    for (const [seat, reward] of rewards) {
      // Individual agents
      const steps = allSteps.get(seat)
      if (steps && steps.length > 0) {
        steps[steps.length - 1].reward += reward
      }
      // Wolf team: aggregate wolf rewards
      const player = state.players.find(p => p.seat === seat)
      if (player && (player.role === 'werewolf') && wolfTeamSteps.length > 0) {
        wolfTeamSteps[wolfTeamSteps.length - 1].reward += reward
      }
      // Mason team: aggregate mason rewards
      if (player && (player.role === 'mason') && masonTeamSteps.length > 0) {
        masonTeamSteps[masonTeamSteps.length - 1].reward += reward
      }
    }
  }

  return {
    steps: allSteps,
    wolfTeamSteps,
    masonTeamSteps,
    result: state.result ?? 'unknown',
  }
}

/** 非同期版: runGameAsync + 並列Retarを使用 */
async function generateGameAsync(
  config: TrainingConfig,
  agents: GameAgents,
  seed: number,
): Promise<GameTrajectories> {
  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])

  const strategiesMap = new Map<number, Strategy>(agents.strategies)
  const lupaConfig: LupaConfig = {
    roles,
    seed,
    strategies: strategiesMap,
    defaultStrategy: agents.defaultStrategy,
    onRolesAssigned: agents.onRolesAssigned ? (seatRoles) => {
      agents.onRolesAssigned!(seatRoles)
      for (const [seat, s] of agents.strategies) {
        if (!strategiesMap.has(seat)) strategiesMap.set(seat, s)
      }
    } : undefined,
    enableRetar: config.enableRetar,
    hasFirstGhost: config.hasFirstGhost,
    revoteConfig: config.revoteConfig,
    wolfTeamStrategy: agents.wolfTeamStrategy,
    masonTeamStrategy: agents.masonTeamStrategy,
    retarFn: analyzeFromEventsParallel,
  }

  for (const s of agents.strategies.values()) s.resetTrajectory?.()
  agents.wolfTeamStrategy?.resetTrajectory()
  agents.masonTeamStrategy?.resetTrajectory()

  const { state, events } = await runGameAsync(lupaConfig)

  // 以降はgenerateGameと同一のトラジェクトリ収集
  const allSteps = new Map<number, TrajectoryStep[]>()
  for (const [seat, strategy] of agents.strategies) {
    const steps = strategy.trajectory
    if (steps.length > 0) {
      steps[steps.length - 1].done = true
      const player = state.players.find(p => p.seat === seat)!
      steps[steps.length - 1].reward += terminalReward(player.role, state.result ?? '', config.rewardConfig)
    }
    allSteps.set(seat, steps)
  }
  const wolfTeamSteps = agents.wolfTeamStrategy?.trajectory ?? []
  if (wolfTeamSteps.length > 0) {
    wolfTeamSteps[wolfTeamSteps.length - 1].done = true
    wolfTeamSteps[wolfTeamSteps.length - 1].reward += terminalReward('werewolf', state.result ?? '', config.rewardConfig)
  }
  const masonTeamSteps = agents.masonTeamStrategy?.trajectory ?? []
  if (masonTeamSteps.length > 0) {
    masonTeamSteps[masonTeamSteps.length - 1].done = true
    masonTeamSteps[masonTeamSteps.length - 1].reward += terminalReward('mason', state.result ?? '', config.rewardConfig)
  }
  for (const event of events) {
    const rewards = intermediateReward(event, state, config.rewardConfig)
    for (const [seat, reward] of rewards) {
      const steps = allSteps.get(seat)
      if (steps && steps.length > 0) steps[steps.length - 1].reward += reward
      const player = state.players.find(p => p.seat === seat)
      if (player?.role === 'werewolf' && wolfTeamSteps.length > 0) wolfTeamSteps[wolfTeamSteps.length - 1].reward += reward
      if (player?.role === 'mason' && masonTeamSteps.length > 0) masonTeamSteps[masonTeamSteps.length - 1].reward += reward
    }
  }
  return { steps: allSteps, wolfTeamSteps, masonTeamSteps, result: state.result ?? 'unknown' }
}

// ============================================================
// PPO Update (tf.js GPU バッチ)
// ============================================================

function ppoUpdate(
  tfNetwork: TfNeuralNetwork,
  batch: ProcessedStep[],
  config: TrainingConfig,
): { policyLoss: number, valueLoss: number, entropy: number } {
  if (batch.length === 0) return { policyLoss: 0, valueLoss: 0, entropy: 0 }

  let totalPolicyLoss = 0
  let totalValueLoss = 0
  let totalEntropy = 0
  let batchCount = 0

  // Shuffle batch
  for (let i = batch.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[batch[i], batch[j]] = [batch[j], batch[i]]
  }

  // Mini-batches → tf.js GPU
  for (let start = 0; start < batch.length; start += config.miniBatchSize) {
    const end = Math.min(start + config.miniBatchSize, batch.length)
    const miniBatch = batch.slice(start, end)

    const result = tfNetwork.trainBatch({
      observations: miniBatch.map(s => s.observation),
      actionHeads: miniBatch.map(s => s.actionHead),
      actionIndices: miniBatch.map(s => s.actionIdx),
      oldLogProbs: miniBatch.map(s => s.logProb),
      advantages: miniBatch.map(s => s.advantage),
      returns: miniBatch.map(s => s.returnValue),
      sigmoidActions: miniBatch.map(s => s.sigmoidActions),
      clipEpsilon: config.clipEpsilon,
      valueLossCoeff: config.valueLossCoeff,
      entropyCoeff: config.entropyCoeff,
    })

    totalPolicyLoss += result.policyLoss
    totalValueLoss += result.valueLoss
    totalEntropy += result.entropy
    batchCount++
  }

  return {
    policyLoss: totalPolicyLoss / Math.max(batchCount, 1),
    valueLoss: totalValueLoss / Math.max(batchCount, 1),
    entropy: totalEntropy / Math.max(batchCount, 1),
  }
}

// ============================================================
// Evaluation
// ============================================================

export function evaluate(
  network: NeuralNetwork,
  config: TrainingConfig,
  numGames: number = 50,
  wolfTeamNet?: NeuralNetwork,
  masonTeamNet?: NeuralNetwork,
): { winRates: Record<string, number>, avgGameLength: number, avgElapsedMs: number } {
  const heuristic = new HeuristicStrategy()
  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])
  const totalPlayers = Array.from(roles.values()).reduce((a, b) => a + b, 0)

  let totalGames = 0
  let totalLength = 0
  let totalElapsed = 0
  const resultCounts: Record<string, number> = {}

  const mlRolesSet = config.mlRoles ? new Set(config.mlRoles) : null

  for (let i = 0; i < numGames; i++) {
    const strategies = new Map<number, any>()

    // mlRoles未指定: 従来の偶数seat方式
    if (!mlRolesSet) {
      for (let seat = 1; seat <= totalPlayers; seat++) {
        if (seat % 2 === 0) {
          strategies.set(seat, new FenrirStrategy(network, { explore: false }))
        } else {
          strategies.set(seat, heuristic)
        }
      }
    }

    const onRolesAssigned = mlRolesSet ? (seatRoles: Map<number, SystemRole>) => {
      for (const [seat, role] of seatRoles) {
        if (mlRolesSet.has(role)) {
          strategies.set(seat, new FenrirStrategy(network, { explore: false }))
        } else {
          strategies.set(seat, heuristic)
        }
      }
    } : undefined

    const lupaConfig: LupaConfig = {
      roles,
      seed: 10000 + i,
      strategies,
      defaultStrategy: heuristic,
      onRolesAssigned,
      enableRetar: config.enableRetar,
      hasFirstGhost: config.hasFirstGhost,
      revoteConfig: config.revoteConfig,
      wolfTeamStrategy: wolfTeamNet
        ? new WolfTeamStrategy(wolfTeamNet, { explore: false })
        : new WolfTeamHeuristic(),
      masonTeamStrategy: masonTeamNet
        ? new MasonTeamStrategy(masonTeamNet, { explore: false })
        : new MasonTeamHeuristic(),
    }
    const t0 = performance.now()
    const { state } = runGame(lupaConfig)
    totalElapsed += performance.now() - t0

    const result = state.result ?? 'unknown'
    resultCounts[result] = (resultCounts[result] ?? 0) + 1
    totalLength += state.day
    totalGames++
  }

  return {
    winRates: Object.fromEntries(
      Object.entries(resultCounts).map(([k, v]) => [k, v / totalGames])
    ),
    avgGameLength: totalLength / totalGames,
    avgElapsedMs: totalElapsed / totalGames,
  }
}

// ============================================================
// Main Training Loop
// ============================================================

function log(msg: string): void {
  process.stderr.write(msg + '\n')
}

import { readFileSync, readdirSync, existsSync } from 'node:fs'

/**
 * チェックポイントディレクトリから最新のイテレーション番号を検出し、
 * 3ネットワークのパスを返す。見つからなければnull。
 */
function findLatestCheckpoint(dir: string): {
  iteration: number
  individual: string
  wolfTeam: string
  masonTeam: string
} | null {
  if (!existsSync(dir)) return null

  const files = readdirSync(dir)

  // final があればそれを優先
  if (files.includes('final.json') && files.includes('wolf_team_final.json') && files.includes('mason_team_final.json')) {
    // finalのiterationを読む
    const raw = JSON.parse(readFileSync(`${dir}/final.json`, 'utf-8'))
    return {
      iteration: raw.metadata?.iteration ?? 0,
      individual: `${dir}/final.json`,
      wolfTeam: `${dir}/wolf_team_final.json`,
      masonTeam: `${dir}/mason_team_final.json`,
    }
  }

  // checkpoint_<iter>.json から最大iterを探す
  let maxIter = 0
  for (const f of files) {
    const m = f.match(/^checkpoint_(\d+)\.json$/)
    if (m) {
      const iter = parseInt(m[1])
      if (iter > maxIter) maxIter = iter
    }
  }

  if (maxIter === 0) return null

  const individual = `${dir}/checkpoint_${maxIter}.json`
  const wolfTeam = `${dir}/wolf_team_${maxIter}.json`
  const masonTeam = `${dir}/mason_team_${maxIter}.json`

  if (!existsSync(individual) || !existsSync(wolfTeam) || !existsSync(masonTeam)) {
    return null
  }

  return { iteration: maxIter, individual, wolfTeam, masonTeam }
}

export async function train(config: TrainingConfig = DEFAULT_TRAINING_CONFIG, resumeDir?: string): Promise<void> {
  log('Fenrir Training Started')
  log(`Observation size: individual=${OBSERVATION_SIZE}, team=${TEAM_OBSERVATION_SIZE}`)

  // === 個人エージェント ===
  const network = createNetwork()
  const tfNetwork = createTfNetwork(config.learningRate)
  log(`Individual network: ${network.totalParams} params`)

  // === 狼チームエージェント ===
  const wolfTeamNet = createWolfTeamNetwork()
  const wolfTeamTf = createWolfTeamTfNetwork(config.learningRate)
  log(`Wolf team network: ${wolfTeamNet.totalParams} params`)

  // === 共有者チームエージェント ===
  const masonTeamNet = createMasonTeamNetwork()
  const masonTeamTf = createMasonTeamTfNetwork(config.learningRate)
  log(`Mason team network: ${masonTeamNet.totalParams} params`)

  // === Retarワーカープール ===
  if (config.enableRetar) {
    initRetarWorkerPool()
    log('Retar worker pool initialized')
  }

  // === ゲーム生成ワーカープール ===
  if (config.numWorkers !== undefined) {
    initGameWorkerPool(config.numWorkers === -1 ? undefined : config.numWorkers)
  }

  // === Resume ===
  let startIter = 1
  if (resumeDir) {
    const ckpt = findLatestCheckpoint(resumeDir)
    if (ckpt) {
      loadCheckpoint(network, ckpt.individual)
      loadCheckpoint(wolfTeamNet, ckpt.wolfTeam)
      loadCheckpoint(masonTeamNet, ckpt.masonTeam)
      startIter = ckpt.iteration + 1
      log(`Resumed from iteration ${ckpt.iteration} (${resumeDir})`)
    } else {
      log(`Warning: no checkpoint found in ${resumeDir}, starting from scratch`)
    }
  }

  // Pool for self-play (past checkpoints)
  const pool: Map<string, Float32Array>[] = []

  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])
  const totalPlayers = Array.from(roles.values()).reduce((a, b) => a + b, 0)

  const trainingStart = performance.now()

  for (let iter = startIter; iter <= config.totalIterations; iter++) {
    const iterStart = performance.now()

    const useHeuristic = iter <= config.phase1End
    const usePool = iter > config.phase2End
    const phase = useHeuristic ? 1 : usePool ? 3 : 2

    const allIndividualTrajectories: ProcessedStep[] = []
    const allWolfTeamTrajectories: ProcessedStep[] = []
    const allMasonTeamTrajectories: ProcessedStep[] = []

    // === タイミング計測 ===
    const tGameStart = performance.now()

    const seeds = Array.from({ length: config.gamesPerBatch }, (_, g) => iter * config.gamesPerBatch + g)

    if (gameWorkerPoolSize() > 0) {
      // === 並列パス: worker_threads でゲーム生成 ===
      const sharedWeights = packWeights(network)
      const sharedWolfWeights = !useHeuristic ? packWeights(wolfTeamNet) : undefined
      const sharedMasonWeights = !useHeuristic ? packWeights(masonTeamNet) : undefined
      const poolSharedWeights = (usePool && pool.length > 0)
        ? pool.map(w => { const net = createNetwork(); net.loadWeights(w); return packWeights(net) })
        : undefined

      const serializedResults = await generateGamesParallel(
        {
          weights: sharedWeights,
          wolfTeamWeights: sharedWolfWeights,
          masonTeamWeights: sharedMasonWeights,
          poolWeights: poolSharedWeights,
          trainingConfig: config,
          phase,
          mlRoles: config.mlRoles,
        },
        seeds,
      )

      for (const game of serializedResults) {
        // Deserialize individual steps
        const stepsMap = new Map<number, TrajectoryStep[]>()
        for (const { seat, steps } of game.individualSteps) {
          stepsMap.set(seat, steps.map(deserializeStep))
        }
        allIndividualTrajectories.push(
          ...processTrajectories(stepsMap, config.gamma, config.lambda)
        )

        // Wolf team
        if (game.wolfTeamSteps.length > 0) {
          const wolfSteps = game.wolfTeamSteps.map(deserializeStep)
          allWolfTeamTrajectories.push(...computeGAE(wolfSteps, config.gamma, config.lambda, 0))
        }

        // Mason team
        if (game.masonTeamSteps.length > 0) {
          const masonSteps = game.masonTeamSteps.map(deserializeStep)
          allMasonTeamTrajectories.push(...computeGAE(masonSteps, config.gamma, config.lambda, 0))
        }
      }
    } else {
      // === 直列フォールバック ===
      const useAsync = config.enableRetar
      const gamePromises: Array<Promise<{ game: GameTrajectories, strategies: Map<number, FenrirStrategy>, wolfTeamStrategy?: WolfTeamStrategy, masonTeamStrategy?: MasonTeamStrategy }>> = []

      for (const seed of seeds) {
        const strategies = new Map<number, FenrirStrategy>()
        const mlRolesSet = config.mlRoles ? new Set(config.mlRoles) : null

        if (!useHeuristic || !mlRolesSet) {
          for (let seat = 1; seat <= totalPlayers; seat++) {
            if (useHeuristic && seat % 2 !== 0) continue

            if (usePool && pool.length > 0 && seat % 3 === 0) {
              const pastWeights = pool[Math.floor(Math.random() * pool.length)]
              const pastNet = createNetwork()
              pastNet.loadWeights(pastWeights)
              strategies.set(seat, new FenrirStrategy(pastNet, { explore: true }))
            } else {
              strategies.set(seat, new FenrirStrategy(network, { explore: true }))
            }
          }
        }

        let wolfTeamStrategy: WolfTeamStrategy | undefined
        let masonTeamStrategy: MasonTeamStrategy | undefined
        if (!useHeuristic) {
          wolfTeamStrategy = new WolfTeamStrategy(wolfTeamNet, { explore: true })
          masonTeamStrategy = new MasonTeamStrategy(masonTeamNet, { explore: true })
        }

        const defaultStrategy = useHeuristic ? new HeuristicStrategy() : undefined
        const onRolesAssigned = (useHeuristic && mlRolesSet) ? (seatRoles: Map<number, SystemRole>) => {
          for (const [seat, role] of seatRoles) {
            if (mlRolesSet.has(role)) {
              strategies.set(seat, new FenrirStrategy(network, { explore: true }))
            }
          }
        } : undefined
        const agents = { strategies, defaultStrategy, onRolesAssigned, wolfTeamStrategy, masonTeamStrategy }

        if (useAsync) {
          gamePromises.push(
            generateGameAsync(config, agents, seed).then(game => ({ game, strategies, wolfTeamStrategy, masonTeamStrategy }))
          )
        } else {
          const game = generateGame(config, agents, seed)
          gamePromises.push(Promise.resolve({ game, strategies, wolfTeamStrategy, masonTeamStrategy }))
        }
      }

      const gameResults = await Promise.all(gamePromises)

      for (const { game, strategies, wolfTeamStrategy, masonTeamStrategy } of gameResults) {
        const currentNetSteps = new Map<number, TrajectoryStep[]>()
        for (const [seat, steps] of game.steps) {
          const strategy = strategies.get(seat)
          if (strategy && strategy.network === network) {
            currentNetSteps.set(seat, steps)
          }
        }
        allIndividualTrajectories.push(
          ...processTrajectories(currentNetSteps, config.gamma, config.lambda)
        )
        if (wolfTeamStrategy && game.wolfTeamSteps.length > 0) {
          allWolfTeamTrajectories.push(...computeGAE(game.wolfTeamSteps, config.gamma, config.lambda, 0))
        }
        if (masonTeamStrategy && game.masonTeamSteps.length > 0) {
          allMasonTeamTrajectories.push(...computeGAE(game.masonTeamSteps, config.gamma, config.lambda, 0))
        }
      }
    }
    const tGameEnd = performance.now()

    const tGaeEnd = performance.now()

    // === PPO更新: 3ネットワーク独立 ===
    const tPpoStart = performance.now()

    // 個人エージェント
    normalizeAdvantages(allIndividualTrajectories)
    tfNetwork.loadWeights(network.cloneWeights())
    let totalPolicyLoss = 0
    for (let epoch = 0; epoch < config.ppoEpochs; epoch++) {
      const { policyLoss } = ppoUpdate(tfNetwork, allIndividualTrajectories, config)
      totalPolicyLoss += policyLoss
    }
    network.loadWeights(tfNetwork.cloneWeights())

    // 狼チーム
    if (allWolfTeamTrajectories.length > 0) {
      normalizeAdvantages(allWolfTeamTrajectories)
      wolfTeamTf.loadWeights(wolfTeamNet.cloneWeights())
      for (let epoch = 0; epoch < config.ppoEpochs; epoch++) {
        ppoUpdate(wolfTeamTf, allWolfTeamTrajectories, config)
      }
      wolfTeamNet.loadWeights(wolfTeamTf.cloneWeights())
    }

    // 共有者チーム
    if (allMasonTeamTrajectories.length > 0) {
      normalizeAdvantages(allMasonTeamTrajectories)
      masonTeamTf.loadWeights(masonTeamNet.cloneWeights())
      for (let epoch = 0; epoch < config.ppoEpochs; epoch++) {
        ppoUpdate(masonTeamTf, allMasonTeamTrajectories, config)
      }
      masonTeamNet.loadWeights(masonTeamTf.cloneWeights())
    }

    const tPpoEnd = performance.now()

    // タイミング
    const gameMs = tGameEnd - tGameStart
    const gaeMs = tGaeEnd - tGameEnd
    const ppoMs = tPpoEnd - tPpoStart

    // Progress bar
    const iterMs = performance.now() - iterStart
    const elapsed = performance.now() - trainingStart
    const pct = iter / config.totalIterations
    const barWidth = 30
    const filled = Math.round(pct * barWidth)
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled)
    const pctStr = (pct * 100).toFixed(1).padStart(5)
    const etaSec = iter > 0 ? ((elapsed / iter) * (config.totalIterations - iter) / 1000) : 0
    const etaStr = etaSec < 60 ? `${etaSec.toFixed(0)}s`
      : etaSec < 3600 ? `${(etaSec / 60).toFixed(1)}m`
      : `${(etaSec / 3600).toFixed(1)}h`
    const avgPL = (totalPolicyLoss / config.ppoEpochs)
    const totalSteps = allIndividualTrajectories.length + allWolfTeamTrajectories.length + allMasonTeamTrajectories.length
    const phaseLabel = phase === 1 ? 'heuristic' : phase === 2 ? 'self-play' : 'pool'
    const gamePct = (gameMs / iterMs * 100).toFixed(0)
    const ppoPct = (ppoMs / iterMs * 100).toFixed(0)
    process.stderr.write(
      `\r\x1b[K  ${bar} ${pctStr}% ${iter}/${config.totalIterations} | ` +
      `${iterMs.toFixed(0)}ms (game${gamePct}% ppo${ppoPct}%) ETA ${etaStr} | ` +
      `loss=${avgPL.toFixed(4)} steps=${totalSteps} | ` +
      `phase ${phase} (${phaseLabel})`
    )

    // Evaluation
    if (iter % config.evalInterval === 0) {
      process.stderr.write('\r\x1b[K')
      const evalResult = evaluate(network, config, 30, wolfTeamNet, masonTeamNet)
      log(
        `[${iter}] Eval: ${Object.entries(evalResult.winRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')} ` +
        `avgLen=${evalResult.avgGameLength.toFixed(1)} ${evalResult.avgElapsedMs.toFixed(0)}ms/game`
      )
    }

    // Checkpoint
    if (iter % config.checkpointInterval === 0) {
      process.stderr.write('\r\x1b[K')
      saveCheckpoint(network, `${config.checkpointDir}/checkpoint_${iter}.json`, { iteration: iter, winRate: 0 })
      saveCheckpoint(wolfTeamNet, `${config.checkpointDir}/wolf_team_${iter}.json`, { iteration: iter, winRate: 0 })
      saveCheckpoint(masonTeamNet, `${config.checkpointDir}/mason_team_${iter}.json`, { iteration: iter, winRate: 0 })
      pool.push(network.cloneWeights())
      if (pool.length > 5) pool.shift()
      log(`[${iter}] Checkpoints saved`)
    }
  }

  process.stderr.write('\r\x1b[K')

  // Final save
  saveCheckpoint(network, `${config.checkpointDir}/final.json`, { iteration: config.totalIterations, winRate: 0 })
  saveCheckpoint(wolfTeamNet, `${config.checkpointDir}/wolf_team_final.json`, { iteration: config.totalIterations, winRate: 0 })
  saveCheckpoint(masonTeamNet, `${config.checkpointDir}/mason_team_final.json`, { iteration: config.totalIterations, winRate: 0 })
  const totalSec = (performance.now() - trainingStart) / 1000
  const timeStr = totalSec < 60 ? `${totalSec.toFixed(1)}s`
    : totalSec < 3600 ? `${(totalSec / 60).toFixed(1)}m`
    : `${(totalSec / 3600).toFixed(1)}h`
  tfNetwork.dispose()
  wolfTeamTf.dispose()
  masonTeamTf.dispose()
  if (config.enableRetar) terminateRetarWorkerPool()
  terminateGameWorkerPool()
  log(`Training complete! (${timeStr})`)
}
