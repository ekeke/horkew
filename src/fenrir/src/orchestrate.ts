#!/usr/bin/env node
/**
 * Fenrir Training Orchestrator (シングルプロセス・ラウンドロビン)
 *
 * GPU の TfNeuralNetwork は1セットだけ保持し、3モデルの推論用 NN (Pure JS) を
 * ラウンドロビンで切り替えながら学習する。
 *
 * メモリ:
 *   GPU: TfNN × 3 (individual + wolf_team + mason_team) — 単一モデル学習と同じ
 *   CPU: Pure JS NN × 3 (推論用)
 */

import type { SystemRole } from '../../types/index.ts'
import type { LupaConfig } from '../../lupa/types.ts'
import type { Strategy } from '../../lupa/strategy.ts'
import { runGame } from '../../lupa/engine-next.ts'
import { minimalAdapter } from '../../lupa/adapters/minimal-adapter.ts'
import { strategyAdapter } from '../../lupa/adapters/strategy-adapter.ts'
import type { AnyNetwork, AnyTfNetwork } from './ml/nn.ts'
import { FenrirStrategy, WolfTeamStrategy, MasonTeamStrategy } from './policy.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from '../../lupa/heuristic.ts'
import { terminalReward, intermediateReward, predictAccuracyReward, buildKnownSeats, DEFAULT_REWARD_CONFIG } from './reward.ts'
import { encodeTrueRoles } from './observation.ts'
import { processTrajectories, normalizeAdvantages, computeGAE, type TrajectoryStep, type ProcessedStep } from './ml/trajectory.ts'
import { saveCheckpoint, loadCheckpoint } from './ml/checkpoint.ts'
import {
  evaluate,
  createNetwork, createWolfTeamNetwork, createMasonTeamNetwork,
  createTfNetwork, createWolfTeamTfNetwork, createMasonTeamTfNetwork,
  createTransformerNetwork, createWolfTeamTransformerNetwork, createMasonTeamTransformerNetwork,
  createTransformerTfNetwork, createWolfTeamTransformerTfNetwork, createMasonTeamTransformerTfNetwork,
  DEFAULT_TRAINING_CONFIG,
  type TrainingConfig,
} from './training.ts'
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import {
  packWeights, initGameWorkerPool, terminateGameWorkerPool, gameWorkerPoolSize,
  generateGamesParallel, deserializeStep,
} from './parallel.ts'

// ============================================================
// Model Group Definitions
// ============================================================

const MODEL_GROUPS = {
  village:  { roles: ['villager', 'seer', 'medium', 'bodyguard', 'nekomata', 'mason'] as SystemRole[], faction: 'villageWin', teamType: 'mason_team' as const },
  wolf:     { roles: ['werewolf', 'fanatic'] as SystemRole[], faction: 'wolfWin', teamType: 'wolf_team' as const },
  third:    { roles: ['werehamster', 'immoralist'] as SystemRole[], faction: 'hamsterWin', teamType: undefined },
}

type ModelName = keyof typeof MODEL_GROUPS
const MODEL_NAMES = Object.keys(MODEL_GROUPS) as ModelName[]

const COLORS: Record<ModelName, string> = {
  village: '\x1b[33m', wolf: '\x1b[31m', third: '\x1b[32m',
}
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

// ============================================================
// Config
// ============================================================

type OrchestratorConfig = {
  iterations: number
  phase2Iterations: number
  chunkSize: number
  batch: number
  checkpointBase: string
  noRetar: boolean
  evalInterval: number
  checkpointInterval: number
  phase1Only: boolean
  phase2Only: boolean
  targetWinRate?: number
  resume: boolean
  learningRate: number
  workers: number
  transformer: boolean
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  iterations: 50000,
  phase2Iterations: 40000,
  chunkSize: 100,
  batch: 64,
  checkpointBase: './checkpoints',
  noRetar: false,
  evalInterval: 100,
  checkpointInterval: 10,
  phase1Only: false,
  phase2Only: false,
  resume: false,
  learningRate: 3e-4,
  workers: 0,
  transformer: false,
}

function parseArgs(): OrchestratorConfig {
  const args = process.argv.slice(2)
  const config = { ...DEFAULT_CONFIG }
  let checkpointBaseSet = false

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--iterations': config.iterations = parseInt(args[++i]); break
      case '--phase2-iterations': config.phase2Iterations = parseInt(args[++i]); break
      case '--chunk-size': config.chunkSize = parseInt(args[++i]); break
      case '--batch': config.batch = parseInt(args[++i]); break
      case '--checkpoint-base': config.checkpointBase = args[++i]; checkpointBaseSet = true; break
      case '--no-retar': config.noRetar = true; break
      case '--eval-interval': config.evalInterval = parseInt(args[++i]); break
      case '--checkpoint-interval': config.checkpointInterval = parseInt(args[++i]); break
      case '--phase1-only': config.phase1Only = true; break
      case '--phase2-only': config.phase2Only = true; break
      case '--target-winrate': config.targetWinRate = parseFloat(args[++i]); break
      case '--resume': config.resume = true; break
      case '--lr': config.learningRate = parseFloat(args[++i]); break
      case '--workers': config.workers = parseInt(args[++i]); break
      case '--transformer': config.transformer = true; break
      case '--help': case '-h': showHelp(); break
    }
  }

  // checkpoint base にアーキテクチャサブディレクトリを付与
  if (!checkpointBaseSet) {
    config.checkpointBase = config.transformer
      ? './checkpoints/transformer'
      : './checkpoints/nn'
  }

  return config
}

function showHelp(): never {
  console.log(`Fenrir Training Orchestrator (single-process round-robin)

Usage: npm run train:orchestrate [-- options]

Options:
  --iterations <n>         Phase 1 上限イテレーション/モデル (default: ${DEFAULT_CONFIG.iterations})
  --phase2-iterations <n>  Phase 2 イテレーション (default: ${DEFAULT_CONFIG.phase2Iterations})
  --chunk-size <n>         ラウンドロビンのチャンクサイズ (default: ${DEFAULT_CONFIG.chunkSize})
  --batch <n>              バッチサイズ (default: ${DEFAULT_CONFIG.batch})
  --checkpoint-base <dir>  ベースDir (default: ${DEFAULT_CONFIG.checkpointBase})
  --eval-interval <n>      評価間隔 (default: ${DEFAULT_CONFIG.evalInterval})
  --checkpoint-interval <n> チェックポイント間隔 (default: ${DEFAULT_CONFIG.checkpointInterval})
  --no-retar               Retar無効化
  --phase1-only            Phase 2 をスキップ
  --phase2-only            Phase 1 をスキップ
  --target-winrate <n>     目標勝率の上書き (default: baseline eval から自動算出)
  --resume                 既存チェックポイントから再開
  --lr <n>                 学習率 (default: ${DEFAULT_CONFIG.learningRate})
  --workers <n>            ゲーム生成ワーカー数 (default: ${DEFAULT_CONFIG.workers})
  --transformer            Transformerアーキテクチャを使用 (default: MLP)
  --help, -h               このヘルプを表示`)
  process.exit(0)
}

// ============================================================
// PPO Update (training.ts から借用)
// ============================================================

function ppoUpdate(
  tfNetwork: AnyTfNetwork,
  batch: ProcessedStep[],
  config: { miniBatchSize: number, clipEpsilon: number, valueLossCoeff: number, entropyCoeff: number, predictLossCoeff?: number },
): { policyLoss: number, predictLoss: number } {
  if (batch.length === 0) return { policyLoss: 0, predictLoss: 0 }

  let totalPolicyLoss = 0
  let totalPredictLoss = 0
  let batchCount = 0

  for (let i = batch.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[batch[i], batch[j]] = [batch[j], batch[i]]
  }

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
      trueRoles: miniBatch.map(s => s.trueRoles),
      predictLossCoeff: config.predictLossCoeff ?? 0.1,
      clipEpsilon: config.clipEpsilon,
      valueLossCoeff: config.valueLossCoeff,
      entropyCoeff: config.entropyCoeff,
    })
    totalPolicyLoss += result.policyLoss
    totalPredictLoss += result.predictLoss
    batchCount++
  }

  return {
    policyLoss: totalPolicyLoss / Math.max(batchCount, 1),
    predictLoss: totalPredictLoss / Math.max(batchCount, 1),
  }
}

// ============================================================
// Game Generation (1ゲーム分)
// ============================================================

async function generateGame(
  trainingConfig: TrainingConfig,
  network: AnyNetwork,
  wolfTeamNet: AnyNetwork,
  masonTeamNet: AnyNetwork,
  mlRolesSet: Set<SystemRole>,
  seed: number,
  useTeam: 'wolf_team' | 'mason_team' | undefined,
): Promise<{ individualSteps: Map<number, TrajectoryStep[]>, wolfTeamSteps: TrajectoryStep[], masonTeamSteps: TrajectoryStep[] }> {
  const roles = new Map(Object.entries(trainingConfig.roles) as [SystemRole, number][])
  const strategies = new Map<number, FenrirStrategy>()
  const heuristic = new HeuristicStrategy()

  const onRolesAssigned = (seatRoles: Map<number, SystemRole>) => {
    for (const [seat, role] of seatRoles) {
      if (mlRolesSet.has(role)) {
        strategies.set(seat, new FenrirStrategy(network, { explore: true, strategyOnly: trainingConfig.strategyOnly }))
      }
    }
  }

  let wolfTeamStrategy: WolfTeamStrategy | undefined
  let masonTeamStrategy: MasonTeamStrategy | undefined
  if (useTeam === 'wolf_team') {
    wolfTeamStrategy = new WolfTeamStrategy(wolfTeamNet, { explore: true })
  }
  if (useTeam === 'mason_team') {
    masonTeamStrategy = new MasonTeamStrategy(masonTeamNet, { explore: true })
  }

  const strategiesMap = new Map<number, Strategy>(strategies)
  for (const s of strategies.values()) s.resetTrajectory?.()
  wolfTeamStrategy?.resetTrajectory()
  masonTeamStrategy?.resetTrajectory()

  let state: import('../../lupa/types.ts').GameState
  let events: import('../../lupa/types.ts').GameEvent[]

  if (trainingConfig.strategyOnly) {
    const handlers = minimalAdapter({
      strategies: strategiesMap,
      defaultStrategy: heuristic,
      wolfTeamStrategy: wolfTeamStrategy ?? new WolfTeamHeuristic(),
      masonTeamStrategy: masonTeamStrategy ?? new MasonTeamHeuristic(),
      onRolesAssigned: (seatRoles) => {
        onRolesAssigned(seatRoles)
        for (const [seat, s] of strategies) {
          if (!strategiesMap.has(seat)) strategiesMap.set(seat, s)
        }
      },
      seed,
    })
    const result = await runGame(
      { roles, seed, hasFirstGhost: trainingConfig.hasFirstGhost, revoteConfig: trainingConfig.revoteConfig, rules: trainingConfig.rules },
      handlers,
    )
    state = result.state
    events = result.events
  } else {
    const handlers = strategyAdapter({
      strategies: strategiesMap,
      defaultStrategy: heuristic,
      wolfTeamStrategy: wolfTeamStrategy ?? new WolfTeamHeuristic(),
      masonTeamStrategy: masonTeamStrategy ?? new MasonTeamHeuristic(),
      enableRetar: trainingConfig.enableRetar,
      onRolesAssigned: (seatRoles) => {
        onRolesAssigned(seatRoles)
        for (const [seat, s] of strategies) {
          if (!strategiesMap.has(seat)) strategiesMap.set(seat, s)
        }
      },
      seed,
      roles,
      rules: trainingConfig.rules,
    })
    const result = await runGame(
      { roles, seed, hasFirstGhost: trainingConfig.hasFirstGhost, revoteConfig: trainingConfig.revoteConfig, rules: trainingConfig.rules },
      handlers,
    )
    state = result.state
    events = result.events
  }

  // Collect trajectories
  const allSteps = new Map<number, TrajectoryStep[]>()
  for (const [seat, strategy] of strategies) {
    const steps = strategy.trajectory
    if (steps.length > 0) {
      steps[steps.length - 1].done = true
      const player = state.players.find(p => p.seat === seat)!
      steps[steps.length - 1].reward += terminalReward(player.role, state.result ?? '', trainingConfig.rewardConfig)
    }
    allSteps.set(seat, steps)
  }

  const wolfTeamSteps = wolfTeamStrategy?.trajectory ?? []
  if (wolfTeamSteps.length > 0) {
    wolfTeamSteps[wolfTeamSteps.length - 1].done = true
    wolfTeamSteps[wolfTeamSteps.length - 1].reward += terminalReward('werewolf', state.result ?? '', trainingConfig.rewardConfig)
  }

  const masonTeamSteps = masonTeamStrategy?.trajectory ?? []
  if (masonTeamSteps.length > 0) {
    masonTeamSteps[masonTeamSteps.length - 1].done = true
    masonTeamSteps[masonTeamSteps.length - 1].reward += terminalReward('mason', state.result ?? '', trainingConfig.rewardConfig)
  }

  for (const event of events) {
    const rewards = intermediateReward(event, state, trainingConfig.rewardConfig)
    for (const [seat, reward] of rewards) {
      const steps = allSteps.get(seat)
      if (steps && steps.length > 0) steps[steps.length - 1].reward += reward
      const player = state.players.find(p => p.seat === seat)
      if (player?.role === 'werewolf' && wolfTeamSteps.length > 0) wolfTeamSteps[wolfTeamSteps.length - 1].reward += reward
      if (player?.role === 'mason' && masonTeamSteps.length > 0) masonTeamSteps[masonTeamSteps.length - 1].reward += reward
    }
  }

  // trueRoles注入 + 推理精度報酬
  const trueRoles = encodeTrueRoles(state.players)
  for (const [seat, steps] of allSteps) {
    const player = state.players.find(p => p.seat === seat)
    if (!player) continue
    const knownSeats = buildKnownSeats(seat, player.role, state)
    for (const step of steps) {
      step.trueRoles = trueRoles
      if (step.actionHead === 'predict' && step.sigmoidActions) {
        step.reward += predictAccuracyReward(
          step.sigmoidActions, trueRoles, player.role, trainingConfig.rewardConfig, knownSeats,
        )
      }
    }
  }

  return { individualSteps: allSteps, wolfTeamSteps, masonTeamSteps }
}

// ============================================================
// Checkpoint helpers
// ============================================================

function findCheckpoint(dir: string): { iteration: number, path: string } | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
  if (files.includes('final.json')) {
    const raw = JSON.parse(readFileSync(`${dir}/final.json`, 'utf-8'))
    return { iteration: raw.metadata?.iteration ?? 0, path: `${dir}/final.json` }
  }
  let maxIter = 0
  for (const f of files) {
    const m = f.match(/^checkpoint_(\d+)\.json$/)
    if (m) { const n = parseInt(m[1]); if (n > maxIter) maxIter = n }
  }
  if (maxIter === 0) return null
  return { iteration: maxIter, path: `${dir}/checkpoint_${maxIter}.json` }
}

// ============================================================
// Logging
// ============================================================

function log(msg: string): void {
  process.stderr.write(`${BOLD}[orch]${RESET} ${msg}\n`)
}

// ============================================================
// Main
// ============================================================

function validateConfig(config: OrchestratorConfig): void {
  const errors: string[] = []
  if (config.evalInterval > config.chunkSize) {
    errors.push(`evalInterval (${config.evalInterval}) > chunkSize (${config.chunkSize}): eval がチャンク内で1回も走らない`)
  }
  if (config.checkpointInterval > config.chunkSize) {
    errors.push(`checkpointInterval (${config.checkpointInterval}) > chunkSize (${config.chunkSize}): チャンク内でcheckpointが保存されない`)
  }
  if (config.chunkSize > config.iterations) {
    errors.push(`chunkSize (${config.chunkSize}) > iterations (${config.iterations}): 1チャンクが上限を超えている`)
  }
  if (config.evalInterval > 0 && config.chunkSize % config.evalInterval !== 0) {
    errors.push(`chunkSize (${config.chunkSize}) が evalInterval (${config.evalInterval}) で割り切れない: チャンク末尾で eval が走らない可能性`)
  }
  if (errors.length > 0) {
    console.error('設定エラー:')
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const config = parseArgs()
  validateConfig(config)

  log(`${BOLD}Fenrir Training Orchestrator (round-robin)${RESET}`)
  log(`Architecture: ${config.transformer ? 'Transformer' : 'MLP'}`)
  log(`Iterations: ${config.iterations}/model, Chunk: ${config.chunkSize}, Batch: ${config.batch}`)

  const trainingConfig: TrainingConfig = {
    ...DEFAULT_TRAINING_CONFIG,
    gamesPerBatch: config.batch,
    enableRetar: !config.noRetar,
    learningRate: config.learningRate,
    rewardConfig: DEFAULT_REWARD_CONFIG,
    useTransformer: config.transformer,
  }

  // === ファクトリ関数 (MLP / Transformer 切り替え) ===
  const makeNetwork = (): AnyNetwork => config.transformer ? createTransformerNetwork() : createNetwork()
  const makeTfNetwork = (lr: number): AnyTfNetwork => config.transformer ? createTransformerTfNetwork(lr) : createTfNetwork(lr)
  const makeWolfTeamNetwork = (): AnyNetwork => config.transformer ? createWolfTeamTransformerNetwork() : createWolfTeamNetwork()
  const makeWolfTeamTfNetwork = (lr: number): AnyTfNetwork => config.transformer ? createWolfTeamTransformerTfNetwork(lr) : createWolfTeamTfNetwork(lr)
  const makeMasonTeamNetwork = (): AnyNetwork => config.transformer ? createMasonTeamTransformerNetwork() : createMasonTeamNetwork()
  const makeMasonTeamTfNetwork = (lr: number): AnyTfNetwork => config.transformer ? createMasonTeamTransformerTfNetwork(lr) : createMasonTeamTfNetwork(lr)

  // === ネットワーク作成 ===
  // 推論用 (Pure JS, CPU): モデルごとに1つ
  const networks = new Map<ModelName, AnyNetwork>()
  for (const name of MODEL_NAMES) networks.set(name, makeNetwork())

  // チーム推論用
  const wolfTeamNet = makeWolfTeamNetwork()
  const masonTeamNet = makeMasonTeamNetwork()

  // 学習用 (TF.js GPU): 1セットだけ — 重みをスワップして共有
  const tfNetwork = makeTfNetwork(config.learningRate)
  const wolfTeamTf = makeWolfTeamTfNetwork(config.learningRate)
  const masonTeamTf = makeMasonTeamTfNetwork(config.learningRate)

  log(`Individual NN: ${networks.values().next().value!.totalParams} params × 6 (CPU)`)
  log(`TfNN: 1 shared (GPU)`)

  // === ゲーム生成ワーカープール ===
  if (config.workers > 0) {
    initGameWorkerPool(config.workers)
  }

  // === Resume ===
  const iterCounts = new Map<ModelName, number>()
  let anyResumed = false
  if (config.resume) {
    for (const name of MODEL_NAMES) {
      let startIter = 0
      const dir = `${config.checkpointBase}/ckpt-${name}`
      const ckpt = findCheckpoint(dir)
      if (ckpt) {
        try {
          loadCheckpoint(networks.get(name)!, ckpt.path)
          startIter = ckpt.iteration
          anyResumed = true
        } catch (e) {
          log(`  ${COLORS[name]}${name}${RESET}: checkpoint incompatible, starting fresh (${(e as Error).message})`)
        }
      }
      iterCounts.set(name, startIter)
    }
    // チームNNも resume
    const wolfDir = `${config.checkpointBase}/ckpt-werewolf`
    const wolfCkpt = findCheckpoint(wolfDir)
    if (wolfCkpt) {
      const teamPath = wolfCkpt.path.replace('checkpoint_', 'wolf_team_').replace('final.json', 'wolf_team_final.json')
      if (existsSync(teamPath)) {
        try { loadCheckpoint(wolfTeamNet, teamPath) } catch { /* incompatible */ }
      }
    }
    const masonDir = `${config.checkpointBase}/ckpt-mason`
    const masonCkpt = findCheckpoint(masonDir)
    if (masonCkpt) {
      const teamPath = masonCkpt.path.replace('checkpoint_', 'mason_team_').replace('final.json', 'mason_team_final.json')
      if (existsSync(teamPath)) {
        try { loadCheckpoint(masonTeamNet, teamPath) } catch { /* incompatible */ }
      }
    }
  } else {
    for (const name of MODEL_NAMES) iterCounts.set(name, 0)
  }

  // Resume 状況の表示
  if (anyResumed) {
    log('Resume:')
    for (const name of MODEL_NAMES) {
      const iter = iterCounts.get(name)!
      log(`  ${COLORS[name]}${name.padEnd(12)}${RESET} iter ${iter}`)
    }
  } else {
    log('Starting from scratch')
  }

  // === Baseline eval ===
  let baselineRates: Record<string, number> = {}
  if (!config.phase2Only) {
    log('Running baseline eval (all heuristic, 100 games)...')
    const dummyNet = makeNetwork()
    const baselineConfig = { ...trainingConfig, mlRoles: [] as SystemRole[] }
    const result = await evaluate(dummyNet, baselineConfig, 100)
    baselineRates = result.winRates
    log(`Baseline: ${Object.entries(baselineRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')}`)
  }

  // === Phase 1: ラウンドロビン ===
  if (!config.phase2Only) {
    log(`${BOLD}=== Phase 1: Round-Robin Training ===${RESET}`)

    const graduated = new Set<ModelName>()
    const ppoConfig = {
      miniBatchSize: trainingConfig.miniBatchSize,
      clipEpsilon: trainingConfig.clipEpsilon,
      valueLossCoeff: trainingConfig.valueLossCoeff,
      entropyCoeff: trainingConfig.entropyCoeff,
    }

    let round = 0
    while (graduated.size < MODEL_NAMES.length) {
      round++
      for (const name of MODEL_NAMES) {
        if (graduated.has(name)) continue

        const group = MODEL_GROUPS[name]
        const network = networks.get(name)!
        const mlRolesSet = new Set(group.roles)
        const currentIter = iterCounts.get(name)!
        const targetIter = Math.min(currentIter + config.chunkSize, config.iterations)
        const targetRate = config.targetWinRate ?? (baselineRates[group.faction] ?? 0.5)

        const prefix = `${COLORS[name]}[${name.padEnd(10)}]${RESET}`

        // チャンク学習
        let iterElapsed = 0
        let iterCount = 0

        for (let iter = currentIter + 1; iter <= targetIter; iter++) {
          const iterStart = performance.now()
          const seeds = Array.from({ length: config.batch }, (_, g) => iter * config.batch + g)

          // ゲーム生成
          const tGameStart = performance.now()
          const allIndividual: ProcessedStep[] = []
          const allWolfTeam: ProcessedStep[] = []
          const allMasonTeam: ProcessedStep[] = []

          let lastBatchTimings: import('./parallel.ts').GameTiming[] = []

          if (gameWorkerPoolSize() > 0) {
            // === 並列パス ===
            const sharedWeights = packWeights(network)
            const sharedWolfWeights = group.teamType === 'wolf_team' ? packWeights(wolfTeamNet) : undefined
            const sharedMasonWeights = group.teamType === 'mason_team' ? packWeights(masonTeamNet) : undefined

            const serializedResults = await generateGamesParallel({
              weights: sharedWeights,
              wolfTeamWeights: sharedWolfWeights,
              masonTeamWeights: sharedMasonWeights,
              useTeamStrategy: group.teamType,
              trainingConfig,
              phase: 1,
              mlRoles: group.roles,
            }, seeds)

            for (const game of serializedResults) {
              const stepsMap = new Map<number, TrajectoryStep[]>()
              for (const { seat, steps } of game.individualSteps) {
                stepsMap.set(seat, steps.map(deserializeStep))
              }
              allIndividual.push(...processTrajectories(stepsMap, trainingConfig.gamma, trainingConfig.lambda))

              if (game.wolfTeamSteps.length > 0 && group.teamType === 'wolf_team') {
                allWolfTeam.push(...computeGAE(game.wolfTeamSteps.map(deserializeStep), trainingConfig.gamma, trainingConfig.lambda, 0))
              }
              if (game.masonTeamSteps.length > 0 && group.teamType === 'mason_team') {
                allMasonTeam.push(...computeGAE(game.masonTeamSteps.map(deserializeStep), trainingConfig.gamma, trainingConfig.lambda, 0))
              }
            }
            lastBatchTimings = serializedResults.filter(g => g.timing).map(g => g.timing!)
          } else {
            // === 直列フォールバック ===
            for (const seed of seeds) {
              const game = await generateGame(trainingConfig, network, wolfTeamNet, masonTeamNet, mlRolesSet, seed, group.teamType)
              const currentSteps = new Map<number, TrajectoryStep[]>()
              for (const [seat, steps] of game.individualSteps) {
                currentSteps.set(seat, steps)
              }
              allIndividual.push(...processTrajectories(currentSteps, trainingConfig.gamma, trainingConfig.lambda))

              if (game.wolfTeamSteps.length > 0 && group.teamType === 'wolf_team') {
                allWolfTeam.push(...computeGAE(game.wolfTeamSteps, trainingConfig.gamma, trainingConfig.lambda, 0))
              }
              if (game.masonTeamSteps.length > 0 && group.teamType === 'mason_team') {
                allMasonTeam.push(...computeGAE(game.masonTeamSteps, trainingConfig.gamma, trainingConfig.lambda, 0))
              }
            }
          }
          const tGameEnd = performance.now()

          // PPO update (shared TfNN に重みをスワップ)
          if (allIndividual.length > 0) {
            normalizeAdvantages(allIndividual)
            tfNetwork.loadWeights(network.cloneWeights())
            for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
              ppoUpdate(tfNetwork, allIndividual, ppoConfig)
            }
            network.loadWeights(tfNetwork.cloneWeights())
          }

          if (allWolfTeam.length > 0) {
            normalizeAdvantages(allWolfTeam)
            wolfTeamTf.loadWeights(wolfTeamNet.cloneWeights())
            for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
              ppoUpdate(wolfTeamTf, allWolfTeam, ppoConfig)
            }
            wolfTeamNet.loadWeights(wolfTeamTf.cloneWeights())
          }

          if (allMasonTeam.length > 0) {
            normalizeAdvantages(allMasonTeam)
            masonTeamTf.loadWeights(masonTeamNet.cloneWeights())
            for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
              ppoUpdate(masonTeamTf, allMasonTeam, ppoConfig)
            }
            masonTeamNet.loadWeights(masonTeamTf.cloneWeights())
          }

          const iterMs = performance.now() - iterStart
          iterElapsed += iterMs
          iterCount++

          iterCounts.set(name, iter)

          // Progress
          const pct = (iter / config.iterations * 100).toFixed(1)
          const wallGameMs = ((tGameEnd - tGameStart) / config.batch).toFixed(0)
          const avgIterMs = (iterElapsed / iterCount / 1000).toFixed(1)
          const remaining = ((targetIter - iter) * iterElapsed / iterCount / 1000).toFixed(0)
          // worker timing breakdown (if available from parallel path)
          let timingStr = `${wallGameMs}ms/game`
          if (lastBatchTimings.length > 0) {
            const avgGame = lastBatchTimings.reduce((a, t) => a + t.gameMs, 0) / lastBatchTimings.length
            const avgInfer = lastBatchTimings.reduce((a, t) => a + t.inferMs, 0) / lastBatchTimings.length
            const avgRetar = lastBatchTimings.reduce((a, t) => a + t.retarMs, 0) / lastBatchTimings.length
            const avgTsumi = lastBatchTimings.reduce((a, t) => a + t.tsumiMs, 0) / lastBatchTimings.length
            timingStr = `${avgGame.toFixed(0)}ms/game (infer ${avgInfer.toFixed(0)}ms retar ${avgRetar.toFixed(0)}ms tsumi ${avgTsumi.toFixed(0)}ms) wall ${wallGameMs}ms`
          }
          process.stderr.write(`\r\x1b[K  ${prefix} iter ${iter}/${config.iterations} (${pct}%) ${timingStr} ${avgIterMs}s/iter ETA ${remaining}s`)

          // Eval
          if (iter % config.evalInterval === 0) {
            process.stderr.write('\r\x1b[K')
            const evalConfig = { ...trainingConfig, mlRoles: group.roles }
            const evalResult = await evaluate(network, evalConfig, 30, wolfTeamNet, masonTeamNet)
            const factionRate = evalResult.winRates[group.faction] ?? 0
            log(
              `${prefix} [${iter}] ${Object.entries(evalResult.winRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')} ` +
              `avgLen=${evalResult.avgGameLength.toFixed(1)} ${evalResult.avgElapsedMs.toFixed(0)}ms/eval`
            )

            if (factionRate >= targetRate) {
              log(`${prefix} ${BOLD}GRADUATED${RESET} (${group.faction}=${(factionRate * 100).toFixed(0)}% >= ${(targetRate * 100).toFixed(0)}%)`)
              graduated.add(name)
              break
            }
          }

          // Checkpoint
          if (iter % config.checkpointInterval === 0) {
            const dir = `${config.checkpointBase}/ckpt-${name}`
            saveCheckpoint(network, `${dir}/checkpoint_${iter}.json`, { iteration: iter, winRate: 0 })
            if (group.teamType === 'wolf_team') {
              saveCheckpoint(wolfTeamNet, `${dir}/wolf_team_${iter}.json`, { iteration: iter, winRate: 0 })
            }
            if (group.teamType === 'mason_team') {
              saveCheckpoint(masonTeamNet, `${dir}/mason_team_${iter}.json`, { iteration: iter, winRate: 0 })
            }

            // マイルストーン (eval タイミング) 以外の古いチェックポイントを削除
            if (existsSync(dir)) {
              for (const f of readdirSync(dir)) {
                const m = f.match(/^(?:checkpoint|wolf_team|mason_team)_(\d+)\.json$/)
                if (!m) continue
                const ckptIter = parseInt(m[1])
                if (ckptIter >= iter) continue  // 今回保存分は残す
                if (ckptIter % config.evalInterval === 0) continue  // マイルストーンは残す
                try { unlinkSync(`${dir}/${f}`) } catch {}
              }
            }
          }
        }

        process.stderr.write('\r\x1b[K')

        // 上限到達チェック
        if (!graduated.has(name) && iterCounts.get(name)! >= config.iterations) {
          log(`${COLORS[name]}[${name}]${RESET} reached max iterations (${config.iterations})`)
          graduated.add(name)
        }

        // Final save
        if (graduated.has(name)) {
          const dir = `${config.checkpointBase}/ckpt-${name}`
          saveCheckpoint(network, `${dir}/final.json`, { iteration: iterCounts.get(name)!, winRate: 0 })
          if (group.teamType === 'wolf_team') {
            saveCheckpoint(wolfTeamNet, `${dir}/wolf_team_final.json`, { iteration: iterCounts.get(name)!, winRate: 0 })
          }
          if (group.teamType === 'mason_team') {
            saveCheckpoint(masonTeamNet, `${dir}/mason_team_final.json`, { iteration: iterCounts.get(name)!, winRate: 0 })
          }
        }
      }

      // ラウンドサマリ
      log(`Round ${round}: ${graduated.size}/${MODEL_NAMES.length} graduated [${MODEL_NAMES.map(n => graduated.has(n) ? `${COLORS[n]}OK${RESET}` : `${COLORS[n]}..${RESET}`).join(' ')}]`)
    }

    log(`${BOLD}=== Phase 1 Complete ===${RESET}`)
  }

  // === Cleanup GPU ===
  tfNetwork.dispose()
  wolfTeamTf.dispose()
  masonTeamTf.dispose()
  terminateGameWorkerPool()

  // === Phase 2 (子プロセスで起動) ===
  if (!config.phase1Only) {
    log(`${BOLD}=== Phase 2: Self-Play ===${RESET}`)
    const dirs = MODEL_NAMES.map(name => `${config.checkpointBase}/ckpt-${name}`).join(',')
    const args = [
      '--experimental-strip-types', 'src/fenrir/src/cli.ts',
      '--phase2-models', dirs,
      '--iterations', String(config.phase2Iterations),
      '--checkpoint-dir', `${config.checkpointBase}/phase2`,
      '--batch', String(config.batch),
      '--eval-interval', String(config.evalInterval),
      '--checkpoint-interval', String(config.checkpointInterval),
    ]
    if (config.noRetar) args.push('--no-retar')
    if (config.transformer) args.push('--transformer')

    await new Promise<void>((resolve, reject) => {
      const child = spawn('node', args, { stdio: ['ignore', 'inherit', 'inherit'] })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Phase 2 exited with code ${code}`))
      })
    })
    log(`${BOLD}=== Phase 2 Complete ===${RESET}`)
  }

  log(`${BOLD}All training complete!${RESET}`)
}

main().catch(e => { console.error(e); process.exit(1) })
