/**
 * Win-Rate Estimator 学習ループ + CLI
 *
 * Usage:
 *   node --experimental-strip-types src/fenrir/src/ml/winrate-training.ts --collect --games 10000
 *   node --experimental-strip-types src/fenrir/src/ml/winrate-training.ts --train --epochs 30
 *   node --experimental-strip-types src/fenrir/src/ml/winrate-training.ts --eval
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { collectWinrateBatchData, DEFAULT_14D_NEKO_CONFIG, type WinrateSample } from './winrate-data.ts'
import { DEFAULT_WINRATE_CONFIG, type WinrateNetworkConfig } from './winrate-network.ts'
import { evaluateWinrate, formatWinrateMetrics, marginalBaselineBrierScore, type WinrateMetrics } from './winrate-eval.ts'

// TF.js は GPU 環境でのみ利用可能。train/eval 時に遅延 import する
async function importTfWinrateNetwork() {
  const { TfWinrateNetwork } = await import('./nn-tf-winrate.ts')
  return TfWinrateNetwork
}

// ============================================================
// Checkpoint (WRE専用: AnyNetworkに依存しない)
// ============================================================

type WinrateCheckpointData = {
  version: number
  config: WinrateNetworkConfig
  weights: Record<string, string>
  metadata: {
    epoch: number
    brierScore: number
    timestamp: string
    trainGames: number
  }
}

function float32ToBase64(arr: Float32Array): string {
  const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
  return buf.toString('base64')
}

function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

function saveWinrateCheckpoint(
  network: { cloneWeights(): Map<string, Float32Array> },
  config: WinrateNetworkConfig,
  path: string,
  metadata: { epoch: number, brierScore: number, trainGames: number },
): void {
  const weights: Record<string, string> = {}
  for (const [name, arr] of network.cloneWeights()) {
    weights[name] = float32ToBase64(arr)
  }
  const data: WinrateCheckpointData = {
    version: 1,
    config,
    weights,
    metadata: { ...metadata, timestamp: new Date().toISOString() },
  }
  const dir = path.substring(0, path.lastIndexOf('/'))
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data))
}

function loadWinrateCheckpoint(
  network: { loadWeights(w: Map<string, Float32Array>): void },
  path: string,
): WinrateCheckpointData {
  const raw = readFileSync(path, 'utf-8')
  const data: WinrateCheckpointData = JSON.parse(raw)
  const weights = new Map<string, Float32Array>()
  for (const [name, b64] of Object.entries(data.weights)) {
    weights.set(name, base64ToFloat32(b64))
  }
  network.loadWeights(weights)
  return data
}

// ============================================================
// Data serialization
// ============================================================

type SerializedDataset = {
  observations: string[]  // base64
  labels: string[]        // base64
  roles: string[]         // SystemRole
  days: number[]
  seats: number[]
  stats: { villageWins: number, wolfWins: number, foxWins: number }
}

function serializeDataset(samples: WinrateSample[], stats: { villageWins: number, wolfWins: number, foxWins: number }): SerializedDataset {
  return {
    observations: samples.map(s => float32ToBase64(s.observation)),
    labels: samples.map(s => float32ToBase64(s.gameResult)),
    roles: samples.map(s => s.role),
    days: samples.map(s => s.day),
    seats: samples.map(s => s.seat),
    stats,
  }
}

function deserializeDataset(data: SerializedDataset): { samples: { observation: Float32Array, gameResult: Float32Array, role: string, day: number, seat: number }[], stats: typeof data.stats } {
  const samples = data.observations.map((obs, i) => ({
    observation: base64ToFloat32(obs),
    gameResult: base64ToFloat32(data.labels[i]),
    role: data.roles[i],
    day: data.days[i],
    seat: data.seats[i],
  }))
  return { samples, stats: data.stats }
}

// ============================================================
// Training
// ============================================================

function shuffleArray<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

async function trainWinrate(opts: {
  dataPath: string
  checkpointDir: string
  epochs: number
  batchSize: number
  learningRate: number
  focalGamma: number
  config: WinrateNetworkConfig
}): Promise<WinrateMetrics> {
  console.log(`Loading data from ${opts.dataPath}...`)
  const raw = readFileSync(opts.dataPath, 'utf-8')
  const dataset = deserializeDataset(JSON.parse(raw))
  const allSamples = dataset.samples
  console.log(`Loaded ${allSamples.length} samples (${JSON.stringify(dataset.stats)})`)

  // Train/test split (80/20)
  const shuffled = shuffleArray([...allSamples])
  const splitIdx = Math.floor(shuffled.length * 0.8)
  const trainSamples = shuffled.slice(0, splitIdx)
  const testSamples = shuffled.slice(splitIdx)
  console.log(`Train: ${trainSamples.length}, Test: ${testSamples.length}`)

  // Create network (TF.js 遅延 import)
  const TfWinrateNetwork = await importTfWinrateNetwork()
  const network = new TfWinrateNetwork(opts.config, opts.learningRate)
  console.log(`Network params: ${network.totalParams}`)

  // Training loop
  const numBatches = Math.ceil(trainSamples.length / opts.batchSize)

  for (let epoch = 0; epoch < opts.epochs; epoch++) {
    const epochSamples = shuffleArray([...trainSamples])
    let epochLoss = 0
    let epochBrier = 0

    for (let b = 0; b < numBatches; b++) {
      const start = b * opts.batchSize
      const end = Math.min(start + opts.batchSize, epochSamples.length)
      const batch = epochSamples.slice(start, end)

      const { loss, brierScore } = network.trainBatch(
        batch.map(s => s.observation),
        batch.map(s => s.gameResult),
        opts.focalGamma,
      )
      epochLoss += loss
      epochBrier += brierScore
    }

    const avgLoss = epochLoss / numBatches
    const avgBrier = epochBrier / numBatches

    if ((epoch + 1) % 5 === 0 || epoch === 0 || epoch === opts.epochs - 1) {
      // Evaluate on test set
      const testPreds = network.forwardBatch(testSamples.map(s => s.observation))
      const testLabels = testSamples.map(s => s.gameResult)
      const metrics = evaluateWinrate(testPreds, testLabels)

      console.log(`Epoch ${epoch + 1}/${opts.epochs}: train_loss=${avgLoss.toFixed(4)} train_brier=${avgBrier.toFixed(4)} | test_brier=${metrics.brierScore.toFixed(4)} test_acc=${(metrics.accuracy * 100).toFixed(1)}%`)
    } else {
      console.log(`Epoch ${epoch + 1}/${opts.epochs}: train_loss=${avgLoss.toFixed(4)} train_brier=${avgBrier.toFixed(4)}`)
    }
  }

  // Final evaluation
  console.log('\n=== Final Evaluation ===')
  const testPreds = network.forwardBatch(testSamples.map(s => s.observation))
  const testLabels = testSamples.map(s => s.gameResult)
  const finalMetrics = evaluateWinrate(testPreds, testLabels)
  const baselineBrier = marginalBaselineBrierScore(finalMetrics.perClassCount)
  console.log(formatWinrateMetrics(finalMetrics, baselineBrier))

  // PoC Go/No-Go
  console.log('\n=== PoC Go/No-Go ===')
  console.log(`Brier Score: ${finalMetrics.brierScore.toFixed(4)} (target: < 0.35, baseline: ${baselineBrier.toFixed(4)})`)
  console.log(`Calibration slope: ${finalMetrics.calibrationSlope.toFixed(3)} (target: 0.6 ~ 1.4)`)
  console.log(`Accuracy: ${(finalMetrics.accuracy * 100).toFixed(1)}% (target: > 55%)`)

  const brierPass = finalMetrics.brierScore < 0.35
  const calibPass = finalMetrics.calibrationSlope >= 0.6 && finalMetrics.calibrationSlope <= 1.4
  const accPass = finalMetrics.accuracy > 0.55

  if (brierPass && calibPass && accPass) {
    console.log('>>> GO: All criteria passed')
  } else {
    const failures = []
    if (!brierPass) failures.push('Brier')
    if (!calibPass) failures.push('Calibration')
    if (!accPass) failures.push('Accuracy')
    console.log(`>>> NO-GO: Failed criteria: ${failures.join(', ')}`)
  }

  // Save checkpoint
  if (!existsSync(opts.checkpointDir)) mkdirSync(opts.checkpointDir, { recursive: true })
  const ckptPath = `${opts.checkpointDir}/winrate-final.json`
  saveWinrateCheckpoint(network, opts.config, ckptPath, {
    epoch: opts.epochs,
    brierScore: finalMetrics.brierScore,
    trainGames: dataset.stats.villageWins + dataset.stats.wolfWins + dataset.stats.foxWins,
  })
  console.log(`Checkpoint saved: ${ckptPath}`)

  network.dispose()
  return finalMetrics
}

// ============================================================
// Evaluate (standalone)
// ============================================================

async function evalWinrate(opts: {
  dataPath: string
  checkpointPath: string
  config: WinrateNetworkConfig
}): Promise<void> {
  const raw = readFileSync(opts.dataPath, 'utf-8')
  const dataset = deserializeDataset(JSON.parse(raw))

  const TfWinrateNetwork = await importTfWinrateNetwork()
  const network = new TfWinrateNetwork(opts.config)
  const ckptData = loadWinrateCheckpoint(network, opts.checkpointPath)
  console.log(`Loaded checkpoint: epoch=${ckptData.metadata.epoch}, brierScore=${ckptData.metadata.brierScore.toFixed(4)}`)

  const preds = network.forwardBatch(dataset.samples.map(s => s.observation))
  const labels = dataset.samples.map(s => s.gameResult)
  const metrics = evaluateWinrate(preds, labels)
  const baselineBrier = marginalBaselineBrierScore(metrics.perClassCount)
  console.log(formatWinrateMetrics(metrics, baselineBrier))

  // Day別の精度
  console.log('\n=== Per-day Brier Score ===')
  const byDay = new Map<number, { preds: Float32Array[], labels: Float32Array[] }>()
  for (let i = 0; i < dataset.samples.length; i++) {
    const day = dataset.samples[i].day
    if (!byDay.has(day)) byDay.set(day, { preds: [], labels: [] })
    const d = byDay.get(day)!
    d.preds.push(preds[i])
    d.labels.push(labels[i])
  }
  for (const [day, data] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const dayMetrics = evaluateWinrate(data.preds, data.labels)
    console.log(`  Day ${day}: brier=${dayMetrics.brierScore.toFixed(4)} acc=${(dayMetrics.accuracy * 100).toFixed(1)}% (n=${data.preds.length})`)
  }

  network.dispose()
}

// ============================================================
// CLI
// ============================================================

const DEFAULT_DIR = 'tmp/winrate'
const DEFAULT_DATA_PATH = `${DEFAULT_DIR}/data.json`
const DEFAULT_CKPT_DIR = `${DEFAULT_DIR}/checkpoints`
const DEFAULT_CKPT_PATH = `${DEFAULT_CKPT_DIR}/winrate-final.json`

async function main() {
  const { values } = parseArgs({
    options: {
      collect: { type: 'boolean', default: false },
      train: { type: 'boolean', default: false },
      eval: { type: 'boolean', default: false },
      games: { type: 'string', default: '10000' },
      epochs: { type: 'string', default: '30' },
      'batch-size': { type: 'string', default: '256' },
      lr: { type: 'string', default: '3e-4' },
      'focal-gamma': { type: 'string', default: '2.0' },
      'data-path': { type: 'string', default: DEFAULT_DATA_PATH },
      'checkpoint-dir': { type: 'string', default: DEFAULT_CKPT_DIR },
      'checkpoint-path': { type: 'string', default: DEFAULT_CKPT_PATH },
    },
    strict: true,
  })

  if (values.collect) {
    const numGames = parseInt(values.games!)
    const dataPath = values['data-path']!
    console.log(`Collecting data from ${numGames} games...`)

    const startTime = Date.now()
    const { samples, stats } = await collectWinrateBatchData(
      DEFAULT_14D_NEKO_CONFIG,
      numGames,
      100000,
      (i) => {
        if ((i + 1) % 100 === 0) {
          const elapsed = (Date.now() - startTime) / 1000
          const gps = (i + 1) / elapsed
          console.log(`  ${i + 1}/${numGames} games (${gps.toFixed(1)} games/sec)`)
        }
      },
    )

    console.log(`Collected ${samples.length} samples from ${numGames} games`)
    console.log(`Results: village=${stats.villageWins} wolf=${stats.wolfWins} fox=${stats.foxWins}`)
    console.log(`Win rates: village=${(stats.villageWins / numGames * 100).toFixed(1)}% wolf=${(stats.wolfWins / numGames * 100).toFixed(1)}% fox=${(stats.foxWins / numGames * 100).toFixed(1)}%`)

    if (!existsSync(DEFAULT_DIR)) mkdirSync(DEFAULT_DIR, { recursive: true })
    const serialized = serializeDataset(samples, stats)
    writeFileSync(dataPath, JSON.stringify(serialized))
    console.log(`Data saved: ${dataPath} (${(Buffer.byteLength(JSON.stringify(serialized)) / 1024 / 1024).toFixed(1)} MB)`)
  }

  if (values.train) {
    await trainWinrate({
      dataPath: values['data-path']!,
      checkpointDir: values['checkpoint-dir']!,
      epochs: parseInt(values.epochs!),
      batchSize: parseInt(values['batch-size']!),
      learningRate: parseFloat(values.lr!),
      focalGamma: parseFloat(values['focal-gamma']!),
      config: DEFAULT_WINRATE_CONFIG,
    })
  }

  if (values.eval) {
    await evalWinrate({
      dataPath: values['data-path']!,
      checkpointPath: values['checkpoint-path']!,
      config: DEFAULT_WINRATE_CONFIG,
    })
  }

  if (!values.collect && !values.train && !values.eval) {
    console.log('Usage:')
    console.log('  --collect --games N    Collect training data from heuristic games')
    console.log('  --train --epochs N     Train WRE model')
    console.log('  --eval                 Evaluate saved model')
    console.log('')
    console.log('Options:')
    console.log('  --data-path PATH       Data file path (default: tmp/winrate/data.json)')
    console.log('  --checkpoint-dir DIR   Checkpoint directory (default: tmp/winrate/checkpoints)')
    console.log('  --checkpoint-path PATH Checkpoint file (default: tmp/winrate/checkpoints/winrate-final.json)')
    console.log('  --batch-size N         Training batch size (default: 256)')
    console.log('  --lr RATE              Learning rate (default: 3e-4)')
    console.log('  --focal-gamma G        Focal loss gamma (default: 2.0, 0=standard CE)')
  }
}

main().catch(console.error)
