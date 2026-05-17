/**
 * skoll-multiday curriculum runner (orchestrate 配下)
 *
 * Stage 1 (verify dataset) → Stage 2 (train) → Stage 3 (validate spot check)。
 * orchestrate.ts から `--curriculum skoll-multiday` で呼ばれる。
 *
 * 既存 jsonl データを前提とする (data 生成は別 script で事前実行)。
 * 環境変数で hyperparams を override 可:
 *   SKOLL_MULTIDAY_DATA      jsonl path (default: data/skoll-multiday-1k.jsonl)
 *   SKOLL_MULTIDAY_EPOCHS    最大 epoch (default: 100)
 *   SKOLL_MULTIDAY_BATCH     batch size (default: 128)
 *   SKOLL_MULTIDAY_LR        learning rate (default: 3e-4)
 *   SKOLL_MULTIDAY_PATIENCE  early stop patience (default: 15)
 *   SKOLL_MULTIDAY_EVAL_RATIO eval split 比 (default: 0.1)
 *   SKOLL_MULTIDAY_SEED      shuffle seed (default: 42)
 *
 * checkpoint レイアウト:
 *   {checkpointBase}/phases/00-skoll-multiday/
 *     ckpt-multiday/checkpoint.json
 *     phase.done
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type SkollMultidayOptions = {
  checkpointBase: string
  dataPath: string
  epochs: number
  batchSize: number
  learningRate: number
  patience: number
  evalRatio: number
  seed: number
}

export const DEFAULT_SKOLL_MULTIDAY_OPTIONS: Omit<SkollMultidayOptions, 'checkpointBase'> = {
  dataPath: 'data/skoll-multiday-1k.jsonl',
  epochs: 100,
  batchSize: 128,
  learningRate: 3e-4,
  patience: 15,
  evalRatio: 0.1,
  seed: 42,
}

function envOverrides(): Partial<SkollMultidayOptions> {
  const out: Partial<SkollMultidayOptions> = {}
  if (process.env.SKOLL_MULTIDAY_DATA) out.dataPath = process.env.SKOLL_MULTIDAY_DATA
  if (process.env.SKOLL_MULTIDAY_EPOCHS) out.epochs = parseInt(process.env.SKOLL_MULTIDAY_EPOCHS, 10)
  if (process.env.SKOLL_MULTIDAY_BATCH) out.batchSize = parseInt(process.env.SKOLL_MULTIDAY_BATCH, 10)
  if (process.env.SKOLL_MULTIDAY_LR) out.learningRate = parseFloat(process.env.SKOLL_MULTIDAY_LR)
  if (process.env.SKOLL_MULTIDAY_PATIENCE) out.patience = parseInt(process.env.SKOLL_MULTIDAY_PATIENCE, 10)
  if (process.env.SKOLL_MULTIDAY_EVAL_RATIO) out.evalRatio = parseFloat(process.env.SKOLL_MULTIDAY_EVAL_RATIO)
  if (process.env.SKOLL_MULTIDAY_SEED) out.seed = parseInt(process.env.SKOLL_MULTIDAY_SEED, 10)
  return out
}

export async function runSkollMultiday(opts: Partial<SkollMultidayOptions> = {}): Promise<void> {
  const options: SkollMultidayOptions = {
    ...DEFAULT_SKOLL_MULTIDAY_OPTIONS,
    ...opts,
    ...envOverrides(),
    checkpointBase: opts.checkpointBase ?? '',
  }

  if (!options.checkpointBase) {
    throw new Error('checkpointBase is required')
  }

  const phaseDir = join(options.checkpointBase, 'phases', '00-skoll-multiday')
  const ckptDir = join(phaseDir, 'ckpt-multiday')
  const ckptPath = join(ckptDir, 'checkpoint.json')
  const phaseDonePath = join(phaseDir, 'phase.done')
  mkdirSync(ckptDir, { recursive: true })

  console.log(`[skoll-multiday] checkpointBase: ${options.checkpointBase}`)
  console.log(`[skoll-multiday] dataPath:       ${options.dataPath}`)
  console.log(`[skoll-multiday] epochs:         ${options.epochs}`)
  console.log(`[skoll-multiday] batch:          ${options.batchSize}`)
  console.log(`[skoll-multiday] lr:             ${options.learningRate}`)
  console.log(`[skoll-multiday] patience:       ${options.patience}`)
  console.log(`[skoll-multiday] eval_ratio:     ${options.evalRatio}`)
  console.log(`[skoll-multiday] ckpt out:       ${ckptPath}`)

  // === Stage 1: dataset 検証 ===
  if (!existsSync(options.dataPath)) {
    throw new Error(
      `dataset not found: ${options.dataPath}\n`
      + `先に generate-multiday-dataset.ts でデータを生成してください:\n`
      + `  node --experimental-strip-types src/skoll/generate-multiday-dataset.ts --games 100 --out ${options.dataPath}`,
    )
  }
  const sampleCount = readFileSync(options.dataPath, 'utf-8').split('\n').filter(l => l.length > 0).length
  console.log(`[skoll-multiday] dataset: ${sampleCount} samples`)

  if (sampleCount < 100) {
    throw new Error(`dataset too small: ${sampleCount} samples (need at least 100)`)
  }

  // === Stage 2: training ===
  console.log('\n[skoll-multiday] === Stage 2: Training ===\n')

  // 動的 import (TF.js を curriculum 外実行時に load しない)
  const { trainMultiday } = await import('./multiday-train-fn.ts')
  const result = await trainMultiday({
    dataPath: options.dataPath,
    outPath: ckptPath,
    epochs: options.epochs,
    batchSize: options.batchSize,
    learningRate: options.learningRate,
    patience: options.patience,
    evalRatio: options.evalRatio,
    seed: options.seed,
  })

  // === Stage 3: 完了 marker ===
  writeFileSync(phaseDonePath, JSON.stringify({
    phaseName: 'skoll-multiday',
    completedAt: new Date().toISOString(),
    bestEvalMse: result.bestEvalMse,
    bestEvalMae: result.bestEvalMae,
    finalEpoch: result.finalEpoch,
    sampleCount,
    config: {
      epochs: options.epochs,
      batchSize: options.batchSize,
      learningRate: options.learningRate,
    },
  }, null, 2))

  console.log(`\n[skoll-multiday] === Complete ===`)
  console.log(`  best eval MSE: ${result.bestEvalMse.toFixed(5)}`)
  console.log(`  best eval MAE: ${result.bestEvalMae.toFixed(5)}`)
  console.log(`  final epoch:   ${result.finalEpoch}`)
  console.log(`  ckpt:          ${ckptPath}`)
  console.log(`  phase.done:    ${phaseDonePath}`)
}
