/**
 * Fenrir Phase Runner — 汎用 PPO ループエンジン
 *
 * curriculum.ts の TrainingStep を受け取り、ネットワーク管理・ゲーム生成・
 * PPO 更新・eval・卒業判定をフェーズ非依存で実行する。
 */

import type { AnyNetwork, AnyTfNetwork } from './ml/nn.ts'
import type { TrainingConfig } from './training.ts'
import type { ProcessedStep } from './ml/trajectory.ts'
import type { SharedWeights, SerializedGameResult, WreSharedWeights, GameTiming } from './parallel.ts'
import type { TrainingStep, ModelName, AgentAssignment, SingleModelGen } from './curriculum.ts'
import {
  MODEL_GROUPS, MODEL_NAMES, ROLE_TO_GROUP, BASELINE_RATES,
  klTargetForIter, formatAssignment,
} from './curriculum.ts'
import { computeRefPlanLogits } from './agents/neural-agent.ts'
import { normalizeAdvantages, computeGAE, processTrajectories } from './ml/trajectory.ts'
import type { TrajectoryStep } from './ml/trajectory.ts'
import { saveCheckpoint, loadCheckpoint } from './ml/checkpoint.ts'
import { evaluate, appendEvalLog } from './training.ts'
import {
  packWeights, generateGamesParallel, deserializeStep, gameWorkerPoolSize,
  type AgentSpec,
} from './parallel.ts'
import { existsSync, readdirSync, readFileSync, appendFileSync, unlinkSync } from 'node:fs'

// ============================================================
// Types
// ============================================================

export type PhaseRunnerContext = {
  config: OrchestratorConfig
  trainingConfig: TrainingConfig
  progress: TrainProgress
  runId: string
  gitSha: string

  /** 推論用ネットワーク (CPU, Pure JS) — ModelName + 'mason_individual' */
  networks: Map<string, AnyNetwork>
  /** 学習用ネットワーク (GPU, TF.js) — ModelName + 'mason_individual' */
  tfNetworks: Map<string, AnyTfNetwork>

  /** KL anchor */
  refNetwork?: AnyNetwork
  /** frozen 済みの重み (e.g. mason_individual → Phase 1, village → Phase 1') */
  frozenWeights: Map<string, SharedWeights>
  /** frozen 推論用ネットワーク (eval で使用) */
  frozenNets: Map<string, AnyNetwork>

  /** Wolf brain ネットワーク (Brain Battle phase 用) */
  wolfBrainNetwork?: AnyNetwork
  wolfBrainTfNetwork?: AnyTfNetwork

  /** BB+ 個別エージェントネットワーク (village, fanatic, third) */
  bbPlusNetworks?: Map<string, AnyNetwork>
  bbPlusTfNetworks?: Map<string, AnyTfNetwork>

  /** カリキュラム: 現在の NN 最大席数 (single_model phases で使用) */
  currentMlMaxSeats?: number

  /** WRE PBRS: frozen 勝率NNの共有重み（--wre 有効時のみ） */
  wreSharedWeights?: WreSharedWeights
  /** WRE再学習コールバック（orchestratorが提供） */
  onWreRefresh?: (games: SerializedGameResult[]) => Promise<WreSharedWeights | undefined>

  checkShutdown: () => void
  log: (msg: string) => void
  writeTrainProgress: (progress: TrainProgress) => void
  pickInspectSeeds: (seeds: number[]) => number[]
  saveInspectGames: (results: SerializedGameResult[], modelName: string, iteration: number) => void
  saveEvalHowl: (checkpointBase: string, iter: number, howlGames: any[]) => void
}

export type OrchestratorConfig = {
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
  strategyOnly: boolean
  miniBatchSize?: number
  inspectInterval: number
  ppoRestart: boolean
  skeleton: boolean
  curriculum: 'default' | 'brain-battle' | 'bb-plus'
  bbCheckpoint?: string
}

export type TrainProgress = {
  runId: string
  checkpointBase: string
  runInfo: {
    started: string
    gitSha: string
    arch: string
    configSummary: string
  }
  curriculum: ProgressCurriculumEntry[]
  evals: ProgressEvalEntry[]
  latest: {
    phase: string
    model: string
    iter: number
    maxIter: number
    klCoeff?: number
    mlMaxSeats?: number
    updated?: string
  }
}

export type ProgressEvalEntry = {
  time: string
  model: string
  iter: number
  winRates: Record<string, number>
  avgLen: number
  status: string
  ppoMetrics?: { policyLoss: number, valueLoss: number, entropy: number, predictLoss: number, klLoss: number }
  baseline?: number
  target?: number
  timing?: { gameMs: number, ppoMs: number, iterMs: number }
}

export type ProgressCurriculumEntry = {
  time: string
  iter: number
  mlMaxSeats: number
  event: string
}

// ============================================================
// Constants
// ============================================================

const COLORS: Record<string, string> = {
  village: '\x1b[33m', wolf_collective: '\x1b[31m', mason_collective: '\x1b[36m',
  fanatic: '\x1b[35m', third: '\x1b[32m', mason_individual: '\x1b[36m',
  wolf_brain: '\x1b[31m',
}
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

// ============================================================
// Checkpoint helpers
// ============================================================

export function findCheckpoint(dir: string, prefix: string = 'checkpoint'): { iteration: number, path: string } | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
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
// PPO Update
// ============================================================

export function ppoUpdate(
  tfNetwork: AnyTfNetwork,
  batch: ProcessedStep[],
  config: {
    miniBatchSize: number, clipEpsilon: number, valueLossCoeff: number, entropyCoeff: number,
    predictLossCoeff?: number, freezePlan?: boolean,
    klCoeff?: number,
  },
  precomputedRefLogits?: Map<ProcessedStep, { plan?: Float32Array }>,
): { policyLoss: number, valueLoss: number, entropy: number, predictLoss: number, klLoss: number, klPlanLoss: number } {
  if (batch.length === 0) return { policyLoss: 0, valueLoss: 0, entropy: 0, predictLoss: 0, klLoss: 0, klPlanLoss: 0 }

  let totalPolicyLoss = 0
  let totalValueLoss = 0
  let totalEntropy = 0
  let totalPredictLoss = 0
  let totalKlLoss = 0
  let totalKlPlanLoss = 0
  let batchCount = 0

  for (let i = batch.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[batch[i], batch[j]] = [batch[j], batch[i]]
  }

  for (let start = 0; start < batch.length; start += config.miniBatchSize) {
    const end = Math.min(start + config.miniBatchSize, batch.length)
    const miniBatch = batch.slice(start, end)

    let refPlanLogits: (Float32Array | undefined)[] | undefined
    if (precomputedRefLogits && config.klCoeff && config.klCoeff > 0) {
      refPlanLogits = miniBatch.map(s => precomputedRefLogits.get(s)?.plan)
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
      planActions: miniBatch.map(s => s.planActions),
      planLogProbs: miniBatch.map(s => s.planLogProbs),
      predictLossCoeff: config.predictLossCoeff ?? 0.1,
      clipEpsilon: config.clipEpsilon,
      valueLossCoeff: config.valueLossCoeff,
      entropyCoeff: config.entropyCoeff,
      freezePlan: config.freezePlan,
      refPlanLogits,
      klCoeff: config.klCoeff,
    })
    totalPolicyLoss += result.policyLoss
    totalValueLoss += result.valueLoss
    totalEntropy += result.entropy
    totalPredictLoss += result.predictLoss
    totalKlLoss += result.klLoss
    totalKlPlanLoss += result.klPlanLoss
    batchCount++
  }

  const n = Math.max(batchCount, 1)
  return {
    policyLoss: totalPolicyLoss / n,
    valueLoss: totalValueLoss / n,
    entropy: totalEntropy / n,
    predictLoss: totalPredictLoss / n,
    klLoss: totalKlLoss / n,
    klPlanLoss: totalKlPlanLoss / n,
  }
}

/** KL 診断ログを checkpointBase/kl_log.jsonl に追記 */
export function appendKlLog(
  checkpointBase: string,
  entry: { iter: number, klPlan: number, klTotal: number, beta: number, klTarget: number },
): void {
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() })
  appendFileSync(`${checkpointBase}/kl_log.jsonl`, line + '\n')
}

// ============================================================
// Internal helpers
// ============================================================

type PpoResult = { policyLoss: number, valueLoss: number, entropy: number, predictLoss: number, klLoss: number, klPlanLoss: number }
const ZERO_PPO: PpoResult = { policyLoss: 0, valueLoss: 0, entropy: 0, predictLoss: 0, klLoss: 0, klPlanLoss: 0 }

/** Build agentAssignment and modelGroupWeights from step definition and frozen state */
function buildAssignmentAndWeights(
  ctx: PhaseRunnerContext,
  step: TrainingStep,
  frozenModels?: Set<string>,
): { assignment: AgentAssignment, modelGroupWeights: Record<string, SharedWeights> } {
  const assignment = { ...step.agentAssignment }
  const modelGroupWeights: Record<string, SharedWeights> = {}
  for (const name of MODEL_NAMES) {
    // frozen override: step 定義が neural でも frozenModels に含まれていれば frozen
    if (frozenModels?.has(name) && assignment[name] !== 'heuristic') {
      assignment[name] = 'frozen'
    }
    if (assignment[name] === 'heuristic') continue
    // neural / frozen → weights を pack
    if (frozenModels?.has(name)) {
      const fw = ctx.frozenWeights.get(name)
      if (fw) { modelGroupWeights[name] = fw; continue }
    }
    const net = ctx.networks.get(name)
    if (net) modelGroupWeights[name] = packWeights(net)
  }
  return { assignment, modelGroupWeights }
}

/** Build EvaluateOptions from context */
function buildEvalOptions(ctx: PhaseRunnerContext, step: TrainingStep, iter: number) {
  // Single-model phases: simpler eval setup
  if (step.gameGen.mode === 'single_model') {
    return {
      masonAsIndividual: step.evalConfig?.masonAsIndividual,
      frozenMasonNet: ctx.frozenNets.get('mason_individual'),
      evalIter: iter,
      saveHowl: true,
    }
  }

  // Multi-model phases: full eval with all model networks
  const individualNets = new Map<string, AnyNetwork>()
  for (const [name, group] of Object.entries(MODEL_GROUPS) as [ModelName, (typeof MODEL_GROUPS)[ModelName]][]) {
    if (!group.collective) {
      const net = ctx.networks.get(name)!
      for (const role of group.roles) individualNets.set(role, net)
    }
  }
  return {
    wolfCollectiveNet: ctx.networks.get('wolf_collective')!,
    masonCollectiveNet: ctx.networks.get('mason_collective')!,
    fanaticNet: ctx.networks.get('fanatic')!,
    frozenVillageNet: ctx.frozenNets.get('village') ?? ctx.networks.get('village')!,
    individualNets,
    evalIter: iter,
    saveHowl: true,
  }
}

/** Checkpoint dir for a model in a step */
function checkpointDir(config: OrchestratorConfig, step: TrainingStep, name: string): string {
  return `${config.checkpointBase}/${step.checkpointDir ?? `ckpt-${name}`}`
}

/** Checkpoint file prefix for a model */
function checkpointPrefix(step: TrainingStep, name: string): { save: string, find: string } {
  const isPhase2 = step.name === 'self_play'
  const info = name in MODEL_GROUPS ? MODEL_GROUPS[name as ModelName] : null
  if (info?.collective) {
    return {
      save: isPhase2 ? `phase2_collective` : 'collective',
      find: isPhase2 ? 'phase2_collective' : 'collective',
    }
  }
  return {
    save: isPhase2 ? `phase2_checkpoint` : 'checkpoint',
    find: isPhase2 ? 'phase2_checkpoint' : 'checkpoint',
  }
}

/** Resolve model info for names that may not be in MODEL_GROUPS (e.g. mason_individual) */
type ModelInfo = { faction: string, collective: boolean, roles: string[] }
function resolveModelInfo(name: string): ModelInfo {
  if (name === 'mason_individual') return { faction: 'villager_won', collective: false, roles: ['mason'] }
  const group = MODEL_GROUPS[name as ModelName]
  if (!group) throw new Error(`Unknown model: ${name}`)
  return { faction: group.faction, collective: group.collective, roles: group.roles }
}

/** Phase display label for progress */
function phaseLabel(step: TrainingStep): string {
  if (step.name === 'self_play') return '2'
  if (step.name === 'brain_battle') return 'BB'
  if (step.name === 'non_village') return "1'"
  if (step.name === 'village') return '1'
  if (step.name === 'mason_individual') return '0'
  return step.name
}

/** Format per-game timing breakdown for progress display */
function formatTimingStr(timings: GameTiming[]): string {
  if (timings.length === 0) return ''
  const n = timings.length
  const avgGame = timings.reduce((a, t) => a + t.gameMs, 0) / n
  const avgInfer = timings.reduce((a, t) => a + t.inferMs, 0) / n
  const avgInferCount = timings.reduce((a, t) => a + t.inferCount, 0) / n
  const avgRetar = timings.reduce((a, t) => a + t.retarMs, 0) / n
  const avgRetarCount = timings.reduce((a, t) => a + t.retarCount, 0) / n
  const avgTsumi = timings.reduce((a, t) => a + t.tsumiMs, 0) / n
  const avgTsumiCount = timings.reduce((a, t) => a + t.tsumiCount, 0) / n
  const fmt = (totalMs: number, count: number) => {
    if (count === 0) return `${totalMs.toFixed(0)}ms`
    return `${(totalMs / count).toFixed(1)}ms×${count.toFixed(0)}=${totalMs.toFixed(0)}ms`
  }
  return `${avgGame.toFixed(0)}ms/game (infer ${fmt(avgInfer, avgInferCount)} retar ${fmt(avgRetar, avgRetarCount)} tsumi ${fmt(avgTsumi, avgTsumiCount)}) `
}

// ============================================================
// Main Entry Point
// ============================================================

/**
 * 汎用 PPO ループ。TrainingStep の宣言に従ってゲーム生成→PPO→eval→卒業判定を実行する。
 *
 * 現在対応: multi-model phases (Phase 1', Phase 2)
 * TODO: single-model phases (Phase 0, Phase 1)
 */
export async function runTrainingPhase(step: TrainingStep, ctx: PhaseRunnerContext): Promise<void> {
  // Brain Battle / BB+: 専用ループで処理
  if (step.adapter === 'brain-battle') {
    if (step.name.startsWith('bb_plus')) {
      return runBBPlusPhase(step, ctx)
    }
    return runBrainBattlePhase(step, ctx)
  }

  const { config, trainingConfig, progress } = ctx
  const maxIter = config[step.maxIterations]
  const phase = phaseLabel(step)

  ctx.log(`${BOLD}=== ${step.displayName} ===${RESET}`)
  ctx.log(`  Agent assignment: ${formatAssignment(step.agentAssignment)}`)

  // Resolve active models: supports both MODEL_GROUPS keys and special names like mason_individual
  const activeModels: string[] = step.activeModels.filter(n => n in MODEL_GROUPS || n === 'mason_individual')
  const frozenModelSet = new Set(step.frozen?.frozenModels ?? [])

  // --- Per-model state ---
  const graduated = new Set<string>()
  const iterCounts = new Map<string, number>()
  for (const name of activeModels) iterCounts.set(name, 0)

  // --- Resume ---
  if (config.resume) {
    for (const name of activeModels) {
      const group = resolveModelInfo(name)
      const dir = checkpointDir(config, step, name)
      const prefix = checkpointPrefix(step, name)
      const ckpt = findCheckpoint(dir, prefix.find)
      if (ckpt) {
        try {
          const net = ctx.networks.get(name)!
          loadCheckpoint(net, ckpt.path)
          iterCounts.set(name, ckpt.iteration)
          ctx.log(`  ${COLORS[name] ?? ''}${name}${RESET}: resumed from iter ${ckpt.iteration}`)
        } catch (e) {
          ctx.log(`  ${COLORS[name] ?? ''}${name}${RESET}: checkpoint incompatible, starting fresh (${(e as Error).message})`)
        }
      }
      // Check for final checkpoint → already graduated
      const finalName = group.collective ? 'collective_final.json' : 'final.json'
      const phase2FinalName = group.collective ? 'phase2_final.json' : 'phase2_final.json'
      const candidateFinals = step.name === 'self_play' ? [phase2FinalName] : [finalName]
      for (const fn of candidateFinals) {
        if (existsSync(`${dir}/${fn}`)) {
          graduated.add(name)
          ctx.log(`  ${COLORS[name] ?? ''}${name}${RESET}: already graduated`)
        }
      }
    }
  }

  // --- Curriculum state (mlMaxSeats progression) ---
  const mlMaxSeatsCap = step.curriculum?.maxSeats?.cap
  if (step.curriculum?.maxSeats) {
    ctx.currentMlMaxSeats = step.curriculum.maxSeats.initial
    // Resume: restore from last curriculum entry
    if (config.resume && progress.curriculum.length > 0) {
      const last = progress.curriculum[progress.curriculum.length - 1]
      if (last.mlMaxSeats !== undefined) {
        ctx.currentMlMaxSeats = last.mlMaxSeats
        ctx.log(`  Curriculum resumed: mlMaxSeats=${ctx.currentMlMaxSeats}`)
      }
    }
    ctx.log(`  mlMaxSeats=${ctx.currentMlMaxSeats}/${mlMaxSeatsCap}`)
  }

  // --- PPO config ---
  const basePpoConfig = {
    miniBatchSize: trainingConfig.miniBatchSize,
    clipEpsilon: trainingConfig.clipEpsilon,
    valueLossCoeff: trainingConfig.valueLossCoeff,
    entropyCoeff: trainingConfig.entropyCoeff,
    freezePlan: step.ppo.freezePlan,
    klCoeff: step.ppo.klConfig ? step.ppo.klConfig.initialBeta : 0,
  }

  // --- KL state (for phases with KL penalty) ---
  let klCoeff = basePpoConfig.klCoeff

  // --- Round-robin loop ---
  let round = 0
  while (graduated.size < activeModels.length) {
    round++
    for (const name of activeModels) {
      if (graduated.has(name)) continue

      const group = resolveModelInfo(name)
      const currentIter = iterCounts.get(name)!
      const targetIter = Math.min(currentIter + config.chunkSize, maxIter)
      const prefix = `${COLORS[name] ?? ''}[${(step.name === 'self_play' ? `P2 ${name}` : name).padEnd(16)}]${RESET}`

      let lastPpoResult: PpoResult = { ...ZERO_PPO }
      let gameMs = 0, ppoMs = 0, iterMs = 0
      let cumulativeIterMs = 0, cumulativeIterCount = 0
      let lastBatchTimings: GameTiming[] = []

      for (let iter = currentIter + 1; iter <= targetIter; iter++) {
        ctx.checkShutdown()
        const iterStart = performance.now()
        const seedOffset = step.gameGen.mode === 'multi_model' ? step.gameGen.seedOffsetBase : 0
        const seeds = Array.from({ length: config.batch }, (_, g) => (seedOffset + iter) * config.batch + g)

        // === Game generation ===
        const tGameStart = performance.now()
        const allIndividual: ProcessedStep[] = []
        const allWolfCollective: ProcessedStep[] = []
        const allMasonCollective: ProcessedStep[] = []

        let serializedResults: SerializedGameResult[] = []

        if (gameWorkerPoolSize() > 0 && step.gameGen.mode === 'single_model') {
          // --- Single-model mode (Phase 0/1): one NN controls mlRoles seats ---
          const singleGen = step.gameGen as SingleModelGen
          const network = ctx.networks.get(name)!
          const inspectSeeds = ctx.pickInspectSeeds(seeds)
          serializedResults = await generateGamesParallel({
            weights: packWeights(network),
            agentAssignment: step.agentAssignment,
            trainingConfig,
            phase: step.workerPhase,
            mlRoles: singleGen.mlRoles as string[],
            mlMaxSeats: ctx.currentMlMaxSeats,
            frozenMasonWeights: ctx.frozenWeights.get('mason_individual'),
            inspectSeeds: inspectSeeds.length > 0 ? inspectSeeds : undefined,
            enableMasonTakeover: step.enableMasonTakeover,
            wreWeights: ctx.wreSharedWeights,
          }, seeds)
          if (inspectSeeds.length > 0) ctx.saveInspectGames(serializedResults, name, iter)

          // Collect ALL individual steps (single model owns all NN-controlled seats)
          for (const game of serializedResults) {
            const stepsMap = new Map<number, TrajectoryStep[]>()
            for (const { seat, steps } of game.individualSteps) {
              stepsMap.set(seat, steps.map(deserializeStep))
            }
            allIndividual.push(...processTrajectories(stepsMap, trainingConfig.gamma, trainingConfig.lambda))
          }
        } else if (gameWorkerPoolSize() > 0 && step.gameGen.mode === 'multi_model') {
          // --- Multi-model mode (Phase 1'/2): each model group has its own NN ---
          const { assignment, modelGroupWeights } = buildAssignmentAndWeights(ctx, step, frozenModelSet)
          const villageFrozenWeights = frozenModelSet.has('village')
            ? (ctx.frozenWeights.get('village') ?? packWeights(ctx.networks.get('village')!))
            : undefined
          const inspectSeeds = ctx.pickInspectSeeds(seeds)
          serializedResults = await generateGamesParallel({
            weights: packWeights(ctx.networks.get('village')!),  // fallback
            agentAssignment: assignment,
            modelGroupWeights,
            villageFrozenWeights,
            trainingConfig,
            phase: step.workerPhase,
            inspectSeeds: inspectSeeds.length > 0 ? inspectSeeds : undefined,
            wreWeights: ctx.wreSharedWeights,
          }, seeds)
          if (inspectSeeds.length > 0) ctx.saveInspectGames(serializedResults, `${phase === '2' ? 'phase2_' : 'phase1p_'}${name}`, iter)

          // Collect trajectories for current model
          for (const game of serializedResults) {
            for (const { role, steps } of game.individualSteps) {
              const groupName = ROLE_TO_GROUP[role]
              if (groupName === name && steps.length > 0) {
                const deserialized = steps.map(deserializeStep)
                allIndividual.push(...computeGAE(deserialized, trainingConfig.gamma, trainingConfig.lambda, 0))
              }
            }
            if (game.wolfTeamSteps.length > 0 && name === 'wolf_collective') {
              allWolfCollective.push(...computeGAE(game.wolfTeamSteps.map(deserializeStep), trainingConfig.gamma, trainingConfig.lambda, 0))
            }
            if (game.masonTeamSteps.length > 0 && name === 'mason_collective') {
              allMasonCollective.push(...computeGAE(game.masonTeamSteps.map(deserializeStep), trainingConfig.gamma, trainingConfig.lambda, 0))
            }
          }
        }

        // WRE refresh (if callback provided) — shared by both modes
        if (serializedResults.length > 0 && ctx.onWreRefresh) {
          const updated = await ctx.onWreRefresh(serializedResults)
          if (updated) ctx.wreSharedWeights = updated
        }

        lastBatchTimings = serializedResults.filter(g => g.timing).map(g => g.timing!)
        const tGameEnd = performance.now()

        // === PPO update ===
        const tPpoStart = performance.now()
        const ppoConfig = { ...basePpoConfig, klCoeff }

        // KL reference logits (precompute for this iteration)
        let precomputedRefLogits: Map<ProcessedStep, { plan?: Float32Array }> | undefined
        if (klCoeff > 0 && ctx.refNetwork) {
          const allSteps = group.collective
            ? (name === 'wolf_collective' ? allWolfCollective : allMasonCollective)
            : allIndividual
          if (allSteps.length > 0) {
            precomputedRefLogits = new Map()
            for (const s of allSteps) {
              const ref = computeRefPlanLogits(ctx.refNetwork, s.observation)
              precomputedRefLogits.set(s, { plan: ref.refPlanLogits })
            }
          }
        }

        // KL early stop threshold (break epoch loop if KL diverges too far)
        const klEarlyStopThreshold = step.ppo.klConfig
          ? klTargetForIter(iter, step.ppo.klConfig) * 2
          : Infinity

        if (group.collective) {
          const steps = name === 'wolf_collective' ? allWolfCollective : allMasonCollective
          if (steps.length > 0) {
            normalizeAdvantages(steps)
            const collectiveNet = ctx.networks.get(name)!
            const collectiveTf = ctx.tfNetworks.get(name)!
            collectiveTf.loadWeights(collectiveNet.cloneWeights())
            for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
              lastPpoResult = ppoUpdate(collectiveTf, steps, ppoConfig, precomputedRefLogits)
              if (lastPpoResult.klLoss > klEarlyStopThreshold) break
            }
            collectiveNet.loadWeights(collectiveTf.cloneWeights())
          }
        } else {
          if (allIndividual.length > 0) {
            normalizeAdvantages(allIndividual)
            const network = ctx.networks.get(name)!
            const tf = ctx.tfNetworks.get(name)!
            tf.loadWeights(network.cloneWeights())
            for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
              lastPpoResult = ppoUpdate(tf, allIndividual, ppoConfig, precomputedRefLogits)
              if (lastPpoResult.klLoss > klEarlyStopThreshold) break
            }
            network.loadWeights(tf.cloneWeights())
          }
        }

        const tPpoEnd = performance.now()
        iterMs = performance.now() - iterStart
        gameMs = tGameEnd - tGameStart
        ppoMs = tPpoEnd - tPpoStart
        cumulativeIterMs += iterMs
        cumulativeIterCount++
        iterCounts.set(name, iter)

        // === KL adaptive β (when KL config is set) ===
        if (step.ppo.klConfig && klCoeff > 0) {
          const klTarget = klTargetForIter(iter, step.ppo.klConfig)
          const klActual = lastPpoResult.klPlanLoss
          const [klMin, klMax] = step.ppo.klConfig.range
          const band = step.ppo.klConfig.band ?? 1.2
          const adjustRate = step.ppo.klConfig.adjustRate ?? 1.5
          if (klActual > klTarget * band) {
            klCoeff = Math.min(klCoeff * adjustRate, klMax)
          } else if (klActual < klTarget / band) {
            klCoeff = Math.max(klCoeff / adjustRate, klMin)
          }
          if (iter % config.evalInterval === 0) {
            appendKlLog(config.checkpointBase, {
              iter, klPlan: lastPpoResult.klPlanLoss,
              klTotal: lastPpoResult.klLoss, beta: klCoeff, klTarget,
            })
          }
        }

        // === Progress display ===
        const totalSteps = allIndividual.length + allWolfCollective.length + allMasonCollective.length
        const pct = (iter / maxIter * 100).toFixed(1)
        const gamePct = (gameMs / iterMs * 100).toFixed(0)
        const ppoPct = (ppoMs / iterMs * 100).toFixed(0)
        const timingStr = formatTimingStr(lastBatchTimings)
        const mlInfo = ctx.currentMlMaxSeats !== undefined && mlMaxSeatsCap !== undefined
          ? ` ml=${ctx.currentMlMaxSeats}/${mlMaxSeatsCap}`
          : ''
        const lossStr = lastPpoResult.policyLoss ? ` pol=${lastPpoResult.policyLoss.toFixed(4)}` : ''
        const entStr = lastPpoResult.entropy ? ` ent=${lastPpoResult.entropy.toFixed(4)}` : ''
        const klStr = lastPpoResult.klLoss ? ` kl=${lastPpoResult.klLoss.toFixed(4)}(β=${klCoeff.toFixed(3)})` : ''
        const avgIterMs = (cumulativeIterMs / cumulativeIterCount / 1000).toFixed(1)
        const remaining = ((targetIter - iter) * cumulativeIterMs / cumulativeIterCount / 1000).toFixed(0)
        process.stderr.write(
          `\r\x1b[K  ${prefix} iter ${iter}/${maxIter} (${pct}%) ` +
          `${iterMs.toFixed(0)}ms (game${gamePct}% ppo${ppoPct}%) ${timingStr}` +
          `steps=${totalSteps}${mlInfo}${lossStr}${entStr}${klStr} ${avgIterMs}s/iter ETA ${remaining}s`
        )

        // === Checkpoint ===
        if (iter % config.checkpointInterval === 0) {
          const dir = checkpointDir(config, step, name)
          const cpPrefix = checkpointPrefix(step, name)
          saveCheckpoint(ctx.networks.get(name)!, `${dir}/${cpPrefix.save}_${iter}.json`, { iteration: iter, winRate: 0 })

          // Prune old checkpoints (keep eval milestones)
          if (existsSync(dir)) {
            for (const f of readdirSync(dir)) {
              const m = f.match(/^(?:checkpoint|collective|phase2_checkpoint|phase2_collective)_(\d+)\.json$/)
              if (!m) continue
              const ckptIter = parseInt(m[1])
              if (ckptIter >= iter) continue
              if (ckptIter % config.evalInterval === 0) continue  // keep milestones
              try { unlinkSync(`${dir}/${f}`) } catch {}
            }
          }
        }

        // === Eval ===
        if (iter % config.evalInterval === 0) {
          process.stderr.write(`\r\x1b[K  ${prefix} iter ${iter} evaluating (${config.evalGames} games)...`)
          const evalMlRoles = step.gameGen.mode === 'single_model'
            ? (step.gameGen as SingleModelGen).mlRoles
            : Object.values(MODEL_GROUPS).flatMap(g => g.roles)
          const evalConfig = { ...trainingConfig, mlRoles: evalMlRoles }
          const evalNetwork = step.gameGen.mode === 'single_model'
            ? ctx.networks.get(name)!
            : ctx.networks.get('village')!
          const evalMlMaxSeats = step.gameGen.mode === 'single_model'
            ? ctx.currentMlMaxSeats
            : undefined
          const evalResult = await evaluate(
            evalNetwork, evalConfig, config.evalGames,
            undefined, undefined, evalMlMaxSeats,
            buildEvalOptions(ctx, step, iter),
          )
          process.stderr.write('\r\x1b[K')
          if (evalResult.howlGames) ctx.saveEvalHowl(config.checkpointBase, iter, evalResult.howlGames)
          appendEvalLog(checkpointDir(config, step, name), iter, evalResult, name, {
            klLoss: lastPpoResult.klLoss, klCoeff,
            policyLoss: lastPpoResult.policyLoss, valueLoss: lastPpoResult.valueLoss, entropy: lastPpoResult.entropy,
          })

          const factionRate = evalResult.winRates[group.faction] ?? 0
          const targetRate = config.targetWinRate ?? (BASELINE_RATES[group.faction] ?? 0.5)
          ctx.log(
            `${prefix} [${iter}] ${Object.entries(evalResult.winRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')} ` +
            `avgLen=${evalResult.avgGameLength.toFixed(1)} ${evalResult.avgElapsedMs.toFixed(0)}ms/eval`
          )

          const progressModel = phase === '2' ? `p2_${name}` : name
          const evalStatus = step.graduation.type === 'faction_winrate' && factionRate >= targetRate ? 'GRADUATED' : ''
          progress.evals.push({
            time: new Date().toISOString(), model: progressModel, iter,
            winRates: { ...evalResult.winRates }, avgLen: evalResult.avgGameLength, status: evalStatus,
            ppoMetrics: { ...lastPpoResult }, baseline: BASELINE_RATES[group.faction], target: targetRate,
            timing: { gameMs, ppoMs, iterMs },
          })
          progress.latest = { phase, model: name, iter, maxIter, klCoeff: klCoeff > 0 ? klCoeff : undefined, mlMaxSeats: ctx.currentMlMaxSeats }
          ctx.writeTrainProgress(progress)

          // Curriculum: advance mlMaxSeats when win rate approaches target
          if (step.curriculum?.maxSeats && ctx.currentMlMaxSeats !== undefined && mlMaxSeatsCap !== undefined) {
            const advanceThreshold = step.curriculum.advanceThreshold
            if (ctx.currentMlMaxSeats < mlMaxSeatsCap && factionRate >= targetRate * advanceThreshold) {
              const prevSeats = ctx.currentMlMaxSeats
              ctx.currentMlMaxSeats = Math.min(ctx.currentMlMaxSeats + 1, mlMaxSeatsCap)
              ctx.log(`${prefix} Curriculum: mlMaxSeats ${prevSeats}→${ctx.currentMlMaxSeats}`)
              progress.curriculum.push({
                time: new Date().toISOString(), iter, mlMaxSeats: ctx.currentMlMaxSeats,
                event: `mlMaxSeats ${prevSeats}→${ctx.currentMlMaxSeats}`,
              })
              ctx.writeTrainProgress(progress)
            }
          }

          // Graduation check
          if (step.graduation.type === 'faction_winrate') {
            const graduationTarget = config.targetWinRate ?? (BASELINE_RATES[step.graduation.faction || group.faction] ?? step.graduation.defaultTarget)
            if (factionRate >= graduationTarget) {
              const minIter = step.graduation.minIter ?? 0
              if (iter >= minIter) {
                ctx.log(`${prefix} ${BOLD}GRADUATED${RESET} (${group.faction}=${(factionRate * 100).toFixed(0)}% >= ${(graduationTarget * 100).toFixed(0)}%)`)
                graduated.add(name)
                break
              }
            }
          } else if (step.graduation.type === 'min_iter') {
            if (iter >= step.graduation.minIter) {
              ctx.log(`${prefix} ${BOLD}GRADUATED${RESET} (iter ${iter} >= ${step.graduation.minIter})`)
              graduated.add(name)
              break
            }
          }
        }
      }

      process.stderr.write('\r\x1b[K')

      // Max iterations → graduate
      if (!graduated.has(name) && iterCounts.get(name)! >= maxIter) {
        ctx.log(`${prefix} reached max iterations (${maxIter})`)
        graduated.add(name)
      }

      // Final save
      if (graduated.has(name)) {
        const dir = checkpointDir(config, step, name)
        const finalSuffix = step.name === 'self_play' ? 'phase2_final' : (resolveModelInfo(name).collective ? 'collective_final' : 'final')
        saveCheckpoint(ctx.networks.get(name)!, `${dir}/${finalSuffix}.json`, { iteration: iterCounts.get(name)!, winRate: 0 })
      }
    }

    ctx.log(`${step.displayName} Round ${round}: ${graduated.size}/${activeModels.length} [${activeModels.map(n => graduated.has(n) ? `${COLORS[n] ?? ''}OK${RESET}` : `${COLORS[n] ?? ''}..${RESET}`).join(' ')}]`)
  }

  ctx.log(`${BOLD}=== ${step.displayName} Complete ===${RESET}`)
  progress.latest = { phase: `${phase} (complete)`, model: '-', iter: maxIter, maxIter }
  ctx.writeTrainProgress(progress)
}

// ============================================================
// Brain Battle Phase (wolf_brain + mason_collective 双方向学習)
// ============================================================

async function runBrainBattlePhase(step: TrainingStep, ctx: PhaseRunnerContext): Promise<void> {
  const { config, trainingConfig, progress } = ctx
  const maxIter = config[step.maxIterations]
  const phase = phaseLabel(step)

  if (!ctx.wolfBrainNetwork || !ctx.wolfBrainTfNetwork) {
    throw new Error('Brain Battle requires wolfBrainNetwork and wolfBrainTfNetwork in PhaseRunnerContext')
  }

  // Mason collective network (双方向学習)
  const masonNet = ctx.networks.get('mason_collective')
  const masonTf = ctx.tfNetworks.get('mason_collective')
  if (!masonNet || !masonTf) {
    throw new Error('Brain Battle requires mason_collective in networks and tfNetworks')
  }

  ctx.log(`${BOLD}=== ${step.displayName} ===${RESET}`)
  ctx.log(`  Agent assignment: ${formatAssignment(step.agentAssignment)}`)

  const wolfPrefix = `${COLORS.wolf_brain}[BB wolf_brain    ]${RESET}`
  const masonPrefix = `${COLORS.mason_collective}[BB mason         ]${RESET}`
  let iter = 0

  // --- Resume ---
  if (config.resume) {
    const wolfDir = checkpointDir(config, step, 'wolf_brain')
    const wolfCkpt = findCheckpoint(wolfDir, 'wolf_brain')
    if (wolfCkpt) {
      try {
        loadCheckpoint(ctx.wolfBrainNetwork, wolfCkpt.path)
        iter = wolfCkpt.iteration
        ctx.log(`  wolf_brain: resumed from iter ${iter}`)
      } catch (e) {
        ctx.log(`  wolf_brain: checkpoint incompatible, starting fresh (${(e as Error).message})`)
      }
    }
    const masonDir = checkpointDir(config, step, 'mason_collective')
    const masonCkpt = findCheckpoint(masonDir, 'collective')
    if (masonCkpt) {
      try {
        loadCheckpoint(masonNet, masonCkpt.path)
        ctx.log(`  mason_collective: resumed from iter ${masonCkpt.iteration}`)
      } catch (e) {
        ctx.log(`  mason_collective: checkpoint incompatible, starting fresh (${(e as Error).message})`)
      }
    }
    if (step.graduation.type !== 'none' && existsSync(`${wolfDir}/wolf_brain_final.json`)) {
      ctx.log(`  wolf_brain: already graduated`)
      return
    }
  }

  // --- PPO config ---
  const ppoConfig = {
    miniBatchSize: trainingConfig.miniBatchSize,
    clipEpsilon: trainingConfig.clipEpsilon,
    valueLossCoeff: trainingConfig.valueLossCoeff,
    entropyCoeff: trainingConfig.entropyCoeff,
    freezePlan: false,
    klCoeff: 0,
  }

  let lastWolfPpo: PpoResult = { ...ZERO_PPO }
  let lastMasonPpo: PpoResult = { ...ZERO_PPO }
  let gameMs = 0, ppoMs = 0, iterMs = 0

  const noMaxIter = step.graduation.type === 'none'
  while (noMaxIter || iter < maxIter) {
    iter++
    ctx.checkShutdown()
    const iterStart = performance.now()
    const seedOffset = step.gameGen.mode === 'multi_model' ? step.gameGen.seedOffsetBase : 0
    const seeds = Array.from({ length: config.batch }, (_, g) => (seedOffset + iter) * config.batch + g)

    // === Game generation (Brain Battle) ===
    const tGameStart = performance.now()
    const allWolfBrainSteps: ProcessedStep[] = []
    const allMasonSteps: ProcessedStep[] = []

    if (gameWorkerPoolSize() > 0) {
      const { assignment, modelGroupWeights } = buildAssignmentAndWeights(ctx, step)
      const inspectSeeds = ctx.pickInspectSeeds(seeds)
      const serializedResults = await generateGamesParallel({
        weights: packWeights(ctx.wolfBrainNetwork),  // fallback
        agentAssignment: assignment,
        modelGroupWeights,
        trainingConfig,
        phase: step.workerPhase,
        brainBattle: true,
        wolfBrainWeights: packWeights(ctx.wolfBrainNetwork),
        inspectSeeds: inspectSeeds.length > 0 ? inspectSeeds : undefined,
      }, seeds)
      if (inspectSeeds.length > 0) ctx.saveInspectGames(serializedResults, 'brain_battle', iter)

      // Collect trajectories from both brains
      for (const game of serializedResults) {
        if (game.wolfTeamSteps.length > 0) {
          allWolfBrainSteps.push(...computeGAE(game.wolfTeamSteps.map(deserializeStep), trainingConfig.gamma, trainingConfig.lambda, 0))
        }
        if (game.masonTeamSteps.length > 0) {
          allMasonSteps.push(...computeGAE(game.masonTeamSteps.map(deserializeStep), trainingConfig.gamma, trainingConfig.lambda, 0))
        }
      }
    }
    const tGameEnd = performance.now()

    // === PPO update (both brains) ===
    const tPpoStart = performance.now()

    // Wolf brain PPO
    if (allWolfBrainSteps.length > 0) {
      normalizeAdvantages(allWolfBrainSteps)
      ctx.wolfBrainTfNetwork.loadWeights(ctx.wolfBrainNetwork.cloneWeights())
      for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
        lastWolfPpo = ppoUpdate(ctx.wolfBrainTfNetwork, allWolfBrainSteps, ppoConfig)
      }
      ctx.wolfBrainNetwork.loadWeights(ctx.wolfBrainTfNetwork.cloneWeights())
    }

    // Mason brain PPO
    if (allMasonSteps.length > 0) {
      normalizeAdvantages(allMasonSteps)
      masonTf.loadWeights(masonNet.cloneWeights())
      for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
        lastMasonPpo = ppoUpdate(masonTf, allMasonSteps, ppoConfig)
      }
      masonNet.loadWeights(masonTf.cloneWeights())
    }

    const tPpoEnd = performance.now()
    iterMs = performance.now() - iterStart
    gameMs = tGameEnd - tGameStart
    ppoMs = tPpoEnd - tPpoStart

    // === Progress display ===
    process.stderr.write(
      `\r\x1b[K  ${wolfPrefix} iter ${iter}/${noMaxIter ? '∞' : maxIter} ` +
      `${iterMs.toFixed(0)}ms (game${(gameMs / iterMs * 100).toFixed(0)}% ppo${(ppoMs / iterMs * 100).toFixed(0)}%) ` +
      `wolf=${allWolfBrainSteps.length} mason=${allMasonSteps.length}`
    )

    // === Checkpoint ===
    if (iter % config.checkpointInterval === 0) {
      const wolfDir = checkpointDir(config, step, 'wolf_brain')
      saveCheckpoint(ctx.wolfBrainNetwork, `${wolfDir}/wolf_brain_${iter}.json`, { iteration: iter, winRate: 0 })
      const masonDir = checkpointDir(config, step, 'mason_collective')
      saveCheckpoint(masonNet, `${masonDir}/collective_${iter}.json`, { iteration: iter, winRate: 0 })
    }

    // === Eval: 3-mode Brain Battle (alternate + mason_only + wolf_only) ===
    if (iter % config.evalInterval === 0) {
      process.stderr.write(`\r\x1b[K  ${wolfPrefix} iter ${iter} evaluating...`)

      const evalGames = config.evalGames
      const halfEval = Math.max(Math.floor(evalGames / 2), 10)

      // Helper: run eval games with a specific turn mode
      const runBBEval = async (turnMode: 'alternate' | 'mason_only' | 'wolf_only', count: number) => {
        const evalSeeds = Array.from({ length: count }, (_, i) => 900000 + iter * 1000 + (turnMode === 'mason_only' ? 300 : turnMode === 'wolf_only' ? 600 : 0) + i)
        const { assignment, modelGroupWeights } = buildAssignmentAndWeights(ctx, step)
        const results = await generateGamesParallel({
          weights: packWeights(ctx.wolfBrainNetwork!),
          agentAssignment: assignment,
          modelGroupWeights,
          trainingConfig,
          phase: step.workerPhase,
          brainBattle: true,
          wolfBrainWeights: packWeights(ctx.wolfBrainNetwork!),
          brainBattleTurnMode: turnMode,
        }, evalSeeds)
        const winRates: Record<string, number> = {}
        let totalDays = 0
        for (const game of results) {
          winRates[game.result] = (winRates[game.result] ?? 0) + 1
          totalDays += game.timing?.totalMs ? 1 : 1  // count games
        }
        for (const key of Object.keys(winRates)) winRates[key] /= results.length
        const avgLen = results.reduce((sum, g) => sum + (g.timing?.totalMs ?? 0), 0) / results.length
        return { winRates, avgLen, count: results.length }
      }

      // Sequential eval (worker pool cannot handle concurrent generateGamesParallel calls)
      const altResult = await runBBEval('alternate', evalGames)
      const masonResult = await runBBEval('mason_only', halfEval)
      const wolfResult = await runBBEval('wolf_only', halfEval)

      process.stderr.write('\r\x1b[K')

      const fmtWr = (wr: Record<string, number>) =>
        Object.entries(wr).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')

      ctx.log(
        `${wolfPrefix} [${iter}] ppo: pL=${lastWolfPpo.policyLoss.toFixed(4)} vL=${lastWolfPpo.valueLoss.toFixed(4)} ent=${lastWolfPpo.entropy.toFixed(4)}`
      )
      ctx.log(
        `${masonPrefix} [${iter}] ppo: pL=${lastMasonPpo.policyLoss.toFixed(4)} vL=${lastMasonPpo.valueLoss.toFixed(4)} ent=${lastMasonPpo.entropy.toFixed(4)}`
      )
      ctx.log(`  [eval alternate ${altResult.count}g] ${fmtWr(altResult.winRates)}`)
      ctx.log(`  [eval mason_only ${masonResult.count}g] ${fmtWr(masonResult.winRates)}`)
      ctx.log(`  [eval wolf_only ${wolfResult.count}g] ${fmtWr(wolfResult.winRates)}`)

      progress.evals.push({
        time: new Date().toISOString(), model: 'bb_alternate', iter,
        winRates: altResult.winRates, avgLen: 0, status: '',
        ppoMetrics: { ...lastWolfPpo },
        timing: { gameMs, ppoMs, iterMs },
      })
      progress.evals.push({
        time: new Date().toISOString(), model: 'bb_mason_only', iter,
        winRates: masonResult.winRates, avgLen: 0, status: '',
        ppoMetrics: { ...lastMasonPpo },
      })
      progress.evals.push({
        time: new Date().toISOString(), model: 'bb_wolf_only', iter,
        winRates: wolfResult.winRates, avgLen: 0, status: '',
      })
      progress.latest = { phase, model: 'wolf_brain+mason', iter, maxIter }
      ctx.writeTrainProgress(progress)

      // Graduation check
      if (step.graduation.type === 'min_iter' && iter >= step.graduation.minIter) {
        ctx.log(`${wolfPrefix} ${BOLD}GRADUATED${RESET} (iter ${iter} >= ${step.graduation.minIter})`)
        break
      }
    }
  }

  process.stderr.write('\r\x1b[K')

  // Final save (both brains) — skip for graduation: none (stopped by shutdown, not graduation)
  if (step.graduation.type !== 'none') {
    const wolfDir = checkpointDir(config, step, 'wolf_brain')
    saveCheckpoint(ctx.wolfBrainNetwork, `${wolfDir}/wolf_brain_final.json`, { iteration: iter, winRate: 0 })
    const masonDir = checkpointDir(config, step, 'mason_collective')
    saveCheckpoint(masonNet, `${masonDir}/collective_final.json`, { iteration: iter, winRate: 0 })
  }

  ctx.log(`${BOLD}=== ${step.displayName} Complete ===${RESET}`)
  progress.latest = { phase: `${phase} (complete)`, model: 'wolf_brain+mason', iter, maxIter }
  ctx.writeTrainProgress(progress)
}

// ============================================================
// BB+ Phase (frozen brains + individual role agents)
// ============================================================

async function runBBPlusPhase(step: TrainingStep, ctx: PhaseRunnerContext): Promise<void> {
  const { config, trainingConfig, progress } = ctx
  const maxIter = config[step.maxIterations]
  const phase = phaseLabel(step)

  // Frozen BB brains (required)
  if (!ctx.wolfBrainNetwork || !ctx.wolfBrainTfNetwork) {
    throw new Error('BB+ requires wolfBrainNetwork in PhaseRunnerContext (frozen)')
  }
  const masonNet = ctx.networks.get('mason_collective')
  if (!masonNet) {
    throw new Error('BB+ requires mason_collective in networks (frozen mason brain)')
  }

  // Individual agent networks (keys: group name or role name e.g. 'village', 'fanatic', 'werehamster', 'immoralist')
  const individualNets = new Map<string, AnyNetwork>()
  const individualTfs = new Map<string, AnyTfNetwork>()
  if (ctx.bbPlusNetworks && ctx.bbPlusTfNetworks) {
    for (const [name, net] of ctx.bbPlusNetworks) {
      const tf = ctx.bbPlusTfNetworks.get(name)
      if (tf) {
        individualNets.set(name, net)
        individualTfs.set(name, tf)
      }
    }
  }
  if (individualNets.size === 0) {
    throw new Error('BB+ requires at least one individual model in bbPlusNetworks')
  }

  ctx.log(`${BOLD}=== ${step.displayName} ===${RESET}`)
  ctx.log(`  Frozen brains: wolf_brain (${ctx.wolfBrainNetwork.totalParams} params), mason_brain (${masonNet.totalParams} params)`)
  ctx.log(`  Individual models: ${[...individualNets.keys()].map(n => `${n} (${individualNets.get(n)!.totalParams})`).join(', ')}`)

  const ppoConfig = {
    miniBatchSize: trainingConfig.miniBatchSize,
    clipEpsilon: trainingConfig.clipEpsilon,
    valueLossCoeff: trainingConfig.valueLossCoeff,
    entropyCoeff: trainingConfig.entropyCoeff,
    freezePlan: false,
    klCoeff: 0,
  }

  let iter = 0
  let lastPpo = new Map<string, PpoResult>()
  let gameMs = 0, ppoMs = 0, iterMs = 0

  // --- Resume ---
  if (config.resume) {
    for (const [name, net] of individualNets) {
      const dir = `${config.checkpointBase}/ckpt-bbplus-${name}`
      const ckpt = findCheckpoint(dir, name)
      if (ckpt) {
        try {
          loadCheckpoint(net, ckpt.path)
          iter = Math.max(iter, ckpt.iteration)
          ctx.log(`  ${name}: resumed from iter ${ckpt.iteration}`)
        } catch (e) {
          ctx.log(`  ${name}: checkpoint incompatible, starting fresh (${(e as Error).message})`)
        }
      }
    }
  }

  const noMaxIter = step.graduation.type === 'none'
  while (noMaxIter || iter < maxIter) {
    iter++
    ctx.checkShutdown()
    const iterStart = performance.now()
    const seedOffset = step.gameGen.mode === 'multi_model' ? step.gameGen.seedOffsetBase : 0
    const seeds = Array.from({ length: config.batch }, (_, g) => (seedOffset + iter) * config.batch + g)

    // === Game generation ===
    const tGameStart = performance.now()
    const perModelSteps = new Map<string, ProcessedStep[]>(
      [...individualNets.keys()].map(n => [n, []])
    )

    if (gameWorkerPoolSize() > 0) {
      // Build agent specs + weights from bbPlusNetworks
      const agentSpecs: Record<string, AgentSpec> = {}
      const specWeights: Record<string, SharedWeights> = {}

      for (const [name, net] of individualNets) {
        specWeights[name] = packWeights(net)
        const isFanatic = name === 'fanatic'
        agentSpecs[name] = {
          type: isFanatic ? 'fanatic' : 'neural',
          weightsKey: name,
          strategyOnly: false,
          observationMode: isFanatic ? 'fanatic' : undefined,
          frozenVillageKey: isFanatic ? 'frozen_village' : undefined,
          maxSeats: step.name.includes('village_1') && name === 'village' ? 1 : undefined,
        }
      }
      // Frozen village NN for fanatic injection
      const frozenVillageWeights = ctx.frozenWeights.get('village')
      if (frozenVillageWeights) specWeights['frozen_village'] = frozenVillageWeights

      const { assignment, modelGroupWeights } = buildAssignmentAndWeights(ctx, step)
      const inspectSeeds = ctx.pickInspectSeeds(seeds)
      const serializedResults = await generateGamesParallel({
        weights: packWeights(ctx.wolfBrainNetwork),
        agentAssignment: assignment,
        modelGroupWeights,
        trainingConfig,
        phase: step.workerPhase,
        brainBattle: true,
        wolfBrainWeights: packWeights(ctx.wolfBrainNetwork),
        agentSpecs,
        specWeights,
        inspectSeeds: inspectSeeds.length > 0 ? inspectSeeds : undefined,
      }, seeds)
      if (inspectSeeds.length > 0) ctx.saveInspectGames(serializedResults, 'bb_plus', iter)

      // Collect individual trajectories grouped by model key
      // Key resolution: role name first (werehamster, immoralist), then group name (village, third)
      for (const game of serializedResults) {
        for (const { role, steps } of game.individualSteps) {
          const group = ROLE_TO_GROUP[role as string]
          const modelKey = perModelSteps.has(role as string) ? role as string : group
          if (!modelKey || !perModelSteps.has(modelKey) || steps.length === 0) continue
          perModelSteps.get(modelKey)!.push(
            ...computeGAE(steps.map(deserializeStep), trainingConfig.gamma, trainingConfig.lambda, 0)
          )
        }
      }
    }
    const tGameEnd = performance.now()

    // === PPO update per individual model ===
    const tPpoStart = performance.now()
    for (const [name, steps] of perModelSteps) {
      if (steps.length === 0) continue
      const net = individualNets.get(name)
      const tf = individualTfs.get(name)
      if (!net || !tf) continue

      normalizeAdvantages(steps)
      tf.loadWeights(net.cloneWeights())
      let ppoResult: PpoResult = { ...ZERO_PPO }
      for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
        ppoResult = ppoUpdate(tf, steps, ppoConfig)
      }
      net.loadWeights(tf.cloneWeights())
      lastPpo.set(name, ppoResult)
    }
    const tPpoEnd = performance.now()
    iterMs = performance.now() - iterStart
    gameMs = tGameEnd - tGameStart
    ppoMs = tPpoEnd - tPpoStart

    // === Progress display ===
    const stepCounts = [...individualNets.keys()].map(n => `${n}=${perModelSteps.get(n)?.length ?? 0}`).join(' ')
    process.stderr.write(
      `\r\x1b[K  [BB+] iter ${iter}/${noMaxIter ? '∞' : maxIter} ` +
      `${iterMs.toFixed(0)}ms (game${(gameMs / iterMs * 100).toFixed(0)}% ppo${(ppoMs / iterMs * 100).toFixed(0)}%) ` +
      stepCounts
    )

    // === Checkpoint ===
    if (iter % config.checkpointInterval === 0) {
      for (const [name, net] of individualNets) {
        const dir = `${config.checkpointBase}/ckpt-bbplus-${name}`
        saveCheckpoint(net, `${dir}/${name}_${iter}.json`, { iteration: iter, winRate: 0 })
      }
    }

    // === Eval ===
    if (iter % config.evalInterval === 0) {
      process.stderr.write(`\r\x1b[K  [BB+] iter ${iter} evaluating...`)

      // Log PPO metrics
      for (const [name, ppo] of lastPpo) {
        ctx.log(`[BB+ ${name.padEnd(10)}] [${iter}] ppo: pL=${ppo.policyLoss.toFixed(4)} vL=${ppo.valueLoss.toFixed(4)} ent=${ppo.entropy.toFixed(4)} steps=${perModelSteps.get(name)?.length ?? 0}`)
      }

      // Run eval games (alternate mode only)
      const evalSeeds = Array.from({ length: config.evalGames }, (_, i) => 900000 + iter * 1000 + i)
      // Reuse same agentSpecs/specWeights as training
      const evalAgentSpecs: Record<string, AgentSpec> = {}
      const evalSpecWeights: Record<string, SharedWeights> = {}
      for (const [name, net] of individualNets) {
        evalSpecWeights[name] = packWeights(net)
        const isFanatic = name === 'fanatic'
        evalAgentSpecs[name] = {
          type: isFanatic ? 'fanatic' : 'neural',
          weightsKey: name,
          strategyOnly: false,
          observationMode: isFanatic ? 'fanatic' : undefined,
          frozenVillageKey: isFanatic ? 'frozen_village' : undefined,
          maxSeats: step.name.includes('village_1') && name === 'village' ? 1 : undefined,
        }
      }
      const evalFrozenVillage = ctx.frozenWeights.get('village')
      if (evalFrozenVillage) evalSpecWeights['frozen_village'] = evalFrozenVillage

      const { assignment: evalAssignment, modelGroupWeights: evalModelGroupWeights } = buildAssignmentAndWeights(ctx, step)
      const evalResults = await generateGamesParallel({
        weights: packWeights(ctx.wolfBrainNetwork!),
        agentAssignment: evalAssignment,
        modelGroupWeights: evalModelGroupWeights,
        trainingConfig,
        phase: step.workerPhase,
        brainBattle: true,
        wolfBrainWeights: packWeights(ctx.wolfBrainNetwork!),
        agentSpecs: evalAgentSpecs,
        specWeights: evalSpecWeights,
      }, evalSeeds)

      const winRates: Record<string, number> = {}
      for (const game of evalResults) {
        winRates[game.result] = (winRates[game.result] ?? 0) + 1
      }
      for (const key of Object.keys(winRates)) winRates[key] /= evalResults.length

      ctx.log(`  [eval alternate ${evalResults.length}g] ${Object.entries(winRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')}`)

      // mason_only eval: mason brain が全日の処刑を決定
      const masonOnlySeeds = Array.from({ length: Math.max(Math.floor(config.evalGames / 2), 10) }, (_, i) => 900000 + iter * 1000 + 300 + i)
      const masonOnlyResults = await generateGamesParallel({
        weights: packWeights(ctx.wolfBrainNetwork!),
        agentAssignment: evalAssignment,
        modelGroupWeights: evalModelGroupWeights,
        trainingConfig,
        phase: step.workerPhase,
        brainBattle: true,
        wolfBrainWeights: packWeights(ctx.wolfBrainNetwork!),
        agentSpecs: evalAgentSpecs,
        specWeights: evalSpecWeights,
        brainBattleTurnMode: 'mason_only',
      }, masonOnlySeeds)
      const masonOnlyWinRates: Record<string, number> = {}
      for (const game of masonOnlyResults) {
        masonOnlyWinRates[game.result] = (masonOnlyWinRates[game.result] ?? 0) + 1
      }
      for (const key of Object.keys(masonOnlyWinRates)) masonOnlyWinRates[key] /= masonOnlyResults.length

      ctx.log(`  [eval mason_only ${masonOnlyResults.length}g] ${Object.entries(masonOnlyWinRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')}`)

      // Update progress
      progress.evals.push({
        time: new Date().toISOString(),
        model: 'bbplus_mason_only',
        iter,
        winRates: masonOnlyWinRates,
        avgLen: 0,
        status: '',
      })
      for (const [name, ppo] of lastPpo) {
        progress.evals.push({
          time: new Date().toISOString(),
          model: `bbplus_${name}`,
          iter,
          winRates,
          avgLen: 0,
          status: '',
          ppoMetrics: {
            policyLoss: ppo.policyLoss,
            valueLoss: ppo.valueLoss,
            entropy: ppo.entropy,
            predictLoss: ppo.predictLoss ?? 0,
            klLoss: 0,
          },
          timing: { gameMs, ppoMs, iterMs },
        })
      }
      progress.latest = { phase, model: [...individualNets.keys()].join('+'), iter, maxIter, updated: new Date().toISOString() }
      ctx.writeTrainProgress(progress)

      // Graduation check
      if (step.graduation.type === 'min_iter' && iter >= step.graduation.minIter) {
        ctx.log(`  [BB+] ${BOLD}GRADUATED${RESET} (iter ${iter} >= ${step.graduation.minIter})`)
        // Save final checkpoints
        for (const [name, net] of individualNets) {
          const dir = `${config.checkpointBase}/ckpt-bbplus-${name}`
          saveCheckpoint(net, `${dir}/${name}_final.json`, { iteration: iter, winRate: 0 })
        }
        break
      }
    }
  }

  ctx.log(`${BOLD}=== ${step.displayName} Complete ===${RESET}`)
}
