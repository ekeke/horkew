/**
 * Fenrir Phase Runner — 汎用 PPO ループエンジン
 *
 * curriculum.ts の TrainingStep を受け取り、ネットワーク管理・ゲーム生成・
 * PPO 更新・eval・卒業判定をフェーズ非依存で実行する。
 */

import type { AnyNetwork, AnyTfNetwork } from './ml/nn.ts'
import type { TrainingConfig } from './training.ts'
import type { ProcessedStep } from './ml/trajectory.ts'
import type { SharedWeights } from './parallel.ts'
import type { TrainingStep, NetworkName } from './curriculum.ts'
import { existsSync, readdirSync, readFileSync, appendFileSync } from 'node:fs'

// === Imports for runTrainingPhase (will be used in Steps 3-6) ===
// import { MODEL_GROUPS, MODEL_NAMES, ROLE_TO_GROUP, BASELINE_RATES, klTargetForIter } from './curriculum.ts'
// import { computeRefPlanLogits } from './agents/neural-agent.ts'
// import { normalizeAdvantages, computeGAE } from './ml/trajectory.ts'
// import { saveCheckpoint, loadCheckpoint } from './ml/checkpoint.ts'
// import { evaluate, appendEvalLog } from './training.ts'
// import { packWeights, generateGamesParallel, deserializeStep, gameWorkerPoolSize } from './parallel.ts'
// import { countSnapshots, loadRandomSnapshots } from './seed-bank.ts'
// import { Rng } from '../../lupa/random.ts'

// ============================================================
// Types
// ============================================================

export type PhaseRunnerContext = {
  config: OrchestratorConfig
  trainingConfig: TrainingConfig
  progress: TrainProgress
  runId: string
  gitSha: string

  /** 推論用ネットワーク (CPU, Pure JS) */
  networks: Map<NetworkName, AnyNetwork>
  /** 学習用ネットワーク (GPU, TF.js) */
  tfNetworks: Map<NetworkName, AnyTfNetwork>

  /** KL anchor */
  refNetwork?: AnyNetwork
  /** frozen 済みの重み (e.g. mason_individual → Phase 1, village → Phase 1') */
  frozenWeights: Map<NetworkName, SharedWeights>
  /** frozen 推論用ネットワーク (eval で使用) */
  frozenNets: Map<NetworkName, AnyNetwork>

  checkShutdown: () => void
  log: (msg: string) => void
  writeTrainProgress: (progress: TrainProgress) => void
  inspectInterval: number
  saveInspectGames: (results: any[], modelName: string, iteration: number) => void
  saveEvalHowl: (checkpointBase: string, iter: number, howlGames: any[]) => void
}

// These types are re-exported from orchestrate.ts — will be moved here fully later
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
  transformer: boolean
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

// const COLORS: Record<string, string> = {
//   village: '\x1b[33m', wolf_collective: '\x1b[31m', mason_collective: '\x1b[36m',
//   fanatic: '\x1b[35m', third: '\x1b[32m', mason_individual: '\x1b[36m',
// }
// const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

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
// Main Entry Point
// ============================================================

/**
 * 汎用 PPO ループ。TrainingStep の宣言に従ってゲーム生成→PPO→eval→卒業判定を実行する。
 *
 * TODO: Step 3 以降で Phase 2 → 1' → 1 → 0 の順にロジックを移行。
 */
export async function runTrainingPhase(step: TrainingStep, ctx: PhaseRunnerContext): Promise<void> {
  ctx.log(`${BOLD}=== ${step.displayName} ===${RESET}`)

  // TODO: Step 3 以降で実装
  // 1. ensureNetworks(step, ctx) — 必要なネットワークを遅延生成
  // 2. Resume: checkpoint 探索、完了済みフェーズはスキップ
  // 3. PPO config 構築 (step.ppo + ctx.trainingConfig から)
  // 4. カリキュラム状態初期化 (step.curriculum から)
  // 5. Round-robin ループ:
  //    - buildWorkerRequest() — step config → WorkerRequest 構築
  //    - generateGamesParallel() → trajectory 処理
  //    - runPpoUpdate() — model 別の PPO 更新
  //    - adaptKL() — KL config があれば adaptive β
  //    - runEval() — eval + 卒業判定 + カリキュラム進行
  //    - saveCheckpoint() — 定期保存

  ctx.log(`  (not yet implemented — will be migrated in Steps 3-6)`)
}
