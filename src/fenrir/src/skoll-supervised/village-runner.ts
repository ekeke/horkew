/**
 * Village perspective skoll pretrain runner。
 *
 * 2 stage:
 *   Stage 1 (collect): village-data-collector で village 役職 (villager/seer/medium/
 *                      bodyguard/nekomata) の vote 機会を採取
 *   Stage 2 (train):   village-trainer で skoll-zero standard NN (1029 dims) を pretrain
 *
 * 出力 checkpoint は default で `tmp/skoll-village-{base}/phases/00-skoll-village-supervised/
 * ckpt-village/village_final.json`。skoll-zero curriculum で warm-start として使うには
 * `src/skoll/models/village.json` にコピーする運用。
 *
 * 起動例:
 *   SKOLL_COLLECT_GAMES=1000 SKOLL_EPOCHS=100 SKOLL_PATIENCE=25 SKOLL_TEMPERATURE=0.15 \
 *     node --experimental-strip-types src/fenrir/src/skoll-supervised/village-runner.ts \
 *     --checkpoint-base tmp/skoll-village-large
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { collectAndSaveVillage } from './village-data-collector.ts'
import { trainAndSaveVillage } from './village-trainer.ts'

export type VillagePretrainOptions = {
  checkpointBase: string
  collectGames: number
  trainEpochs: number
  learningRate: number
  batchSize: number
  temperature: number
  baseSeed: number
  patience: number
}

export const DEFAULT_VILLAGE_PRETRAIN_OPTIONS: VillagePretrainOptions = {
  checkpointBase: '',
  collectGames: 200,
  trainEpochs: 30,
  learningRate: 3e-4,
  batchSize: 256,
  temperature: 0.3,
  baseSeed: 38000,
  patience: 5,
}

function envOverrides(): Partial<VillagePretrainOptions> {
  const out: Partial<VillagePretrainOptions> = {}
  if (process.env.SKOLL_COLLECT_GAMES) out.collectGames = parseInt(process.env.SKOLL_COLLECT_GAMES, 10)
  if (process.env.SKOLL_EPOCHS) out.trainEpochs = parseInt(process.env.SKOLL_EPOCHS, 10)
  if (process.env.SKOLL_BATCH) out.batchSize = parseInt(process.env.SKOLL_BATCH, 10)
  if (process.env.SKOLL_TEMPERATURE) out.temperature = parseFloat(process.env.SKOLL_TEMPERATURE)
  if (process.env.SKOLL_BASE_SEED) out.baseSeed = parseInt(process.env.SKOLL_BASE_SEED, 10)
  if (process.env.SKOLL_PATIENCE) out.patience = parseInt(process.env.SKOLL_PATIENCE, 10)
  if (process.env.SKOLL_LR) out.learningRate = parseFloat(process.env.SKOLL_LR)
  return out
}

export async function runVillagePretrain(opts: Partial<VillagePretrainOptions> = {}): Promise<void> {
  const options = { ...DEFAULT_VILLAGE_PRETRAIN_OPTIONS, ...opts, ...envOverrides() }
  if (!options.checkpointBase) throw new Error('checkpointBase is required')

  const phaseDir = join(options.checkpointBase, 'phases', '00-skoll-village-supervised')
  mkdirSync(phaseDir, { recursive: true })

  const samplesPath = join(phaseDir, 'data', 'samples.jsonl')
  const ckptPath = join(phaseDir, 'ckpt-village', 'village_final.json')
  const doneFile = join(phaseDir, 'phase.done')
  const summaryPath = join(phaseDir, 'phase-summary.json')

  if (existsSync(doneFile)) {
    process.stderr.write(`[village-pretrain] phase already done (${doneFile}). Delete to re-run.\n`)
    return
  }

  process.stderr.write(`[village-pretrain] === Stage 1: skoll 教師データ収集 (village perspective) ===\n`)
  const collectResult = await collectAndSaveVillage({
    numGames: options.collectGames,
    baseSeed: options.baseSeed,
    temperature: options.temperature,
    outputPath: samplesPath,
  })

  process.stderr.write(`[village-pretrain] === Stage 2: 教師あり学習 ===\n`)
  const trainResult = await trainAndSaveVillage({
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
  writeFileSync(doneFile, JSON.stringify({ phaseName: 'skoll-village-supervised', graduatedAt: new Date().toISOString() }, null, 2))

  process.stderr.write(`[village-pretrain] === All Stages Complete ===\n`)
  process.stderr.write(`[village-pretrain] checkpoint: ${ckptPath}\n`)
  process.stderr.write(`[village-pretrain] copy command: cp ${ckptPath} src/skoll/models/village.json\n`)
}

function parseCli(): Partial<VillagePretrainOptions> {
  const opts: Partial<VillagePretrainOptions> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--checkpoint-base': opts.checkpointBase = args[++i]; break
      case '--games': opts.collectGames = parseInt(args[++i], 10); break
      case '--epochs': opts.trainEpochs = parseInt(args[++i], 10); break
      case '--temperature': opts.temperature = parseFloat(args[++i]); break
      case '--seed': opts.baseSeed = parseInt(args[++i], 10); break
      case '--patience': opts.patience = parseInt(args[++i], 10); break
      case '--lr': opts.learningRate = parseFloat(args[++i]); break
      case '--help':
        process.stderr.write('Usage: village-runner.ts --checkpoint-base PATH [--games N] [--epochs N] [--temperature T] [--seed S] [--patience N] [--lr R]\n')
        process.exit(0)
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('village-runner.ts')) {
  runVillagePretrain(parseCli()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
