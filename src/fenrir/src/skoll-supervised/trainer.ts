/**
 * Stage 2: skoll 教師あり学習ループ
 *
 * data-collector.ts が出した JSONL を読んで、
 * mason_collective と互換の標準 NN (createTfNetwork) の vote head + trunk を
 * trainSupervisedVote で fresh から学習する。
 *
 * - train/eval split (デフォルト 90/10)
 * - epoch ごとに eval、early stopping (patience)
 * - checkpoint 保存（既存の saveCheckpoint 形式）
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { createMasonBrainNetwork, createMasonBrainTfNetwork } from '../training.ts'
import { saveCheckpoint } from '../ml/checkpoint.ts'
import { SEATS } from '../observation.ts'
import { makeSoftLabel } from './data-collector.ts'
import type { AnyNetwork } from '../ml/nn.ts'

type LoadedSample = {
  observation: Float32Array
  label: Float32Array
  mask: Float32Array
}

export type TrainerOptions = {
  inputJsonl: string
  outputCheckpointPath: string
  batchSize: number
  miniBatchSize: number
  epochs: number
  learningRate: number
  /** train/eval split 比率 (eval ratio) */
  evalRatio: number
  /** 早期停止 patience（連続 N epoch eval loss が改善しなければ停止） */
  patience: number
  /** RNG seed (split shuffle 用) */
  seed: number
  /** 指定すると JSONL の rawWinRates から label/mask を再計算する。データを取り直さず温度スイープ可能 */
  relabelTemperature?: number
  /** hard label の混合比 (0=純 soft, 1=純 hard one-hot)。
   *  hybrid label = (1-α) * soft + α * one_hot(bestExecution)
   *  tied ケースで NN に skoll の tie-break (lowest seat) を学ばせる用 */
  hardLabelMix?: number
}

export const DEFAULT_TRAINER_OPTIONS: TrainerOptions = {
  inputJsonl: 'tmp/skoll-data/samples.jsonl',
  outputCheckpointPath: 'tmp/skoll-trainer/ckpt-skoll/checkpoint.json',
  batchSize: 256,
  miniBatchSize: 64,
  epochs: 30,
  learningRate: 3e-4,
  evalRatio: 0.1,
  patience: 5,
  seed: 42,
}

function loadJsonl(path: string, relabelTemperature?: number, hardLabelMix?: number): LoadedSample[] {
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n').filter(l => l.length > 0)
  const samples: LoadedSample[] = []
  const needRelabel = relabelTemperature !== undefined
  const alpha = hardLabelMix ?? 0
  for (const line of lines) {
    const obj = JSON.parse(line)
    let label: Float32Array
    let mask: Float32Array
    if (needRelabel) {
      const rawWinRates = obj.metadata?.rawWinRates as Array<{ seat: number, winRate: number }> | undefined
      if (rawWinRates && rawWinRates.length > 0) {
        const built = makeSoftLabel(rawWinRates, relabelTemperature!)
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

    if (alpha > 0) {
      const bestExecution = obj.metadata?.bestExecution as number | undefined
      if (bestExecution !== undefined && bestExecution >= 1 && bestExecution <= SEATS) {
        // hybrid: (1-α) * soft + α * one_hot(bestExecution)
        const mixed = new Float32Array(SEATS)
        for (let i = 0; i < SEATS; i++) mixed[i] = (1 - alpha) * label[i]
        mixed[bestExecution - 1] += alpha
        label = mixed
      }
    }

    samples.push({
      observation: Float32Array.from(obj.observation),
      label,
      mask,
    })
  }
  return samples
}

/** Mulberry32 PRNG（決定的シャッフル用） */
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

/** label argmax (soft label の最大確率 seat = skoll bestExecution の近似) */
function argmax(arr: Float32Array): number {
  let bestIdx = 0
  let bestVal = arr[0]
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > bestVal) { bestVal = arr[i]; bestIdx = i }
  }
  return bestIdx
}

/**
 * NN forward → vote logits → masked softmax → top-k 取得。
 * trainSupervisedVote と同じ処理だが gradient なし。
 *
 * 簡易実装: バッチごとに network.forward を呼ぶ（ピュア JS の方が overhead 少ない可能性あり）。
 * ここでは TF network の forwardTrunk + perSeatLogits を直接呼ぶのは public API 化されていないため、
 * trainSupervisedVote と同じ tensor 経路を使う簡略 eval を実装する。
 */
function evalAccuracy(
  net: AnyNetwork,
  samples: LoadedSample[],
  batchSize: number,
): { loss: number, top1: number, top3: number } {
  if (samples.length === 0) return { loss: 0, top1: 0, top3: 0 }

  let totalLoss = 0
  let totalTop1 = 0
  let totalTop3 = 0
  let totalSamples = 0

  for (let start = 0; start < samples.length; start += batchSize) {
    const batch = samples.slice(start, Math.min(start + batchSize, samples.length))
    // trainSupervisedVote を eval モードで呼ぶための簡略策: 1 epoch の forward + loss を計算するために
    // trainSupervisedVote を呼んでしまうと weights が更新される。
    // 代わりに pure JS network.forward 相当の処理を tf.tidy で実装するのは複雑なので、
    // ここでは「1 ステップだけ」super-low LR (0) ではなく、forward だけ手動実装する。
    //
    // 簡易: argmax(label) と argmax(masked logits) の一致で accuracy を算出
    // loss は cross-entropy を tensorflow なしで計算
    const result = forwardOnly(net, batch)
    totalLoss += result.loss * batch.length
    totalTop1 += result.top1 * batch.length
    totalTop3 += result.top3 * batch.length
    totalSamples += batch.length
  }

  return {
    loss: totalLoss / totalSamples,
    top1: totalTop1 / totalSamples,
    top3: totalTop3 / totalSamples,
  }
}

/**
 * バッチを forward して loss + top-k accuracy を計算（gradient なし）。
 * net.forward を 1 サンプルずつ呼ぶ素直な実装。
 */
function forwardOnly(
  net: AnyNetwork,
  batch: LoadedSample[],
): { loss: number, top1: number, top3: number } {
  let totalLoss = 0
  let totalTop1 = 0
  let totalTop3 = 0
  for (const s of batch) {
    const result = net.forward(s.observation)
    const voteLogits = result.policies.get('vote')
    if (!voteLogits) continue

    // mask 適用
    const masked = new Float32Array(SEATS)
    for (let i = 0; i < SEATS; i++) masked[i] = voteLogits[i] + s.mask[i]
    // softmax
    let maxLogit = -Infinity
    for (let i = 0; i < SEATS; i++) if (masked[i] > maxLogit) maxLogit = masked[i]
    let expSum = 0
    const probs = new Float32Array(SEATS)
    for (let i = 0; i < SEATS; i++) {
      probs[i] = Math.exp(masked[i] - maxLogit)
      expSum += probs[i]
    }
    for (let i = 0; i < SEATS; i++) probs[i] /= expSum

    // CE loss
    let loss = 0
    for (let i = 0; i < SEATS; i++) {
      if (s.label[i] > 0) loss -= s.label[i] * Math.log(probs[i] + 1e-8)
    }
    totalLoss += loss

    // top-k vs label argmax
    const labelIdx = argmax(s.label)
    const probIdx = argmax(probs)
    if (probIdx === labelIdx) totalTop1++

    const sortedIdx = Array.from({ length: SEATS }, (_, i) => i).sort((a, b) => probs[b] - probs[a])
    if (sortedIdx.slice(0, 3).includes(labelIdx)) totalTop3++
  }
  const n = batch.length
  return {
    loss: n > 0 ? totalLoss / n : 0,
    top1: n > 0 ? totalTop1 / n : 0,
    top3: n > 0 ? totalTop3 / n : 0,
  }
}

export async function trainAndSave(opts: Partial<TrainerOptions> = {}): Promise<{
  numTrain: number
  numEval: number
  bestEpoch: number
  bestEvalLoss: number
  bestEvalTop1: number
  bestEvalTop3: number
  checkpointPath: string
}> {
  const options = { ...DEFAULT_TRAINER_OPTIONS, ...opts }
  process.stderr.write(`[skoll-train] loading ${options.inputJsonl}\n`)
  if (options.relabelTemperature !== undefined) {
    process.stderr.write(`[skoll-train] relabel-temperature=${options.relabelTemperature} (rawWinRates から再計算)\n`)
  }
  if (options.hardLabelMix && options.hardLabelMix > 0) {
    process.stderr.write(`[skoll-train] hard-label-mix=${options.hardLabelMix} (label = (1-α) * soft + α * one_hot(bestExecution))\n`)
  }
  const all = loadJsonl(options.inputJsonl, options.relabelTemperature, options.hardLabelMix)
  process.stderr.write(`[skoll-train] loaded ${all.length} samples\n`)

  const rng = makeRng(options.seed)
  shuffleInPlace(all, rng)

  const numEval = Math.max(1, Math.floor(all.length * options.evalRatio))
  const evalSet = all.slice(0, numEval)
  const trainSet = all.slice(numEval)
  process.stderr.write(`[skoll-train] split: train=${trainSet.length}, eval=${numEval}\n`)

  // brain-battle の mason_brain と互換のアーキテクチャで学習する。
  // input=MASON_COLLECTIVE_OBSERVATION_SIZE, vote head のみ。
  const tfNet = createMasonBrainTfNetwork(options.learningRate)
  const evalNet = createMasonBrainNetwork()

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

    // eval: TF → Pure JS 同期 → forward
    evalNet.loadWeights(tfNet.cloneWeights())
    const evalRes = evalAccuracy(evalNet, evalSet, options.batchSize)

    process.stderr.write(
      `[skoll-train] epoch ${epoch + 1}/${options.epochs} `
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
        process.stderr.write(`[skoll-train] early stop at epoch ${epoch + 1} (patience ${options.patience})\n`)
        break
      }
    }
  }

  tfNet.dispose()

  process.stderr.write(`[skoll-train] === Done ===\n`)
  process.stderr.write(`[skoll-train] best epoch: ${bestEpoch + 1}\n`)
  process.stderr.write(`[skoll-train] best eval: loss=${bestEvalLoss.toFixed(4)} top1=${bestEvalTop1.toFixed(3)} top3=${bestEvalTop3.toFixed(3)}\n`)
  process.stderr.write(`[skoll-train] checkpoint → ${options.outputCheckpointPath}\n`)

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

function parseCli(): Partial<TrainerOptions> {
  const opts: Partial<TrainerOptions> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input': opts.inputJsonl = args[++i]; break
      case '--output': opts.outputCheckpointPath = args[++i]; break
      case '--batch': opts.batchSize = parseInt(args[++i], 10); break
      case '--mini-batch': opts.miniBatchSize = parseInt(args[++i], 10); break
      case '--epochs': opts.epochs = parseInt(args[++i], 10); break
      case '--lr': opts.learningRate = parseFloat(args[++i]); break
      case '--eval-ratio': opts.evalRatio = parseFloat(args[++i]); break
      case '--patience': opts.patience = parseInt(args[++i], 10); break
      case '--seed': opts.seed = parseInt(args[++i], 10); break
      case '--relabel-temperature': opts.relabelTemperature = parseFloat(args[++i]); break
      case '--hard-label-mix': opts.hardLabelMix = parseFloat(args[++i]); break
      case '--help':
        process.stderr.write('Usage: trainer.ts [--input PATH] [--output PATH] [--batch N] [--mini-batch N] [--epochs N] [--lr R] [--eval-ratio R] [--patience N] [--seed S] [--relabel-temperature T] [--hard-label-mix A]\n')
        process.exit(0)
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('trainer.ts')) {
  trainAndSave(parseCli()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
