/**
 * skoll-multiday-NN 訓練関数 (CLI と orchestrate runner から共有)。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { TfMultidaySkollNetwork } from '../fenrir/src/ml/nn-tf-multiday-skoll.ts'
import {
  DEFAULT_MULTIDAY_SKOLL_CONFIG,
  tokenizeSkollInput,
  CLS_FEATURES,
  SEAT_FEATURES,
  MAX_SEAT,
} from '../fenrir/src/ml/multiday-skoll-network.ts'

type RawSample = {
  game_seed: number
  day: number
  viewer: { seat: number, role: string } | null
  alive_seats: number[]
  possibilities: number[]
  setup: Record<string, number>
  max_seat: number
  max_surviving_nv: number
  labels: { seat: number, winRate: number }[]
}

type PreparedSample = {
  cls: Float32Array
  seat: Float32Array
  label: Float32Array
  mask: Float32Array
}

export type TrainMultidayOptions = {
  dataPath: string
  outPath: string
  epochs: number
  batchSize: number
  learningRate: number
  patience: number
  evalRatio: number
  seed: number
}

export type TrainMultidayResult = {
  bestEvalMse: number
  bestEvalMae: number
  finalEpoch: number
  trainSize: number
  evalSize: number
}

function loadAndPrepare(path: string): PreparedSample[] {
  const raw = readFileSync(path, 'utf-8')
  const lines = raw.split('\n').filter(l => l.length > 0)
  const samples: PreparedSample[] = []
  for (const line of lines) {
    const obj: RawSample = JSON.parse(line)
    const { cls, seats } = tokenizeSkollInput({
      possibilities: obj.possibilities,
      aliveSeats: obj.alive_seats,
      setup: obj.setup,
      day: obj.day,
      maxSurvivingNV: obj.max_surviving_nv,
    })
    const label = new Float32Array(MAX_SEAT)
    const mask = new Float32Array(MAX_SEAT)
    for (const { seat, winRate } of obj.labels) {
      const idx = seat - 1
      if (idx >= 0 && idx < MAX_SEAT) {
        label[idx] = winRate
        mask[idx] = 1
      }
    }
    samples.push({ cls, seat: seats, label, mask })
  }
  return samples
}

function buildBatch(samples: PreparedSample[], indices: number[]): {
  cls: Float32Array, seat: Float32Array, label: Float32Array, mask: Float32Array
} {
  const n = indices.length
  const cls = new Float32Array(n * CLS_FEATURES)
  const seat = new Float32Array(n * MAX_SEAT * SEAT_FEATURES)
  const label = new Float32Array(n * MAX_SEAT)
  const mask = new Float32Array(n * MAX_SEAT)
  for (let i = 0; i < n; i++) {
    const s = samples[indices[i]]
    cls.set(s.cls, i * CLS_FEATURES)
    seat.set(s.seat, i * MAX_SEAT * SEAT_FEATURES)
    label.set(s.label, i * MAX_SEAT)
    mask.set(s.mask, i * MAX_SEAT)
  }
  return { cls, seat, label, mask }
}

function shuffleIndices(arr: number[], rng: () => number): number[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function float32ToBase64(arr: Float32Array): string {
  const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
  return buf.toString('base64')
}

function saveCheckpoint(
  network: TfMultidaySkollNetwork,
  path: string,
  metadata: Record<string, unknown>,
): void {
  const weights: Record<string, string> = {}
  for (const [name, arr] of network.cloneWeights()) {
    weights[name] = float32ToBase64(arr)
  }
  const data = {
    version: 1,
    type: 'multiday-skoll',
    config: network.config,
    weights,
    metadata: { ...metadata, timestamp: new Date().toISOString() },
  }
  const dir = dirname(path)
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data))
}

export async function trainMultiday(options: TrainMultidayOptions): Promise<TrainMultidayResult> {
  const t0 = Date.now()
  console.log('[trainMultiday] loading dataset...')
  const all = loadAndPrepare(options.dataPath)
  console.log(`[trainMultiday] loaded ${all.length} samples in ${Date.now() - t0}ms`)

  if (all.length === 0) throw new Error('no samples loaded')

  let rngState = options.seed
  const rng = () => {
    rngState = (rngState * 1664525 + 1013904223) | 0
    return ((rngState >>> 0) / 0xFFFFFFFF)
  }
  const allIndices = shuffleIndices(all.map((_, i) => i), rng)
  const evalCount = Math.max(1, Math.floor(allIndices.length * options.evalRatio))
  const evalIndices = allIndices.slice(0, evalCount)
  const trainIndices = allIndices.slice(evalCount)
  console.log(`[trainMultiday] split: train=${trainIndices.length} eval=${evalIndices.length}`)

  const network = new TfMultidaySkollNetwork(DEFAULT_MULTIDAY_SKOLL_CONFIG, options.learningRate)
  console.log(`[trainMultiday] network: ${JSON.stringify(DEFAULT_MULTIDAY_SKOLL_CONFIG)}`)

  let bestMse = Infinity
  let bestMae = Infinity
  let bestEpoch = 0
  let patienceCount = 0
  let lastEpoch = 0

  for (let epoch = 1; epoch <= options.epochs; epoch++) {
    lastEpoch = epoch
    const epochStart = Date.now()
    const shuffled = shuffleIndices(trainIndices, rng)
    let trainLossSum = 0
    let batchCount = 0
    for (let i = 0; i < shuffled.length; i += options.batchSize) {
      const batchIdx = shuffled.slice(i, i + options.batchSize)
      if (batchIdx.length === 0) continue
      const batch = buildBatch(all, batchIdx)
      const loss = network.trainStep(batch.cls, batch.seat, batch.label, batch.mask, batchIdx.length)
      trainLossSum += loss
      batchCount++
    }
    const trainLoss = trainLossSum / Math.max(batchCount, 1)

    let evalMseSum = 0
    let evalMaeSum = 0
    let evalN = 0
    for (let i = 0; i < evalIndices.length; i += options.batchSize) {
      const batchIdx = evalIndices.slice(i, i + options.batchSize)
      if (batchIdx.length === 0) continue
      const batch = buildBatch(all, batchIdx)
      const r = network.evalBatch(batch.cls, batch.seat, batch.label, batch.mask, batchIdx.length)
      evalMseSum += r.mse * r.n
      evalMaeSum += r.mae * r.n
      evalN += r.n
    }
    const evalMse = evalMseSum / Math.max(evalN, 1)
    const evalMae = evalMaeSum / Math.max(evalN, 1)

    const epochMs = Date.now() - epochStart
    console.log(`[epoch ${epoch}/${options.epochs}] train_loss=${trainLoss.toFixed(5)} eval_mse=${evalMse.toFixed(5)} eval_mae=${evalMae.toFixed(5)} (${epochMs}ms)`)

    if (evalMse < bestMse) {
      bestMse = evalMse
      bestMae = evalMae
      bestEpoch = epoch
      patienceCount = 0
      saveCheckpoint(network, options.outPath, {
        epoch,
        train_loss: trainLoss,
        eval_mse: evalMse,
        eval_mae: evalMae,
        train_size: trainIndices.length,
        eval_size: evalIndices.length,
      })
    } else {
      patienceCount++
      if (patienceCount >= options.patience) {
        console.log(`[trainMultiday] early stop at epoch ${epoch} (best epoch=${bestEpoch} eval_mse=${bestMse.toFixed(5)})`)
        break
      }
    }
  }

  console.log(`\n[trainMultiday] done. best eval_mse=${bestMse.toFixed(5)} eval_mae=${bestMae.toFixed(5)} elapsed=${((Date.now() - t0) / 60000).toFixed(2)}min`)

  return {
    bestEvalMse: bestMse,
    bestEvalMae: bestMae,
    finalEpoch: lastEpoch,
    trainSize: trainIndices.length,
    evalSize: evalIndices.length,
  }
}
