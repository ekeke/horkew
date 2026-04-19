/**
 * Stage 3: skoll-pretrain curriculum runner
 *
 * Stage 0 (diagnose) → Stage 1 (collect) → Stage 2 (train) を順に実行する。
 * orchestrate.ts から `--curriculum skoll-pretrain` で呼ばれる。
 *
 * checkpoint レイアウト:
 *   {checkpointBase}/phases/00-skoll-supervised/
 *     diagnose-report.json
 *     data/samples.jsonl
 *     ckpt-skoll/checkpoint.json
 *     phase.done
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { runDiagnostic } from './diagnose-observation.ts'
import { collectAndSave } from './data-collector.ts'
import { trainAndSave } from './trainer.ts'
import { evaluateCheckpoint } from './eval.ts'

export type SkollPretrainOptions = {
  checkpointBase: string
  /** Stage 0 ゲーム数（診断のみ） */
  diagnoseGames: number
  /** Stage 1 ゲーム数（学習データ生成） */
  collectGames: number
  /** Stage 2 epoch 数 */
  trainEpochs: number
  /** Stage 2 学習率 */
  learningRate: number
  /** Stage 2 batch サイズ */
  batchSize: number
  /** Stage 1 soft label 温度 */
  temperature: number
  /** Stage 1 base seed */
  baseSeed: number
  /** Stage 0 をスキップする（既に GO 確認済みの再実行用） */
  skipDiagnose: boolean
  /** Stage 0 の判定が NOGO でも続行する */
  ignoreNogo: boolean
  /** Stage 4 held-out 評価ゲーム数 */
  evalGames: number
  /** Stage 2 early-stop patience */
  patience: number
}

export const DEFAULT_SKOLL_PRETRAIN_OPTIONS: SkollPretrainOptions = {
  checkpointBase: '',
  diagnoseGames: 30,
  collectGames: 200,
  trainEpochs: 30,
  learningRate: 3e-4,
  batchSize: 256,
  temperature: 0.3,
  baseSeed: 8000,
  skipDiagnose: false,
  ignoreNogo: false,
  evalGames: 30,
  patience: 5,
}

/** 環境変数からの override (スモークラン等のため) */
function envOverrides(): Partial<SkollPretrainOptions> {
  const out: Partial<SkollPretrainOptions> = {}
  if (process.env.SKOLL_DIAGNOSE_GAMES) out.diagnoseGames = parseInt(process.env.SKOLL_DIAGNOSE_GAMES, 10)
  if (process.env.SKOLL_COLLECT_GAMES) out.collectGames = parseInt(process.env.SKOLL_COLLECT_GAMES, 10)
  if (process.env.SKOLL_EPOCHS) out.trainEpochs = parseInt(process.env.SKOLL_EPOCHS, 10)
  if (process.env.SKOLL_BATCH) out.batchSize = parseInt(process.env.SKOLL_BATCH, 10)
  if (process.env.SKOLL_TEMPERATURE) out.temperature = parseFloat(process.env.SKOLL_TEMPERATURE)
  if (process.env.SKOLL_BASE_SEED) out.baseSeed = parseInt(process.env.SKOLL_BASE_SEED, 10)
  if (process.env.SKOLL_EVAL_GAMES) out.evalGames = parseInt(process.env.SKOLL_EVAL_GAMES, 10)
  if (process.env.SKOLL_PATIENCE) out.patience = parseInt(process.env.SKOLL_PATIENCE, 10)
  if (process.env.SKOLL_SKIP_DIAGNOSE) out.skipDiagnose = true
  if (process.env.SKOLL_IGNORE_NOGO) out.ignoreNogo = true
  return out
}

export async function runSkollPretrain(opts: Partial<SkollPretrainOptions> = {}): Promise<void> {
  const options = { ...DEFAULT_SKOLL_PRETRAIN_OPTIONS, ...opts, ...envOverrides() }
  if (!options.checkpointBase) {
    throw new Error('checkpointBase is required')
  }

  const phaseDir = join(options.checkpointBase, 'phases', '00-skoll-supervised')
  mkdirSync(phaseDir, { recursive: true })

  const diagnosePath = join(phaseDir, 'diagnose-report.json')
  const samplesPath = join(phaseDir, 'data', 'samples.jsonl')
  // brain-battle の findCheckpoint(dir, 'collective') と同じ命名規約で保存。
  // → ckpt-mason_collective/ ディレクトリを別 base 配下にコピーすれば BB が自動 load する。
  const ckptPath = join(phaseDir, 'ckpt-mason_collective', 'collective_final.json')
  const doneFile = join(phaseDir, 'phase.done')
  const summaryPath = join(phaseDir, 'phase-summary.json')

  if (existsSync(doneFile)) {
    process.stderr.write(`[skoll-pretrain] phase already done (${doneFile}). Delete the file to re-run.\n`)
    return
  }

  // === Stage 0: 診断 ===
  let diagnoseSummary: any = null
  if (!options.skipDiagnose) {
    process.stderr.write(`[skoll-pretrain] === Stage 0: 観測十分性診断 ===\n`)
    const report = await runDiagnostic({
      numGames: options.diagnoseGames,
      baseSeed: options.baseSeed - 1000,
      outputPath: diagnosePath,
    })
    diagnoseSummary = {
      verdict: report.verdict,
      pearsonCorrelation: report.pearsonCorrelation,
      numAnomalousPairs: report.numAnomalousPairs,
    }
    if (report.verdict === 'NOGO' && !options.ignoreNogo) {
      throw new Error(`Stage 0 NOGO. See ${diagnosePath}. Use --ignore-nogo to proceed anyway.`)
    }
  }

  // === Stage 1: データ収集 ===
  process.stderr.write(`[skoll-pretrain] === Stage 1: skoll 教師データ収集 ===\n`)
  const collectResult = await collectAndSave({
    numGames: options.collectGames,
    baseSeed: options.baseSeed,
    temperature: options.temperature,
    outputPath: samplesPath,
  })

  // === Stage 2: 学習 ===
  process.stderr.write(`[skoll-pretrain] === Stage 2: 教師あり学習 ===\n`)
  const trainResult = await trainAndSave({
    inputJsonl: samplesPath,
    outputCheckpointPath: ckptPath,
    epochs: options.trainEpochs,
    learningRate: options.learningRate,
    batchSize: options.batchSize,
    patience: options.patience,
  })

  // === Stage 4: held-out 評価 ===
  process.stderr.write(`[skoll-pretrain] === Stage 4: held-out 評価 ===\n`)
  const evalResult = await evaluateCheckpoint({
    checkpointPath: ckptPath,
    baseSeed: options.baseSeed + 100000,  // 学習データと被らない seed 範囲
    numGames: options.evalGames,
    temperature: options.temperature,
    samplesOutputPath: join(phaseDir, 'data', 'heldout-samples.jsonl'),
  })

  // === Phase summary + done marker ===
  const summary = {
    options,
    diagnose: diagnoseSummary,
    collect: {
      numSamples: collectResult.numSamples,
      marginStats: collectResult.marginStats,
    },
    train: {
      numTrain: trainResult.numTrain,
      numEval: trainResult.numEval,
      bestEpoch: trainResult.bestEpoch,
      bestEvalLoss: trainResult.bestEvalLoss,
      bestEvalTop1: trainResult.bestEvalTop1,
      bestEvalTop3: trainResult.bestEvalTop3,
    },
    heldoutEval: evalResult,
    finishedAt: new Date().toISOString(),
  }
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  writeFileSync(doneFile, JSON.stringify({ phaseName: 'skoll-supervised', phaseIndex: 0, graduatedAt: new Date().toISOString() }, null, 2))

  process.stderr.write(`[skoll-pretrain] === All Stages Complete ===\n`)
  process.stderr.write(`[skoll-pretrain] checkpoint: ${ckptPath}\n`)
  process.stderr.write(`[skoll-pretrain] summary:    ${summaryPath}\n`)
  process.stderr.write(`[skoll-pretrain] done marker: ${doneFile}\n`)
}
