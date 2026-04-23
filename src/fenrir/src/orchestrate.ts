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

import type { AnyNetwork, AnyTfNetwork } from './ml/nn.ts'
import {
  MODEL_NAMES, MODEL_GROUPS, BASELINE_RATES,
  type ModelName,
} from './curriculum.ts'
import {
  findCheckpoint,
  runTrainingPhase,
  type TrainProgress, type PhaseRunnerContext,
} from './phase-runner.ts'
import { buildCurriculum, type TrainingStep, type PhaseStep } from './curriculum.ts'
import { DEFAULT_REWARD_CONFIG, BRAIN_BATTLE_REWARD_CONFIG } from './reward.ts'
import { saveCheckpoint, loadCheckpoint } from './ml/checkpoint.ts'
import {
  phaseDir as phaseDirPath,
  phaseCheckpointDir,
  pretrainCheckpointDir,
  phaseDirName,
} from './curriculum.ts'
import { isPhaseDone, findLatestModelCheckpoint } from './phase-runner.ts'
import {
  createNetwork,
  createTfNetwork, createWolfTeamTfNetwork, createMasonTeamTfNetwork,
  createWolfCollectiveNetwork, createMasonCollectiveNetwork,
  createWolfCollectiveTfNetwork, createMasonCollectiveTfNetwork,
  createFanaticNetwork, createFanaticTfNetwork,
  createWolfBrainNetwork, createWolfBrainTfNetwork,
  createMasonBrainNetwork, createMasonBrainTfNetwork,
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
  packWeights, initGameWorkerPool, terminateGameWorkerPool,
  packWreWeights, type WreSharedWeights, type SharedWeights,
} from './parallel.ts'
import { WinrateNetwork } from './ml/winrate-network.ts'
import { loadWinrateCheckpoint, saveWinrateCheckpoint } from './ml/winrate-training.ts'
import { extractWreSamplesFromGameResults } from './ml/winrate-data.ts'
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
  /** WRE再学習間隔 (iteration数、0=再学習無効)。サンプルバッファが batch×14×5×n×4.8KB 蓄積するため batch=64 なら n≤40 推奨 */
  wreRefresh: number
  curriculum: 'default' | 'brain-battle' | 'bb-plus' | 'skoll-pretrain' | 'skoll-zero' | 'huginn' | 'skoll-zero-pretrain'
  /** huginn 専用パラメータ (curriculum === 'huginn' のときのみ参照) */
  huginnScenarios?: string[]
  huginnIterations?: number
  huginnGamesPerIter?: number
  huginnLr?: number
  huginnDModel?: number
  huginnNumLayers?: number
  huginnNumHeads?: number
  huginnDff?: number
  huginnCheckpointInterval?: number
  huginnGreedyEvalEvery?: number
  huginnGreedyEvalGames?: number
  huginnOptimizer?: 'sgd' | 'adam'
  huginnValueLossWeight?: number
  huginnEntropyBonus?: number
  huginnGradClip?: number
  /** skoll-zero カリキュラム専用パラメータ (curriculum === 'skoll-zero' のときのみ参照) */
  skollZeroOutcomeSL?: boolean
  skollZeroKlCoeff?: number
  skollZeroRounds?: number
  skollZeroGamesPerRound?: number
  skollZeroRollouts?: number
  skollZeroStepsPerRound?: number
  skollZeroBatchSize?: number
  /** skoll-zero-pretrain カリキュラム専用パラメータ (Phase 2.5 consolidation) */
  skollzpDataDir?: string
  skollzpBaseline?: string
  skollzpEpochs?: number
  skollzpBatchSize?: number
  skollzpPatience?: number
  skollzpEvalRatio?: number
  skollzpOnlyRole?: string
  skollzpSkipMethods?: string[]
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
  curriculum: 'default' as const,
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
      case '--curriculum': config.curriculum = args[++i] as 'default' | 'brain-battle' | 'bb-plus' | 'skoll-pretrain' | 'skoll-zero' | 'huginn' | 'skoll-zero-pretrain'; break
      case '--huginn-scenario': config.huginnScenarios = args[++i].split(',').map(s => s.trim()).filter(Boolean); break
      case '--huginn-iters': config.huginnIterations = parseInt(args[++i]); break
      case '--huginn-games-per-iter': config.huginnGamesPerIter = parseInt(args[++i]); break
      case '--huginn-lr': config.huginnLr = parseFloat(args[++i]); break
      case '--huginn-dmodel': config.huginnDModel = parseInt(args[++i]); break
      case '--huginn-layers': config.huginnNumLayers = parseInt(args[++i]); break
      case '--huginn-heads': config.huginnNumHeads = parseInt(args[++i]); break
      case '--huginn-dff': config.huginnDff = parseInt(args[++i]); break
      case '--huginn-checkpoint-interval': config.huginnCheckpointInterval = parseInt(args[++i]); break
      case '--huginn-greedy-eval-every': config.huginnGreedyEvalEvery = parseInt(args[++i]); break
      case '--huginn-greedy-eval-games': config.huginnGreedyEvalGames = parseInt(args[++i]); break
      case '--huginn-optimizer': config.huginnOptimizer = args[++i] as 'sgd' | 'adam'; break
      case '--huginn-value-loss-weight': config.huginnValueLossWeight = parseFloat(args[++i]); break
      case '--huginn-entropy-bonus': config.huginnEntropyBonus = parseFloat(args[++i]); break
      case '--huginn-grad-clip': config.huginnGradClip = parseFloat(args[++i]); break
      case '--skoll-zero-outcome-sl': config.skollZeroOutcomeSL = true; break
      case '--skoll-zero-kl-coeff': config.skollZeroKlCoeff = parseFloat(args[++i]); break
      case '--skoll-zero-rounds': config.skollZeroRounds = parseInt(args[++i]); break
      case '--skoll-zero-games': config.skollZeroGamesPerRound = parseInt(args[++i]); break
      case '--skoll-zero-rollouts': config.skollZeroRollouts = parseInt(args[++i]); break
      case '--skoll-zero-steps': config.skollZeroStepsPerRound = parseInt(args[++i]); break
      case '--skoll-zero-batch': config.skollZeroBatchSize = parseInt(args[++i]); break
      case '--skollzp-data-dir': config.skollzpDataDir = args[++i]; break
      case '--skollzp-baseline': config.skollzpBaseline = args[++i]; break
      case '--skollzp-epochs': config.skollzpEpochs = parseInt(args[++i]); break
      case '--skollzp-batch': config.skollzpBatchSize = parseInt(args[++i]); break
      case '--skollzp-patience': config.skollzpPatience = parseInt(args[++i]); break
      case '--skollzp-eval-ratio': config.skollzpEvalRatio = parseFloat(args[++i]); break
      case '--skollzp-role': config.skollzpOnlyRole = args[++i]; break
      case '--skollzp-skip-methods': config.skollzpSkipMethods = args[++i].split(',').map(s => s.trim()).filter(Boolean); break
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
  --curriculum <name>      カリキュラム選択: default | brain-battle | bb-plus | skoll-pretrain | skoll-zero | skoll-zero-pretrain | huginn (default: default)
  --skeleton               最小イテレーションで全パイプラインを通す (プラットフォームバグ検出用)

Huginn 専用 (--curriculum huginn):
  --huginn-scenario <a,b>   シナリオ名 (catalog key、カンマ区切り mix 可)。
                            省略時は catalog 全 scenario を MAX_AGENTS=15 padding で mix 統合学習
                            (1 個の NN、ckpt-huginn/final.json)。実プレイ向け.
                            明示指定時は ckpt-huginn-{name}/ に分離 (個別 scenario 評価向け).
  --huginn-iters <n>        学習 iteration 数 (default: 500)
  --huginn-games-per-iter <n> 1 iter あたりのゲーム数 (default: 32)
  --huginn-lr <f>           学習率 (default: 0.05)
  --huginn-dmodel <n>       モデル次元 (default: 64)
  --huginn-layers <n>       Transformer 層数 (default: 2)
  --huginn-heads <n>        Attention head 数 (default: 4)
  --huginn-dff <n>          FFN 次元 (default: 128)
  --huginn-checkpoint-interval <n>  N iter ごとに iter{N}.json 保存 (default: 0=final のみ)
  --huginn-greedy-eval-every <n>    N iter ごとに greedy eval (default: 0=無効)
  --huginn-greedy-eval-games <n>    greedy eval 1 回あたりのゲーム数 (default: 32)
  --huginn-optimizer <sgd|adam>     オプティマイザ (default: sgd)。adam は lr 小さめ推奨 (1e-3)
  --huginn-value-loss-weight <f>    value loss の重み (default: 1.0)。爆発時は 0.5 / 0.1 等
  --huginn-entropy-bonus <f>        policy entropy 正則化 (default: 0.01)
  --huginn-grad-clip <f>            Global L2 gradient clip norm (default: 0=無効、推奨 1.0-5.0)

Skoll-Zero 専用 (--curriculum skoll-zero):
  --skoll-zero-rounds <n>   学習 round 数 (default: 30)
  --skoll-zero-games <n>    1 round あたりの self-play ゲーム数 (default: 30)
  --skoll-zero-rollouts <n> MCTS rollout 数 (default: 50)
  --skoll-zero-steps <n>    1 round あたりの train step 数 (default: 40)
  --skoll-zero-batch <n>    PPO/SL batch size (default: 32)
  --skoll-zero-outcome-sl   Phase 3 Outcome-weighted SL head 学習を有効化 (default: 無効)
  --skoll-zero-kl-coeff <f> Outcome-SL 時の KL anchor 係数 (default: 0.1、0 で KL 無効)

Skoll-Zero-Pretrain 専用 (--curriculum skoll-zero-pretrain、Phase 2.5 multi-head consolidation):
  --skollzp-data-dir <dir>  Phase 2 収集済 JSONL ディレクトリ (default: tmp/phase2-data-v1)
  --skollzp-baseline <path> Phase 2 single-head summary.json で diff 計算 (default: tmp/phase2-pretrain-v1/summary.json)
  --skollzp-epochs <n>      最大 epoch 数 (default: trainer.ts の DEFAULT_MULTIHEAD_OPTIONS)
  --skollzp-batch <n>       batch size
  --skollzp-patience <n>    early stopping patience
  --skollzp-eval-ratio <f>  eval split 比率
  --skollzp-role <name>     単一役職のみ実行 (debug 用)
  --skollzp-skip-methods <a,b> カンマ区切りで method を除外
  --wre [path]             WRE PBRS reward shaping (default: tmp/winrate/checkpoints/winrate-final.json)
  --wre-refresh <n>        WRE re-training interval in iterations (default: 0=disabled)
                           ⚠ batch×14×5×n×4.8KB がメモリに蓄積。batch=64 なら n≤40 推奨 (≈1GB)
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

    // Wolf/mason team trajectory → timeline
    const addTeamSteps = (steps: typeof game.wolfTeamSteps, label: string) => {
      for (const step of steps) {
        const entry: Record<string, unknown> = {
          seat: step.seat, role: label,
          day: step.day,
          phase: 'day',
          actionHead: step.actionHead,
          actionDescription: describeAction(step.actionHead, step.actionIdx),
          actionIdx: step.actionIdx,
          logProb: step.logProb,
          reward: step.reward,
          value: step.value,
          done: step.done,
        }
        if (step.planActions) {
          entry.plan = {
            indices: step.planActions,
            description: step.planActions.map(describePlanIndex).join(' '),
            groups: parsePlanIndices(step.planActions),
          }
        }
        timeline.push(entry)
      }
    }
    addTeamSteps(game.wolfTeamSteps, 'wolf_team')
    addTeamSteps(game.masonTeamSteps, 'mason_team')

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
  const scanDir = (dir: string) => {
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const data = JSON.parse(readFileSync(`${dir}/${f}`, 'utf-8'))
        const ts = data.metadata?.timestamp as string | undefined
        if (!ts) return
        totalFiles++
        if (!oldest || ts < oldest) oldest = ts
        if (!newest || ts > newest) newest = ts
      } catch { /* corrupt file */ }
    }
  }
  // Pretrain
  const pretrainDir = `${baseDir}/pretrain`
  if (existsSync(pretrainDir)) {
    for (const sub of readdirSync(pretrainDir)) scanDir(`${pretrainDir}/${sub}`)
  }
  // Phases
  const phasesDir = `${baseDir}/phases`
  if (existsSync(phasesDir)) {
    for (const phase of readdirSync(phasesDir)) {
      const pDir = `${phasesDir}/${phase}`
      if (!existsSync(pDir)) continue
      try {
        for (const sub of readdirSync(pDir)) scanDir(`${pDir}/${sub}`)
      } catch {}
    }
  }
  if (totalFiles === 0) return null
  return { oldest, newest, totalFiles }
}

/** PPO チェックポイントを削除し、pretrain だけ残す */
function deletePpoCheckpoints(checkpointBase: string): void {
  const phasesDir = `${checkpointBase}/phases`
  if (existsSync(phasesDir)) rmSync(phasesDir, { recursive: true })
  const evalHowlDir = `${checkpointBase}/eval-howl`
  if (existsSync(evalHowlDir)) rmSync(evalHowlDir, { recursive: true })
  const inspectDir = `${checkpointBase}/inspect`
  if (existsSync(inspectDir)) rmSync(inspectDir, { recursive: true })
  const klLog = `${checkpointBase}/kl_log.jsonl`
  if (existsSync(klLog)) unlinkSync(klLog)
}

/** 全チェックポイントを削除 (pretrain 含む) */
function deleteAllCheckpoints(checkpointBase: string): void {
  deletePpoCheckpoints(checkpointBase)
  const pretrainDir = `${checkpointBase}/pretrain`
  if (existsSync(pretrainDir)) rmSync(pretrainDir, { recursive: true })
  // Legacy cleanup: old flat ckpt-<name>/ dirs
  for (const f of (existsSync(checkpointBase) ? readdirSync(checkpointBase) : [])) {
    if (f.startsWith('ckpt-')) {
      try { rmSync(`${checkpointBase}/${f}`, { recursive: true }) } catch {}
    }
  }
}

/** 指定 phase 以降のフェーズを削除（任意フェーズからの再実行用） */
function deletePhasesFrom(checkpointBase: string, steps: PhaseStep[], fromIdx: number): string[] {
  const removed: string[] = []
  const trainingSteps = steps.filter((s): s is TrainingStep => s.type === 'training')
  for (const step of trainingSteps) {
    const idx = step.phaseIndex ?? 0
    if (idx < fromIdx) continue
    const dir = phaseDirPath(checkpointBase, step)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true })
      removed.push(phaseDirName(step))
    }
  }
  return removed
}

/** 旧レイアウト (<base>/ckpt-*) を検出 */
function hasLegacyLayout(checkpointBase: string): boolean {
  if (!existsSync(checkpointBase)) return false
  for (const f of readdirSync(checkpointBase)) {
    if (f.startsWith('ckpt-')) return true
  }
  return false
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

/** Build the step list for a curriculum name (without running it). */
function listCurriculumPhases(curriculum: OrchestratorConfig['curriculum']): TrainingStep[] {
  const steps = buildCurriculum({ curriculum })
  return steps.filter((s): s is TrainingStep => s.type === 'training')
}

type PhaseStatus = {
  step: TrainingStep
  index: number
  done: boolean
  latestIter: number
  hasCheckpoint: boolean
}

function getPhaseStatuses(checkpointBase: string, curriculum: OrchestratorConfig['curriculum']): PhaseStatus[] {
  const trainingSteps = listCurriculumPhases(curriculum)
  return trainingSteps.map((step, i) => {
    const idx = step.phaseIndex ?? i
    const done = isPhaseDone(checkpointBase, step)
    // Scan the phase dir for any model checkpoint iter
    let latestIter = 0
    let hasCheckpoint = false
    const pDir = phaseDirPath(checkpointBase, step)
    if (existsSync(pDir)) {
      for (const sub of readdirSync(pDir)) {
        if (!sub.startsWith('ckpt-')) continue
        const dir = `${pDir}/${sub}`
        if (!existsSync(dir)) continue
        for (const f of readdirSync(dir)) {
          const m = f.match(/_(\d+)\.json$/)
          if (m) {
            hasCheckpoint = true
            const n = parseInt(m[1])
            if (n > latestIter) latestIter = n
          } else if (f.endsWith('.json')) {
            hasCheckpoint = true
          }
        }
      }
    }
    return { step, index: idx, done, latestIter, hasCheckpoint }
  })
}

function formatPhaseList(statuses: PhaseStatus[]): string[] {
  const lines: string[] = []
  const maxName = Math.max(...statuses.map(s => s.step.name.length), 12)
  for (const s of statuses) {
    const idxStr = String(s.index).padStart(2, '0')
    let status = ''
    if (s.done) status = `${BOLD}\x1b[32m[done]${RESET}`
    else if (s.hasCheckpoint) status = `\x1b[33m[in-progress iter ${s.latestIter}]${RESET}`
    else status = '\x1b[90m[not started]${RESET}'.replace('${RESET}', RESET)
    lines.push(`    [${idxStr}] ${s.step.name.padEnd(maxName)}  ${status}`)
  }
  return lines
}

/** Show status + interactive prompt. Returns nothing; mutates config. */
async function promptForCheckpointAction(config: OrchestratorConfig, checkpointBase: string): Promise<void> {
  const fmtTime = (iso: string) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })

  // Legacy layout detection
  if (hasLegacyLayout(checkpointBase)) {
    log(`${BOLD}\x1b[31m旧レイアウトを検出:${RESET} ${checkpointBase}/ に ckpt-* ディレクトリが直置きされています`)
    log(`  新レイアウト (phases/NN-name/) に移行するには全削除が必要です。`)
    log('')
    log(`  [n] 全削除して新規学習 (pretrain からやり直し)`)
    log(`  [new] 新しいベースで開始`)
    log(`  [q] 中止`)
    const choice = await promptChoice(`  選択 (n/new/Q): `)
    if (choice === 'n') {
      deleteAllCheckpoints(checkpointBase)
      config.checkpointBase = checkpointBase
      log('全チェックポイントを削除しました。')
    } else if (choice === 'new') {
      config.checkpointBase = nextCheckpointBase()
      log(`新しいベースで開始: ${config.checkpointBase}`)
    } else {
      log('中止しました。'); process.exit(0)
    }
    return
  }

  const range = getCheckpointTimeRange(checkpointBase)
  if (!range) {
    config.checkpointBase = checkpointBase
    return
  }

  const statuses = getPhaseStatuses(checkpointBase, config.curriculum)
  const statusForSha = readTrainStatus()
  const rec = detectBreakTag(statusForSha?.gitSha)

  log(`${BOLD}既存ランを検出:${RESET} ${checkpointBase}/`)
  log(`  ファイル数: ${range.totalFiles}`)
  log(`  学習期間: ${fmtTime(range.oldest)} 〜 ${fmtTime(range.newest)}`)
  log(`  curriculum: ${config.curriculum}`)
  log('')
  log(`  ${BOLD}フェーズ状況:${RESET}`)
  for (const line of formatPhaseList(statuses)) log(line)
  log('')
  const recStr = formatRecommendation(rec)
  if (recStr) process.stderr.write(`${BOLD}[orch]${RESET} ${recStr}\n`)

  const latestPhase = [...statuses].reverse().find(s => s.hasCheckpoint || s.done)
  const latestLabel = latestPhase ? `フェーズ ${String(latestPhase.index).padStart(2, '0')}-${latestPhase.step.name}` : '(なし)'

  log(`  [n] 全削除して新規学習 (pretrain からやり直し)`)
  log(`  [new] 新しいベースで新規ラン開始`)
  log(`  [p] pretrain 後から PPO やり直し`)
  log(`  [r] 最新チェックポイントから再開 (${latestLabel})`)
  log(`  [NN] 指定フェーズから再実行 (以降のフェーズを削除)`)
  log(`  [q] 中止`)

  const defaultChoice = rec?.recommended ?? 'q'
  const choice = (await promptChoice(`  選択 (n/new/p/r/NN/Q) [${defaultChoice}]: `) || defaultChoice).trim()
  config.checkpointBase = checkpointBase

  if (choice === 'n') {
    deleteAllCheckpoints(checkpointBase)
    log('全チェックポイントを削除しました。')
    return
  }
  if (choice === 'new') {
    config.checkpointBase = nextCheckpointBase()
    log(`新しいベースで開始: ${config.checkpointBase}`)
    return
  }
  if (choice === 'p') {
    deletePpoCheckpoints(checkpointBase)
    log('PPOチェックポイントを削除しました (pretrain は保持)。')
    config.resume = true
    config.ppoRestart = true
    return
  }
  if (choice === 'r') {
    config.resume = true
    return
  }
  if (/^\d+$/.test(choice)) {
    const fromIdx = parseInt(choice, 10)
    const allSteps = buildCurriculum({ curriculum: config.curriculum })
    const removed = deletePhasesFrom(checkpointBase, allSteps, fromIdx)
    log(`フェーズ ${fromIdx} 以降を削除: ${removed.length > 0 ? removed.join(', ') : '(対象なし)'}`)
    config.resume = true
    return
  }
  log('中止しました。'); process.exit(0)
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

  // --curriculum huginn: 既存 phase UI をスキップ (huginn 独自 layout)。
  // --checkpoint-base 未指定なら train-status.json から前回ベースを拾うか、無ければ新規。
  if (config.curriculum === 'huginn') {
    if (!config.checkpointBase) {
      const status = readTrainStatus()
      if (status?.checkpointBase && existsSync(status.checkpointBase)) {
        config.checkpointBase = status.checkpointBase
        log(`Huginn: using previous base ${config.checkpointBase}`)
      } else {
        config.checkpointBase = nextCheckpointBase()
        log(`Huginn new run: ${config.checkpointBase}`)
      }
    }
    return
  }

  // --curriculum skoll-zero-pretrain: phase runner が final.json ベースで役職粒度 resume を処理する。
  // orchestrate 層ではプロンプトをスキップし、指定または前回 base をそのまま使う。
  if (config.curriculum === 'skoll-zero-pretrain') {
    if (!config.checkpointBase) {
      const status = readTrainStatus()
      if (status?.checkpointBase && existsSync(status.checkpointBase)) {
        config.checkpointBase = status.checkpointBase
        log(`Skoll-Zero-Pretrain: using previous base ${config.checkpointBase}`)
      } else {
        config.checkpointBase = nextCheckpointBase()
        log(`Skoll-Zero-Pretrain new run: ${config.checkpointBase}`)
      }
    } else {
      log(`Skoll-Zero-Pretrain: using ${config.checkpointBase}`)
    }
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

  // --checkpoint-base が明示指定されている場合
  if (config.checkpointBase) {
    await promptForCheckpointAction(config, config.checkpointBase)
    return
  }

  // --checkpoint-base 未指定: train-status.json から前回ベースを取得
  const status = readTrainStatus()
  const previousBase = status?.checkpointBase

  if (previousBase && existsSync(previousBase)) {
    await promptForCheckpointAction(config, previousBase)
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

// ============================================================
// Main
// ============================================================

function validateConfig(config: OrchestratorConfig): void {
  // huginn は fenrir の evalInterval/chunkSize 等の制約を使わない独立カリキュラム.
  // --huginn-scenario 未指定時は catalog 全 scenario を順次学習する (auto-all モード).
  if (config.curriculum === 'huginn') return
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
  appendTrainHistory({ event: 'started', time: new Date().toISOString(), runId, checkpointBase: config.checkpointBase, gitSha, pid: process.pid, mode: startMode, command: process.argv, cwd: process.cwd() })

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

  // === Skoll-Pretrain カリキュラム: 独立パイプライン（PPO 系統一切なし） ===
  if (config.curriculum === 'skoll-pretrain') {
    const { runSkollPretrain } = await import('./skoll-supervised/runner.ts')
    await runSkollPretrain({
      checkpointBase: config.checkpointBase,
      learningRate: config.learningRate,
    })
    shutdownCleanup('completed')
    log(`${BOLD}Skoll Pretrain complete!${RESET}`)
    return
  }

  // === Skoll-Zero カリキュラム: 6 役職 multi-agent self-play + ISMCTS ===
  if (config.curriculum === 'skoll-zero') {
    const { runSkollZero } = await import('../../skoll-zero/phase/runner.ts')
    await runSkollZero({
      checkpointBase: config.checkpointBase,
      learningRate: config.learningRate,
      ...(config.skollZeroOutcomeSL !== undefined ? { enableOutcomeSL: config.skollZeroOutcomeSL } : {}),
      ...(config.skollZeroKlCoeff !== undefined ? { klCoeff: config.skollZeroKlCoeff } : {}),
      ...(config.skollZeroRounds !== undefined ? { rounds: config.skollZeroRounds } : {}),
      ...(config.skollZeroGamesPerRound !== undefined ? { gamesPerRound: config.skollZeroGamesPerRound } : {}),
      ...(config.skollZeroRollouts !== undefined ? { rollouts: config.skollZeroRollouts } : {}),
      ...(config.skollZeroStepsPerRound !== undefined ? { stepsPerRound: config.skollZeroStepsPerRound } : {}),
      ...(config.skollZeroBatchSize !== undefined ? { batchSize: config.skollZeroBatchSize } : {}),
    })
    shutdownCleanup('completed')
    log(`${BOLD}Skoll Zero complete!${RESET}`)
    return
  }

  // === Skoll-Zero-Pretrain カリキュラム: Phase 2.5 multi-head consolidation ===
  if (config.curriculum === 'skoll-zero-pretrain') {
    const { runSkollZeroPretrain } = await import('../../skoll/phase2/phase-runner.ts')
    await runSkollZeroPretrain({
      checkpointBase: config.checkpointBase,
      learningRate: config.learningRate,
      ...(config.skollzpDataDir !== undefined ? { dataDir: config.skollzpDataDir } : {}),
      ...(config.skollzpBaseline !== undefined ? { baselineSummary: config.skollzpBaseline } : {}),
      ...(config.skollzpEpochs !== undefined ? { epochs: config.skollzpEpochs } : {}),
      ...(config.skollzpBatchSize !== undefined ? { batchSize: config.skollzpBatchSize } : {}),
      ...(config.skollzpPatience !== undefined ? { patience: config.skollzpPatience } : {}),
      ...(config.skollzpEvalRatio !== undefined ? { evalRatio: config.skollzpEvalRatio } : {}),
      ...(config.skollzpOnlyRole !== undefined ? { onlyRole: config.skollzpOnlyRole } : {}),
      ...(config.skollzpSkipMethods !== undefined ? { skipMethods: config.skollzpSkipMethods } : {}),
    })
    shutdownCleanup('completed')
    log(`${BOLD}Skoll Zero Pretrain complete!${RESET}`)
    return
  }

  // === Huginn カリキュラム: 独立ループ (fenrir モデル非依存) ===
  if (config.curriculum === 'huginn') {
    const scenarios = config.huginnScenarios ?? []
    const baseHuginnConfig = {
      checkpointBase: config.checkpointBase,
      iterations: config.huginnIterations ?? 500,
      gamesPerIter: config.huginnGamesPerIter ?? 32,
      lr: config.huginnLr ?? 0.05,
      dModel: config.huginnDModel,
      numLayers: config.huginnNumLayers,
      numHeads: config.huginnNumHeads,
      dFf: config.huginnDff,
      seed: 42,
      greedyEvalEvery: config.huginnGreedyEvalEvery,
      greedyEvalGames: config.huginnGreedyEvalGames,
      checkpointInterval: config.huginnCheckpointInterval,
      optimizer: config.huginnOptimizer,
      valueLossWeight: config.huginnValueLossWeight,
      entropyBonus: config.huginnEntropyBonus,
      gradClipNorm: config.huginnGradClip,
      skeleton: config.skeleton,
      log,
    }
    if (scenarios.length === 0) {
      // デフォルト: catalog 全 scenario を MAX_AGENTS padding で mix 統合学習 → 1 個の NN.
      // 結果は ckpt-huginn/final.json (label なし) で、demo の実プレイで使用する.
      const { runHuginnMixedAll } = await import('./huginn-orchestrator.ts')
      runHuginnMixedAll(baseHuginnConfig)
    } else {
      const { runHuginnCurriculum } = await import('./huginn-orchestrator.ts')
      runHuginnCurriculum({ ...baseHuginnConfig, scenarios })
    }
    shutdownCleanup('completed')
    log(`${BOLD}Huginn Training complete!${RESET}`)
    return
  }

  const trainingConfig: TrainingConfig = {
    ...DEFAULT_TRAINING_CONFIG,
    gamesPerBatch: config.batch,
    enableRetar: !config.noRetar,
    learningRate: config.learningRate,
    rewardConfig: DEFAULT_REWARD_CONFIG,
    strategyOnly: config.strategyOnly,
    miniBatchSize: config.miniBatchSize ?? DEFAULT_TRAINING_CONFIG.miniBatchSize,
  }

  // === Brain Battle カリキュラム: 専用パスで早期分岐 ===
  if (config.curriculum === 'brain-battle') {
    // Brain Battle 専用報酬: 狐勝利 -3.0、中間報酬なし
    const bbTrainingConfig: TrainingConfig = { ...trainingConfig, rewardConfig: BRAIN_BATTLE_REWARD_CONFIG }

    const steps = buildCurriculum({ curriculum: 'brain-battle' })
    const bbStep = steps.find(s => s.type === 'training' && s.name === 'brain_battle') as TrainingStep
    if (!bbStep) throw new Error('brain_battle step not found in brain-battle curriculum')

    // Mason brain: direct vote head (Brain Battle 専用)
    const masonNet = createMasonBrainNetwork()
    const masonTf = createMasonBrainTfNetwork(config.learningRate)
    const masonDir = phaseCheckpointDir(config.checkpointBase, bbStep, 'mason_collective')
    const masonCkpt = findCheckpoint(masonDir, 'collective')
    if (masonCkpt) {
      loadCheckpoint(masonNet, masonCkpt.path)
      log(`Mason brain loaded from ${masonCkpt.path} (iter ${masonCkpt.iteration})`)
    } else {
      log(`No mason_collective checkpoint found in ${masonDir}, using random weights`)
    }

    // Wolf brain networks
    const wolfBrainNet = createWolfBrainNetwork()
    const wolfBrainTf = createWolfBrainTfNetwork(config.learningRate)
    log(`Wolf Brain NN: ${wolfBrainNet.totalParams} params`)
    log(`Mason Brain NN: ${masonNet.totalParams} params (vote-head)`)

    // Worker pool
    if (config.workers !== 0) {
      initGameWorkerPool(config.workers === -1 ? undefined : config.workers)
    }

    const bbCtx: PhaseRunnerContext = {
      config, trainingConfig: bbTrainingConfig, progress, runId, gitSha,
      networks: new Map<string, AnyNetwork>([['mason_collective', masonNet]]),
      tfNetworks: new Map<string, AnyTfNetwork>([['mason_collective', masonTf]]),
      frozenWeights: new Map(),
      frozenNets: new Map(),
      wolfBrainNetwork: wolfBrainNet,
      wolfBrainTfNetwork: wolfBrainTf,
      checkShutdown,
      log,
      writeTrainProgress,
      pickInspectSeeds: (seeds) => pickInspectSeeds(seeds, config.inspectInterval),
      saveInspectGames: (results, modelName, iteration) => saveInspectGames(results, modelName, iteration, { gitSha, runId, checkpointBase: config.checkpointBase }),
      saveEvalHowl,
    }
    await runTrainingPhase(bbStep, bbCtx)

    wolfBrainTf.dispose()
    masonTf.dispose()
    terminateGameWorkerPool()
    log(`${BOLD}Brain Battle training complete!${RESET}`)
    return
  }

  // === BB+ カリキュラム: BB (brains) → BB+1..5 (個別役職) 統合パイプライン ===
  if (config.curriculum === 'bb-plus') {
    const bbTrainingConfig: TrainingConfig = { ...trainingConfig, rewardConfig: BRAIN_BATTLE_REWARD_CONFIG }

    const steps = buildCurriculum({ curriculum: 'bb-plus' })
      .filter((s): s is TrainingStep => s.type === 'training')

    // BB brains — BB フェーズで学習、BB+ フェーズで frozen
    const masonBrainNet = createMasonBrainNetwork()
    const wolfBrainNet = createWolfBrainNetwork()

    // Walk training steps in reverse to find latest checkpoint per model.
    const loadLatest = (net: AnyNetwork, modelName: string, prefix: string, label: string) => {
      const hit = findLatestModelCheckpoint(config.checkpointBase, steps, modelName, prefix)
      if (hit) { loadCheckpoint(net, hit.path); log(`${label}: ${hit.path} (iter ${hit.iteration})`) }
    }
    loadLatest(wolfBrainNet, 'wolf_brain', 'wolf_brain', 'wolf_brain')
    loadLatest(masonBrainNet, 'mason_collective', 'collective', 'mason_brain')

    // BB+ individual agent networks: per-role (random init, Pure JS only — TF は stage ごとに作成)
    const VILLAGE_ROLES = ['seer', 'medium', 'bodyguard', 'nekomata', 'villager'] as const
    const villageRoleNets = new Map<string, AnyNetwork>()
    for (const role of VILLAGE_ROLES) {
      villageRoleNets.set(role, createNetwork())
    }
    const fanaticNet = createFanaticNetwork()
    const werehamsterNet = createNetwork()
    const immoralistNet = createNetwork()

    log(`Wolf Brain: ${wolfBrainNet.totalParams} params, Mason Brain: ${masonBrainNet.totalParams} params`)
    log(`BB+ village roles: ${VILLAGE_ROLES.join(',')} (${villageRoleNets.get('seer')!.totalParams} each)`)
    log(`BB+ fanatic: ${fanaticNet.totalParams}, werehamster: ${werehamsterNet.totalParams}, immoralist: ${immoralistNet.totalParams}`)

    // Load latest per-model checkpoints from prior phases (backbone transfer)
    for (const role of VILLAGE_ROLES) loadLatest(villageRoleNets.get(role)!, role, role, role)
    loadLatest(fanaticNet, 'fanatic', 'fanatic', 'fanatic')
    loadLatest(werehamsterNet, 'werehamster', 'werehamster', 'werehamster')
    loadLatest(immoralistNet, 'immoralist', 'immoralist', 'immoralist')

    if (config.workers !== 0) {
      initGameWorkerPool(config.workers === -1 ? undefined : config.workers)
    }

    // Run each phase/stage sequentially
    for (const step of steps) {
      checkShutdown()

      const isBBPhase = step.name === 'brain_battle'

      if (isBBPhase) {
        // Phase BB: train wolf_brain + mason_brain (TF を stage 内で作成・破棄)
        const wolfBrainTf = createWolfBrainTfNetwork(config.learningRate)
        const masonBrainTf = createMasonBrainTfNetwork(config.learningRate)
        try {
          const bbCtx: PhaseRunnerContext = {
            config, trainingConfig: bbTrainingConfig, progress, runId, gitSha,
            networks: new Map<string, AnyNetwork>([['mason_collective', masonBrainNet]]),
            tfNetworks: new Map<string, AnyTfNetwork>([['mason_collective', masonBrainTf]]),
            frozenWeights: new Map(),
            frozenNets: new Map(),
            wolfBrainNetwork: wolfBrainNet,
            wolfBrainTfNetwork: wolfBrainTf,
            checkShutdown, log, writeTrainProgress,
            pickInspectSeeds: (seeds) => pickInspectSeeds(seeds, config.inspectInterval),
            saveInspectGames: (results, modelName, iteration) => saveInspectGames(results, modelName, iteration, { gitSha, runId, checkpointBase: config.checkpointBase }),
            saveEvalHowl,
          }
          await runTrainingPhase(step, bbCtx)
        } finally {
          wolfBrainTf.dispose()
          masonBrainTf.dispose()
          log(`BB phase: disposed 2 TF networks`)
        }
      } else {
        // Phase BB+: frozen brains + individual agents (学習対象の TF のみ作成)
        const bbPlusNets = new Map<string, AnyNetwork>()
        const bbPlusTfs = new Map<string, AnyTfNetwork>()
        const stageTfs: AnyTfNetwork[] = []
        const frozenWeightsMap = new Map<string, SharedWeights>()

        // Village per-role: 常に agentSpecs に含める（ゲーム内で NN agent として動作）
        // TfNetworks は学習対象ステージのみ作成（PPO 更新の有無を制御 + VRAM 節約）
        const villageIsLearning = step.name.includes('village') || step.name.includes('all')
        for (const [role, net] of villageRoleNets) {
          bbPlusNets.set(role, net)
          if (villageIsLearning) {
            const tf = createTfNetwork(config.learningRate)
            stageTfs.push(tf)
            bbPlusTfs.set(role, tf)
          }
        }

        const fanaticIsLearning = step.name.includes('fanatic') || step.name.includes('all')
        bbPlusNets.set('fanatic', fanaticNet)
        if (fanaticIsLearning) {
          const tf = createFanaticTfNetwork(config.learningRate)
          stageTfs.push(tf)
          bbPlusTfs.set('fanatic', tf)
        }

        const thirdIsLearning = step.name.includes('third') || step.name.includes('all')
        bbPlusNets.set('werehamster', werehamsterNet)
        bbPlusNets.set('immoralist', immoralistNet)
        if (thirdIsLearning) {
          const werehamsterTf = createTfNetwork(config.learningRate)
          const immoralistTf = createTfNetwork(config.learningRate)
          stageTfs.push(werehamsterTf, immoralistTf)
          bbPlusTfs.set('werehamster', werehamsterTf)
          bbPlusTfs.set('immoralist', immoralistTf)
        }

        // frozen village NN for fanatic observation injection
        frozenWeightsMap.set('village', packWeights(villageRoleNets.get('seer')!))

        // wolf_brain を学習対象に含むステージ（bb_plus_wolf, bb_plus_all）では TF を作る
        const wolfBrainIsLearning = step.activeModels.includes('wolf_brain' as any)
        let wolfBrainTfStage: AnyTfNetwork | undefined
        if (wolfBrainIsLearning) {
          wolfBrainTfStage = createWolfBrainTfNetwork(config.learningRate)
          stageTfs.push(wolfBrainTfStage)
        }

        // mason_brain を学習対象に含むステージ（bb_plus_all の共進化）では TF を作る
        const masonBrainIsLearning = step.activeModels.includes('mason_collective' as any)
        const stageTfNetworks = new Map<string, AnyTfNetwork>()
        if (masonBrainIsLearning) {
          const masonBrainTfStage = createMasonBrainTfNetwork(config.learningRate)
          stageTfs.push(masonBrainTfStage)
          stageTfNetworks.set('mason_collective', masonBrainTfStage)
        }

        try {
          const stageCtx: PhaseRunnerContext = {
            config, trainingConfig: bbTrainingConfig, progress, runId, gitSha,
            networks: new Map<string, AnyNetwork>([['mason_collective', masonBrainNet]]),
            tfNetworks: stageTfNetworks,
            frozenWeights: frozenWeightsMap,
            frozenNets: new Map(),
            wolfBrainNetwork: wolfBrainNet,
            wolfBrainTfNetwork: wolfBrainTfStage,
            bbPlusNetworks: bbPlusNets,
            bbPlusTfNetworks: bbPlusTfs,
            checkShutdown, log, writeTrainProgress,
            pickInspectSeeds: (seeds) => pickInspectSeeds(seeds, config.inspectInterval),
            saveInspectGames: (results, modelName, iteration) => saveInspectGames(results, modelName, iteration, { gitSha, runId, checkpointBase: config.checkpointBase }),
            saveEvalHowl,
          }
          await runTrainingPhase(step, stageCtx)
        } finally {
          for (const tf of stageTfs) tf.dispose()
          log(`BB+ stage ${step.name}: disposed ${stageTfs.length} TF network(s)`)
        }
      }
    }

    terminateGameWorkerPool()
    log(`${BOLD}BB+ training complete!${RESET}`)
    return
  }

  // === ネットワーク作成 ===
  // 推論用 (Pure JS, CPU): モデルごとに1つ
  const networks = new Map<ModelName, AnyNetwork>()
  for (const name of MODEL_NAMES) networks.set(name, createNetwork())

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
  // Walk all curriculum phases in reverse to find the latest checkpoint per model.
  // Fallback chain: phases/NN-<step>/ckpt-<model>/ → pretrain/ckpt-<model>/
  const iterCounts = new Map<ModelName, number>()
  let anyResumed = false
  const resumeCurriculumSteps = buildCurriculum()
  if (config.resume) {
    for (const name of MODEL_NAMES) {
      let startIter = 0
      // default curriculum の collective モデルは collective_final.json が prefix
      const info = MODEL_GROUPS[name]
      const prefix = info.collective ? 'collective' : 'checkpoint'
      const hit = findLatestModelCheckpoint(config.checkpointBase, resumeCurriculumSteps, name, prefix)
      if (hit) {
        try {
          loadCheckpoint(networks.get(name)!, hit.path)
          startIter = hit.iteration
          anyResumed = true
        } catch (e) {
          log(`  ${COLORS[name]}${name}${RESET}: checkpoint incompatible, starting fresh (${(e as Error).message})`)
        }
      }
      iterCounts.set(name, startIter)
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
    const villageDir = pretrainCheckpointDir(config.checkpointBase, 'village')
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

  // === Shared PhaseRunnerContext builder ===
  const curriculum = buildCurriculum()
  const buildCtx = (overrides?: Partial<PhaseRunnerContext>): PhaseRunnerContext => ({
    config, trainingConfig, progress, runId, gitSha,
    networks: new Map<string, AnyNetwork>(),
    tfNetworks: new Map<string, AnyTfNetwork>(),
    frozenWeights: new Map<string, SharedWeights>(),
    frozenNets: new Map<string, AnyNetwork>(),
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
    ...overrides,
  })

  // === Phase 0: Mason Individual (backbone pre-training) — delegated to phase-runner ===
  let frozenMasonWeights: SharedWeights | undefined
  let frozenMasonNet: AnyNetwork | undefined
  if (!config.phase2Only) {
    const masonStep = curriculum.find(s => s.type === 'training' && s.name === 'mason_individual') as TrainingStep | undefined
    const masonDir = masonStep ? phaseCheckpointDir(config.checkpointBase, masonStep, 'mason_individual') : ''
    const masonFinalPath = masonStep ? `${masonDir}/final.json` : ''
    const phase0Done = masonStep ? isPhaseDone(config.checkpointBase, masonStep) : false

    if (phase0Done && masonStep) {
      log(`${BOLD}=== Phase 0: Mason Individual (already graduated) ===${RESET}`)
      const villageNet = networks.get('village' as ModelName)!
      const masonNet = createNetwork()
      const latestHit = findLatestModelCheckpoint(config.checkpointBase, [masonStep], 'mason_individual', 'checkpoint')
      if (latestHit) loadCheckpoint(masonNet, latestHit.path)
      else loadCheckpoint(masonNet, masonFinalPath)
      villageNet.loadWeights(masonNet.cloneWeights())
      frozenMasonWeights = packWeights(masonNet)
      frozenMasonNet = masonNet
      log(`  Mason backbone transferred to village network`)
      if (refNetwork) {
        refNetwork.loadWeights(masonNet.cloneWeights())
        log(`  Reference network updated from mason weights`)
      }
    } else {
      // Create mason_individual networks
      const masonNet = createNetwork()
      const masonTf = createTfNetwork(config.learningRate * 0.2)

      // Initialize from village pretrain weights (if not resuming)
      const existingMasonCkpt = masonStep ? findLatestModelCheckpoint(config.checkpointBase, [masonStep], 'mason_individual', 'checkpoint') : null
      if (!config.resume || !existingMasonCkpt) {
        const villageNet = networks.get('village' as ModelName)!
        masonNet.loadWeights(villageNet.cloneWeights())
      }

      // Mason-specific KL reference (frozen copy of initial weights)
      const masonRefNetwork = createNetwork()
      masonRefNetwork.loadWeights(masonNet.cloneWeights())

      if (!masonStep) throw new Error('mason_individual step not found in default curriculum')
      const phase0Ctx = buildCtx({
        networks: new Map([['mason_individual', masonNet]]),
        tfNetworks: new Map([['mason_individual', masonTf]]),
        refNetwork: masonRefNetwork,
      })
      await runTrainingPhase(masonStep, phase0Ctx)

      // Post-phase: backbone transfer mason → village
      const villageNet = networks.get('village' as ModelName)!
      villageNet.loadWeights(masonNet.cloneWeights())
      frozenMasonWeights = packWeights(masonNet)
      frozenMasonNet = masonNet
      log(`Mason backbone transferred to village network (all weights)`)
      if (refNetwork) {
        refNetwork.loadWeights(masonNet.cloneWeights())
        log(`Reference network updated from mason weights`)
      }
      tfNetwork.loadWeights(masonNet.cloneWeights())
    }
  }

  // === Phase 1: Village Training — delegated to phase-runner ===
  if (!config.phase2Only) {
    const villageStep = curriculum.find(s => s.type === 'training' && s.name === 'village') as TrainingStep
    const phase1Ctx = buildCtx({
      networks: new Map([['village', networks.get('village' as ModelName)!]]),
      tfNetworks: new Map([['village', tfNetwork]]),
      refNetwork,
      frozenWeights: frozenMasonWeights ? new Map([['mason_individual', frozenMasonWeights]]) : new Map(),
      frozenNets: frozenMasonNet ? new Map([['mason_individual', frozenMasonNet]]) : new Map(),
    })

    await runTrainingPhase(villageStep, phase1Ctx)
  }

  // === Phase 1': Collective + Non-Village — delegated to phase-runner ===
  if (!config.phase2Only) {
    // Create collective/fanatic-specific networks (different NN configs)
    const wolfCollectiveNet = createWolfCollectiveNetwork()
    const masonCollectiveNet = createMasonCollectiveNetwork()
    const wolfCollectiveTf = createWolfCollectiveTfNetwork(config.learningRate)
    const masonCollectiveTf = createMasonCollectiveTfNetwork(config.learningRate)
    const fanaticNet = createFanaticNetwork()
    const fanaticTf = createFanaticTfNetwork(config.learningRate)
    networks.set('fanatic', fanaticNet)  // Replace generic with fanatic-specific

    const frozenVillageWeights = packWeights(networks.get('village' as ModelName)!)

    const phase1PrimeStep = curriculum.find(s => s.type === 'training' && s.name === 'non_village') as TrainingStep
    const phase1PrimeCtx = buildCtx({
      networks: new Map<string, AnyNetwork>([
        ['village', networks.get('village' as ModelName)!],
        ['wolf_collective', wolfCollectiveNet],
        ['mason_collective', masonCollectiveNet],
        ['fanatic', fanaticNet],
        ['third', networks.get('third' as ModelName)!],
      ]),
      tfNetworks: new Map<string, AnyTfNetwork>([
        ['village', tfNetwork],
        ['wolf_collective', wolfCollectiveTf],
        ['mason_collective', masonCollectiveTf],
        ['fanatic', fanaticTf],
        ['third', tfNetwork],
      ]),
      frozenWeights: new Map([['village', frozenVillageWeights]]),
      frozenNets: new Map([['village', networks.get('village' as ModelName)!]]),
    })
    await runTrainingPhase(phase1PrimeStep, phase1PrimeCtx)

    // === Phase 2: Self-Play (全5モデル同時学習) — delegated to phase-runner ===
    if (!config.phase1Only) {
      const phase2Step = curriculum.find(s => s.type === 'training' && s.name === 'self_play') as TrainingStep
      const phase2Ctx = buildCtx({
        networks: new Map<string, AnyNetwork>([
          ['village', networks.get('village' as ModelName)!],
          ['wolf_collective', wolfCollectiveNet],
          ['mason_collective', masonCollectiveNet],
          ['fanatic', fanaticNet],
          ['third', networks.get('third' as ModelName)!],
        ]),
        tfNetworks: new Map<string, AnyTfNetwork>([
          ['village', tfNetwork],
          ['wolf_collective', wolfCollectiveTf],
          ['mason_collective', masonCollectiveTf],
          ['fanatic', fanaticTf],
          ['third', tfNetwork],
        ]),
      })
      await runTrainingPhase(phase2Step, phase2Ctx)
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

main().catch(e => {
  console.error('Fatal error:', e)
  if (e && typeof e === 'object') {
    console.error('Error details:', JSON.stringify(e, Object.getOwnPropertyNames(e), 2))
  }
  process.exit(1)
})
