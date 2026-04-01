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
import { runGame } from '../../lupa/engine.ts'
import { minimalAdapter } from '../../lupa/adapters/minimal-adapter.ts'
import { strategyAdapter } from '../../lupa/adapters/strategy-adapter.ts'
import type { AnyNetwork, AnyTfNetwork } from './ml/nn.ts'
import { FenrirStrategy, WolfTeamStrategy, MasonTeamStrategy, computeRefPlanLogits } from './policy.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from '../../lupa/heuristic.ts'
import { terminalReward, intermediateReward, predictAccuracyReward, buildKnownSeats, DEFAULT_REWARD_CONFIG } from './reward.ts'
import { encodeTrueRoles } from './observation.ts'
import { processTrajectories, normalizeAdvantages, computeGAE, type TrajectoryStep, type ProcessedStep } from './ml/trajectory.ts'
import { saveCheckpoint, loadCheckpoint } from './ml/checkpoint.ts'
import {
  evaluate, appendEvalLog,
  createNetwork, createWolfTeamNetwork, createMasonTeamNetwork,
  createTfNetwork, createWolfTeamTfNetwork, createMasonTeamTfNetwork,
  createTransformerNetwork, createWolfTeamTransformerNetwork, createMasonTeamTransformerNetwork,
  createTransformerTfNetwork, createWolfTeamTransformerTfNetwork, createMasonTeamTransformerTfNetwork,
  createWolfCollectiveNetwork, createMasonCollectiveNetwork,
  createWolfCollectiveTfNetwork, createMasonCollectiveTfNetwork,
  createFanaticNetwork, createFanaticTfNetwork,
  DEFAULT_TRAINING_CONFIG,
  type TrainingConfig,
} from './training.ts'
import { existsSync, readdirSync, readFileSync, unlinkSync, rmSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { generatePlanTokenTrainingBatch } from './ml/execution-plan-data.ts'
import { collectBatchGameData } from './ml/pretrain-game-data.ts'
import { PLAN_VOCAB } from './rule-action.ts'
import {
  packWeights, initGameWorkerPool, terminateGameWorkerPool, gameWorkerPoolSize,
  generateGamesParallel, deserializeStep,
} from './parallel.ts'
import { loadRandomSnapshots, countSnapshots } from './seed-bank.ts'
import { Rng } from '../../lupa/random.ts'

// ============================================================
// Model Group Definitions
// ============================================================

const MODEL_GROUPS = {
  village:          { roles: ['villager', 'seer', 'medium', 'bodyguard', 'nekomata'] as SystemRole[], faction: 'villager_won', collective: false, teamType: undefined as 'wolf_team' | 'mason_team' | undefined },
  wolf_collective:  { roles: ['werewolf'] as SystemRole[], faction: 'werewolf_won', collective: true, teamType: 'wolf_team' as const },
  mason_collective: { roles: ['mason'] as SystemRole[], faction: 'villager_won', collective: true, teamType: 'mason_team' as const },
  fanatic:          { roles: ['fanatic'] as SystemRole[], faction: 'werewolf_won', collective: false, teamType: undefined as 'wolf_team' | 'mason_team' | undefined },
  third:            { roles: ['werehamster', 'immoralist'] as SystemRole[], faction: 'werehamster_won', collective: false, teamType: undefined as 'wolf_team' | 'mason_team' | undefined },
}

type ModelName = keyof typeof MODEL_GROUPS
const MODEL_NAMES = Object.keys(MODEL_GROUPS) as ModelName[]

/** role → モデルグループ名の逆引きマップ (MODEL_GROUPSから自動構築) */
const ROLE_TO_GROUP: Record<string, ModelName> = {}
for (const [name, group] of Object.entries(MODEL_GROUPS) as [ModelName, typeof MODEL_GROUPS[ModelName]][]) {
  for (const role of group.roles) ROLE_TO_GROUP[role] = name
}

const COLORS: Record<ModelName, string> = {
  village: '\x1b[33m', wolf_collective: '\x1b[31m', mason_collective: '\x1b[36m', fanatic: '\x1b[35m', third: '\x1b[32m',
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
  evalGames: number
  phase1Only: boolean
  phase2Only: boolean
  targetWinRate?: number
  resume: boolean
  learningRate: number
  workers: number
  transformer: boolean
  strategyOnly: boolean
  miniBatchSize?: number
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
  evalGames: 100,
  phase1Only: false,
  phase2Only: false,
  resume: false,
  learningRate: 3e-4,
  workers: 0,
  transformer: false,
  strategyOnly: false,
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
      case '--eval-games': config.evalGames = parseInt(args[++i]); break
      case '--phase1-only': config.phase1Only = true; break
      case '--phase2-only': config.phase2Only = true; break
      case '--target-winrate': config.targetWinRate = parseFloat(args[++i]); break
      case '--resume': config.resume = true; break
      case '--lr': config.learningRate = parseFloat(args[++i]); break
      case '--workers': {
        const val = args[++i]
        config.workers = val === 'auto' ? -1 : parseInt(val)
        break
      }
      case '--transformer': config.transformer = true; break
      case '--strategy-only': config.strategyOnly = true; break
      case '--mini-batch': config.miniBatchSize = parseInt(args[++i]); break
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
  --eval-games <n>       評価ゲーム数 (default: ${DEFAULT_CONFIG.evalGames})
  --no-retar               Retar無効化
  --phase1-only            Phase 2 をスキップ
  --phase2-only            Phase 1 をスキップ
  --target-winrate <n>     目標勝率の上書き (default: baseline eval から自動算出)
  --resume                 既存チェックポイントから再開
  --lr <n>                 学習率 (default: ${DEFAULT_CONFIG.learningRate})
  --workers <n|auto>       ゲーム生成ワーカー数 (auto=CPU-1, default: 直列)
  --transformer            Transformerアーキテクチャを使用 (default: MLP)
  --strategy-only          戦略NNのみ学習、行動はルールベース (Step 1 bootstrap)
  --mini-batch <n>         PPOミニバッチサイズ (default: ${DEFAULT_TRAINING_CONFIG.miniBatchSize})
  --help, -h               このヘルプを表示`)
  process.exit(0)
}

// ============================================================
// PPO Update (training.ts から借用)
// ============================================================

function ppoUpdate(
  tfNetwork: AnyTfNetwork,
  batch: ProcessedStep[],
  config: {
    miniBatchSize: number, clipEpsilon: number, valueLossCoeff: number, entropyCoeff: number,
    predictLossCoeff?: number, freezePlan?: boolean,
    klCoeff?: number,
  },
  precomputedRefLogits?: Map<ProcessedStep, { fwd?: Float32Array, eg?: Float32Array }>,
): { policyLoss: number, predictLoss: number, klLoss: number } {
  if (batch.length === 0) return { policyLoss: 0, predictLoss: 0, klLoss: 0 }

  let totalPolicyLoss = 0
  let totalPredictLoss = 0
  let totalKlLoss = 0
  let batchCount = 0

  for (let i = batch.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[batch[i], batch[j]] = [batch[j], batch[i]]
  }

  for (let start = 0; start < batch.length; start += config.miniBatchSize) {
    const end = Math.min(start + config.miniBatchSize, batch.length)
    const miniBatch = batch.slice(start, end)

    // Reference logits lookup (precomputed per iteration, not per minibatch)
    let refFwdLogits: (Float32Array | undefined)[] | undefined
    let refEgLogits: (Float32Array | undefined)[] | undefined
    if (precomputedRefLogits && config.klCoeff && config.klCoeff > 0) {
      refFwdLogits = miniBatch.map(s => precomputedRefLogits.get(s)?.fwd)
      refEgLogits = miniBatch.map(s => precomputedRefLogits.get(s)?.eg)
    }

    const result = tfNetwork.trainBatch({
      observations: miniBatch.map(s => s.observation),
      actionHeads: miniBatch.map(s => s.actionHead),
      actionIndices: miniBatch.map(s => s.actionIdx),
      oldLogProbs: miniBatch.map(s => s.logProb),
      advantages: miniBatch.map(s => s.advantage),
      returns: miniBatch.map(s => s.returnValue),
      sigmoidActions: miniBatch.map(s => s.sigmoidActions),
      trueRoles: miniBatch.map(s => s.trueRoles),
      planForwardActions: miniBatch.map(s => s.planForwardActions),
      planForwardLogProbs: miniBatch.map(s => s.planForwardLogProbs),
      planEndgameActions: miniBatch.map(s => s.planEndgameActions),
      planEndgameLogProbs: miniBatch.map(s => s.planEndgameLogProbs),
      predictLossCoeff: config.predictLossCoeff ?? 0.1,
      clipEpsilon: config.clipEpsilon,
      valueLossCoeff: config.valueLossCoeff,
      entropyCoeff: config.entropyCoeff,
      freezePlan: config.freezePlan,
      refPlanForwardLogits: refFwdLogits,
      refPlanEndgameLogits: refEgLogits,
      klCoeff: config.klCoeff,
    })
    totalPolicyLoss += result.policyLoss
    totalPredictLoss += result.predictLoss
    totalKlLoss += result.klLoss
    batchCount++
  }

  return {
    policyLoss: totalPolicyLoss / Math.max(batchCount, 1),
    predictLoss: totalPredictLoss / Math.max(batchCount, 1),
    klLoss: totalKlLoss / Math.max(batchCount, 1),
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
  mlMaxSeats?: number,
  mlStartDay?: number,
): Promise<{ individualSteps: Map<number, TrajectoryStep[]>, wolfTeamSteps: TrajectoryStep[], masonTeamSteps: TrajectoryStep[] }> {
  const roles = new Map(Object.entries(trainingConfig.roles) as [SystemRole, number][])
  const strategies = new Map<number, FenrirStrategy>()
  const heuristic = new HeuristicStrategy()

  const onRolesAssigned = (seatRoles: Map<number, SystemRole>) => {
    const candidates = [...seatRoles].filter(([_, role]) => mlRolesSet.has(role))
    // seed ベースでシャッフル
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = (seed * 7 + i * 13) % (i + 1)
      ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
    }
    const limit = mlMaxSeats ?? candidates.length
    for (let i = 0; i < Math.min(limit, candidates.length); i++) {
      strategies.set(candidates[i][0], new FenrirStrategy(network, { explore: true, strategyOnly: trainingConfig.strategyOnly, activeFromDay: mlStartDay }))
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
      enableRetar: trainingConfig.enableRetar,
      retarStartDay: mlStartDay,
      roles,
      rules: trainingConfig.rules,
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
      retarStartDay: mlStartDay,
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

function promptChoice(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase())
    })
  })
}

/** checkpoint ディレクトリの最古・最新 timestamp を取得 */
function getCheckpointTimeRange(baseDir: string): { oldest: string, newest: string, totalFiles: number } | null {
  let oldest = '', newest = ''
  let totalFiles = 0
  for (const name of MODEL_NAMES) {
    const dir = `${baseDir}/ckpt-${name}`
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const data = JSON.parse(readFileSync(`${dir}/${f}`, 'utf-8'))
        const ts = data.metadata?.timestamp as string | undefined
        if (!ts) continue
        totalFiles++
        if (!oldest || ts < oldest) oldest = ts
        if (!newest || ts > newest) newest = ts
      } catch { /* corrupt file */ }
    }
  }
  if (totalFiles === 0) return null
  return { oldest, newest, totalFiles }
}

/** --resume 無しで既存 checkpoint がある場合、削除確認を出す */
async function checkExistingCheckpoints(config: OrchestratorConfig): Promise<void> {
  if (config.resume) return
  const range = getCheckpointTimeRange(config.checkpointBase)
  if (!range) return

  const fmtTime = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
  }

  log(`${BOLD}既存チェックポイントを検出:${RESET}`)
  log(`  パス: ${config.checkpointBase}/`)
  log(`  ファイル数: ${range.totalFiles}`)
  log(`  学習期間: ${fmtTime(range.oldest)} 〜 ${fmtTime(range.newest)}`)
  log('')
  log(`  [y] 全削除して新規学習 (pretrain からやり直し)`)
  log(`  [p] PPOチェックポイントだけ削除 (pretrain は残して PPO からやり直し)`)
  log(`  [n] 中断 (--resume で再開可能)`)

  const choice = await promptChoice(`  選択 (y/p/N): `)
  if (choice === 'y') {
    for (const name of MODEL_NAMES) {
      const dir = `${config.checkpointBase}/ckpt-${name}`
      if (existsSync(dir)) rmSync(dir, { recursive: true })
    }
    log('全チェックポイントを削除しました。')
  } else if (choice === 'p') {
    // checkpoint_0.json (pretrain) だけ残し、iter>0 のチェックポイントを削除
    for (const name of MODEL_NAMES) {
      const dir = `${config.checkpointBase}/ckpt-${name}`
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir)) {
        const m = f.match(/^(?:checkpoint|wolf_team|mason_team)_(\d+)\.json$/)
        if (m && parseInt(m[1]) > 0) {
          try { unlinkSync(`${dir}/${f}`) } catch {}
        }
        if (f === 'final.json' || f === 'wolf_team_final.json' || f === 'mason_team_final.json') {
          try { unlinkSync(`${dir}/${f}`) } catch {}
        }
        if (f === 'eval_log.jsonl') {
          try { unlinkSync(`${dir}/${f}`) } catch {}
        }
      }
    }
    log('PPOチェックポイントを削除しました (pretrain checkpoint_0 は保持)。')
    config.resume = true  // pretrain checkpoint から resume
  } else {
    log('中断しました。--resume を付けて再実行してください。')
    process.exit(0)
  }
}

function findCheckpoint(dir: string, prefix: string = 'checkpoint'): { iteration: number, path: string } | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
  // final variants: prefix_final.json or final.json
  const finalName = `${prefix}_final.json`
  for (const candidate of [finalName, 'final.json']) {
    if (files.includes(candidate)) {
      const raw = JSON.parse(readFileSync(`${dir}/${candidate}`, 'utf-8'))
      return { iteration: raw.metadata?.iteration ?? 0, path: `${dir}/${candidate}` }
    }
  }
  let maxIter = -1
  const regex = new RegExp(`^${prefix}_(\\d+)\\.json$`)
  for (const f of files) {
    const m = f.match(regex)
    if (m) { const n = parseInt(m[1]); if (n > maxIter) maxIter = n }
  }
  if (maxIter < 0) return null
  return { iteration: maxIter, path: `${dir}/${prefix}_${maxIter}.json` }
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
  await checkExistingCheckpoints(config)

  // Git情報
  const gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  const gitDirty = execSync('git status --porcelain', { encoding: 'utf-8' }).trim() !== ''
  log(`${BOLD}Fenrir Training Orchestrator (round-robin)${RESET}`)
  log(`Git: ${gitSha}${gitDirty ? ' (dirty)' : ''} | ${new Date().toISOString()}`)
  log(`Architecture: ${config.transformer ? 'Transformer' : 'MLP'}${config.strategyOnly ? ' (strategy-only)' : ''}`)
  log(`Iterations: ${config.iterations}/model, Chunk: ${config.chunkSize}, Batch: ${config.batch}`)

  const trainingConfig: TrainingConfig = {
    ...DEFAULT_TRAINING_CONFIG,
    gamesPerBatch: config.batch,
    enableRetar: !config.noRetar,
    learningRate: config.learningRate,
    rewardConfig: DEFAULT_REWARD_CONFIG,
    useTransformer: config.transformer,
    strategyOnly: config.strategyOnly,
    miniBatchSize: config.miniBatchSize ?? DEFAULT_TRAINING_CONFIG.miniBatchSize,
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
  if (config.workers !== 0) {
    initGameWorkerPool(config.workers === -1 ? undefined : config.workers)
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

  // resume 時も PPO lr を適用（pretrain 後の低 lr）
  if (anyResumed && config.transformer) {
    const ppoLr = config.learningRate * 0.2
    ;(tfNetwork as any).setLearningRate(ppoLr)
    ;(wolfTeamTf as any).setLearningRate?.(ppoLr)
    ;(masonTeamTf as any).setLearningRate?.(ppoLr)
    log(`  PPO learning rate: ${ppoLr.toExponential(1)}`)
  }

  // === Pretrain: plan tokens の事前学習 (新規学習時のみ、Transformer限定) ===
  if (!anyResumed && config.transformer) {
    log(`${BOLD}=== Pretrain B: Plan Token Supervised Learning ===${RESET}`)
    const tB0 = performance.now()
    const pretrainBatchSize = 512
    const pretrainMaxEpochs = 1000
    const pretrainTargetAcc = 0.85
    const pretrainLogInterval = 100

    let bestAcc = 0
    for (let epoch = 1; epoch <= pretrainMaxEpochs; epoch++) {
      const samples = generatePlanTokenTrainingBatch(pretrainBatchSize, epoch)
      const { loss, accuracy } = (tfNetwork as any).trainSupervisedPlan({
        observations: samples.map(s => s.observation),
        forwardLabels: samples.map(s => s.forwardLabels),
        forwardMasks: samples.map(s => s.forwardMask),
        numTokens: samples[0].forwardLabels.length,
        vocabSize: PLAN_VOCAB.SIZE,
      })
      if (accuracy > bestAcc) bestAcc = accuracy
      if (epoch % pretrainLogInterval === 0 || epoch === 1) {
        log(`  epoch=${epoch} loss=${loss.toFixed(4)} acc=${(accuracy * 100).toFixed(1)}% best=${(bestAcc * 100).toFixed(1)}%`)
      }
      if (accuracy >= pretrainTargetAcc) {
        log(`  Target accuracy ${(pretrainTargetAcc * 100).toFixed(0)}% reached at epoch ${epoch}`)
        break
      }
    }
    // pretrain 済みの重みを village の推論用 NN にコピー
    const villageNet = networks.get('village' as ModelName)
    if (villageNet) {
      villageNet.loadWeights(tfNetwork.cloneWeights())
      log(`  Pretrained weights → village network`)
    }
    log(`  Method B complete: ${(bestAcc * 100).toFixed(1)}% accuracy, ${((performance.now() - tB0) / 1000).toFixed(1)}s`)

    // === Method D: 実ゲームで predict + value の事前学習 ===
    log(`${BOLD}=== Pretrain D: Heuristic Game Supervised Learning ===${RESET}`)
    const pretrainGames = 100
    const pretrainDEpochs = 30

    log(`  Collecting data from ${pretrainGames} heuristic games...`)
    const tD0 = performance.now()
    const gameSamples = await collectBatchGameData(trainingConfig, pretrainGames)
    const tDCollect = performance.now() - tD0
    log(`  Collected ${gameSamples.length} vote samples from ${pretrainGames} games in ${(tDCollect / 1000).toFixed(1)}s (${(tDCollect / pretrainGames).toFixed(0)}ms/game)`)

    if (gameSamples.length > 0) {
      const dMiniBatch = 256
      for (let epoch = 1; epoch <= pretrainDEpochs; epoch++) {
        let epochPlanLoss = 0, epochPlanAcc = 0, epochPredLoss = 0, epochValLoss = 0
        let batchCount = 0

        for (let offset = 0; offset < gameSamples.length; offset += dMiniBatch) {
          const batch = gameSamples.slice(offset, offset + dMiniBatch)

          const planResult = (tfNetwork as any).trainSupervisedPlan({
            observations: batch.map(s => s.observation),
            forwardLabels: batch.map(s => s.forwardLabels),
            forwardMasks: batch.map(s => s.forwardMask),
            numTokens: batch[0].forwardLabels.length,
            vocabSize: PLAN_VOCAB.SIZE,
          })

          const multiResult = (tfNetwork as any).trainSupervisedMulti({
            observations: batch.map(s => s.observation),
            predictLabels: batch.map(s => s.predictLabel),
            valueLabels: batch.map(s => s.valueLabel),
          })

          epochPlanLoss += planResult.loss
          epochPlanAcc += planResult.accuracy
          epochPredLoss += multiResult.predictLoss
          epochValLoss += multiResult.valueLoss
          batchCount++
        }

        if ((epoch % 5 === 0 || epoch === 1) && batchCount > 0) {
          log(`  epoch=${epoch} plan_loss=${(epochPlanLoss / batchCount).toFixed(4)} plan_acc=${(epochPlanAcc / batchCount * 100).toFixed(1)}% pred_loss=${(epochPredLoss / batchCount).toFixed(4)} val_loss=${(epochValLoss / batchCount).toFixed(4)}`)
        }
      }

      // 重みを village にコピー
      const villageNet2 = networks.get('village' as ModelName)
      if (villageNet2) {
        villageNet2.loadWeights(tfNetwork.cloneWeights())
        log(`  Method D pretrained weights → village network`)
      }
    }
    const tDTotal = performance.now() - tD0
    log(`  Method D complete: ${pretrainGames} games, ${pretrainDEpochs} epochs, ${(tDTotal / 1000).toFixed(1)}s total`)

    // Pretrain 済み checkpoint を保存 (--resume で復帰可能)
    const villageDir = `${config.checkpointBase}/ckpt-village`
    saveCheckpoint(networks.get('village' as ModelName)!, `${villageDir}/checkpoint_0.json`, { iteration: 0, winRate: 0 })
    log(`  Pretrain checkpoint saved → ${villageDir}/checkpoint_0.json`)

    // PPO 用に学習率を下げる（pretrain の知識を保持するため）
    const ppoLr = config.learningRate * 0.2  // 3e-4 → 6e-5
    ;(tfNetwork as any).setLearningRate(ppoLr)
    ;(wolfTeamTf as any).setLearningRate?.(ppoLr)
    ;(masonTeamTf as any).setLearningRate?.(ppoLr)
    log(`  PPO learning rate: ${ppoLr.toExponential(1)} (${config.learningRate.toExponential(1)} × 0.2)`)
  }

  // === Reference network for KL penalty ===
  // 常に現在の village 重みからスナップショット。
  // checkpoint_0 (pretrain) ではなく現在重みを使う理由:
  // frozen-plan PPO で trunk が変わっているため、pretrain trunk と現在 trunk で
  // plan logits が大きく異なり、KL が最初から巨大になる。
  let refNetwork: AnyNetwork | undefined
  if (config.transformer) {
    refNetwork = createTransformerNetwork()
    const villageNet = networks.get('village' as ModelName)
    if (villageNet) refNetwork.loadWeights(villageNet.cloneWeights())
    log(`Reference network created from current village weights (KL anchor)`)
  }

  // === Baseline (14D猫 heuristic vs heuristic, ハードコード) ===
  // 100ゲーム × 複数回の測定結果から: village≈55%, hamster≈27%, wolf≈15%, draw≈3%
  const baselineRates: Record<string, number> = {
    villager_won: 0.55,
    werehamster_won: 0.27,
    werewolf_won: 0.15,
    draw: 0.03,
  }
  log(`Baseline (hardcoded): ${Object.entries(baselineRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')}`)

  // === Phase 1: ラウンドロビン ===
  if (!config.phase2Only) {
    log(`${BOLD}=== Phase 1: Round-Robin Training ===${RESET}`)

    const graduated = new Set<ModelName>()
    // カリキュラム: NN 席数を徐々に増やす (village のみ)
    let mlMaxSeats = 1
    const ML_MAX_SEATS_CAP = 7  // 村役職の最大数
    // カリキュラム: ML/Retar開始Dayを徐々に前に (序盤Retarコスト回避)
    let mlStartDay = 4
    const ML_START_DAY_MIN = 1  // 全日ML
    log(`  Initial mlMaxSeats=${mlMaxSeats} mlStartDay=${mlStartDay}`)

    const ppoConfig = {
      miniBatchSize: trainingConfig.miniBatchSize,
      clipEpsilon: trainingConfig.clipEpsilon,
      valueLossCoeff: trainingConfig.valueLossCoeff,
      entropyCoeff: trainingConfig.entropyCoeff,
      freezePlan: false,  // plan 解凍 + KL penalty で pretrain 知識を保護
      klCoeff: refNetwork ? 0.2 : 0,
    }

    // Seed Bank: ディスクからスナップショットを読み込み
    const villageRoles = MODEL_GROUPS.village.roles as string[]
    let snapshotCount = mlStartDay > ML_START_DAY_MIN ? countSnapshots(mlStartDay - 1, villageRoles, mlMaxSeats) : 0
    const evalSnapshotCount = mlStartDay > ML_START_DAY_MIN ? countSnapshots(mlStartDay - 1, villageRoles, mlMaxSeats, true) : 0
    if (mlStartDay > ML_START_DAY_MIN && snapshotCount === 0) {
      log(`  ⚠ No snapshots at Day ${mlStartDay - 1} (run: npm run generate-snapshots -- --day ${mlStartDay - 1} --alive village --min-alive ${mlMaxSeats}). Falling back to full games.`)
    } else if (snapshotCount > 0) {
      log(`  Seed bank: ${snapshotCount} train + ${evalSnapshotCount} eval snapshots at Day ${mlStartDay - 1}`)
    }
    if (mlStartDay > ML_START_DAY_MIN && evalSnapshotCount === 0) {
      log(`  ⚠ No eval snapshots (run: npm run generate-snapshots -- --day ${mlStartDay - 1} --alive village --min-alive ${mlMaxSeats} --for-eval)`)
    }

    // Phase 1: village のみ学習（wolf/third は strategy-only 未対応）
    const phase1Models: ModelName[] = ['village']
    // wolf/third は即 graduated 扱い
    for (const name of MODEL_NAMES) {
      if (!phase1Models.includes(name)) graduated.add(name)
    }

    let round = 0
    while (graduated.size < MODEL_NAMES.length) {
      round++
      for (const name of phase1Models) {
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

            // Seed Bank: スナップショットからリプレイ
            // Seed Bank: ディスクからランダムにスナップショットを読み込み
            const batchSnapshots = (snapshotCount > 0 && name === 'village')
              ? loadRandomSnapshots(mlStartDay - 1, seeds.length, new Rng(iter), {
                  aliveRoles: group.roles,
                  minAlive: mlMaxSeats,
                })
              : undefined

            const serializedResults = await generateGamesParallel({
              weights: sharedWeights,
              wolfTeamWeights: sharedWolfWeights,
              masonTeamWeights: sharedMasonWeights,
              useTeamStrategy: group.teamType,
              trainingConfig,
              phase: 1,
              mlRoles: group.roles,
              mlMaxSeats: name === 'village' ? mlMaxSeats : undefined,
              mlStartDay: (!batchSnapshots && name === 'village') ? mlStartDay : undefined,
              snapshots: batchSnapshots,
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
              const game = await generateGame(trainingConfig, network, wolfTeamNet, masonTeamNet, mlRolesSet, seed, group.teamType, name === 'village' ? mlMaxSeats : undefined, name === 'village' ? mlStartDay : undefined)
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
          const tPpoStart = performance.now()

          // PPO update (shared TfNN に重みをスワップ)
          let lastPpoResult = { policyLoss: 0, predictLoss: 0, klLoss: 0 }
          if (allIndividual.length > 0) {
            normalizeAdvantages(allIndividual)

            // Reference logits を iteration あたり1回だけ計算（epoch/minibatch をまたいで再利用）
            let precomputedRefLogits: Map<ProcessedStep, { fwd?: Float32Array, eg?: Float32Array }> | undefined
            if (refNetwork && ppoConfig.klCoeff && ppoConfig.klCoeff > 0) {
              precomputedRefLogits = new Map()
              for (const step of allIndividual) {
                if (step.actionHead === 'strategy') {
                  const { refFwdLogits, refEgLogits } = computeRefPlanLogits(refNetwork, step.observation)
                  precomputedRefLogits.set(step, { fwd: refFwdLogits, eg: refEgLogits })
                }
              }
            }

            tfNetwork.loadWeights(network.cloneWeights())
            for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
              lastPpoResult = ppoUpdate(tfNetwork, allIndividual, ppoConfig, precomputedRefLogits)
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

          // Adaptive KL: β を自動調整して KL を目標付近に維持
          if (ppoConfig.klCoeff > 0 && lastPpoResult.klLoss > 0) {
            const klTarget = 0.05  // 目標 KL divergence
            if (lastPpoResult.klLoss > klTarget * 1.5) {
              ppoConfig.klCoeff *= 1.5  // KL 高すぎ → β 増
            } else if (lastPpoResult.klLoss < klTarget / 1.5) {
              ppoConfig.klCoeff /= 1.5  // KL 低すぎ → β 減
            }
            // β の上下限
            ppoConfig.klCoeff = Math.max(0.01, Math.min(10, ppoConfig.klCoeff))
          }

          const tPpoEnd = performance.now()

          const iterMs = performance.now() - iterStart
          iterElapsed += iterMs
          iterCount++

          iterCounts.set(name, iter)

          // Progress
          const pct = (iter / config.iterations * 100).toFixed(1)
          const gameMs = tGameEnd - tGameStart
          const ppoMs = tPpoEnd - tPpoStart
          const gamePct = (gameMs / iterMs * 100).toFixed(0)
          const ppoPct = (ppoMs / iterMs * 100).toFixed(0)
          const totalSteps = allIndividual.length + allWolfTeam.length + allMasonTeam.length
          const avgIterMs = (iterElapsed / iterCount / 1000).toFixed(1)
          const remaining = ((targetIter - iter) * iterElapsed / iterCount / 1000).toFixed(0)
          // worker timing breakdown (if available from parallel path)
          let timingStr = ''
          if (lastBatchTimings.length > 0) {
            const n = lastBatchTimings.length
            const avgGame = lastBatchTimings.reduce((a, t) => a + t.gameMs, 0) / n
            const avgInfer = lastBatchTimings.reduce((a, t) => a + t.inferMs, 0) / n
            const avgInferCount = lastBatchTimings.reduce((a, t) => a + t.inferCount, 0) / n
            const avgRetar = lastBatchTimings.reduce((a, t) => a + t.retarMs, 0) / n
            const avgRetarCount = lastBatchTimings.reduce((a, t) => a + t.retarCount, 0) / n
            const avgTsumi = lastBatchTimings.reduce((a, t) => a + t.tsumiMs, 0) / n
            const avgTsumiCount = lastBatchTimings.reduce((a, t) => a + t.tsumiCount, 0) / n
            const fmtBreakdown = (totalMs: number, count: number) => {
              if (count === 0) return `${totalMs.toFixed(0)}ms`
              return `${(totalMs / count).toFixed(1)}ms×${count.toFixed(0)}=${totalMs.toFixed(0)}ms`
            }
            timingStr = `${avgGame.toFixed(0)}ms/game (infer ${fmtBreakdown(avgInfer, avgInferCount)} retar ${fmtBreakdown(avgRetar, avgRetarCount)} tsumi ${fmtBreakdown(avgTsumi, avgTsumiCount)}) `
          }
          const mlInfo = name === 'village' ? ` ml=${mlMaxSeats}/${ML_MAX_SEATS_CAP} day=${mlStartDay}` : ''
          const lossStr = lastPpoResult.policyLoss ? ` pol=${lastPpoResult.policyLoss.toFixed(4)}` : ''
          const klStr = lastPpoResult.klLoss ? ` kl=${lastPpoResult.klLoss.toFixed(4)}(β=${ppoConfig.klCoeff.toFixed(3)})` : ''
          process.stderr.write(
            `\r\x1b[K  ${prefix} iter ${iter}/${config.iterations} (${pct}%) ` +
            `${iterMs.toFixed(0)}ms (game${gamePct}% ppo${ppoPct}%) ${timingStr}` +
            `steps=${totalSteps}${mlInfo}${lossStr}${klStr} ${avgIterMs}s/iter ETA ${remaining}s`
          )

          // Eval
          if (iter % config.evalInterval === 0) {
            process.stderr.write(`\r\x1b[K  ${prefix} iter ${iter} evaluating (${config.evalGames} games)...`)
            const evalConfig = { ...trainingConfig, mlRoles: group.roles }
            const evalMlMax = name === 'village' ? mlMaxSeats : undefined
            const evalSnapshots = (snapshotCount > 0 && name === 'village')
              ? loadRandomSnapshots(mlStartDay - 1, config.evalGames, new Rng(42), {
                  aliveRoles: group.roles,
                  minAlive: mlMaxSeats,
                  forEval: true,
                })
              : undefined
            const evalResult = await evaluate(network, evalConfig, config.evalGames, wolfTeamNet, masonTeamNet, evalMlMax, evalSnapshots ? { snapshots: evalSnapshots } : undefined)
            process.stderr.write('\r\x1b[K')
            appendEvalLog(`${config.checkpointBase}/ckpt-${name}`, iter, evalResult, name)
            const factionRate = evalResult.winRates[group.faction] ?? 0
            log(
              `${prefix} [${iter}] ${Object.entries(evalResult.winRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')} ` +
              `avgLen=${evalResult.avgGameLength.toFixed(1)} ${evalResult.avgElapsedMs.toFixed(0)}ms/eval`
            )

            // カリキュラム: 勝率がベースラインの90%に達したら NN 席数を増やす / 開始Dayを前に
            if (name === 'village' && mlMaxSeats < ML_MAX_SEATS_CAP && factionRate >= targetRate * 0.9) {
              mlMaxSeats = Math.min(mlMaxSeats + 1, ML_MAX_SEATS_CAP)
              log(`${prefix} Curriculum: mlMaxSeats → ${mlMaxSeats}`)
            }
            if (name === 'village' && mlStartDay > ML_START_DAY_MIN && factionRate >= targetRate * 0.9) {
              mlStartDay = Math.max(mlStartDay - 1, ML_START_DAY_MIN)
              log(`${prefix} Curriculum: mlStartDay → ${mlStartDay}`)
              // Seed Bank: 新しい Day のスナップショット数を確認
              snapshotCount = mlStartDay > ML_START_DAY_MIN ? countSnapshots(mlStartDay - 1, villageRoles, mlMaxSeats) : 0
              if (mlStartDay > ML_START_DAY_MIN && snapshotCount === 0) {
                log(`${prefix} ⚠ No snapshots at Day ${mlStartDay - 1} (run: npm run generate-snapshots -- --day ${mlStartDay - 1} --alive village --min-alive ${mlMaxSeats}). Falling back to full games.`)
              } else if (snapshotCount > 0) {
                log(`${prefix} Seed bank: ${snapshotCount} snapshots at Day ${mlStartDay}`)
              }
            }

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

  // === Phase 1': 集団NN + 狂信者 + 第三勢力の学習 (frozen村NN注入) ===
  if (!config.phase2Only) {
    log(`${BOLD}=== Phase 1': Collective + Non-Village Training ===${RESET}`)

    // 集団NN用の推論/学習ネットワーク (config が異なるため専用インスタンスが必要)
    const wolfCollectiveNet = createWolfCollectiveNetwork()
    const masonCollectiveNet = createMasonCollectiveNetwork()
    const wolfCollectiveTf = createWolfCollectiveTfNetwork(config.learningRate)
    const masonCollectiveTf = createMasonCollectiveTfNetwork(config.learningRate)

    // 狂信者専用NN (村NN注入のため個人NNとは config が異なる)
    const fanaticNet = createFanaticNetwork()
    const fanaticTf = createFanaticTfNetwork(config.learningRate)
    networks.set('fanatic', fanaticNet)  // 汎用個人NNを狂信者専用に置き換え

    // frozen村NNの重み (Phase 1 で学習済み)
    const frozenVillageWeights = packWeights(networks.get('village')!)

    // Phase 1' の学習対象
    const phase1PrimeModels: ModelName[] = ['wolf_collective', 'mason_collective', 'fanatic', 'third']
    const phase1PrimeGraduated = new Set<ModelName>()
    const phase1PrimeIterCounts = new Map<ModelName, number>()
    for (const name of phase1PrimeModels) phase1PrimeIterCounts.set(name, 0)

    // === Phase 1' Resume ===
    if (config.resume) {
      let anyResumedPrime = false
      for (const name of phase1PrimeModels) {
        const group = MODEL_GROUPS[name]
        const dir = `${config.checkpointBase}/ckpt-${name}`
        const prefix = group.collective ? 'collective' : 'checkpoint'
        const ckpt = findCheckpoint(dir, prefix)
        if (ckpt) {
          try {
            const net = group.collective
              ? (name === 'wolf_collective' ? wolfCollectiveNet : masonCollectiveNet)
              : networks.get(name)!
            loadCheckpoint(net, ckpt.path)
            phase1PrimeIterCounts.set(name, ckpt.iteration)
            anyResumedPrime = true
            log(`  ${COLORS[name]}${name}${RESET}: resumed from iter ${ckpt.iteration}`)
          } catch (e) {
            log(`  ${COLORS[name]}${name}${RESET}: checkpoint incompatible, starting fresh (${(e as Error).message})`)
          }
        }
        // final checkpoint → graduated
        const finalName = group.collective ? 'collective_final.json' : 'final.json'
        if (existsSync(`${dir}/${finalName}`)) {
          phase1PrimeGraduated.add(name)
          log(`  ${COLORS[name]}${name}${RESET}: already graduated`)
        }
      }
      if (anyResumedPrime) {
        log('Phase 1\' Resume:')
        for (const name of phase1PrimeModels) {
          const iter = phase1PrimeIterCounts.get(name)!
          log(`  ${COLORS[name]}${name.padEnd(16)}${RESET} iter ${iter}${phase1PrimeGraduated.has(name) ? ' (graduated)' : ''}`)
        }
      }
    }

    const ppoConfig = {
      miniBatchSize: trainingConfig.miniBatchSize,
      clipEpsilon: trainingConfig.clipEpsilon,
      valueLossCoeff: trainingConfig.valueLossCoeff,
      entropyCoeff: trainingConfig.entropyCoeff,
    }

    // 全5モデルの weights を modelGroupWeights として pack
    const packAllModelWeights = (): Record<string, import('./parallel.ts').SharedWeights> => {
      const result: Record<string, import('./parallel.ts').SharedWeights> = {}
      result['village'] = frozenVillageWeights
      result['wolf_collective'] = packWeights(wolfCollectiveNet)
      result['mason_collective'] = packWeights(masonCollectiveNet)
      result['fanatic'] = packWeights(networks.get('fanatic')!)
      result['third'] = packWeights(networks.get('third')!)
      return result
    }

    let round = 0
    while (phase1PrimeGraduated.size < phase1PrimeModels.length) {
      round++
      for (const name of phase1PrimeModels) {
        if (phase1PrimeGraduated.has(name)) continue

        const group = MODEL_GROUPS[name]
        const currentIter = phase1PrimeIterCounts.get(name)!
        const targetIter = Math.min(currentIter + config.chunkSize, config.iterations)
        const prefix = `${COLORS[name]}[${name.padEnd(16)}]${RESET}`

        for (let iter = currentIter + 1; iter <= targetIter; iter++) {
          const iterStart = performance.now()
          const seeds = Array.from({ length: config.batch }, (_, g) => (10000 + iter) * config.batch + g)

          // ゲーム生成 (マルチモデルモード)
          const tGameStart = performance.now()
          const allIndividual: ProcessedStep[] = []
          const allWolfCollective: ProcessedStep[] = []
          const allMasonCollective: ProcessedStep[] = []

          if (gameWorkerPoolSize() > 0) {
            const modelGroupWeights = packAllModelWeights()
            const serializedResults = await generateGamesParallel({
              weights: frozenVillageWeights,  // fallback
              modelGroupWeights,
              villageFrozenWeights: frozenVillageWeights,
              trainingConfig,
              phase: 1,
            }, seeds)

            for (const game of serializedResults) {
              // 個人steps: fanatic/third のみ収集 (village は frozen)
              for (const { role, steps } of game.individualSteps) {
                const groupName = ROLE_TO_GROUP[role]
                if (groupName === name && steps.length > 0) {
                  const deserialized = steps.map(deserializeStep)
                  allIndividual.push(...computeGAE(deserialized, trainingConfig.gamma, trainingConfig.lambda, 0))
                }
              }
              // 集団steps
              if (game.wolfTeamSteps.length > 0 && name === 'wolf_collective') {
                allWolfCollective.push(...computeGAE(game.wolfTeamSteps.map(deserializeStep), trainingConfig.gamma, trainingConfig.lambda, 0))
              }
              if (game.masonTeamSteps.length > 0 && name === 'mason_collective') {
                allMasonCollective.push(...computeGAE(game.masonTeamSteps.map(deserializeStep), trainingConfig.gamma, trainingConfig.lambda, 0))
              }
            }
          }
          const tGameEnd = performance.now()
          const tPpoStart = performance.now()

          // PPO update
          if (group.collective) {
            // 集団NN の PPO
            const steps = name === 'wolf_collective' ? allWolfCollective : allMasonCollective
            if (steps.length > 0) {
              normalizeAdvantages(steps)
              const collectiveNet = name === 'wolf_collective' ? wolfCollectiveNet : masonCollectiveNet
              const collectiveTf = name === 'wolf_collective' ? wolfCollectiveTf : masonCollectiveTf
              collectiveTf.loadWeights(collectiveNet.cloneWeights())
              for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
                ppoUpdate(collectiveTf, steps, ppoConfig)
              }
              collectiveNet.loadWeights(collectiveTf.cloneWeights())
            }
          } else {
            // 個人NN (fanatic, third) の PPO
            if (allIndividual.length > 0) {
              normalizeAdvantages(allIndividual)
              const network = networks.get(name)!
              const tf = name === 'fanatic' ? fanaticTf : tfNetwork
              tf.loadWeights(network.cloneWeights())
              for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
                ppoUpdate(tf, allIndividual, ppoConfig)
              }
              network.loadWeights(tf.cloneWeights())
            }
          }

          const tPpoEnd = performance.now()
          const iterMs = performance.now() - iterStart
          phase1PrimeIterCounts.set(name, iter)

          // Progress
          const totalSteps = allIndividual.length + allWolfCollective.length + allMasonCollective.length
          const gameMs = tGameEnd - tGameStart
          const ppoMs = tPpoEnd - tPpoStart
          process.stderr.write(
            `\r\x1b[K  ${prefix} iter ${iter}/${config.iterations} ` +
            `${iterMs.toFixed(0)}ms (game${(gameMs / iterMs * 100).toFixed(0)}% ppo${(ppoMs / iterMs * 100).toFixed(0)}%) ` +
            `steps=${totalSteps}`
          )

          // Checkpoint
          if (iter % config.checkpointInterval === 0) {
            const dir = `${config.checkpointBase}/ckpt-${name}`
            if (group.collective) {
              const collectiveNet = name === 'wolf_collective' ? wolfCollectiveNet : masonCollectiveNet
              saveCheckpoint(collectiveNet, `${dir}/collective_${iter}.json`, { iteration: iter, winRate: 0 })
            } else {
              saveCheckpoint(networks.get(name)!, `${dir}/checkpoint_${iter}.json`, { iteration: iter, winRate: 0 })
            }
          }

          // Eval (全5モデル同時評価)
          if (iter % config.evalInterval === 0) {
            process.stderr.write(`\r\x1b[K  ${prefix} iter ${iter} evaluating (${config.evalGames} games)...`)
            // 全役職をMLで動かすため、全モデルの roles を集約
            const allMlRoles = Object.values(MODEL_GROUPS).flatMap(g => g.roles)
            const evalConfig = { ...trainingConfig, mlRoles: allMlRoles }
            const individualNets = new Map<string, AnyNetwork>()
            for (const role of MODEL_GROUPS.village.roles) individualNets.set(role, networks.get('village')!)
            for (const role of MODEL_GROUPS.third.roles) individualNets.set(role, networks.get('third')!)
            const evalResult = await evaluate(
              networks.get('village')!, evalConfig, config.evalGames,
              undefined, undefined, undefined,
              {
                wolfCollectiveNet,
                masonCollectiveNet,
                fanaticNet: networks.get('fanatic')!,
                frozenVillageNet: networks.get('village')!,
                individualNets,
              },
            )
            process.stderr.write('\r\x1b[K')
            appendEvalLog(`${config.checkpointBase}/ckpt-${name}`, iter, evalResult, name)
            const factionRate = evalResult.winRates[group.faction] ?? 0
            const targetRate = config.targetWinRate ?? (baselineRates[group.faction] ?? 0.5)
            log(
              `${prefix} [${iter}] ${Object.entries(evalResult.winRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')} ` +
              `avgLen=${evalResult.avgGameLength.toFixed(1)} ${evalResult.avgElapsedMs.toFixed(0)}ms/eval`
            )
            if (factionRate >= targetRate) {
              log(`${prefix} ${BOLD}GRADUATED${RESET} (${group.faction}=${(factionRate * 100).toFixed(0)}% >= ${(targetRate * 100).toFixed(0)}%)`)
              phase1PrimeGraduated.add(name)
              break
            }
          }
        }

        process.stderr.write('\r\x1b[K')

        // 上限到達チェック
        if (!phase1PrimeGraduated.has(name) && phase1PrimeIterCounts.get(name)! >= config.iterations) {
          log(`${prefix} reached max iterations (${config.iterations})`)
          phase1PrimeGraduated.add(name)
        }

        // Final save
        if (phase1PrimeGraduated.has(name)) {
          const dir = `${config.checkpointBase}/ckpt-${name}`
          if (group.collective) {
            const collectiveNet = name === 'wolf_collective' ? wolfCollectiveNet : masonCollectiveNet
            saveCheckpoint(collectiveNet, `${dir}/collective_final.json`, { iteration: phase1PrimeIterCounts.get(name)!, winRate: 0 })
          } else {
            saveCheckpoint(networks.get(name)!, `${dir}/final.json`, { iteration: phase1PrimeIterCounts.get(name)!, winRate: 0 })
          }
        }
      }

      log(`Round ${round}: ${phase1PrimeGraduated.size}/${phase1PrimeModels.length} graduated [${phase1PrimeModels.map(n => phase1PrimeGraduated.has(n) ? `${COLORS[n]}OK${RESET}` : `${COLORS[n]}..${RESET}`).join(' ')}]`)
    }

    // Phase 1' cleanup
    wolfCollectiveTf.dispose()
    masonCollectiveTf.dispose()
    fanaticTf.dispose()

    log(`${BOLD}=== Phase 1' Complete ===${RESET}`)
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
