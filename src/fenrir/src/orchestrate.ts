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
import type { AnyNetwork, AnyTfNetwork } from './ml/nn.ts'
import { computeRefPlanLogits } from './policy.ts'
import { DEFAULT_REWARD_CONFIG } from './reward.ts'
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
import { existsSync, readdirSync, readFileSync, unlinkSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { generatePlanTokenTrainingBatch } from './ml/execution-plan-data.ts'
import { collectBatchGameData } from './ml/pretrain-game-data.ts'
import { PLAN_VOCAB, parsePlanIndices } from './rule-action.ts'
import { CO_ROLES } from './observation.ts'
import {
  packWeights, initGameWorkerPool, terminateGameWorkerPool, gameWorkerPoolSize,
  generateGamesParallel, deserializeStep,
} from './parallel.ts'
import { loadRandomSnapshots, countSnapshots } from './seed-bank.ts'
import { Rng } from '../../lupa/random.ts'
import { decodeObservation } from './decode-observation.ts'

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
  /** inspect サンプリング間隔（N ゲームに 1 回、0=無効） */
  inspectInterval: number
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
  workers: -1,
  transformer: false,
  strategyOnly: false,
  inspectInterval: 0,
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
      case '--inspect-interval': config.inspectInterval = parseInt(args[++i]); break
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
  --inspect-interval <n>   inspect サンプリング間隔: N ゲームに1回保存 (default: 0=無効)
  --help, -h               このヘルプを表示`)
  process.exit(0)
}

// ============================================================
// Inspect Sampling
// ============================================================

const INSPECT_DIR = 'demo/public/inspect'

let inspectGameCounter = 0

function describePlanIndex(idx: number): string {
  if (idx >= PLAN_VOCAB.SEAT_START && idx < PLAN_VOCAB.SEAT_END) return `seat${idx + 1}`
  if (idx >= PLAN_VOCAB.ROLE_START && idx < PLAN_VOCAB.ROLE_END) return CO_ROLES[idx - PLAN_VOCAB.ROLE_START]
  if (idx === PLAN_VOCAB.GRAYRAN) return 'grayran'
  if (idx === PLAN_VOCAB.NEXT) return 'NEXT'
  if (idx === PLAN_VOCAB.STOP) return 'STOP'
  return `?${idx}`
}

/**
 * バッチの seeds から inspect 対象の seed を選ぶ
 * inspectInterval ゲームに 1 回の確率でサンプリング
 */
function pickInspectSeeds(seeds: number[], interval: number): number[] {
  if (interval <= 0) return []
  const result: number[] = []
  for (const seed of seeds) {
    inspectGameCounter++
    if (inspectGameCounter % interval === 0) result.push(seed)
  }
  return result
}

/**
 * SerializedGameResult から inspect JSON を生成・保存
 */
function saveInspectGames(results: import('./parallel.ts').SerializedGameResult[], modelName: string, iteration: number) {
  const sampled = results.filter(g => g.howl)
  if (sampled.length === 0) return

  mkdirSync(INSPECT_DIR, { recursive: true })

  type IndexEntry = { file: string, seed: number, result: string, gameLength: number, model: string, iteration: number }
  const indexPath = `${INSPECT_DIR}/index.json`
  let indexEntries: IndexEntry[] = []
  if (existsSync(indexPath)) {
    try { indexEntries = JSON.parse(readFileSync(indexPath, 'utf-8')) } catch {}
  }
  const byFile = new Map(indexEntries.map(e => [e.file, e]))

  for (const game of sampled) {
    // trajectory をデコード
    const timeline: Array<Record<string, unknown>> = []
    for (const { seat, role, steps } of game.individualSteps) {
      for (const step of steps) {
        const obs = decodeObservation(new Float32Array(step.observation))
        const entry: Record<string, unknown> = {
          seat, role,
          day: obs.global.day,
          phase: obs.global.phase,
          actionHead: step.actionHead,
          actionDescription: describeAction(step.actionHead, step.actionIdx),
          actionIdx: step.actionIdx,
          logProb: step.logProb,
          reward: step.reward,
          value: step.value,
          done: step.done,
          observation: obs,
        }
        if (step.planForwardActions) {
          const groups = parsePlanIndices(step.planForwardActions)
          entry.planForward = {
            indices: step.planForwardActions,
            description: step.planForwardActions.map(describePlanIndex).join(' '),
            groups,
          }
        }
        if (step.planEndgameActions) {
          const groups = parsePlanIndices(step.planEndgameActions)
          entry.planEndgame = {
            indices: step.planEndgameActions,
            description: step.planEndgameActions.map(describePlanIndex).join(' '),
            groups,
          }
        }
        if (step.sigmoidActions && step.actionHead === 'predict') {
          const ROLES_LIST = ['villager','seer','medium','bodyguard','mason','nekomata','werewolf','possessed','fanatic','werehamster','immoralist']
          const predictions: Array<{ seat: number, roles: Array<{ role: string, value: number }> }> = []
          for (let s = 0; s < 14; s++) {
            const seatPreds: Array<{ role: string, value: number }> = []
            for (let r = 0; r < 11; r++) {
              const val = step.sigmoidActions[s * 11 + r]
              if (val > 0.3) seatPreds.push({ role: ROLES_LIST[r], value: Math.round(val * 100) / 100 })
            }
            if (seatPreds.length > 0) predictions.push({ seat: s + 1, roles: seatPreds })
          }
          entry.predict = predictions
        }
        timeline.push(entry)
      }
    }

    timeline.sort((a, b) => {
      const da = a.day as number, db = b.day as number
      if (da !== db) return da - db
      const pa = a.phase === 'night' ? 0 : 1, pb = b.phase === 'night' ? 0 : 1
      if (pa !== pb) return pa - pb
      return (a.seat as number) - (b.seat as number)
    })

    const inspectData = {
      seed: game.seed,
      result: game.result,
      gameLength: game.gameLength,
      howl: game.howl,
      players: game.players,
      timeline,
      model: modelName,
      iteration,
    }

    const fileName = `game_${game.seed}.json`
    writeFileSync(`${INSPECT_DIR}/${fileName}`, JSON.stringify(inspectData, null, 2))
    byFile.set(fileName, { file: fileName, seed: game.seed!, result: game.result, gameLength: game.gameLength!, model: modelName, iteration })
  }

  const finalIndex = [...byFile.values()].sort((a, b) => a.seed - b.seed)
  writeFileSync(indexPath, JSON.stringify(finalIndex, null, 2))
  console.error(`  [inspect] ${sampled.length} game(s) saved (total ${finalIndex.length})`)
}

function describeAction(actionHead: string, actionIdx: number): string {
  switch (actionHead) {
    case 'vote': return `vote → seat${actionIdx + 1}`
    case 'night': return actionIdx < 14 ? `night → seat${actionIdx + 1}` : 'night → skip'
    case 'claim': return `claim: ${actionIdx}`
    case 'strategy': return 'strategy (plan tokens)'
    default: return `${actionHead}: ${actionIdx}`
  }
}

// ============================================================
// Progress Log (固定ファイルへの進捗書き出し)
// ============================================================

type ProgressEvalEntry = {
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

type ProgressCurriculumEntry = {
  time: string
  iter: number
  mlMaxSeats: number
  mlStartDay: number
  event: string
}

type ProgressLog = {
  checkpointBase: string
  runInfo: {
    started: string
    git: string
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
  }
}

function fmtTime(iso: string): string {
  return iso.slice(11, 19)
}

function fmtPct(v: number): string {
  return (v * 100).toFixed(0)
}

function updateProgressFile(progress: ProgressLog): void {
  const { runInfo, curriculum, evals, latest } = progress
  const lines: string[] = []

  lines.push('# Fenrir Training Progress')
  lines.push('')
  lines.push('## Run Info')
  lines.push(`- Started: ${runInfo.started}`)
  lines.push(`- Git: ${runInfo.git}`)
  lines.push(`- Architecture: ${runInfo.arch}`)
  lines.push(`- Config: ${runInfo.configSummary}`)
  lines.push('')

  // Curriculum
  if (curriculum.length > 0) {
    lines.push('## Curriculum Changes')
    lines.push('| Time | Iter | mlMaxSeats | mlStartDay | Event |')
    lines.push('|------|------|-----------|-----------|-------|')
    for (const c of curriculum) {
      lines.push(`| ${fmtTime(c.time)} | ${c.iter} | ${c.mlMaxSeats} | ${c.mlStartDay} | ${c.event} |`)
    }
    lines.push('')
  }

  // Eval history
  if (evals.length > 0) {
    lines.push('## Eval History')
    lines.push('| Time | Model | Iter | village% | wolf% | hamster% | draw% | avgLen | base% | target% | pLoss | vLoss | ent | kl | game% | ppo% | Status |')
    lines.push('|------|-------|------|----------|-------|----------|-------|--------|-------|---------|-------|-------|-----|-----|-------|------|--------|')
    for (const e of evals) {
      const v = fmtPct(e.winRates['villager_won'] ?? 0)
      const w = fmtPct(e.winRates['werewolf_won'] ?? 0)
      const h = fmtPct(e.winRates['werehamster_won'] ?? 0)
      const d = fmtPct(e.winRates['draw'] ?? 0)
      const base = e.baseline != null ? (e.baseline * 100).toFixed(0) : '-'
      const tgt = e.target != null ? (e.target * 100).toFixed(0) : '-'
      const ppo = e.ppoMetrics
      const pL = ppo ? ppo.policyLoss.toFixed(4) : '-'
      const vL = ppo ? ppo.valueLoss.toFixed(4) : '-'
      const ent = ppo ? ppo.entropy.toFixed(4) : '-'
      const kl = ppo ? ppo.klLoss.toFixed(4) : '-'
      const gPct = e.timing ? (e.timing.gameMs / e.timing.iterMs * 100).toFixed(0) : '-'
      const pPct = e.timing ? (e.timing.ppoMs / e.timing.iterMs * 100).toFixed(0) : '-'
      lines.push(`| ${fmtTime(e.time)} | ${e.model} | ${e.iter} | ${v} | ${w} | ${h} | ${d} | ${e.avgLen.toFixed(1)} | ${base} | ${tgt} | ${pL} | ${vL} | ${ent} | ${kl} | ${gPct} | ${pPct} | ${e.status} |`)
    }
    lines.push('')
  }

  // Latest status
  lines.push('## Latest Status')
  lines.push(`- Phase: ${latest.phase}`)
  lines.push(`- Current Model: ${latest.model}`)
  lines.push(`- Iteration: ${latest.iter}/${latest.maxIter}`)
  if (latest.klCoeff != null) lines.push(`- KL coeff (beta): ${latest.klCoeff.toFixed(3)}`)
  if (latest.mlMaxSeats != null) lines.push(`- mlMaxSeats: ${latest.mlMaxSeats}`)
  if (latest.mlStartDay != null) lines.push(`- mlStartDay: ${latest.mlStartDay}`)
  lines.push(`- Updated: ${new Date().toISOString()}`)
  lines.push('')

  mkdirSync(progress.checkpointBase, { recursive: true })
  writeFileSync(`${progress.checkpointBase}/progress.md`, lines.join('\n'))
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
): { policyLoss: number, valueLoss: number, entropy: number, predictLoss: number, klLoss: number } {
  if (batch.length === 0) return { policyLoss: 0, valueLoss: 0, entropy: 0, predictLoss: 0, klLoss: 0 }

  let totalPolicyLoss = 0
  let totalValueLoss = 0
  let totalEntropy = 0
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
    totalValueLoss += result.valueLoss
    totalEntropy += result.entropy
    totalPredictLoss += result.predictLoss
    totalKlLoss += result.klLoss
    batchCount++
  }

  const n = Math.max(batchCount, 1)
  return {
    policyLoss: totalPolicyLoss / n,
    valueLoss: totalValueLoss / n,
    entropy: totalEntropy / n,
    predictLoss: totalPredictLoss / n,
    klLoss: totalKlLoss / n,
  }
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

function formatTimingStr(timings: import('./parallel.ts').GameTiming[]): string {
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
  process.title = `fenrir-orch [${config.checkpointBase}]`
  await checkExistingCheckpoints(config)

  // Git情報
  const gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  const gitDirty = execSync('git status --porcelain', { encoding: 'utf-8' }).trim() !== ''
  log(`${BOLD}Fenrir Training Orchestrator (round-robin)${RESET}`)
  log(`Git: ${gitSha}${gitDirty ? ' (dirty)' : ''} | ${new Date().toISOString()}`)
  log(`Architecture: ${config.transformer ? 'Transformer' : 'MLP'}${config.strategyOnly ? ' (strategy-only)' : ''}`)
  log(`Iterations: ${config.iterations}/model, Chunk: ${config.chunkSize}, Batch: ${config.batch}`)

  // === Progress Log ===
  const progress: ProgressLog = {
    checkpointBase: config.checkpointBase,
    runInfo: {
      started: new Date().toISOString(),
      git: `${gitSha}${gitDirty ? ' (dirty)' : ''}`,
      arch: `${config.transformer ? 'Transformer' : 'MLP'}${config.strategyOnly ? ' (strategy-only)' : ''}`,
      configSummary: `batch=${config.batch}, lr=${config.learningRate}, evalInterval=${config.evalInterval}, chunkSize=${config.chunkSize}, workers=${config.workers}`,
    },
    curriculum: [],
    evals: [],
    latest: { phase: 'init', model: '-', iter: 0, maxIter: config.iterations },
  }
  updateProgressFile(progress)

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

  // === Phase 0: Mason Individual (backbone pre-training) ===
  // 確定白の共有者を個人モデルとして学習。1 ML席で村全体の投票を制御できるため学習シグナルが強い。
  // 卒業後に全重みを village モデルに転送して Phase 1 を warm start する。
  let frozenMasonWeights: import('./parallel.ts').SharedWeights | undefined
  let frozenMasonNet: AnyNetwork | undefined
  if (!config.phase2Only) {
    const masonDir = `${config.checkpointBase}/ckpt-mason_individual`
    const masonFinalPath = `${masonDir}/final.json`
    const phase0Done = existsSync(masonFinalPath)

    if (phase0Done) {
      log(`${BOLD}=== Phase 0: Mason Individual (already graduated) ===${RESET}`)
      // Backbone transfer: mason → village
      const villageNet = networks.get('village' as ModelName)!
      const masonNet = makeNetwork()
      loadCheckpoint(masonNet, masonFinalPath)
      villageNet.loadWeights(masonNet.cloneWeights())
      frozenMasonWeights = packWeights(masonNet)
      frozenMasonNet = masonNet
      log(`  Mason backbone transferred to village network`)
      if (refNetwork) {
        refNetwork.loadWeights(masonNet.cloneWeights())
        log(`  Reference network updated from mason weights`)
      }
    } else {
      log(`${BOLD}=== Phase 0: Mason Individual ===${RESET}`)

      // Mason individual uses the same architecture as village
      const masonNet = makeNetwork()
      const masonTf = makeTfNetwork(config.learningRate * 0.2)

      // Resume support
      let masonIter = 0
      if (config.resume) {
        const ckpt = findCheckpoint(masonDir)
        if (ckpt) {
          try {
            loadCheckpoint(masonNet, ckpt.path)
            masonIter = ckpt.iteration
            log(`  Resumed from ${ckpt.path} (iter ${masonIter})`)
          } catch (e) {
            log(`  Checkpoint incompatible, starting fresh (${(e as Error).message})`)
          }
        }
      }

      // Pretrain: mason も village の pretrain 重みを使う（同一アーキテクチャ）
      if (masonIter === 0) {
        const villageNet = networks.get('village' as ModelName)!
        masonNet.loadWeights(villageNet.cloneWeights())
        log(`  Mason initialized from village pretrain weights`)
      }

      const masonPpoConfig = {
        miniBatchSize: trainingConfig.miniBatchSize,
        clipEpsilon: trainingConfig.clipEpsilon,
        valueLossCoeff: trainingConfig.valueLossCoeff,
        entropyCoeff: trainingConfig.entropyCoeff,
        freezePlan: false,
        klCoeff: refNetwork ? 0.2 : 0,
      }

      // Mason ref network (KL anchor)
      // KL reference network（MLP でも使用可能）
      const masonRefNetwork = makeNetwork()
      masonRefNetwork.loadWeights(masonNet.cloneWeights())

      const masonMlRoles = ['mason'] as SystemRole[]
      let masonMlStartDay = 1  // Day 1 からフルゲーム（snapshot に mason 生存保証がないため）
      const ML_START_DAY_MIN_MASON = 1

      function refreshMasonSnapshotCount() {
        if (masonMlStartDay <= ML_START_DAY_MIN_MASON) return 0
        let count = countSnapshots(masonMlStartDay - 1, MODEL_GROUPS.village.roles as string[], 1)
        if (count > 0) {
          log(`  Seed bank: ${count} snapshots at Day ${masonMlStartDay - 1}`)
        } else {
          log(`  ⚠ No snapshots at Day ${masonMlStartDay - 1}. Falling back to full games.`)
        }
        return count
      }
      let masonSnapshotCount = refreshMasonSnapshotCount()
      log(`  Initial masonMlStartDay=${masonMlStartDay}`)

      const masonTargetRate = baselineRates['villager_won'] ?? 0.55
      const prefix = `\x1b[36m[mason_ind ]${RESET}`
      mkdirSync(masonDir, { recursive: true })
      let graduated = false
      let iterElapsed = 0
      let iterCount = 0

      for (let iter = masonIter + 1; iter <= config.iterations && !graduated; iter++) {
        const iterStart = performance.now()
        const seeds = Array.from({ length: config.batch }, (_, g) => iter * config.batch + g)

        // ゲーム生成
        const allSteps: ProcessedStep[] = []

        const sharedWeights = packWeights(masonNet)
        const aliveRoles = MODEL_GROUPS.village.roles as string[]
        const batchSnapshots = masonSnapshotCount > 0
          ? loadRandomSnapshots(masonMlStartDay - 1, seeds.length, new Rng(iter), {
              aliveRoles,
              minAlive: 1,
            })
          : undefined

        const inspectSeeds = pickInspectSeeds(seeds, config.inspectInterval)
        const serializedResults = await generateGamesParallel({
          weights: sharedWeights,
          trainingConfig,
          phase: 1,
          mlRoles: masonMlRoles,
          mlMaxSeats: 1,
          mlStartDay: (!batchSnapshots) ? masonMlStartDay : undefined,
          snapshots: batchSnapshots,
          inspectSeeds: inspectSeeds.length > 0 ? inspectSeeds : undefined,
        }, seeds)
        if (inspectSeeds.length > 0) saveInspectGames(serializedResults, 'mason_individual', masonIter)

        for (const game of serializedResults) {
          const stepsMap = new Map<number, TrajectoryStep[]>()
          for (const { seat, steps } of game.individualSteps) {
            stepsMap.set(seat, steps.map(deserializeStep))
          }
          allSteps.push(...processTrajectories(stepsMap, trainingConfig.gamma, trainingConfig.lambda))
        }
        const lastBatchTimings = serializedResults.filter(g => g.timing).map(g => g.timing!)
        const tGameEnd = performance.now()
        const tPpoStart = performance.now()

        // PPO update
        let lastPpoResult = { policyLoss: 0, valueLoss: 0, entropy: 0, predictLoss: 0, klLoss: 0 }
        if (allSteps.length > 0) {
          normalizeAdvantages(allSteps)

          let precomputedRefLogits: Map<ProcessedStep, { fwd?: Float32Array, eg?: Float32Array }> | undefined
          if (masonRefNetwork && masonPpoConfig.klCoeff > 0) {
            precomputedRefLogits = new Map()
            for (const step of allSteps) {
              if (step.actionHead === 'strategy') {
                const { refFwdLogits, refEgLogits } = computeRefPlanLogits(masonRefNetwork, step.observation)
                precomputedRefLogits.set(step, { fwd: refFwdLogits, eg: refEgLogits })
              }
            }
          }

          masonTf.loadWeights(masonNet.cloneWeights())
          for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
            lastPpoResult = ppoUpdate(masonTf, allSteps, masonPpoConfig, precomputedRefLogits)
          }
          masonNet.loadWeights(masonTf.cloneWeights())
        }

        // Adaptive KL
        if (masonPpoConfig.klCoeff > 0 && lastPpoResult.klLoss > 0) {
          const klTarget = 0.05
          if (lastPpoResult.klLoss > klTarget * 1.5) {
            masonPpoConfig.klCoeff *= 1.5
          } else if (lastPpoResult.klLoss < klTarget / 1.5) {
            masonPpoConfig.klCoeff /= 1.5
          }
          masonPpoConfig.klCoeff = Math.max(0.01, Math.min(10, masonPpoConfig.klCoeff))
        }

        const tPpoEnd = performance.now()
        const iterMs = performance.now() - iterStart
        iterElapsed += iterMs
        iterCount++
        const gameMs = tGameEnd - iterStart
        const ppoMs = tPpoEnd - tPpoStart
        const gamePct = (gameMs / iterMs * 100).toFixed(0)
        const ppoPct = (ppoMs / iterMs * 100).toFixed(0)
        const pct = (iter / config.iterations * 100).toFixed(1)
        const lossStr = lastPpoResult.policyLoss ? ` pol=${lastPpoResult.policyLoss.toFixed(4)}` : ''
        const entStr = lastPpoResult.entropy ? ` ent=${lastPpoResult.entropy.toFixed(4)}` : ''
        const klStr = lastPpoResult.klLoss ? ` kl=${lastPpoResult.klLoss.toFixed(4)}(β=${masonPpoConfig.klCoeff.toFixed(3)})` : ''
        const avgIterMs = (iterElapsed / iterCount / 1000).toFixed(1)
        const remaining = ((config.iterations - iter) * iterElapsed / iterCount / 1000).toFixed(0)

        // timing breakdown (same as Phase 1)
        const timingStr = formatTimingStr(lastBatchTimings)

        process.stderr.write(
          `\r\x1b[K  ${prefix} iter ${iter}/${config.iterations} (${pct}%) ` +
          `${iterMs.toFixed(0)}ms (game${gamePct}% ppo${ppoPct}%) ${timingStr}` +
          `steps=${allSteps.length} day=${masonMlStartDay}${lossStr}${entStr}${klStr} ${avgIterMs}s/iter ETA ${remaining}s`
        )

        // Eval
        if (iter % config.evalInterval === 0) {
          process.stderr.write(`\r\x1b[K  ${prefix} iter ${iter} evaluating (${config.evalGames} games)...`)

          const aliveRoles = MODEL_GROUPS.village.roles as string[]
          const evalSnapshots = masonSnapshotCount > 0
            ? loadRandomSnapshots(masonMlStartDay - 1, config.evalGames, new Rng(42), {
                aliveRoles,
                minAlive: 1,
                forEval: true,
              })
            : undefined
          const evalResult = await evaluate(
            masonNet, { ...trainingConfig, mlRoles: masonMlRoles }, config.evalGames,
            wolfTeamNet, masonTeamNet, 1,
            { ...(evalSnapshots ? { snapshots: evalSnapshots } : {}), masonAsIndividual: true, evalIter: iter },
          )
          process.stderr.write('\r\x1b[K')
          appendEvalLog(masonDir, iter, evalResult, 'mason_individual')
          const factionRate = evalResult.winRates['villager_won'] ?? 0
          log(
            `${prefix} [${iter}] ${Object.entries(evalResult.winRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')} ` +
            `avgLen=${evalResult.avgGameLength.toFixed(1)} ${evalResult.avgElapsedMs.toFixed(0)}ms/eval`
          )

          progress.evals.push({
            time: new Date().toISOString(), model: 'mason_individual' as any, iter,
            winRates: { ...evalResult.winRates }, avgLen: evalResult.avgGameLength, status: factionRate >= masonTargetRate ? 'GRADUATED' : '',
            ppoMetrics: { ...lastPpoResult }, baseline: masonTargetRate, target: masonTargetRate * 0.9,
            timing: { gameMs, ppoMs, iterMs },
          })
          progress.latest = { phase: '0', model: 'mason_individual', iter, maxIter: config.iterations, klCoeff: masonPpoConfig.klCoeff, mlStartDay: masonMlStartDay }
          updateProgressFile(progress)

          const MASON_MIN_ITER = 1000
          // Day カリキュラム: 勝率達成で Day をデクリメント
          if (iter >= MASON_MIN_ITER && factionRate >= masonTargetRate * 0.9) {
            if (masonMlStartDay > ML_START_DAY_MIN_MASON) {
              const prevDay = masonMlStartDay
              masonMlStartDay--
              log(`${prefix} Curriculum: masonMlStartDay ${prevDay} → ${masonMlStartDay}`)
              progress.curriculum.push({ time: new Date().toISOString(), iter, mlMaxSeats: 1, mlStartDay: masonMlStartDay, event: `mason day ${prevDay}→${masonMlStartDay}` })
              masonSnapshotCount = refreshMasonSnapshotCount()
            }
            if (masonMlStartDay <= ML_START_DAY_MIN_MASON && factionRate >= masonTargetRate) {
              log(`${prefix} ${BOLD}GRADUATED${RESET} (villager_won=${(factionRate * 100).toFixed(0)}% >= ${(masonTargetRate * 100).toFixed(0)}%, day=${masonMlStartDay})`)
              graduated = true
            }
          }
        }

        // Checkpoint
        if (iter % config.checkpointInterval === 0) {
          saveCheckpoint(masonNet, `${masonDir}/checkpoint_${iter}.json`, { iteration: iter, winRate: 0 })
        }
      }

      process.stderr.write('\r\x1b[K')

      // Final save
      saveCheckpoint(masonNet, masonFinalPath, { iteration: config.iterations, winRate: 0 })
      log(`Phase 0 complete. Mason individual checkpoint → ${masonFinalPath}`)

      // Backbone transfer: mason → village
      const villageNet = networks.get('village' as ModelName)!
      villageNet.loadWeights(masonNet.cloneWeights())
      frozenMasonWeights = packWeights(masonNet)
      frozenMasonNet = masonNet
      log(`Mason backbone transferred to village network (all weights)`)
      if (refNetwork) {
        refNetwork.loadWeights(masonNet.cloneWeights())
        log(`Reference network updated from mason weights`)
      }

      // TfNetwork も更新
      tfNetwork.loadWeights(masonNet.cloneWeights())
    }
  }

  // === Phase 1: ラウンドロビン ===
  if (!config.phase2Only) {
    log(`${BOLD}=== Phase 1: Round-Robin Training ===${RESET}`)

    const graduated = new Set<ModelName>()
    // カリキュラム: NN 席数を徐々に増やす (village のみ)
    let mlMaxSeats = 1
    const ML_MAX_SEATS_CAP = 6  // 村役職の最大席数 (村2+占1+霊1+狩1+猫1、共有は集団NNなので除外)
    // カリキュラム: ML/Retar開始Dayを徐々に前に (序盤Retarコスト回避)
    let mlStartDay = 3
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

          const sharedWeights = packWeights(network)
          const sharedWolfWeights = group.teamType === 'wolf_team' ? packWeights(wolfTeamNet) : undefined
          const sharedMasonWeights = group.teamType === 'mason_team' ? packWeights(masonTeamNet) : undefined

          // Seed Bank: ディスクからランダムにスナップショットを読み込み
          const batchSnapshots = (snapshotCount > 0 && name === 'village')
            ? loadRandomSnapshots(mlStartDay - 1, seeds.length, new Rng(iter), {
                aliveRoles: group.roles,
                minAlive: mlMaxSeats,
              })
            : undefined

          const inspectSeeds = pickInspectSeeds(seeds, config.inspectInterval)
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
            frozenMasonWeights: name === 'village' ? frozenMasonWeights : undefined,
            inspectSeeds: inspectSeeds.length > 0 ? inspectSeeds : undefined,
          }, seeds)
          if (inspectSeeds.length > 0) saveInspectGames(serializedResults, name, iter)

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
          const lastBatchTimings = serializedResults.filter(g => g.timing).map(g => g.timing!)
          const tGameEnd = performance.now()
          const tPpoStart = performance.now()

          // PPO update (shared TfNN に重みをスワップ)
          let lastPpoResult = { policyLoss: 0, valueLoss: 0, entropy: 0, predictLoss: 0, klLoss: 0 }
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
          const timingStr = formatTimingStr(lastBatchTimings)
          const mlInfo = name === 'village' ? ` ml=${mlMaxSeats}/${ML_MAX_SEATS_CAP} day=${mlStartDay}` : ''
          const lossStr = lastPpoResult.policyLoss ? ` pol=${lastPpoResult.policyLoss.toFixed(4)}` : ''
          const entStr = lastPpoResult.entropy ? ` ent=${lastPpoResult.entropy.toFixed(4)}` : ''
          const klStr = lastPpoResult.klLoss ? ` kl=${lastPpoResult.klLoss.toFixed(4)}(β=${ppoConfig.klCoeff.toFixed(3)})` : ''
          process.stderr.write(
            `\r\x1b[K  ${prefix} iter ${iter}/${config.iterations} (${pct}%) ` +
            `${iterMs.toFixed(0)}ms (game${gamePct}% ppo${ppoPct}%) ${timingStr}` +
            `steps=${totalSteps}${mlInfo}${lossStr}${entStr}${klStr} ${avgIterMs}s/iter ETA ${remaining}s`
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
            const evalResult = await evaluate(network, evalConfig, config.evalGames, wolfTeamNet, masonTeamNet, evalMlMax, { ...(evalSnapshots ? { snapshots: evalSnapshots } : {}), evalIter: iter, frozenMasonNet: name === 'village' ? frozenMasonNet : undefined })
            process.stderr.write('\r\x1b[K')
            appendEvalLog(`${config.checkpointBase}/ckpt-${name}`, iter, evalResult, name)
            const factionRate = evalResult.winRates[group.faction] ?? 0
            log(
              `${prefix} [${iter}] ${Object.entries(evalResult.winRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')} ` +
              `avgLen=${evalResult.avgGameLength.toFixed(1)} ${evalResult.avgElapsedMs.toFixed(0)}ms/eval`
            )

            // Progress log: eval
            const evalStatus = factionRate >= targetRate ? 'GRADUATED' : ''
            progress.evals.push({
              time: new Date().toISOString(), model: name, iter,
              winRates: { ...evalResult.winRates }, avgLen: evalResult.avgGameLength, status: evalStatus,
              ppoMetrics: { ...lastPpoResult }, baseline: baselineRates[group.faction], target: targetRate,
              timing: { gameMs, ppoMs, iterMs },
            })
            progress.latest = { phase: '1', model: name, iter, maxIter: config.iterations, klCoeff: ppoConfig.klCoeff, mlMaxSeats, mlStartDay }

            // カリキュラム: 勝率がベースラインの90%に達したら NN 席数を増やす / 開始Dayを前に
            if (name === 'village' && mlMaxSeats < ML_MAX_SEATS_CAP && factionRate >= targetRate * 0.9) {
              const prevSeats = mlMaxSeats
              mlMaxSeats = Math.min(mlMaxSeats + 1, ML_MAX_SEATS_CAP)
              log(`${prefix} Curriculum: mlMaxSeats → ${mlMaxSeats}`)
              progress.curriculum.push({ time: new Date().toISOString(), iter, mlMaxSeats, mlStartDay, event: `mlMaxSeats ${prevSeats}→${mlMaxSeats}` })
            }
            if (name === 'village' && mlStartDay > ML_START_DAY_MIN && factionRate >= targetRate * 0.9) {
              const prevDay = mlStartDay
              mlStartDay = Math.max(mlStartDay - 1, ML_START_DAY_MIN)
              log(`${prefix} Curriculum: mlStartDay → ${mlStartDay}`)
              progress.curriculum.push({ time: new Date().toISOString(), iter, mlMaxSeats, mlStartDay, event: `mlStartDay ${prevDay}→${mlStartDay}` })
              // Seed Bank: 新しい Day のスナップショット数を確認
              snapshotCount = mlStartDay > ML_START_DAY_MIN ? countSnapshots(mlStartDay - 1, villageRoles, mlMaxSeats) : 0
              if (mlStartDay > ML_START_DAY_MIN && snapshotCount === 0) {
                log(`${prefix} ⚠ No snapshots at Day ${mlStartDay - 1} (run: npm run generate-snapshots -- --day ${mlStartDay - 1} --alive village --min-alive ${mlMaxSeats}). Falling back to full games.`)
              } else if (snapshotCount > 0) {
                log(`${prefix} Seed bank: ${snapshotCount} snapshots at Day ${mlStartDay}`)
              }
            }

            updateProgressFile(progress)

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
    progress.latest = { phase: '1 (complete)', model: '-', iter: config.iterations, maxIter: config.iterations }
    updateProgressFile(progress)
  }

  // === Phase 1': 集団NN + 狂信者 + 第三勢力の学習 (frozen村NN注入) ===
  if (!config.phase2Only) {
    log(`${BOLD}=== Phase 1': Collective + Non-Village Training ===${RESET}`)
    progress.latest = { phase: "1'", model: '-', iter: 0, maxIter: config.iterations }
    updateProgressFile(progress)

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

        let lastPpoResult1p = { policyLoss: 0, valueLoss: 0, entropy: 0, predictLoss: 0, klLoss: 0 }
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
            const inspectSeeds = pickInspectSeeds(seeds, config.inspectInterval)
            const serializedResults = await generateGamesParallel({
              weights: frozenVillageWeights,  // fallback
              modelGroupWeights,
              villageFrozenWeights: frozenVillageWeights,
              trainingConfig,
              phase: 1,
              inspectSeeds: inspectSeeds.length > 0 ? inspectSeeds : undefined,
            }, seeds)
            if (inspectSeeds.length > 0) saveInspectGames(serializedResults, `phase1p_${name}`, iter)

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
                lastPpoResult1p = ppoUpdate(collectiveTf, steps, ppoConfig)
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
                lastPpoResult1p = ppoUpdate(tf, allIndividual, ppoConfig)
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
                evalIter: iter,
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

            // Progress log: Phase 1' eval
            const evalStatus = factionRate >= targetRate ? 'GRADUATED' : ''
            progress.evals.push({
              time: new Date().toISOString(), model: name, iter,
              winRates: { ...evalResult.winRates }, avgLen: evalResult.avgGameLength, status: evalStatus,
              ppoMetrics: { ...lastPpoResult1p }, baseline: baselineRates[group.faction], target: targetRate,
              timing: { gameMs, ppoMs, iterMs },
            })
            progress.latest = { phase: "1'", model: name, iter, maxIter: config.iterations }
            updateProgressFile(progress)

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
    progress.latest = { phase: "1' (complete)", model: '-', iter: config.iterations, maxIter: config.iterations }
    updateProgressFile(progress)
  }

  // === Cleanup GPU ===
  tfNetwork.dispose()
  wolfTeamTf.dispose()
  masonTeamTf.dispose()
  terminateGameWorkerPool()

  // === Phase 2 (子プロセスで起動) ===
  if (!config.phase1Only) {
    log(`${BOLD}=== Phase 2: Self-Play ===${RESET}`)
    progress.latest = { phase: '2', model: 'self-play', iter: 0, maxIter: config.phase2Iterations }
    updateProgressFile(progress)
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
