/**
 * Hamster perspective skoll 教師あり学習。
 *
 * standard createNetwork (TRANSFORMER_NETWORK_CONFIG, input=1029) を使用。
 * 個人役職なので team context なし、vote head のみ学習対象。
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { createNetwork, createTfNetwork } from '../training.ts'
import { saveCheckpoint } from '../ml/checkpoint.ts'
import { SEATS } from '../observation.ts'
import { makeHamsterSoftLabel } from './hamster-data-collector.ts'
import type { AnyNetwork } from '../ml/nn.ts'

type LoadedSample = {
  observation: Float32Array
  label: Float32Array
  mask: Float32Array
}

export type HamsterTrainerOptions = {
  inputJsonl: string
  outputCheckpointPath: string
  batchSize: number
  miniBatchSize: number
  epochs: number
  learningRate: number
  evalRatio: number
  patience: number
  seed: number
  relabelTemperature?: number
}

export const DEFAULT_HAMSTER_TRAINER_OPTIONS: HamsterTrainerOptions = {
  inputJsonl: 'tmp/skoll-hamster-data/samples.jsonl',
  outputCheckpointPath: 'tmp/skoll-hamster-trainer/ckpt-hamster/hamster_final.json',
  batchSize: 256,
  miniBatchSize: 64,
  epochs: 30,
  learningRate: 3e-4,
  evalRatio: 0.1,
  patience: 5,
  seed: 42,
}

function loadJsonl(path: string, relabelTemperature?: number): LoadedSample[] {
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n').filter(l => l.length > 0)
  const samples: LoadedSample[] = []
  for (const line of lines) {
    const obj = JSON.parse(line)
    let label: Float32Array
    let mask: Float32Array
    if (relabelTemperature !== undefined) {
      const raws = obj.metadata?.rawHamsterWinRates as Array<{ seat: number, hamsterWinRate: number }> | undefined
      if (raws && raws.length > 0) {
        const candidates = raws.map(r => ({ seat: r.seat, hamsterWinRate: r.hamsterWinRate, isSelf: false }))
        const built = makeHamsterSoftLabel(candidates, relabelTemperature)
        label = built.label
        mask = built.mask
      } else {
        label = Float32Array.from(obj.label)
        mask = Float32Array.from(obj.mask)
      }
    } else {
      label = Float32Array.from(obj.label)
      mask = Float32Array.from(obj.mask)
    }
    samples.push({ observation: Float32Array.from(obj.observation), label, mask })
  }
  return samples
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

function argmax(arr: Float32Array): number {
  let bestIdx = 0
  let bestVal = arr[0]
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > bestVal) { bestVal = arr[i]; bestIdx = i }
  }
  return bestIdx
}

function evalAccuracy(net: AnyNetwork, samples: LoadedSample[]): { loss: number, top1: number, top3: number } {
  if (samples.length === 0) return { loss: 0, top1: 0, top3: 0 }
  let totalLoss = 0
  let totalTop1 = 0
  let totalTop3 = 0
  for (const s of samples) {
    const result = net.forward(s.observation)
    const voteLogits = result.policies.get('vote')
    if (!voteLogits) continue
    const masked = new Float32Array(SEATS)
    for (let i = 0; i < SEATS; i++) masked[i] = voteLogits[i] + s.mask[i]
    let maxLogit = -Infinity
    for (let i = 0; i < SEATS; i++) if (masked[i] > maxLogit) maxLogit = masked[i]
    const probs = new Float32Array(SEATS)
    let expSum = 0
    for (let i = 0; i < SEATS; i++) {
      probs[i] = Math.exp(masked[i] - maxLogit)
      expSum += probs[i]
    }
    for (let i = 0; i < SEATS; i++) probs[i] /= expSum
    let loss = 0
    for (let i = 0; i < SEATS; i++) {
      if (s.label[i] > 0) loss -= s.label[i] * Math.log(probs[i] + 1e-8)
    }
    totalLoss += loss
    const labelIdx = argmax(s.label)
    const probIdx = argmax(probs)
    if (probIdx === labelIdx) totalTop1++
    const sortedIdx = Array.from({ length: SEATS }, (_, i) => i).sort((a, b) => probs[b] - probs[a])
    if (sortedIdx.slice(0, 3).includes(labelIdx)) totalTop3++
  }
  const n = samples.length
  return { loss: totalLoss / n, top1: totalTop1 / n, top3: totalTop3 / n }
}

export async function trainAndSaveHamster(opts: Partial<HamsterTrainerOptions> = {}): Promise<{
  numTrain: number
  numEval: number
  bestEpoch: number
  bestEvalLoss: number
  bestEvalTop1: number
  bestEvalTop3: number
  checkpointPath: string
}> {
  const options = { ...DEFAULT_HAMSTER_TRAINER_OPTIONS, ...opts }
  process.stderr.write(`[hamster-train] loading ${options.inputJsonl}\n`)
  const all = loadJsonl(options.inputJsonl, options.relabelTemperature)
  process.stderr.write(`[hamster-train] loaded ${all.length} samples\n`)

  const rng = makeRng(options.seed)
  shuffleInPlace(all, rng)

  const numEval = Math.max(1, Math.floor(all.length * options.evalRatio))
  const evalSet = all.slice(0, numEval)
  const trainSet = all.slice(numEval)
  process.stderr.write(`[hamster-train] split: train=${trainSet.length}, eval=${numEval}\n`)

  const tfNet = createTfNetwork(options.learningRate)
  const evalNet = createNetwork()

  let bestEpoch = -1
  let bestEvalLoss = Infinity
  let bestEvalTop1 = 0
  let bestEvalTop3 = 0
  let patienceCounter = 0

  for (let epoch = 0; epoch < options.epochs; epoch++) {
    shuffleInPlace(trainSet, rng)

    let trainLoss = 0
    let trainAcc = 0
    let trainCount = 0
    for (let start = 0; start < trainSet.length; start += options.batchSize) {
      const batch = trainSet.slice(start, Math.min(start + options.batchSize, trainSet.length))
      const result = tfNet.trainSupervisedVote({
        observations: batch.map(s => s.observation),
        labels: batch.map(s => s.label),
        masks: batch.map(s => s.mask),
      })
      trainLoss += result.loss * batch.length
      trainAcc += result.accuracy * batch.length
      trainCount += batch.length
    }
    trainLoss /= Math.max(1, trainCount)
    trainAcc /= Math.max(1, trainCount)

    evalNet.loadWeights(tfNet.cloneWeights())
    const evalRes = evalAccuracy(evalNet, evalSet)

    process.stderr.write(
      `[hamster-train] epoch ${epoch + 1}/${options.epochs} `
      + `train: loss=${trainLoss.toFixed(4)} acc=${trainAcc.toFixed(3)} | `
      + `eval: loss=${evalRes.loss.toFixed(4)} top1=${evalRes.top1.toFixed(3)} top3=${evalRes.top3.toFixed(3)}\n`,
    )

    if (evalRes.loss < bestEvalLoss) {
      bestEvalLoss = evalRes.loss
      bestEvalTop1 = evalRes.top1
      bestEvalTop3 = evalRes.top3
      bestEpoch = epoch
      patienceCounter = 0
      mkdirSync(dirname(options.outputCheckpointPath), { recursive: true })
      saveCheckpoint(evalNet, options.outputCheckpointPath, { iteration: epoch, winRate: 0 })
    } else {
      patienceCounter++
      if (patienceCounter >= options.patience) {
        process.stderr.write(`[hamster-train] early stop at epoch ${epoch + 1} (patience ${options.patience})\n`)
        break
      }
    }
  }

  tfNet.dispose()

  process.stderr.write(`[hamster-train] === Done ===\n`)
  process.stderr.write(`[hamster-train] best epoch: ${bestEpoch + 1}\n`)
  process.stderr.write(`[hamster-train] best eval: loss=${bestEvalLoss.toFixed(4)} top1=${bestEvalTop1.toFixed(3)} top3=${bestEvalTop3.toFixed(3)}\n`)
  process.stderr.write(`[hamster-train] checkpoint → ${options.outputCheckpointPath}\n`)

  return {
    numTrain: trainSet.length,
    numEval,
    bestEpoch,
    bestEvalLoss,
    bestEvalTop1,
    bestEvalTop3,
    checkpointPath: options.outputCheckpointPath,
  }
}

function parseCli(): Partial<HamsterTrainerOptions> {
  const opts: Partial<HamsterTrainerOptions> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input': opts.inputJsonl = args[++i]; break
      case '--output': opts.outputCheckpointPath = args[++i]; break
      case '--batch': opts.batchSize = parseInt(args[++i], 10); break
      case '--epochs': opts.epochs = parseInt(args[++i], 10); break
      case '--lr': opts.learningRate = parseFloat(args[++i]); break
      case '--eval-ratio': opts.evalRatio = parseFloat(args[++i]); break
      case '--patience': opts.patience = parseInt(args[++i], 10); break
      case '--seed': opts.seed = parseInt(args[++i], 10); break
      case '--relabel-temperature': opts.relabelTemperature = parseFloat(args[++i]); break
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('hamster-trainer.ts')) {
  trainAndSaveHamster(parseCli()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
