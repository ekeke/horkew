#!/usr/bin/env node
/**
 * Fenrir Training Orchestrator (シングルプロセス・ラウンドロビン)
 *
 * GPU の TfTransformerNetwork は1セットだけ保持し、3モデルの推論用 NN (Pure JS) を
 * ラウンドロビンで切り替えながら学習する。
 *
 * メモリ:
 *   GPU: TfNN × 3 (individual + wolf_team + mason_team) — 単一モデル学習と同じ
 *   CPU: Pure JS NN × 3 (推論用)
 */

import type { SystemRole } from '../../types/index.ts'
import type { AnyNetwork, AnyTfNetwork } from './ml/nn.ts'
import {
  MODEL_GROUPS, MODEL_NAMES, ROLE_TO_GROUP, BASELINE_RATES,
  klTargetForIter, DEFAULT_KL_CONFIG,
  type ModelName,
} from './curriculum.ts'
import {
  ppoUpdate, appendKlLog, findCheckpoint,
  runTrainingPhase,
  type TrainProgress, type PhaseRunnerContext,
} from './phase-runner.ts'
import { buildCurriculum, formatAssignment, type TrainingStep } from './curriculum.ts'
import { computeRefPlanLogits } from './agents/neural-agent.ts'
import { DEFAULT_REWARD_CONFIG } from './reward.ts'
import { processTrajectories, normalizeAdvantages, computeGAE, type TrajectoryStep, type ProcessedStep } from './ml/trajectory.ts'
import { saveCheckpoint, loadCheckpoint } from './ml/checkpoint.ts'
import {
  evaluate, appendEvalLog,
  createNetwork, createWolfTeamNetwork, createMasonTeamNetwork,
  createTfNetwork, createWolfTeamTfNetwork, createMasonTeamTfNetwork,
  createWolfCollectiveNetwork, createMasonCollectiveNetwork,
  createWolfCollectiveTfNetwork, createMasonCollectiveTfNetwork,
  createFanaticNetwork, createFanaticTfNetwork,
  DEFAULT_TRAINING_CONFIG,
  type TrainingConfig,
} from './training.ts'
import { existsSync, readdirSync, readFileSync, unlinkSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { basename } from 'node:path'
import { execSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { generatePlanTokenTrainingBatch, generateStructurePretrainBatch } from './ml/execution-plan-data.ts'
import { collectBatchGameData } from './ml/pretrain-game-data.ts'
import { collectTsumiBatch, saveTsumiCache, loadTsumiCache, loadTsumiFromDB } from './ml/pretrain-tsumi-data.ts'
import { PLAN_VOCAB, parsePlanIndices, describePlanIndex } from './plan/plan-vocab.ts'
import {
  packWeights, initGameWorkerPool, terminateGameWorkerPool, gameWorkerPoolSize,
  generateGamesParallel, deserializeStep,
  packWreWeights, type WreSharedWeights,
} from './parallel.ts'
import { WinrateNetwork } from './ml/winrate-network.ts'
import { loadWinrateCheckpoint, saveWinrateCheckpoint } from './ml/winrate-training.ts'
import { extractWreSamplesFromGameResults } from './ml/winrate-data.ts'
import { loadRandomSnapshots, countSnapshots } from './seed-bank.ts'
import { Rng } from '../../lupa/random.ts'
import {
  type PretrainSnapshot,
  SNAPSHOT_EPOCHS_B, SNAPSHOT_EPOCHS_B2, SNAPSHOT_EPOCHS_D,
  capturePlanSnapshot, captureGameSnapshot, savePretrainSnapshots,
} from './pretrain-snapshot.ts'
// decode-observation.ts は削除済み — CollectedObservation を直接使用

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
  strategyOnly: boolean
  miniBatchSize?: number
  /** inspect サンプリング間隔（N ゲームに 1 回、0=無効） */
  inspectInterval: number
  /** `p` 選択時に true — resume 後に iterCounts を 0 にリセット */
  ppoRestart: boolean
  /** 最小イテレーションで全パイプラインを通す (プラットフォームバグ検出用) */
  skeleton: boolean
  /** WRE PBRS: 勝率NNチェックポイントパス (undefined=無効) */
  wre?: string
  /** WRE再学習間隔 (iteration数、0=再学習無効) */
  wreRefresh: number
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  iterations: 50000,
  phase2Iterations: 40000,
  chunkSize: 100,
  batch: 64,
  checkpointBase: '',
  noRetar: false,
  evalInterval: 100,
  checkpointInterval: 10,
  evalGames: 100,
  phase1Only: false,
  phase2Only: false,
  resume: false,
  learningRate: 3e-4,
  workers: 4,
  strategyOnly: true,
  inspectInterval: 0,
  ppoRestart: false,
  skeleton: false,
  wreRefresh: 0,
}

function parseArgs(): OrchestratorConfig {
  const args = process.argv.slice(2)
  const config = { ...DEFAULT_CONFIG }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--iterations': config.iterations = parseInt(args[++i]); break
      case '--phase2-iterations': config.phase2Iterations = parseInt(args[++i]); break
      case '--chunk-size': config.chunkSize = parseInt(args[++i]); break
      case '--batch': config.batch = parseInt(args[++i]); break
      case '--checkpoint-base': config.checkpointBase = args[++i]; break
      case '--no-retar': config.noRetar = true; break
      case '--eval-interval': config.evalInterval = parseInt(args[++i]); break
      case '--checkpoint-interval': config.checkpointInterval = parseInt(args[++i]); break
      case '--eval-games': config.evalGames = parseInt(args[++i]); break
      case '--phase1-only': config.phase1Only = true; break
      case '--phase2-only': config.phase2Only = true; break
      case '--target-winrate': config.targetWinRate = parseFloat(args[++i]); break
      // --resume は廃止（selectStartMode の対話プロンプトに統合）
      case '--resume': config.resume = true; break  // 後方互換: 指定されたら従来通り動作
      case '--lr': config.learningRate = parseFloat(args[++i]); break
      case '--workers': {
        const val = args[++i]
        config.workers = val === 'auto' ? -1 : parseInt(val)
        break
      }
      case '--strategy-only': config.strategyOnly = true; break
      case '--mini-batch': config.miniBatchSize = parseInt(args[++i]); break
      case '--inspect-interval': config.inspectInterval = parseInt(args[++i]); break
      case '--skeleton': config.skeleton = true; break
      case '--wre': {
        const next = args[i + 1]
        config.wre = (next && !next.startsWith('-')) ? args[++i] : 'tmp/winrate/checkpoints/winrate-final.json'
        break
      }
      case '--wre-refresh': config.wreRefresh = parseInt(args[++i]); break
      case '--help': case '-h': showHelp(); break
    }
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
  --checkpoint-base <dir>  ベースDir (省略時: 新規=tmp/orch-run-N, resume=前回のランから自動取得)
  --eval-interval <n>      評価間隔 (default: ${DEFAULT_CONFIG.evalInterval})
  --checkpoint-interval <n> チェックポイント間隔 (default: ${DEFAULT_CONFIG.checkpointInterval})
  --eval-games <n>       評価ゲーム数 (default: ${DEFAULT_CONFIG.evalGames})
  --no-retar               Retar無効化
  --phase1-only            Phase 2 をスキップ
  --phase2-only            Phase 1 をスキップ
  --target-winrate <n>     目標勝率の上書き (default: baseline eval から自動算出)
  --resume                 (非推奨) 最新チェックポイントから再開。省略時は対話プロンプトで選択
  --lr <n>                 学習率 (default: ${DEFAULT_CONFIG.learningRate})
  --workers <n|auto>       ゲーム生成ワーカー数 (auto=CPU-1, default: 4)
  --strategy-only          戦略NNのみ学習、行動はルールベース (Step 1 bootstrap)
  --mini-batch <n>         PPOミニバッチサイズ (default: ${DEFAULT_TRAINING_CONFIG.miniBatchSize})
  --inspect-interval <n>   inspect サンプリング間隔: N ゲームに1回保存 (default: 0=無効)
  --skeleton               最小イテレーションで全パイプラインを通す (プラットフォームバグ検出用)
  --wre [path]             WRE PBRS reward shaping (default: tmp/winrate/checkpoints/winrate-final.json)
  --wre-refresh <n>        WRE re-training interval in iterations (default: 0=disabled, e.g. 500)
  --help, -h               このヘルプを表示`)
  process.exit(0)
}

// ============================================================
// Inspect Sampling
// ============================================================

let inspectGameCounter = 0

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
function saveInspectGames(results: import('./parallel.ts').SerializedGameResult[], modelName: string, iteration: number, options: { gitSha?: string, runId: string, checkpointBase: string }) {
  const sampled = results.filter(g => g.howl)
  if (sampled.length === 0) return

  const inspectDir = `${options.checkpointBase}/inspect`
  mkdirSync(inspectDir, { recursive: true })
  const sha = options.gitSha ?? execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()

  type IndexEntry = { file: string, seed: number, result: string, gameLength: number, model: string, iteration: number, gitSha: string, runId: string }
  const indexPath = `${inspectDir}/index.json`
  let indexEntries: IndexEntry[] = []
  if (existsSync(indexPath)) {
    try { indexEntries = JSON.parse(readFileSync(indexPath, 'utf-8')) } catch {}
  }
  const byFile = new Map(indexEntries.map(e => [e.file, e]))

  for (const game of sampled) {
    // trajectory → timeline（observation は allPlayerSteps で一元管理）
    const timeline: Array<Record<string, unknown>> = []
    for (const { seat, role, steps } of game.individualSteps) {
      for (const step of steps) {
        const entry: Record<string, unknown> = {
          seat, role,
          day: step.day,
          phase: 'day',
          actionHead: step.actionHead,
          actionDescription: describeAction(step.actionHead, step.actionIdx),
          actionIdx: step.actionIdx,
          logProb: step.logProb,
          reward: step.reward,
          value: step.value,
          done: step.done,
          ...(step.source ? { source: step.source } : {}),
        }
        if (step.planActions) {
          const groups = parsePlanIndices(step.planActions)
          entry.plan = {
            indices: step.planActions,
            description: step.planActions.map(describePlanIndex).join(' '),
            groups,
          }
        }
        if (step.sigmoidActions) {
          const ROLES_LIST = ['villager','seer','medium','bodyguard','mason','nekomata','werewolf','possessed','fanatic','werehamster','immoralist']
          const predictions: Array<{ seat: number, roles: Array<{ role: string, value: number }> }> = []
          for (let s = 0; s < 14; s++) {
            const seatPreds: Array<{ role: string, value: number }> = []
            for (let r = 0; r < 11; r++) {
              const val = step.sigmoidActions[s * 11 + r]
              seatPreds.push({ role: ROLES_LIST[r], value: Math.round(val * 100) / 100 })
            }
            if (seatPreds.length > 0) predictions.push({ seat: s + 1, roles: seatPreds })
          }
          entry.predict = predictions
        }
        // 同一 seat+day+actionHead の重複は後勝ち（onPreVote → decideVote の二重記録対策）
        const dedupeKey = `${seat}:${step.day}:${step.actionHead}`
        const existing = timeline.findIndex(e => `${e.seat}:${e.day}:${e.actionHead}` === dedupeKey)
        if (existing >= 0) {
          timeline[existing] = entry
        } else {
          timeline.push(entry)
        }
      }
    }

    timeline.sort((a, b) => {
      const da = a.day as number, db = b.day as number
      if (da !== db) return da - db
      const pa = a.phase === 'night' ? 0 : 1, pb = b.phase === 'night' ? 0 : 1
      if (pa !== pb) return pa - pb
      return (a.seat as number) - (b.seat as number)
    })

    // observation を per-day 共通部分と per-player 部分に分離
    const daySnapshots: Record<number, Record<string, unknown>> = {}
    const playerSteps: Array<Record<string, unknown>> = []
    if (game.allObservations) {
      for (const o of game.allObservations) {
        const obs = o.observation as import('./observation.ts').CollectedObservation
        if (!daySnapshots[o.day]) {
          const { myRole: _, ropeMargin: __, ...globalRest } = obs.global
          daySnapshots[o.day] = {
            global: globalRest,
            seats: obs.seats.map(s => { const { isMe: _, ...rest } = s; return rest }),
            revote: obs.revote,
            history: obs.history,
            plan: obs.plan,
            tsumiTarget: obs.tsumiTarget,
          }
        }
        playerSteps.push({
          seat: o.seat,
          role: o.role,
          day: o.day,
          myRole: obs.global.myRole,
          ropeMargin: obs.global.ropeMargin,
          private: obs.private,
          retar: obs.retar,
          proposals: o.proposals,
        })
      }
    }

    const inspectData = {
      runId: options.runId,
      checkpointBase: options.checkpointBase,
      seed: game.seed,
      result: game.result,
      gameLength: game.gameLength,
      howl: game.howl,
      players: game.players,
      timeline,
      daySnapshots,
      playerSteps,
      model: modelName,
      iteration,
      gitSha: sha,
    }

    const now = new Date()
    const ts = now.getFullYear().toString()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0')
    const fileName = `${ts}.json`
    writeFileSync(`${inspectDir}/${fileName}`, JSON.stringify(inspectData, null, 2))
    byFile.set(fileName, { file: fileName, seed: game.seed!, result: game.result, gameLength: game.gameLength!, model: modelName, iteration, gitSha: sha, runId: options.runId })
  }

  const finalIndex = [...byFile.values()].sort((a, b) => b.iteration - a.iteration || a.seed - b.seed)
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

function saveEvalHowl(
  checkpointBase: string,
  iter: number,
  howlGames: Array<{ seed: number, howl: string, result: string, gameLength: number }>,
): void {
  const dir = `${checkpointBase}/eval-howl/iter_${iter}`
  mkdirSync(dir, { recursive: true })
  for (const game of howlGames) {
    writeFileSync(`${dir}/seed_${game.seed}.howl`, game.howl)
  }
}

// ============================================================
// Train Status / History / Progress
// ============================================================

type TrainStatus = {
  status: 'running' | 'stopped'
  runId: string
  checkpointBase: string
  pid: number
  gitSha: string
  updated: string
}

const TRAIN_STATUS_FILE = 'train-status.json'
const TRAIN_HISTORY_FILE = 'train-history.jsonl'

function readTrainStatus(): TrainStatus | null {
  if (!existsSync(TRAIN_STATUS_FILE)) return null
  try { return JSON.parse(readFileSync(TRAIN_STATUS_FILE, 'utf-8')) } catch { return null }
}

function writeTrainStatus(status: TrainStatus): void {
  writeFileSync(TRAIN_STATUS_FILE, JSON.stringify(status, null, 2) + '\n')
}

function appendTrainHistory(event: Record<string, unknown>): void {
  appendFileSync(TRAIN_HISTORY_FILE, JSON.stringify(event) + '\n')
}

function generateRunId(checkpointBase: string): string {
  const now = new Date()
  const ts = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0')
    + '-'
    + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
    + String(now.getSeconds()).padStart(2, '0')
  return `${basename(checkpointBase)}-${ts}`
}

/** checkpointBase 省略時に次の連番ディレクトリを決定 */
function nextCheckpointBase(): string {
  mkdirSync('tmp', { recursive: true })
  let maxN = 0
  try {
    for (const entry of readdirSync('tmp')) {
      const m = entry.match(/^orch-run-(\d+)$/)
      if (m) { const n = parseInt(m[1]); if (n > maxN) maxN = n }
    }
  } catch { /* tmp/ doesn't exist yet */ }
  return `tmp/orch-run-${maxN + 1}`
}

// --- Progress (per-checkpointBase) ---

function readTrainProgress(checkpointBase: string): TrainProgress | null {
  const path = `${checkpointBase}/train-progress.json`
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return null }
}

function writeTrainProgress(progress: TrainProgress): void {
  mkdirSync(progress.checkpointBase, { recursive: true })
  progress.latest.updated = new Date().toISOString()
  writeFileSync(`${progress.checkpointBase}/train-progress.json`, JSON.stringify(progress, null, 2) + '\n')
  // train-status.json の updated も更新（道標を最新に保つ）
  const status = readTrainStatus()
  if (status && status.runId === progress.runId) {
    status.updated = progress.latest.updated
    writeTrainStatus(status)
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

/** PPO チェックポイントを削除し、pretrain の checkpoint_0 だけ残す */
function deletePpoCheckpoints(checkpointBase: string): void {
  for (const name of MODEL_NAMES) {
    const dir = `${checkpointBase}/ckpt-${name}`
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
}

/** 全チェックポイントを削除 */
function deleteAllCheckpoints(checkpointBase: string): void {
  for (const name of MODEL_NAMES) {
    const dir = `${checkpointBase}/ckpt-${name}`
    if (existsSync(dir)) rmSync(dir, { recursive: true })
  }
}

/**
 * train-status.json の gitSha 以降のコミットから [break:*] タグを検出し、推薦モードを返す。
 * - [break:all] → 'n' (新規)
 * - [break:ppo] → 'p' (PPO やり直し)
 * - なし → 'r' (最新から再開)
 * - gitSha が不明 → null (推薦なし)
 */
function detectBreakTag(trainingSha: string | undefined): { recommended: 'n' | 'p' | 'r', breaks: string[] } | null {
  if (!trainingSha) return null
  try {
    const gitLog = execSync(`git log --oneline ${trainingSha}..HEAD`, { encoding: 'utf-8' }).trim()
    if (!gitLog) return { recommended: 'r', breaks: [] }
    const lines = gitLog.split('\n')
    const breakLines = lines.filter(l => /\[break:/.test(l))
    if (breakLines.length === 0) return { recommended: 'r', breaks: [] }
    const hasBreakAll = breakLines.some(l => /\[break:all]/.test(l))
    return {
      recommended: hasBreakAll ? 'n' : 'p',
      breaks: breakLines,
    }
  } catch {
    return null  // git コマンド失敗（SHA が見つからない等）
  }
}

/** 推薦モードの表示文字列 */
function formatRecommendation(rec: ReturnType<typeof detectBreakTag>): string {
  if (!rec) return ''
  const label = rec.recommended === 'n' ? 'n: 新規' : rec.recommended === 'p' ? 'p: PPO やり直し' : 'r: 再開'
  if (rec.breaks.length === 0) {
    return `  ${BOLD}→ 推薦: ${label}${RESET} (break タグなし)\n`
  }
  const lines = [`  ${BOLD}→ 推薦: ${label}${RESET} (${rec.breaks.length} 件の break タグ)`]
  for (const b of rec.breaks) {
    lines.push(`    ${b}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * 起動モード選択の対話プロンプト。
 * --resume が明示指定されている場合はスキップ（後方互換）。
 * --checkpoint-base が明示指定されている場合はそのベースに対してプロンプトを出す。
 */
async function selectStartMode(config: OrchestratorConfig): Promise<void> {
  // --skeleton: 常に新規開始、プロンプトなし
  if (config.skeleton) {
    config.checkpointBase = config.checkpointBase || nextCheckpointBase()
    return
  }

  // --resume が明示指定されている場合は従来動作（後方互換）
  if (config.resume) {
    if (!config.checkpointBase) {
      const status = readTrainStatus()
      if (!status) {
        console.error('ERROR: No previous run found (train-status.json missing). Specify --checkpoint-base.')
        process.exit(1)
      }
      config.checkpointBase = status.checkpointBase
      log(`Resuming from: ${config.checkpointBase} (run: ${status.runId})`)
    }
    return
  }

  const fmtTime = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
  }

  // --checkpoint-base が明示指定されている場合
  if (config.checkpointBase) {
    const range = getCheckpointTimeRange(config.checkpointBase)
    if (!range) return  // checkpoint なし → そのまま新規開始

    const statusForSha = readTrainStatus()
    const rec = detectBreakTag(statusForSha?.gitSha)

    log(`${BOLD}既存チェックポイントを検出:${RESET}`)
    log(`  パス: ${config.checkpointBase}/`)
    log(`  ファイル数: ${range.totalFiles}`)
    log(`  学習期間: ${fmtTime(range.oldest)} 〜 ${fmtTime(range.newest)}`)
    log('')
    const recStr = formatRecommendation(rec)
    if (recStr) process.stderr.write(`${BOLD}[orch]${RESET} ${recStr}\n`)
    log(`  [n] 全削除して新規学習 (pretrain からやり直し)`)
    log(`  [p] pretrain 後から PPO やり直し`)
    log(`  [r] 最新チェックポイントから再開`)
    log(`  [q] 中止`)

    const defaultChoice = rec?.recommended ?? 'q'
    const choice = await promptChoice(`  選択 (n/p/r/Q) [${defaultChoice}]: `) || defaultChoice
    if (choice === 'n') {
      deleteAllCheckpoints(config.checkpointBase)
      log('全チェックポイントを削除しました。')
    } else if (choice === 'p') {
      deletePpoCheckpoints(config.checkpointBase)
      log('PPOチェックポイントを削除しました (pretrain checkpoint_0 は保持)。')
      config.resume = true
      config.ppoRestart = true
    } else if (choice === 'r') {
      config.resume = true
    } else {
      log('中止しました。')
      process.exit(0)
    }
    return
  }

  // --checkpoint-base 未指定: train-status.json から前回ベースを取得
  const status = readTrainStatus()
  const previousBase = status?.checkpointBase

  if (previousBase && existsSync(previousBase)) {
    const range = getCheckpointTimeRange(previousBase)

    if (range) {
      // 前回ベースに checkpoint がある
      const rec = detectBreakTag(status?.gitSha)

      log(`${BOLD}前回の学習を検出:${RESET}`)
      log(`  パス: ${previousBase}/`)
      log(`  ファイル数: ${range.totalFiles}`)
      log(`  学習期間: ${fmtTime(range.oldest)} 〜 ${fmtTime(range.newest)}`)
      log('')
      const recStr = formatRecommendation(rec)
      if (recStr) process.stderr.write(`${BOLD}[orch]${RESET} ${recStr}\n`)
      log(`  [n] 新しいベースで開始 (pretrain から)`)
      log(`  [p] ${previousBase} — pretrain 後から PPO やり直し`)
      log(`  [r] ${previousBase} — 最新チェックポイントから再開`)
      log(`  [q] 中止`)

      const defaultChoice = rec?.recommended ?? 'q'
      const choice = await promptChoice(`  選択 (n/p/r/Q) [${defaultChoice}]: `) || defaultChoice
      if (choice === 'n') {
        config.checkpointBase = nextCheckpointBase()
        log(`New run: ${config.checkpointBase}`)
      } else if (choice === 'p') {
        config.checkpointBase = previousBase
        deletePpoCheckpoints(previousBase)
        log('PPOチェックポイントを削除しました (pretrain checkpoint_0 は保持)。')
        config.resume = true
        config.ppoRestart = true
      } else if (choice === 'r') {
        config.checkpointBase = previousBase
        config.resume = true
      } else {
        log('中止しました。')
        process.exit(0)
      }
    } else {
      // 前回ベースのディレクトリはあるが checkpoint がない
      log(`${BOLD}前回のベースを検出 (チェックポイントなし):${RESET}`)
      log(`  パス: ${previousBase}/`)
      log('')
      log(`  [n] 新しいベースで開始`)
      log(`  [c] ${previousBase} を再利用して開始`)
      log(`  [q] 中止`)

      const choice = await promptChoice(`  選択 (n/c/Q): `)
      if (choice === 'n') {
        config.checkpointBase = nextCheckpointBase()
        log(`New run: ${config.checkpointBase}`)
      } else if (choice === 'c') {
        config.checkpointBase = previousBase
        log(`Reusing: ${previousBase}`)
      } else {
        log('中止しました。')
        process.exit(0)
      }
    }
  } else {
    // 初回起動 (train-status.json なし or 前回ベースが存在しない)
    config.checkpointBase = nextCheckpointBase()
    log(`New run: ${config.checkpointBase}`)
  }
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

  // === Skeleton mode: 最小イテレーションで全パイプライン通過 ===
  if (config.skeleton) {
    log(`${BOLD}=== SKELETON MODE ===${RESET} (minimal iterations for platform bug detection)`)
    config.iterations = 3
    config.phase2Iterations = 3
    config.chunkSize = 3
    config.batch = 4
    config.evalInterval = 3
    config.checkpointInterval = 3
    config.evalGames = 10
    config.phase1Only = false
    config.phase2Only = false
  }

  validateConfig(config)

  // === 重複起動チェック (train-status.json) ===
  const existingStatus = readTrainStatus()
  if (existingStatus && existingStatus.status === 'running') {
    let alive = false
    try { process.kill(existingStatus.pid, 0); alive = true } catch {}
    if (alive) {
      console.error(`ERROR: Orchestrator already running (pid=${existingStatus.pid}, run=${existingStatus.runId}). Kill it first.`)
      process.exit(1)
    }
    log(`Stale train-status.json found (pid=${existingStatus.pid}, status=running but not alive). Overwriting.`)
  }

  // === 起動モード選択 (checkpointBase + resume/ppoRestart を決定) ===
  await selectStartMode(config)

  process.title = `fenrir-orch [${config.checkpointBase}]`

  // === Shutdown handling ===
  let shutdownRequested = 0  // 0=none, >0=exit code
  let runId = ''     // set below after runId is determined
  let gitSha = ''    // set below after git info is fetched
  const shutdownCleanup = (reason: string) => {
    if (runId) {
      appendTrainHistory({ event: 'shutdown', time: new Date().toISOString(), runId, pid: process.pid, reason })
      writeTrainStatus({ status: 'stopped', runId, checkpointBase: config.checkpointBase, pid: process.pid, gitSha, updated: new Date().toISOString() })
    }
    terminateGameWorkerPool()
  }
  const requestShutdown = (code: number) => {
    if (shutdownRequested) {
      log(`\nForce shutdown (second signal)`)
      shutdownCleanup(code === 130 ? 'SIGINT' : 'SIGTERM')
      process.exit(code)
    }
    shutdownRequested = code
    process.stderr.write(`\nShutdown requested, will exit after current operation...\n`)
  }
  const checkShutdown = () => {
    if (!shutdownRequested) return
    log(`Shutting down...`)
    shutdownCleanup(shutdownRequested === 130 ? 'SIGINT' : 'SIGTERM')
    process.exit(shutdownRequested)
  }
  process.on('SIGINT', () => requestShutdown(130))
  process.on('SIGTERM', () => requestShutdown(143))

  // === Git 情報 ===
  gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  let gitDirty = false
  try { execSync('git diff --quiet HEAD', { encoding: 'utf-8' }); gitDirty = false } catch { gitDirty = true }
  log(`${BOLD}Fenrir Training Orchestrator (round-robin)${RESET}`)
  log(`Git: ${gitSha}${gitDirty ? ' (dirty)' : ''} | ${new Date().toISOString()}`)
  log(`Architecture: Transformer${config.strategyOnly ? ' (strategy-only)' : ''}`)
  log(`Iterations: ${config.iterations}/model, Chunk: ${config.chunkSize}, Batch: ${config.batch}`)
  log(`DESIGNATION_DEBUG=${process.env.DESIGNATION_DEBUG ?? '(unset)'}`)

  // === Run ID + Status + History + Progress ===
  const existingProgress = readTrainProgress(config.checkpointBase)
  runId = config.resume && existingProgress?.runId
    ? existingProgress.runId
    : generateRunId(config.checkpointBase)

  const startMode = config.ppoRestart ? 'ppo_restart' : config.resume ? 'resumed' : 'new'
  writeTrainStatus({ status: 'running', runId, checkpointBase: config.checkpointBase, pid: process.pid, gitSha, updated: new Date().toISOString() })
  appendTrainHistory({ event: 'started', time: new Date().toISOString(), runId, checkpointBase: config.checkpointBase, gitSha, pid: process.pid, mode: startMode })

  const arch = `Transformer${config.strategyOnly ? ' (strategy-only)' : ''}`
  const configSummary = `batch=${config.batch}, lr=${config.learningRate}, evalInterval=${config.evalInterval}, chunkSize=${config.chunkSize}, workers=${config.workers}`
  const progress: TrainProgress = {
    runId,
    checkpointBase: config.checkpointBase,
    runInfo: {
      started: existingProgress?.runInfo.started ?? new Date().toISOString(),
      gitSha,
      arch,
      configSummary,
    },
    curriculum: existingProgress?.curriculum ?? [],
    evals: existingProgress?.evals ?? [],
    latest: { phase: 'init', model: '-', iter: 0, maxIter: config.iterations, updated: new Date().toISOString() },
  }
  writeTrainProgress(progress)

  const trainingConfig: TrainingConfig = {
    ...DEFAULT_TRAINING_CONFIG,
    gamesPerBatch: config.batch,
    enableRetar: !config.noRetar,
    learningRate: config.learningRate,
    rewardConfig: DEFAULT_REWARD_CONFIG,
    strategyOnly: config.strategyOnly,
    miniBatchSize: config.miniBatchSize ?? DEFAULT_TRAINING_CONFIG.miniBatchSize,
  }

  // === ネットワーク作成 ===
  // 推論用 (Pure JS, CPU): モデルごとに1つ
  const networks = new Map<ModelName, AnyNetwork>()
  for (const name of MODEL_NAMES) networks.set(name, createNetwork())

  // チーム推論用
  const wolfTeamNet = createWolfTeamNetwork()
  const masonTeamNet = createMasonTeamNetwork()

  // 学習用 (TF.js GPU): 1セットだけ — 重みをスワップして共有
  const tfNetwork = createTfNetwork(config.learningRate)
  const wolfTeamTf = createWolfTeamTfNetwork(config.learningRate)
  const masonTeamTf = createMasonTeamTfNetwork(config.learningRate)

  log(`Individual NN: ${networks.values().next().value!.totalParams} params × 6 (CPU)`)
  log(`TfNN: 1 shared (GPU)`)

  // === ゲーム生成ワーカープール ===
  if (config.workers !== 0) {
    initGameWorkerPool(config.workers === -1 ? undefined : config.workers)
  }

  // === WRE PBRS ===
  let wreSharedWeights: WreSharedWeights | undefined
  if (config.wre) {
    if (!existsSync(config.wre)) {
      log(`WRE checkpoint not found: ${config.wre}`)
      process.exit(1)
    }
    const wreNet = new WinrateNetwork()
    loadWinrateCheckpoint(wreNet, config.wre)
    wreSharedWeights = packWreWeights(wreNet)
    log(`WRE PBRS enabled: ${wreNet.totalParams} params from ${config.wre}`)
  }

  // WRE再学習: PPOゲーム結果からWREを更新する関数
  // ゲーム結果全体ではなく抽出済みサンプル (observation + label) のみバッファに蓄積
  // ゲーム結果をそのまま溜めると observation の number[] が 43MB/iter 蓄積して OOM になる
  const MAX_WRE_BUFFER_MB = 1024  // バッファ上限 1GB
  if (config.wreRefresh > 0 && wreSharedWeights) {
    // 1 iter あたり推定サンプル数: batch × seats × ~5 steps
    const estimatedSamplesPerIter = config.batch * 14 * 5
    const bytesPerSample = 1209 * 4 + 3 * 4  // Float32Array(observation) + Float32Array(label)
    const estimatedBufferMB = (config.wreRefresh * estimatedSamplesPerIter * bytesPerSample) / (1024 * 1024)
    if (estimatedBufferMB > MAX_WRE_BUFFER_MB) {
      const maxRefresh = Math.floor(MAX_WRE_BUFFER_MB / (estimatedSamplesPerIter * bytesPerSample / (1024 * 1024)))
      throw new Error(
        `--wre-refresh ${config.wreRefresh} would accumulate ~${estimatedBufferMB.toFixed(0)}MB in WRE sample buffer (limit: ${MAX_WRE_BUFFER_MB}MB). ` +
        `Reduce to --wre-refresh ${maxRefresh} or less.`,
      )
    }
  }
  const wreSampleBuffer: { observations: Float32Array[], labels: Float32Array[] } = { observations: [], labels: [] }
  let wreRefreshCounter = 0
  async function maybeRefreshWre(
    gameResults: Array<{ individualSteps: Array<{ role: string, steps: Array<{ observation: number[] }> }>, result: string }>,
  ): Promise<void> {
    if (!wreSharedWeights || config.wreRefresh <= 0) return
    const { observations, labels } = extractWreSamplesFromGameResults(gameResults)
    wreSampleBuffer.observations.push(...observations)
    wreSampleBuffer.labels.push(...labels)
    wreRefreshCounter++
    if (wreRefreshCounter < config.wreRefresh) return

    // 再学習サイクル実行
    wreRefreshCounter = 0
    const bufObs = wreSampleBuffer.observations
    const bufLabels = wreSampleBuffer.labels
    wreSampleBuffer.observations = []
    wreSampleBuffer.labels = []

    if (bufObs.length < 100) {
      log(`WRE refresh skipped: only ${bufObs.length} samples (need ≥100)`)
      return
    }

    log(`WRE refresh: ${bufObs.length} samples from recent games...`)
    const { TfWinrateNetwork } = await import('./ml/nn-tf-winrate.ts')
    const tfWre = new TfWinrateNetwork(wreSharedWeights!.config, 3e-4)
    // 現在の重みをロードして fine-tune (warm start)
    const currentWeights = new Map<string, Float32Array>()
    for (const [name, arr] of Object.entries(wreSharedWeights!.weights)) {
      currentWeights.set(name, new Float32Array(arr))
    }
    tfWre.loadWeights(currentWeights)

    // 5 epochs の fine-tune
    const batchSize = 256
    const epochs = 5
    for (let e = 0; e < epochs; e++) {
      let totalLoss = 0, batches = 0
      for (let i = 0; i < bufObs.length; i += batchSize) {
        const end = Math.min(i + batchSize, bufObs.length)
        const { loss } = tfWre.trainBatch(
          bufObs.slice(i, end),
          bufLabels.slice(i, end),
          2.0,
        )
        totalLoss += loss
        batches++
      }
      if (e === epochs - 1) log(`  WRE refresh epoch ${e + 1}: loss=${(totalLoss / batches).toFixed(4)}`)
    }

    // 更新された重みをpackして配布
    const updatedNet = new WinrateNetwork(wreSharedWeights!.config)
    const cloned = tfWre.cloneWeights()
    updatedNet.loadWeights(cloned)
    wreSharedWeights = packWreWeights(updatedNet)

    // チェックポイント保存
    const wreCkptPath = `${config.checkpointBase}/wre-latest.json`
    saveWinrateCheckpoint(updatedNet, wreSharedWeights!.config, wreCkptPath, {
      epoch: 0, brierScore: 0, trainGames: bufObs.length,
    })

    tfWre.dispose()
    log(`WRE refresh done: weights updated, saved to ${wreCkptPath}`)
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

  // PPO restart: 重みはロード済みだが iter は 0 からやり直す
  if (config.ppoRestart) {
    for (const name of MODEL_NAMES) iterCounts.set(name, 0)
    log('PPO restart: all iterCounts reset to 0')
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
  if (anyResumed) {
    const ppoLr = config.learningRate * 0.2
    ;(tfNetwork as any).setLearningRate(ppoLr)
    ;(wolfTeamTf as any).setLearningRate?.(ppoLr)
    ;(masonTeamTf as any).setLearningRate?.(ppoLr)
    log(`  PPO learning rate: ${ppoLr.toExponential(1)}`)
  }

  // === Pretrain: plan tokens の事前学習 (新規学習時のみ) ===
  if (!anyResumed) {
    const pretrainBatchSize = 512
    const pretrainLogInterval = 100
    const pretrainSnapshots: PretrainSnapshot[] = []

    // Hati 詰みデータの読み込み: DB → キャッシュ → runtime 収集の優先順
    const totalPlayers = Object.values(trainingConfig.roles).reduce((a: number, b: number) => a + b, 0)
    const tsumiDbDir = `data/tsumi-db/${totalPlayers}p`
    const tsumiCachePath = `${config.checkpointBase}/tsumi-pretrain-cache.ndjson`
    let tsumiSamples = loadTsumiFromDB(tsumiDbDir, log)
    if (tsumiSamples.length === 0) {
      tsumiSamples = loadTsumiCache(tsumiCachePath)
      if (tsumiSamples.length > 0) {
        log(`  Loaded ${tsumiSamples.length} cached tsumi samples (no DB)`)
      }
    }
    if (tsumiSamples.length === 0) {
      const tsumiGames = config.skeleton ? 10 : 500
      log(`  No DB or cache found. Collecting tsumi from ${tsumiGames} games...`)
      const tT0 = performance.now()
      tsumiSamples = await collectTsumiBatch(trainingConfig, tsumiGames, 80000, log)
      log(`  Collected ${tsumiSamples.length} tsumi samples in ${((performance.now() - tT0) / 1000).toFixed(1)}s`)
      if (tsumiSamples.length > 0) {
        saveTsumiCache(tsumiSamples, tsumiCachePath)
        log(`  Cached to ${tsumiCachePath}`)
      }
    }
    const tsumiRatio = tsumiSamples.length > 0 ? 0.3 : 0

    // === Pretrain B2 (先): Plan 構造 (NEXT 配置) の教師あり学習 ===
    // B2 を先に実行して NEXT/STOP 文法を学び、B で席ターゲットを上書きする。
    // B が最後なので seat logits のマージンが保たれ、explore 時に STOP に負けない。
    log(`${BOLD}=== Pretrain B2: Plan Structure (NEXT placement) ===${RESET}`)
    const tB2_0 = performance.now()
    const b2MaxEpochs = config.skeleton ? 2 : 500
    const b2TargetNextAcc = config.skeleton ? 0 : 0.80
    let b2BestNextAcc = 0
    const probeSamplesB2 = generateStructurePretrainBatch(8, 199999)
    for (let epoch = 1; epoch <= b2MaxEpochs; epoch++) {
      await new Promise(r => setTimeout(r, 0))
      checkShutdown()
      const structSamples = generateStructurePretrainBatch(pretrainBatchSize, epoch + 100000)
      const { loss, accuracy, nextAccuracy, stopAccuracy } = (tfNetwork as any).trainSupervisedPlan({
        observations: structSamples.map(s => s.observation),
        labels: structSamples.map(s => s.forwardLabels),
        masks: structSamples.map(s => s.forwardMask),
        numTokens: structSamples[0].forwardLabels.length,
        vocabSize: PLAN_VOCAB.SIZE,
      })
      if (nextAccuracy > b2BestNextAcc) b2BestNextAcc = nextAccuracy
      if (epoch % pretrainLogInterval === 0 || epoch === 1) {
        log(`  epoch=${epoch} loss=${loss.toFixed(4)} acc=${(accuracy * 100).toFixed(1)}% next=${(nextAccuracy * 100).toFixed(1)}% stop=${(stopAccuracy * 100).toFixed(1)}%`)
      }
      if (SNAPSHOT_EPOCHS_B2.has(epoch)) {
        const villageNet = networks.get('village' as ModelName)
        if (villageNet) pretrainSnapshots.push(capturePlanSnapshot('B2', epoch, { loss, accuracy, nextAccuracy, stopAccuracy }, probeSamplesB2, villageNet, tfNetwork))
      }
      if (nextAccuracy >= b2TargetNextAcc) {
        log(`  NEXT accuracy ${(b2TargetNextAcc * 100).toFixed(0)}% reached at epoch ${epoch}`)
        break
      }
    }
    log(`  B2 complete: ${(b2BestNextAcc * 100).toFixed(1)}% NEXT, ${((performance.now() - tB2_0) / 1000).toFixed(1)}s`)

    // === Pretrain B (後): Plan Token 席ターゲットの教師あり学習 ===
    // B2 の NEXT 構造をベースに、人外の席を指すパターンを学ぶ。
    // 終了条件に seat accuracy を追加: explore で STOP に負けないマージンを保証。
    log(`${BOLD}=== Pretrain B: Plan Token Supervised Learning ===${RESET}`)
    const tB0 = performance.now()
    const pretrainMaxEpochs = config.skeleton ? 2 : 1000
    const pretrainTargetAcc = config.skeleton ? 0 : 0.85
    const pretrainNextTargetAcc = 0.60
    const pretrainSeatTargetAcc = config.skeleton ? 0 : 0.15

    let bestAcc = 0
    let bestNextAcc = 0
    let bestSeatAcc = 0
    // Fixed probe samples for snapshot comparison (same input across all epochs)
    const probeSamplesB = generatePlanTokenTrainingBatch(8, 99999, tsumiSamples, tsumiRatio)
    for (let epoch = 1; epoch <= pretrainMaxEpochs; epoch++) {
      await new Promise(r => setTimeout(r, 0))  // yield to event loop for signal handling
      checkShutdown()
      const samples = generatePlanTokenTrainingBatch(pretrainBatchSize, epoch, tsumiSamples, tsumiRatio)
      const { loss, accuracy, nextAccuracy, stopAccuracy, seatAccuracy } = (tfNetwork as any).trainSupervisedPlan({
        observations: samples.map(s => s.observation),
        labels: samples.map(s => s.forwardLabels),
        masks: samples.map(s => s.forwardMask),
        numTokens: samples[0].forwardLabels.length,
        vocabSize: PLAN_VOCAB.SIZE,
      })
      if (accuracy > bestAcc) bestAcc = accuracy
      if (nextAccuracy > bestNextAcc) bestNextAcc = nextAccuracy
      if (seatAccuracy > bestSeatAcc) bestSeatAcc = seatAccuracy
      if (epoch % pretrainLogInterval === 0 || epoch === 1) {
        log(`  epoch=${epoch} loss=${loss.toFixed(4)} acc=${(accuracy * 100).toFixed(1)}% next=${(nextAccuracy * 100).toFixed(1)}% stop=${(stopAccuracy * 100).toFixed(1)}% seat=${(seatAccuracy * 100).toFixed(1)}% best=${(bestAcc * 100).toFixed(1)}%`)
      }
      if (SNAPSHOT_EPOCHS_B.has(epoch)) {
        const villageNet = networks.get('village' as ModelName)
        if (villageNet) pretrainSnapshots.push(capturePlanSnapshot('B', epoch, { loss, accuracy, nextAccuracy, stopAccuracy }, probeSamplesB, villageNet, tfNetwork))
      }
      if (accuracy >= pretrainTargetAcc && nextAccuracy >= pretrainNextTargetAcc && seatAccuracy >= pretrainSeatTargetAcc) {
        log(`  Target acc=${(pretrainTargetAcc * 100).toFixed(0)}% + NEXT=${(pretrainNextTargetAcc * 100).toFixed(0)}% + seat=${(pretrainSeatTargetAcc * 100).toFixed(0)}% reached at epoch ${epoch}`)
        break
      }
    }
    // pretrain 済みの重みを village の推論用 NN にコピー（B2 + B の結果）
    const villageNet = networks.get('village' as ModelName)
    if (villageNet) {
      villageNet.loadWeights(tfNetwork.cloneWeights())
      log(`  Pretrained weights → village network`)
    }
    log(`  Method B complete: ${(bestAcc * 100).toFixed(1)}% acc, ${(bestNextAcc * 100).toFixed(1)}% NEXT, ${(bestSeatAcc * 100).toFixed(1)}% seat, ${((performance.now() - tB0) / 1000).toFixed(1)}s`)

    // === Method D: 実ゲームで predict + value の事前学習 ===
    log(`${BOLD}=== Pretrain D: Heuristic Game Supervised Learning ===${RESET}`)
    const pretrainGames = config.skeleton ? 5 : 100
    const pretrainDEpochs = config.skeleton ? 2 : 30

    log(`  Collecting data from ${pretrainGames} heuristic games...`)
    const tD0 = performance.now()
    const gameSamples = await collectBatchGameData(trainingConfig, pretrainGames, 50000, checkShutdown)
    const tDCollect = performance.now() - tD0
    log(`  Collected ${gameSamples.length} vote samples from ${pretrainGames} games in ${(tDCollect / 1000).toFixed(1)}s (${(tDCollect / pretrainGames).toFixed(0)}ms/game)`)

    if (gameSamples.length > 0) {
      const dMiniBatch = 256
      const probeSamplesD = gameSamples.slice(0, 8)
      for (let epoch = 1; epoch <= pretrainDEpochs; epoch++) {
        await new Promise(r => setTimeout(r, 0))
        checkShutdown()
        let epochPredLoss = 0, epochValLoss = 0
        let batchCount = 0

        for (let offset = 0; offset < gameSamples.length; offset += dMiniBatch) {
          checkShutdown()
          const batch = gameSamples.slice(offset, offset + dMiniBatch)

          // plan は B で学習済み。D では predict + value のみ学習（plan 上書き防止）
          const multiResult = (tfNetwork as any).trainSupervisedMulti({
            observations: batch.map(s => s.observation),
            predictLabels: batch.map(s => s.predictLabel),
            valueLabels: batch.map(s => s.valueLabel),
          })

          epochPredLoss += multiResult.predictLoss
          epochValLoss += multiResult.valueLoss
          batchCount++
        }

        if ((epoch % 5 === 0 || epoch === 1) && batchCount > 0) {
          log(`  epoch=${epoch} pred_loss=${(epochPredLoss / batchCount).toFixed(4)} val_loss=${(epochValLoss / batchCount).toFixed(4)}`)
        }
        if (SNAPSHOT_EPOCHS_D.has(epoch) && batchCount > 0) {
          const villageNet = networks.get('village' as ModelName)
          if (villageNet) pretrainSnapshots.push(captureGameSnapshot(epoch, { predictLoss: epochPredLoss / batchCount, valueLoss: epochValLoss / batchCount }, probeSamplesD, villageNet, tfNetwork))
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

    // Pretrain スナップショット保存
    savePretrainSnapshots(pretrainSnapshots, config.checkpointBase)

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
  const refNetwork: AnyNetwork = createNetwork()
  const villageNet = networks.get('village' as ModelName)
  if (villageNet) refNetwork.loadWeights(villageNet.cloneWeights())
  log(`Reference network created from current village weights (KL anchor)`)

  log(`Baseline (hardcoded): ${Object.entries(BASELINE_RATES).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')}`)

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
      const masonNet = createNetwork()
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
      log(`  Agent assignment: ${formatAssignment({ village: 'heuristic', wolf_collective: 'heuristic', mason_collective: 'heuristic', fanatic: 'heuristic', third: 'heuristic' })}`)

      // Mason individual uses the same architecture as village
      const masonNet = createNetwork()
      const masonTf = createTfNetwork(config.learningRate * 0.2)

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
      // KL reference network
      const masonRefNetwork = createNetwork()
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

      const masonTargetRate = BASELINE_RATES['villager_won'] ?? 0.55
      const prefix = `\x1b[36m[mason_ind ]${RESET}`
      mkdirSync(masonDir, { recursive: true })
      let graduated = false
      let iterElapsed = 0
      let iterCount = 0

      for (let iter = masonIter + 1; iter <= config.iterations && !graduated; iter++) {
        checkShutdown()
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
          agentAssignment: {
            village: 'heuristic', wolf_collective: 'heuristic',
            mason_collective: 'heuristic', fanatic: 'heuristic', third: 'heuristic',
          },
          trainingConfig,
          phase: 1,
          mlRoles: masonMlRoles,
          mlMaxSeats: 1,
          mlStartDay: (!batchSnapshots) ? masonMlStartDay : undefined,
          snapshots: batchSnapshots,
          inspectSeeds: inspectSeeds.length > 0 ? inspectSeeds : undefined,
          enableMasonTakeover: true,
          wreWeights: wreSharedWeights,
        }, seeds)
        if (inspectSeeds.length > 0) saveInspectGames(serializedResults, 'mason_individual', masonIter, { gitSha, runId, checkpointBase: config.checkpointBase })

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
        let lastPpoResult = { policyLoss: 0, valueLoss: 0, entropy: 0, predictLoss: 0, klLoss: 0, klPlanLoss: 0 }
        if (allSteps.length > 0) {
          normalizeAdvantages(allSteps)

          let precomputedRefLogits: Map<ProcessedStep, { plan?: Float32Array }> | undefined
          if (masonRefNetwork && masonPpoConfig.klCoeff > 0) {
            precomputedRefLogits = new Map()
            for (const step of allSteps) {
              if (step.actionHead === 'strategy') {
                const { refPlanLogits } = computeRefPlanLogits(masonRefNetwork, step.observation)
                precomputedRefLogits.set(step, { plan: refPlanLogits })
              }
            }
          }

          masonTf.loadWeights(masonNet.cloneWeights())
          const klEarlyStopThreshold = klTargetForIter(iter) * 2
          for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
            lastPpoResult = ppoUpdate(masonTf, allSteps, masonPpoConfig, precomputedRefLogits)
            if (lastPpoResult.klLoss > klEarlyStopThreshold) break
          }
          masonNet.loadWeights(masonTf.cloneWeights())
        }

        // Adaptive KL
        if (masonPpoConfig.klCoeff > 0 && lastPpoResult.klLoss > 0) {
          const klTarget = klTargetForIter(iter)
          const { band, adjustRate, range: [klMin, klMax] } = DEFAULT_KL_CONFIG
          if (lastPpoResult.klLoss > klTarget * band) {
            masonPpoConfig.klCoeff *= adjustRate
          } else if (lastPpoResult.klLoss < klTarget / band) {
            masonPpoConfig.klCoeff /= adjustRate
          }
          masonPpoConfig.klCoeff = Math.max(klMin, Math.min(klMax, masonPpoConfig.klCoeff))
        }
        appendKlLog(config.checkpointBase, {
          iter, klPlan: lastPpoResult.klPlanLoss,
          klTotal: lastPpoResult.klLoss, beta: masonPpoConfig.klCoeff, klTarget: klTargetForIter(iter),
        })

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
            { ...(evalSnapshots ? { snapshots: evalSnapshots } : {}), masonAsIndividual: true, evalIter: iter, saveHowl: true },
          )
          process.stderr.write('\r\x1b[K')
          if (evalResult.howlGames) saveEvalHowl(config.checkpointBase, iter, evalResult.howlGames)
          appendEvalLog(masonDir, iter, evalResult, 'mason_individual', {
            klLoss: lastPpoResult.klLoss, klCoeff: masonPpoConfig.klCoeff,
            policyLoss: lastPpoResult.policyLoss, valueLoss: lastPpoResult.valueLoss, entropy: lastPpoResult.entropy,
          })
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
          writeTrainProgress(progress)

          const MASON_MIN_ITER = 300
          // Day カリキュラム: 勝率達成で Day をデクリメント
          if (iter >= MASON_MIN_ITER && factionRate >= masonTargetRate * 0.9) {
            if (masonMlStartDay > ML_START_DAY_MIN_MASON) {
              const prevDay = masonMlStartDay
              masonMlStartDay--
              log(`${prefix} Curriculum: masonMlStartDay ${prevDay} → ${masonMlStartDay}`)
              progress.curriculum.push({ time: new Date().toISOString(), iter, mlMaxSeats: 1, mlStartDay: masonMlStartDay, event: `mason day ${prevDay}→${masonMlStartDay}` })
              masonSnapshotCount = refreshMasonSnapshotCount()
            }
          }
          // minIter 到達で卒業
          if (iter >= MASON_MIN_ITER) {
            log(`${prefix} ${BOLD}GRADUATED${RESET} (iter ${iter} >= ${MASON_MIN_ITER})`)
            graduated = true
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
    log(`  Agent assignment: ${formatAssignment({ village: 'neural', wolf_collective: 'heuristic', mason_collective: 'frozen', fanatic: 'heuristic', third: 'heuristic' })}`)

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
    const VILLAGE_MIN_ITER = 300
    const phase1Models: ModelName[] = ['village']
    // wolf/third は即 graduated 扱い
    for (const name of MODEL_NAMES) {
      if (!phase1Models.includes(name)) graduated.add(name)
    }
    // Resume: minIter 到達済みなら即卒業
    for (const name of phase1Models) {
      if (iterCounts.get(name)! >= VILLAGE_MIN_ITER) {
        log(`  ${COLORS[name]}${name}${RESET}: already at iter ${iterCounts.get(name)!} >= ${VILLAGE_MIN_ITER}, skipping`)
        graduated.add(name)
      }
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
        const targetRate = config.targetWinRate ?? (BASELINE_RATES[group.faction] ?? 0.5)

        const prefix = `${COLORS[name]}[${name.padEnd(10)}]${RESET}`

        // チャンク学習
        let iterElapsed = 0
        let iterCount = 0

        for (let iter = currentIter + 1; iter <= targetIter; iter++) {
          checkShutdown()
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
            agentAssignment: {
              village: 'neural', wolf_collective: 'heuristic',
              mason_collective: 'frozen', fanatic: 'heuristic', third: 'heuristic',
            },
            wolfTeamWeights: sharedWolfWeights,
            masonTeamWeights: sharedMasonWeights,
            trainingConfig,
            phase: 1,
            mlRoles: group.roles,
            mlMaxSeats: name === 'village' ? mlMaxSeats : undefined,
            mlStartDay: (!batchSnapshots && name === 'village') ? mlStartDay : undefined,
            snapshots: batchSnapshots,
            frozenMasonWeights: name === 'village' ? frozenMasonWeights : undefined,
            inspectSeeds: inspectSeeds.length > 0 ? inspectSeeds : undefined,
            wreWeights: wreSharedWeights,
          }, seeds)
          if (inspectSeeds.length > 0) saveInspectGames(serializedResults, name, iter, { gitSha, runId, checkpointBase: config.checkpointBase })

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
          let lastPpoResult = { policyLoss: 0, valueLoss: 0, entropy: 0, predictLoss: 0, klLoss: 0, klPlanLoss: 0 }
          if (allIndividual.length > 0) {
            normalizeAdvantages(allIndividual)

            // Reference logits を iteration あたり1回だけ計算（epoch/minibatch をまたいで再利用）
            let precomputedRefLogits: Map<ProcessedStep, { plan?: Float32Array }> | undefined
            if (refNetwork && ppoConfig.klCoeff && ppoConfig.klCoeff > 0) {
              precomputedRefLogits = new Map()
              for (const step of allIndividual) {
                if (step.actionHead === 'strategy') {
                  const { refPlanLogits } = computeRefPlanLogits(refNetwork, step.observation)
                  precomputedRefLogits.set(step, { plan: refPlanLogits })
                }
              }
            }

            tfNetwork.loadWeights(network.cloneWeights())
            const klEarlyStopThreshold = klTargetForIter(iter) * 2
            for (let epoch = 0; epoch < trainingConfig.ppoEpochs; epoch++) {
              lastPpoResult = ppoUpdate(tfNetwork, allIndividual, ppoConfig, precomputedRefLogits)
              if (lastPpoResult.klLoss > klEarlyStopThreshold) break
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

          // Adaptive KL
          if (ppoConfig.klCoeff > 0 && lastPpoResult.klLoss > 0) {
            const klTarget = klTargetForIter(iter)
            const { band, adjustRate, range: [klMin, klMax] } = DEFAULT_KL_CONFIG
            if (lastPpoResult.klLoss > klTarget * band) {
              ppoConfig.klCoeff *= adjustRate
            } else if (lastPpoResult.klLoss < klTarget / band) {
              ppoConfig.klCoeff /= adjustRate
            }
            ppoConfig.klCoeff = Math.max(klMin, Math.min(klMax, ppoConfig.klCoeff))
          }
          appendKlLog(config.checkpointBase, {
            iter, klPlan: lastPpoResult.klPlanLoss,
            klTotal: lastPpoResult.klLoss, beta: ppoConfig.klCoeff, klTarget: klTargetForIter(iter),
          })

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
            const evalResult = await evaluate(network, evalConfig, config.evalGames, wolfTeamNet, masonTeamNet, evalMlMax, { ...(evalSnapshots ? { snapshots: evalSnapshots } : {}), evalIter: iter, frozenMasonNet: name === 'village' ? frozenMasonNet : undefined, saveHowl: true })
            process.stderr.write('\r\x1b[K')
            if (evalResult.howlGames) saveEvalHowl(config.checkpointBase, iter, evalResult.howlGames)
            appendEvalLog(`${config.checkpointBase}/ckpt-${name}`, iter, evalResult, name, {
              klLoss: lastPpoResult.klLoss, klCoeff: ppoConfig.klCoeff,
              policyLoss: lastPpoResult.policyLoss, valueLoss: lastPpoResult.valueLoss, entropy: lastPpoResult.entropy,
            })
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
              ppoMetrics: { ...lastPpoResult }, baseline: BASELINE_RATES[group.faction], target: targetRate,
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

            writeTrainProgress(progress)

            if (iter >= VILLAGE_MIN_ITER) {
              log(`${prefix} ${BOLD}GRADUATED${RESET} (iter ${iter} >= ${VILLAGE_MIN_ITER})`)
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
    writeTrainProgress(progress)
  }

  // === Phase 1': 集団NN + 狂信者 + 第三勢力の学習 (frozen村NN注入) ===
  if (!config.phase2Only) {
    log(`${BOLD}=== Phase 1': Collective + Non-Village Training ===${RESET}`)
    log(`  Agent assignment: ${formatAssignment({ village: 'frozen', wolf_collective: 'neural', mason_collective: 'neural', fanatic: 'neural', third: 'neural' })}`)
    progress.latest = { phase: "1'", model: '-', iter: 0, maxIter: config.iterations }
    writeTrainProgress(progress)

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
      // minIter 到達済みなら即卒業
      const PHASE1P_MIN_ITER_RESUME = 300
      for (const name of phase1PrimeModels) {
        if (!phase1PrimeGraduated.has(name) && phase1PrimeIterCounts.get(name)! >= PHASE1P_MIN_ITER_RESUME) {
          log(`  ${COLORS[name]}${name}${RESET}: already at iter ${phase1PrimeIterCounts.get(name)!} >= ${PHASE1P_MIN_ITER_RESUME}, skipping`)
          phase1PrimeGraduated.add(name)
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

        let lastPpoResult1p = { policyLoss: 0, valueLoss: 0, entropy: 0, predictLoss: 0, klLoss: 0, klPlanLoss: 0 }
        for (let iter = currentIter + 1; iter <= targetIter; iter++) {
          checkShutdown()
          const iterStart = performance.now()
          const seeds = Array.from({ length: config.batch }, (_, g) => (10000 + iter) * config.batch + g)

          // ゲーム生成 (マルチモデルモード)
          const tGameStart = performance.now()
          const allIndividual: ProcessedStep[] = []
          const allWolfCollective: ProcessedStep[] = []
          const allMasonCollective: ProcessedStep[] = []
          let serializedResults: import('./parallel.ts').SerializedGameResult[] = []

          if (gameWorkerPoolSize() > 0) {
            const modelGroupWeights = packAllModelWeights()
            const inspectSeeds = pickInspectSeeds(seeds, config.inspectInterval)
            serializedResults = await generateGamesParallel({
              weights: frozenVillageWeights,  // fallback
              agentAssignment: {
                village: 'frozen', wolf_collective: 'neural',
                mason_collective: 'neural', fanatic: 'neural', third: 'neural',
              },
              modelGroupWeights,
              villageFrozenWeights: frozenVillageWeights,
              trainingConfig,
              phase: 1,
              inspectSeeds: inspectSeeds.length > 0 ? inspectSeeds : undefined,
              wreWeights: wreSharedWeights,
            }, seeds)
            if (inspectSeeds.length > 0) saveInspectGames(serializedResults, `phase1p_${name}`, iter, { gitSha, runId, checkpointBase: config.checkpointBase })

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
          // per-game timing from worker results
          const timings = serializedResults.filter(g => g.timing).map(g => g.timing!)
          const avgGameMs = timings.length > 0 ? timings.reduce((s, t) => s + t.gameMs, 0) / timings.length : 0
          const avgRetarMs = timings.length > 0 ? timings.reduce((s, t) => s + t.retarMs, 0) / timings.length : 0
          const avgInferMs = timings.length > 0 ? timings.reduce((s, t) => s + t.inferMs, 0) / timings.length : 0
          const avgTsumiMs = timings.length > 0 ? timings.reduce((s, t) => s + t.tsumiMs, 0) / timings.length : 0
          process.stderr.write(
            `\r\x1b[K  ${prefix} iter ${iter}/${config.iterations} ` +
            `${(iterMs / 1000).toFixed(1)}s (game${(gameMs / iterMs * 100).toFixed(0)}% ppo${(ppoMs / iterMs * 100).toFixed(0)}%) ` +
            `steps=${totalSteps}` +
            (timings.length > 0 ? ` | avg/game: ${avgGameMs.toFixed(0)}ms (retar=${avgRetarMs.toFixed(0)} infer=${avgInferMs.toFixed(0)} tsumi=${avgTsumiMs.toFixed(0)})` : '')
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
                saveHowl: true,
              },
            )
            process.stderr.write('\r\x1b[K')
            if (evalResult.howlGames) saveEvalHowl(config.checkpointBase, iter, evalResult.howlGames)
            appendEvalLog(`${config.checkpointBase}/ckpt-${name}`, iter, evalResult, name, {
              klLoss: lastPpoResult1p.klLoss, klCoeff: 0,
              policyLoss: lastPpoResult1p.policyLoss, valueLoss: lastPpoResult1p.valueLoss, entropy: lastPpoResult1p.entropy,
            })
            const factionRate = evalResult.winRates[group.faction] ?? 0
            const targetRate = config.targetWinRate ?? (BASELINE_RATES[group.faction] ?? 0.5)
            log(
              `${prefix} [${iter}] ${Object.entries(evalResult.winRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')} ` +
              `avgLen=${evalResult.avgGameLength.toFixed(1)} ${evalResult.avgElapsedMs.toFixed(0)}ms/eval`
            )

            // Progress log: Phase 1' eval
            const evalStatus = factionRate >= targetRate ? 'GRADUATED' : ''
            progress.evals.push({
              time: new Date().toISOString(), model: name, iter,
              winRates: { ...evalResult.winRates }, avgLen: evalResult.avgGameLength, status: evalStatus,
              ppoMetrics: { ...lastPpoResult1p }, baseline: BASELINE_RATES[group.faction], target: targetRate,
              timing: { gameMs, ppoMs, iterMs },
            })
            progress.latest = { phase: "1'", model: name, iter, maxIter: config.iterations }
            writeTrainProgress(progress)

            const PHASE1P_MIN_ITER = 300
            if (iter >= PHASE1P_MIN_ITER) {
              log(`${prefix} ${BOLD}GRADUATED${RESET} (iter ${iter} >= ${PHASE1P_MIN_ITER})`)
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

    log(`${BOLD}=== Phase 1' Complete ===${RESET}`)
    progress.latest = { phase: "1' (complete)", model: '-', iter: config.iterations, maxIter: config.iterations }
    writeTrainProgress(progress)

    // === Phase 2: Self-Play (全5モデル同時学習) — delegated to phase-runner ===
    if (!config.phase1Only) {
      const phase2Step = buildCurriculum().find(s => s.type === 'training' && s.name === 'self_play') as TrainingStep
      const phaseCtx: PhaseRunnerContext = {
        config, trainingConfig, progress, runId, gitSha,
        networks: new Map<string, AnyNetwork>([
          ['village', networks.get('village' as ModelName)!],
          ['wolf_collective', wolfCollectiveNet],
          ['mason_collective', masonCollectiveNet],
          ['fanatic', networks.get('fanatic' as ModelName)!],
          ['third', networks.get('third' as ModelName)!],
        ]),
        tfNetworks: new Map<string, AnyTfNetwork>([
          ['village', tfNetwork],
          ['wolf_collective', wolfCollectiveTf],
          ['mason_collective', masonCollectiveTf],
          ['fanatic', fanaticTf],
          ['third', tfNetwork],
        ]),
        frozenWeights: new Map(),
        frozenNets: new Map(),
        checkShutdown,
        log,
        writeTrainProgress,
        pickInspectSeeds: (seeds) => pickInspectSeeds(seeds, config.inspectInterval),
        saveInspectGames: (results, modelName, iteration) => saveInspectGames(results, modelName, iteration, { gitSha, runId, checkpointBase: config.checkpointBase }),
        saveEvalHowl,
        wreSharedWeights,
        onWreRefresh: wreSharedWeights && config.wreRefresh > 0 ? async (games) => {
          await maybeRefreshWre(games)
          return wreSharedWeights
        } : undefined,
      }
      await runTrainingPhase(phase2Step, phaseCtx)
    }

    // === Cleanup GPU (Phase 1' + Phase 2 共用) ===
    wolfCollectiveTf.dispose()
    masonCollectiveTf.dispose()
    fanaticTf.dispose()
  }

  // === Cleanup GPU ===
  tfNetwork.dispose()
  wolfTeamTf.dispose()
  masonTeamTf.dispose()
  terminateGameWorkerPool()

  log(`${BOLD}All training complete!${RESET}`)
}

main().catch(e => { console.error(e); process.exit(1) })
