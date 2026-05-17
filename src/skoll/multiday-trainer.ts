/**
 * skoll-multiday-NN 訓練スクリプト。
 *
 * generate-multiday-dataset.ts が生成した jsonl を読み込み、
 * TfMultidaySkollNetwork (~100K params, Seat Transformer) を SL pretrain。
 * checkpoint を JSON で保存し、 Pure JS 推論 (MultidaySkollNetwork.loadWeights)
 * で再利用可能。
 *
 * 起動 (例):
 *   node --experimental-strip-types src/skoll/multiday-trainer.ts \
 *     --data data/skoll-multiday-1k.jsonl \
 *     --out tmp/multiday-skoll/ckpt.json \
 *     --epochs 30 --batch 128 --lr 3e-4
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

// ---- データ型 ----
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
  label: Float32Array  // MAX_SEAT dim
  mask: Float32Array   // MAX_SEAT dim (1 if alive)
}

// ---- データ読込 + 前処理 ----
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
      const idx = seat - 1  // 1-indexed → 0-indexed
      if (idx >= 0 && idx < MAX_SEAT) {
        label[idx] = winRate
        mask[idx] = 1
      }
    }

    samples.push({ cls, seat: seats, label, mask })
  }
  return samples
}

// ---- batch 構築 ----
function buildBatch(samples: PreparedSample[], indices: number[]): {
  cls: Float32Array
  seat: Float32Array
  label: Float32Array
  mask: Float32Array
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

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// ---- checkpoint save (TF.js weights → JSON file) ----
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

// ---- CLI args ----
function parseArg(name: string): string | null {
  const prefix = `--${name}=`
  const found = process.argv.find(a => a.startsWith(prefix))
  if (found) return found.slice(prefix.length)
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1]
  return null
}

const DATA_PATH = parseArg('data') ?? 'data/skoll-multiday-1k.jsonl'
const OUT_PATH = parseArg('out') ?? 'tmp/multiday-skoll/ckpt.json'
const EPOCHS = parseInt(parseArg('epochs') ?? '30', 10)
const BATCH = parseInt(parseArg('batch') ?? '128', 10)
const LR = parseFloat(parseArg('lr') ?? '3e-4')
const EVAL_RATIO = parseFloat(parseArg('eval-ratio') ?? '0.1')
const SEED = parseInt(parseArg('seed') ?? '42', 10)
const PATIENCE = parseInt(parseArg('patience') ?? '5', 10)

// ---- main ----
async function main(): Promise<void> {
  console.log(`[multiday-trainer] data=${DATA_PATH} out=${OUT_PATH}`)
  console.log(`[multiday-trainer] epochs=${EPOCHS} batch=${BATCH} lr=${LR} eval_ratio=${EVAL_RATIO}`)

  const t0 = Date.now()
  console.log('[multiday-trainer] loading dataset...')
  const all = loadAndPrepare(DATA_PATH)
  console.log(`[multiday-trainer] loaded ${all.length} samples in ${Date.now() - t0}ms`)

  if (all.length === 0) {
    console.error('[multiday-trainer] no samples loaded')
    process.exit(1)
  }

  // shuffle + split
  let rngState = SEED
  const rng = () => {
    rngState = (rngState * 1664525 + 1013904223) | 0
    return ((rngState >>> 0) / 0xFFFFFFFF)
  }
  const allIndices = shuffle(all.map((_, i) => i), rng)
  const evalCount = Math.max(1, Math.floor(allIndices.length * EVAL_RATIO))
  const evalIndices = allIndices.slice(0, evalCount)
  const trainIndices = allIndices.slice(evalCount)
  console.log(`[multiday-trainer] split: train=${trainIndices.length} eval=${evalIndices.length}`)

  // build network
  const network = new TfMultidaySkollNetwork(DEFAULT_MULTIDAY_SKOLL_CONFIG, LR)
  console.log(`[multiday-trainer] network: ${JSON.stringify(DEFAULT_MULTIDAY_SKOLL_CONFIG)}`)

  // training loop
  let bestMse = Infinity
  let patienceCount = 0

  for (let epoch = 1; epoch <= EPOCHS; epoch++) {
    const epochStart = Date.now()
    const shuffled = shuffle(trainIndices, rng)
    let trainLossSum = 0
    let batchCount = 0
    for (let i = 0; i < shuffled.length; i += BATCH) {
      const batchIdx = shuffled.slice(i, i + BATCH)
      if (batchIdx.length === 0) continue
      const batch = buildBatch(all, batchIdx)
      const loss = network.trainStep(batch.cls, batch.seat, batch.label, batch.mask, batchIdx.length)
      trainLossSum += loss
      batchCount++
    }
    const trainLoss = trainLossSum / Math.max(batchCount, 1)

    // eval
    let evalMseSum = 0
    let evalMaeSum = 0
    let evalN = 0
    for (let i = 0; i < evalIndices.length; i += BATCH) {
      const batchIdx = evalIndices.slice(i, i + BATCH)
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
    console.log(`[epoch ${epoch}/${EPOCHS}] train_loss=${trainLoss.toFixed(5)} eval_mse=${evalMse.toFixed(5)} eval_mae=${evalMae.toFixed(5)} (${epochMs}ms)`)

    if (evalMse < bestMse) {
      bestMse = evalMse
      patienceCount = 0
      saveCheckpoint(network, OUT_PATH, {
        epoch,
        train_loss: trainLoss,
        eval_mse: evalMse,
        eval_mae: evalMae,
        train_size: trainIndices.length,
        eval_size: evalIndices.length,
      })
    } else {
      patienceCount++
      if (patienceCount >= PATIENCE) {
        console.log(`[multiday-trainer] early stop at epoch ${epoch} (best eval_mse=${bestMse.toFixed(5)})`)
        break
      }
    }
  }

  console.log(`\n[done] best eval_mse=${bestMse.toFixed(5)} ckpt=${OUT_PATH} elapsed=${((Date.now() - t0) / 60000).toFixed(2)}min`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
