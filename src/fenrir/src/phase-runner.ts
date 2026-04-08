/**
 * Fenrir Phase Runner — 汎用 PPO ループエンジン
 *
 * curriculum.ts の TrainingStep を受け取り、ネットワーク管理・ゲーム生成・
 * PPO 更新・eval・卒業判定をフェーズ非依存で実行する。
 */

import type { AnyNetwork, AnyTfNetwork } from './ml/nn.ts'
import type { TrainingConfig } from './training.ts'
import type { ProcessedStep } from './ml/trajectory.ts'
import type { SharedWeights, SerializedGameResult, WreSharedWeights } from './parallel.ts'
import type { TrainingStep, ModelName } from './curriculum.ts'
import {
  MODEL_GROUPS, MODEL_NAMES, ROLE_TO_GROUP, BASELINE_RATES,
  klTargetForIter,
} from './curriculum.ts'
import { computeRefPlanLogits } from './agents/neural-agent.ts'
import { normalizeAdvantages, computeGAE } from './ml/trajectory.ts'
import { saveCheckpoint, loadCheckpoint } from './ml/checkpoint.ts'
import { evaluate, appendEvalLog } from './training.ts'
import {
  packWeights, generateGamesParallel, deserializeStep, gameWorkerPoolSize,
} from './parallel.ts'
import { existsSync, readdirSync, readFileSync, appendFileSync } from 'node:fs'

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
    mlStartDay?: number
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
  mlStartDay: number
  event: string
}

// ============================================================
// Constants
// ============================================================

const COLORS: Record<string, string> = {
  village: '\x1b[33m', wolf_collective: '\x1b[31m', mason_collective: '\x1b[36m',
  fanatic: '\x1b[35m', third: '\x1b[32m', mason_individual: '\x1b[36m',
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

/** Pack weights for all MODEL_GROUPS models from context networks */
function packAllModelWeights(ctx: PhaseRunnerContext, frozenModels?: Set<string>): Record<string, SharedWeights> {
  const result: Record<string, SharedWeights> = {}
  for (const name of MODEL_NAMES) {
    if (frozenModels?.has(name)) {
      // Use pre-packed frozen weights
      const fw = ctx.frozenWeights.get(name)
      if (fw) { result[name] = fw; continue }
    }
    const net = ctx.networks.get(name)
    if (net) result[name] = packWeights(net)
  }
  return result
}

/** Build EvaluateOptions from context */
function buildEvalOptions(ctx: PhaseRunnerContext, _step: TrainingStep, iter: number) {
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
  const group = MODEL_GROUPS[name as ModelName]
  if (group?.collective) {
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

/** Phase display label for progress */
function phaseLabel(step: TrainingStep): string {
  if (step.name === 'self_play') return '2'
  if (step.name === 'non_village') return "1'"
  if (step.name === 'village') return '1'
  if (step.name === 'mason_individual') return '0'
  return step.name
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
  const { config, trainingConfig, progress } = ctx
  const maxIter = config[step.maxIterations]
  const phase = phaseLabel(step)

  ctx.log(`${BOLD}=== ${step.displayName} ===${RESET}`)

  // Only MODEL_GROUPS models are trained (mason_individual handled separately in future)
  const activeModels = step.activeModels.filter(n => n in MODEL_GROUPS) as ModelName[]
  const frozenModelSet = new Set(step.frozen?.frozenModels ?? [])

  // --- Per-model state ---
  const graduated = new Set<ModelName>()
  const iterCounts = new Map<ModelName, number>()
  for (const name of activeModels) iterCounts.set(name, 0)

  // --- Resume ---
  if (config.resume) {
    for (const name of activeModels) {
      const group = MODEL_GROUPS[name]
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

      const group = MODEL_GROUPS[name]
      const currentIter = iterCounts.get(name)!
      const targetIter = Math.min(currentIter + config.chunkSize, maxIter)
      const prefix = `${COLORS[name] ?? ''}[${(step.name === 'self_play' ? `P2 ${name}` : name).padEnd(16)}]${RESET}`

      let lastPpoResult: PpoResult = { ...ZERO_PPO }
      let gameMs = 0, ppoMs = 0, iterMs = 0

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

        if (gameWorkerPoolSize() > 0 && step.gameGen.mode === 'multi_model') {
          const modelGroupWeights = packAllModelWeights(ctx, frozenModelSet)
          const villageFrozenWeights = frozenModelSet.has('village')
            ? (ctx.frozenWeights.get('village') ?? packWeights(ctx.networks.get('village')!))
            : undefined
          const inspectSeeds = ctx.pickInspectSeeds(seeds)
          const serializedResults = await generateGamesParallel({
            weights: packWeights(ctx.networks.get('village')!),  // fallback
            modelGroupWeights,
            villageFrozenWeights,
            trainingConfig,
            phase: step.workerPhase,
            inspectSeeds: inspectSeeds.length > 0 ? inspectSeeds : undefined,
            wreWeights: ctx.wreSharedWeights,
          }, seeds)
          if (inspectSeeds.length > 0) ctx.saveInspectGames(serializedResults, `${phase === '2' ? 'phase2_' : 'phase1p_'}${name}`, iter)

          // WRE refresh (if callback provided)
          if (ctx.onWreRefresh) {
            const updated = await ctx.onWreRefresh(serializedResults)
            if (updated) ctx.wreSharedWeights = updated
          }

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

        if (group.collective) {
          const steps = name === 'wolf_collective' ? allWolfCollective : allMasonCollective
          if (steps.length > 0) {
            normalizeAdvantages(steps)
            const collectiveNet = ctx.networks.get(name)!
            const collectiveTf = ctx.tfNetworks.get(name)!
            collectiveTf.loadWeights(collectiveNet.cloneWeights())
            for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
              lastPpoResult = ppoUpdate(collectiveTf, steps, ppoConfig, precomputedRefLogits)
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
            }
            network.loadWeights(tf.cloneWeights())
          }
        }

        const tPpoEnd = performance.now()
        iterMs = performance.now() - iterStart
        gameMs = tGameEnd - tGameStart
        ppoMs = tPpoEnd - tPpoStart
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
        process.stderr.write(
          `\r\x1b[K  ${prefix} iter ${iter}/${maxIter} ` +
          `${iterMs.toFixed(0)}ms (game${(gameMs / iterMs * 100).toFixed(0)}% ppo${(ppoMs / iterMs * 100).toFixed(0)}%) ` +
          `steps=${totalSteps}`
        )

        // === Checkpoint ===
        if (iter % config.checkpointInterval === 0) {
          const dir = checkpointDir(config, step, name)
          const cpPrefix = checkpointPrefix(step, name)
          saveCheckpoint(ctx.networks.get(name)!, `${dir}/${cpPrefix.save}_${iter}.json`, { iteration: iter, winRate: 0 })
        }

        // === Eval ===
        if (iter % config.evalInterval === 0) {
          process.stderr.write(`\r\x1b[K  ${prefix} iter ${iter} evaluating (${config.evalGames} games)...`)
          const allMlRoles = Object.values(MODEL_GROUPS).flatMap(g => g.roles)
          const evalConfig = { ...trainingConfig, mlRoles: allMlRoles }
          const evalResult = await evaluate(
            ctx.networks.get('village')!, evalConfig, config.evalGames,
            undefined, undefined, undefined,
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
          progress.latest = { phase, model: name, iter, maxIter, klCoeff: klCoeff > 0 ? klCoeff : undefined }
          ctx.writeTrainProgress(progress)

          // Graduation check (faction_winrate)
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
        const finalSuffix = step.name === 'self_play' ? 'phase2_final' : (MODEL_GROUPS[name].collective ? 'collective_final' : 'final')
        saveCheckpoint(ctx.networks.get(name)!, `${dir}/${finalSuffix}.json`, { iteration: iterCounts.get(name)!, winRate: 0 })
      }
    }

    ctx.log(`${step.displayName} Round ${round}: ${graduated.size}/${activeModels.length} [${activeModels.map(n => graduated.has(n) ? `${COLORS[n] ?? ''}OK${RESET}` : `${COLORS[n] ?? ''}..${RESET}`).join(' ')}]`)
  }

  ctx.log(`${BOLD}=== ${step.displayName} Complete ===${RESET}`)
  progress.latest = { phase: `${phase} (complete)`, model: '-', iter: maxIter, maxIter }
  ctx.writeTrainProgress(progress)
}
