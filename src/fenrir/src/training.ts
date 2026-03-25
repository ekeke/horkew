/**
 * PPO Training Loop
 *
 * 自己対戦でゲームを生成し、PPOで重みを更新する。
 */

import type { SystemRole } from '../../types/index.ts'
import type { LupaConfig } from '../../lupa/types.ts'
import { runGame } from '../../lupa/engine.ts'
import { NeuralNetwork } from './ml/nn.ts'
import { TfNeuralNetwork } from './ml/nn-tf.ts'
import { OBSERVATION_SIZE } from './observation.ts'
import { HEAD_SIZES } from './action.ts'
import { FenrirStrategy } from './policy.ts'
import { HeuristicStrategy } from '../../lupa/heuristic.ts'
import { terminalReward, intermediateReward, type RewardConfig, DEFAULT_REWARD_CONFIG } from './reward.ts'
import { processTrajectories, normalizeAdvantages, type TrajectoryStep, type ProcessedStep } from './ml/trajectory.ts'
import { saveCheckpoint } from './ml/checkpoint.ts'

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
}

export const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  roles: { werewolf: 2, villager: 4, seer: 1, medium: 1, bodyguard: 1, mason: 2 },
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

/** 推論用（ゲーム内、ピュアJS — 単一forward が速い） */
export function createNetwork(): NeuralNetwork {
  return new NeuralNetwork(NETWORK_CONFIG)
}

/** 学習用（PPOバッチ更新、tf.js GPU加速） */
export function createTfNetwork(lr: number = 3e-4): TfNeuralNetwork {
  return new TfNeuralNetwork(NETWORK_CONFIG, lr)
}

// ============================================================
// Game Generation
// ============================================================

type GameTrajectories = {
  steps: Map<number, TrajectoryStep[]>  // seat → steps
  result: string
}

function generateGame(
  config: TrainingConfig,
  strategies: Map<number, FenrirStrategy>,
  seed: number,
): GameTrajectories {
  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])

  const lupaConfig: LupaConfig = {
    roles,
    seed,
    strategies: new Map(strategies),
    enableRetar: config.enableRetar,
  }

  // Reset trajectories
  for (const s of strategies.values()) s.resetTrajectory()

  const { state, events } = runGame(lupaConfig)

  // Collect trajectories and add terminal rewards
  const allSteps = new Map<number, TrajectoryStep[]>()
  for (const [seat, strategy] of strategies) {
    const steps = strategy.trajectory
    if (steps.length > 0) {
      // Mark last step as done
      steps[steps.length - 1].done = true
      // Add terminal reward
      const player = state.players.find(p => p.seat === seat)!
      const reward = terminalReward(player.role, state.result ?? '', config.rewardConfig)
      steps[steps.length - 1].reward += reward
    }
    allSteps.set(seat, steps)
  }

  // Add intermediate rewards
  for (const event of events) {
    const rewards = intermediateReward(event, state, config.rewardConfig)
    for (const [seat, reward] of rewards) {
      const steps = allSteps.get(seat)
      if (steps && steps.length > 0) {
        steps[steps.length - 1].reward += reward
      }
    }
  }

  return {
    steps: allSteps,
    result: state.result ?? 'unknown',
  }
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
): { winRates: Record<string, number>, avgGameLength: number } {
  const heuristic = new HeuristicStrategy()
  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])
  const totalPlayers = Array.from(roles.values()).reduce((a, b) => a + b, 0)

  let totalGames = 0
  let totalLength = 0
  const resultCounts: Record<string, number> = {}

  for (let i = 0; i < numGames; i++) {
    // ML plays half the seats, heuristic plays the other half
    const strategies = new Map<number, any>()
    for (let seat = 1; seat <= totalPlayers; seat++) {
      if (seat % 2 === 0) {
        strategies.set(seat, new FenrirStrategy(network, { explore: false }))
      } else {
        strategies.set(seat, heuristic)
      }
    }

    const lupaConfig: LupaConfig = { roles, seed: 10000 + i, strategies, enableRetar: config.enableRetar }
    const { state } = runGame(lupaConfig)

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
  }
}

// ============================================================
// Main Training Loop
// ============================================================

function log(msg: string): void {
  process.stderr.write(msg + '\n')
}

export function train(config: TrainingConfig = DEFAULT_TRAINING_CONFIG): void {
  log('Fenrir Training Started')
  log(`Observation size: ${OBSERVATION_SIZE}`)

  // 推論用 (ピュアJS、ゲーム内 forward が速い)
  const network = createNetwork()
  // 学習用 (tf.js GPU、バッチ PPO が速い)
  const tfNetwork = createTfNetwork(config.learningRate)
  log(`Network params: ${network.totalParams} (JS inference + tf.js GPU training)`)

  // Pool for self-play (past checkpoints)
  const pool: Map<string, Float32Array>[] = []

  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])
  const totalPlayers = Array.from(roles.values()).reduce((a, b) => a + b, 0)

  const trainingStart = performance.now()

  for (let iter = 1; iter <= config.totalIterations; iter++) {
    const iterStart = performance.now()

    // Determine opponent strategy based on curriculum phase
    const useHeuristic = iter <= config.phase1End
    const usePool = iter > config.phase2End
    const phase = useHeuristic ? 1 : usePool ? 3 : 2

    // Create strategies for all seats
    const allTrajectories: ProcessedStep[] = []

    for (let g = 0; g < config.gamesPerBatch; g++) {
      const strategies = new Map<number, FenrirStrategy>()

      for (let seat = 1; seat <= totalPlayers; seat++) {
        if (useHeuristic && seat % 2 !== 0) {
          // Phase 1: half heuristic, half ML
          // heuristic seats won't be in strategies map → engine uses default
          continue
        }

        if (usePool && pool.length > 0 && seat % 3 === 0) {
          // Phase 3: some seats use past checkpoints
          const pastWeights = pool[Math.floor(Math.random() * pool.length)]
          const pastNet = createNetwork()
          pastNet.loadWeights(pastWeights)
          strategies.set(seat, new FenrirStrategy(pastNet, { explore: true }))
        } else {
          strategies.set(seat, new FenrirStrategy(network, { explore: true }))
        }
      }

      const seed = iter * config.gamesPerBatch + g
      const game = generateGame(config, strategies, seed)

      // Process trajectories (only for current network's seats)
      const currentNetSteps = new Map<number, TrajectoryStep[]>()
      for (const [seat, steps] of game.steps) {
        const strategy = strategies.get(seat)
        if (strategy && strategy.network === network) {
          currentNetSteps.set(seat, steps)
        }
      }

      const processed = processTrajectories(currentNetSteps, config.gamma, config.lambda)
      allTrajectories.push(...processed)
    }

    // Normalize advantages
    normalizeAdvantages(allTrajectories)

    // PPO update (tf.js GPU)
    // 推論ネットワークの重みを学習ネットワークに同期
    tfNetwork.loadWeights(network.cloneWeights())

    let totalPolicyLoss = 0
    let totalValueLoss = 0
    let totalEntropy = 0

    for (let epoch = 0; epoch < config.ppoEpochs; epoch++) {
      const { policyLoss, valueLoss, entropy } = ppoUpdate(
        tfNetwork, allTrajectories, config,
      )
      totalPolicyLoss += policyLoss
      totalValueLoss += valueLoss
      totalEntropy += entropy
    }

    // 学習結果を推論ネットワークに同期
    network.loadWeights(tfNetwork.cloneWeights())

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
    const phaseLabel = phase === 1 ? 'heuristic' : phase === 2 ? 'self-play' : 'pool'
    process.stderr.write(
      `\r\x1b[K  ${bar} ${pctStr}% ${iter}/${config.totalIterations} | ` +
      `${iterMs.toFixed(0)}ms/iter ETA ${etaStr} | ` +
      `loss=${avgPL.toFixed(4)} steps=${allTrajectories.length} | ` +
      `phase ${phase} (${phaseLabel})`
    )

    // Evaluation
    if (iter % config.evalInterval === 0) {
      process.stderr.write('\r\x1b[K')
      const evalResult = evaluate(network, config, 30)
      log(
        `[${iter}] Eval: ${Object.entries(evalResult.winRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')} ` +
        `avgLen=${evalResult.avgGameLength.toFixed(1)}`
      )
    }

    // Checkpoint
    if (iter % config.checkpointInterval === 0) {
      process.stderr.write('\r\x1b[K')
      const path = `${config.checkpointDir}/checkpoint_${iter}.json`
      saveCheckpoint(network, path, { iteration: iter, winRate: 0 })
      pool.push(network.cloneWeights())
      if (pool.length > 5) pool.shift()
      log(`[${iter}] Checkpoint saved: ${path}`)
    }
  }

  process.stderr.write('\r\x1b[K')

  // Final save
  saveCheckpoint(network, `${config.checkpointDir}/final.json`, {
    iteration: config.totalIterations,
    winRate: 0,
  })
  const totalSec = (performance.now() - trainingStart) / 1000
  const timeStr = totalSec < 60 ? `${totalSec.toFixed(1)}s`
    : totalSec < 3600 ? `${(totalSec / 60).toFixed(1)}m`
    : `${(totalSec / 3600).toFixed(1)}h`
  tfNetwork.dispose()
  log(`Training complete! (${timeStr})`)
}
