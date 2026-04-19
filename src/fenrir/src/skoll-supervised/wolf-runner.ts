/**
 * Wolf perspective skoll pretrain runner。
 *
 * mason 版 (runner.ts) の wolf 版。
 *   Stage 1 (collect): wolf-data-collector
 *   Stage 2 (train):   wolf-trainer
 *
 * 観測診断 (Stage 0) と held-out eval (Stage 4) は mason 版で十分なので省略可。
 *
 * 起動例:
 *   SKOLL_COLLECT_GAMES=1000 SKOLL_EPOCHS=100 SKOLL_PATIENCE=25 SKOLL_TEMPERATURE=0.15 \
 *   node --experimental-strip-types src/fenrir/src/skoll-supervised/wolf-runner.ts \
 *     --checkpoint-base tmp/skoll-wolf-large
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { collectAndSaveWolf } from './wolf-data-collector.ts'
import { trainAndSaveWolf } from './wolf-trainer.ts'

export type WolfPretrainOptions = {
  checkpointBase: string
  collectGames: number
  trainEpochs: number
  learningRate: number
  batchSize: number
  temperature: number
  baseSeed: number
  patience: number
}

export const DEFAULT_WOLF_PRETRAIN_OPTIONS: WolfPretrainOptions = {
  checkpointBase: '',
  collectGames: 200,
  trainEpochs: 30,
  learningRate: 3e-4,
  batchSize: 256,
  temperature: 0.3,
  baseSeed: 18000,
  patience: 5,
}

function envOverrides(): Partial<WolfPretrainOptions> {
  const out: Partial<WolfPretrainOptions> = {}
  if (process.env.SKOLL_COLLECT_GAMES) out.collectGames = parseInt(process.env.SKOLL_COLLECT_GAMES, 10)
  if (process.env.SKOLL_EPOCHS) out.trainEpochs = parseInt(process.env.SKOLL_EPOCHS, 10)
  if (process.env.SKOLL_BATCH) out.batchSize = parseInt(process.env.SKOLL_BATCH, 10)
  if (process.env.SKOLL_TEMPERATURE) out.temperature = parseFloat(process.env.SKOLL_TEMPERATURE)
  if (process.env.SKOLL_BASE_SEED) out.baseSeed = parseInt(process.env.SKOLL_BASE_SEED, 10)
  if (process.env.SKOLL_PATIENCE) out.patience = parseInt(process.env.SKOLL_PATIENCE, 10)
  return out
}

export async function runWolfPretrain(opts: Partial<WolfPretrainOptions> = {}): Promise<void> {
  const options = { ...DEFAULT_WOLF_PRETRAIN_OPTIONS, ...opts, ...envOverrides() }
  if (!options.checkpointBase) throw new Error('checkpointBase is required')

  const phaseDir = join(options.checkpointBase, 'phases', '00-skoll-wolf-supervised')
  mkdirSync(phaseDir, { recursive: true })

  const samplesPath = join(phaseDir, 'data', 'samples.jsonl')
  const ckptPath = join(phaseDir, 'ckpt-wolf_brain', 'wolf_brain_final.json')
  const doneFile = join(phaseDir, 'phase.done')
  const summaryPath = join(phaseDir, 'phase-summary.json')

  if (existsSync(doneFile)) {
    process.stderr.write(`[wolf-pretrain] phase already done (${doneFile}). Delete to re-run.\n`)
    return
  }

  process.stderr.write(`[wolf-pretrain] === Stage 1: skoll 教師データ収集 (wolf perspective) ===\n`)
  const collectResult = await collectAndSaveWolf({
    numGames: options.collectGames,
    baseSeed: options.baseSeed,
    temperature: options.temperature,
    outputPath: samplesPath,
  })

  process.stderr.write(`[wolf-pretrain] === Stage 2: 教師あり学習 ===\n`)
  const trainResult = await trainAndSaveWolf({
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
  writeFileSync(doneFile, JSON.stringify({ phaseName: 'skoll-wolf-supervised', graduatedAt: new Date().toISOString() }, null, 2))

  process.stderr.write(`[wolf-pretrain] === All Stages Complete ===\n`)
  process.stderr.write(`[wolf-pretrain] checkpoint: ${ckptPath}\n`)
}

function parseCli(): Partial<WolfPretrainOptions> {
  const opts: Partial<WolfPretrainOptions> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--checkpoint-base': opts.checkpointBase = args[++i]; break
      case '--games': opts.collectGames = parseInt(args[++i], 10); break
      case '--epochs': opts.trainEpochs = parseInt(args[++i], 10); break
      case '--temperature': opts.temperature = parseFloat(args[++i]); break
      case '--seed': opts.baseSeed = parseInt(args[++i], 10); break
      case '--patience': opts.patience = parseInt(args[++i], 10); break
      case '--help':
        process.stderr.write('Usage: wolf-runner.ts --checkpoint-base PATH [--games N] [--epochs N] [--temperature T] [--seed S] [--patience N]\n')
        process.exit(0)
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('wolf-runner.ts')) {
  runWolfPretrain(parseCli()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
