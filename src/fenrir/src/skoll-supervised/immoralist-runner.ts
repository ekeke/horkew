/**
 * Immoralist perspective skoll pretrain runner。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { collectAndSaveImmoralist } from './immoralist-data-collector.ts'
import { trainAndSaveImmoralist } from './immoralist-trainer.ts'

export type ImmoralistPretrainOptions = {
  checkpointBase: string
  collectGames: number
  trainEpochs: number
  learningRate: number
  batchSize: number
  temperature: number
  baseSeed: number
  patience: number
}

export const DEFAULT_IMMORALIST_PRETRAIN_OPTIONS: ImmoralistPretrainOptions = {
  checkpointBase: '',
  collectGames: 200,
  trainEpochs: 30,
  learningRate: 3e-4,
  batchSize: 256,
  temperature: 0.3,
  baseSeed: 38000,
  patience: 5,
}

function envOverrides(): Partial<ImmoralistPretrainOptions> {
  const out: Partial<ImmoralistPretrainOptions> = {}
  if (process.env.SKOLL_COLLECT_GAMES) out.collectGames = parseInt(process.env.SKOLL_COLLECT_GAMES, 10)
  if (process.env.SKOLL_EPOCHS) out.trainEpochs = parseInt(process.env.SKOLL_EPOCHS, 10)
  if (process.env.SKOLL_BATCH) out.batchSize = parseInt(process.env.SKOLL_BATCH, 10)
  if (process.env.SKOLL_TEMPERATURE) out.temperature = parseFloat(process.env.SKOLL_TEMPERATURE)
  if (process.env.SKOLL_BASE_SEED) out.baseSeed = parseInt(process.env.SKOLL_BASE_SEED, 10)
  if (process.env.SKOLL_PATIENCE) out.patience = parseInt(process.env.SKOLL_PATIENCE, 10)
  return out
}

export async function runImmoralistPretrain(opts: Partial<ImmoralistPretrainOptions> = {}): Promise<void> {
  const options = { ...DEFAULT_IMMORALIST_PRETRAIN_OPTIONS, ...opts, ...envOverrides() }
  if (!options.checkpointBase) throw new Error('checkpointBase is required')

  const phaseDir = join(options.checkpointBase, 'phases', '00-skoll-immoralist-supervised')
  mkdirSync(phaseDir, { recursive: true })

  const samplesPath = join(phaseDir, 'data', 'samples.jsonl')
  const ckptPath = join(phaseDir, 'ckpt-immoralist', 'immoralist_final.json')
  const doneFile = join(phaseDir, 'phase.done')
  const summaryPath = join(phaseDir, 'phase-summary.json')

  if (existsSync(doneFile)) {
    process.stderr.write(`[immoralist-pretrain] phase already done (${doneFile}). Delete to re-run.\n`)
    return
  }

  process.stderr.write(`[immoralist-pretrain] === Stage 1: skoll 教師データ収集 (immoralist perspective) ===\n`)
  const collectResult = await collectAndSaveImmoralist({
    numGames: options.collectGames,
    baseSeed: options.baseSeed,
    temperature: options.temperature,
    outputPath: samplesPath,
  })

  process.stderr.write(`[immoralist-pretrain] === Stage 2: 教師あり学習 ===\n`)
  const trainResult = await trainAndSaveImmoralist({
    inputJsonl: samplesPath,
    outputCheckpointPath: ckptPath,
    epochs: options.trainEpochs,
    learningRate: options.learningRate,
    batchSize: options.batchSize,
    patience: options.patience,
  })

  const summary = {
    options,
    collect: { numSamples: collectResult.numSamples, marginStats: collectResult.marginStats },
    train: {
      numTrain: trainResult.numTrain,
      numEval: trainResult.numEval,
      bestEpoch: trainResult.bestEpoch,
      bestEvalLoss: trainResult.bestEvalLoss,
      bestEvalTop1: trainResult.bestEvalTop1,
      bestEvalTop3: trainResult.bestEvalTop3,
    },
    finishedAt: new Date().toISOString(),
  }
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  writeFileSync(doneFile, JSON.stringify({ phaseName: 'skoll-immoralist-supervised', graduatedAt: new Date().toISOString() }, null, 2))

  process.stderr.write(`[immoralist-pretrain] === All Stages Complete ===\n`)
  process.stderr.write(`[immoralist-pretrain] checkpoint: ${ckptPath}\n`)
}

function parseCli(): Partial<ImmoralistPretrainOptions> {
  const opts: Partial<ImmoralistPretrainOptions> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--checkpoint-base': opts.checkpointBase = args[++i]; break
      case '--games': opts.collectGames = parseInt(args[++i], 10); break
      case '--epochs': opts.trainEpochs = parseInt(args[++i], 10); break
      case '--temperature': opts.temperature = parseFloat(args[++i]); break
      case '--seed': opts.baseSeed = parseInt(args[++i], 10); break
      case '--patience': opts.patience = parseInt(args[++i], 10); break
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('immoralist-runner.ts')) {
  runImmoralistPretrain(parseCli()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
