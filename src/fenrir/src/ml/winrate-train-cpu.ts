/**
 * Win-Rate Estimator CPU学習 (TF.js不要)
 *
 * フラットMLP (1209 → 128 → 64 → 3) で勝率予測を学習する。
 * Transformer版のPoC検証として、データパイプラインと評価指標の動作確認用。
 *
 * Usage:
 *   node --experimental-strip-types src/fenrir/src/ml/winrate-train-cpu.ts [--epochs 30] [--data-path path]
 */

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { DenseLayer, softmax } from './nn.ts'
import { OBSERVATION_SIZE } from '../observation.ts'
import { evaluateWinrate, formatWinrateMetrics, marginalBaselineBrierScore } from './winrate-eval.ts'
import { NUM_CLASSES } from './winrate-network.ts'

// ============================================================
// MLP Model
// ============================================================

class WinrateMLP {
  private layers: DenseLayer[]

  constructor() {
    this.layers = [
      new DenseLayer(OBSERVATION_SIZE, 128),
      new DenseLayer(128, 64),
      new DenseLayer(64, NUM_CLASSES),
    ]
  }

  forward(obs: Float32Array): Float32Array {
    let x = obs
    // Hidden layers with ReLU
    for (let i = 0; i < this.layers.length - 1; i++) {
      const raw = this.layers[i].forward(x)
      x = new Float32Array(raw.length)
      for (let j = 0; j < raw.length; j++) x[j] = raw[j] > 0 ? raw[j] : 0  // ReLU
    }
    // Output layer → softmax
    const logits = this.layers[this.layers.length - 1].forward(x)
    return softmax(logits)
  }

  /** 逆伝播: focal cross-entropy の勾配を計算して蓄積 */
  backward(probs: Float32Array, label: Float32Array, focalGamma: number): void {
    // d(focal CE)/d(logits) = probs - label (simplified for softmax + CE)
    // For focal: weight = (1 - p_correct)^gamma
    let pCorrect = 0
    for (let c = 0; c < NUM_CLASSES; c++) pCorrect += probs[c] * label[c]
    const focalWeight = focalGamma > 0 ? Math.pow(1 - pCorrect, focalGamma) : 1

    // Gradient of CE w.r.t. logits (pre-softmax) = probs - label
    const gradLogits = new Float32Array(NUM_CLASSES)
    for (let c = 0; c < NUM_CLASSES; c++) {
      gradLogits[c] = focalWeight * (probs[c] - label[c])
    }

    // Backward through layers (reverse order)
    let grad = this.layers[this.layers.length - 1].backward(gradLogits)

    for (let i = this.layers.length - 2; i >= 0; i--) {
      // ReLU backward
      const output = this.layers[i].lastOutput!
      const reluGrad = new Float32Array(grad.length)
      for (let j = 0; j < grad.length; j++) {
        reluGrad[j] = output[j] > 0 ? grad[j] : 0
      }
      grad = this.layers[i].backward(reluGrad)
    }
  }

  /** Adam update */
  update(lr: number, adam: AdamState): void {
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i]
      adamUpdate(layer.weights, layer.weightGrads, adam, `w${i}`, lr)
      adamUpdate(layer.biases, layer.biasGrads, adam, `b${i}`, lr)
      layer.zeroGrad()
    }
  }

  get totalParams(): number {
    return this.layers.reduce((sum, l) => sum + l.paramCount, 0)
  }
}

// ============================================================
// Adam optimizer
// ============================================================

type AdamState = {
  t: number
  m: Map<string, Float32Array>
  v: Map<string, Float32Array>
}

function createAdamState(): AdamState {
  return { t: 0, m: new Map(), v: new Map() }
}

function adamUpdate(
  params: Float32Array,
  grads: Float32Array,
  state: AdamState,
  key: string,
  lr: number,
  beta1 = 0.9,
  beta2 = 0.999,
  eps = 1e-8,
): void {
  if (!state.m.has(key)) {
    state.m.set(key, new Float32Array(params.length))
    state.v.set(key, new Float32Array(params.length))
  }
  state.t++
  const m = state.m.get(key)!
  const v = state.v.get(key)!
  const bc1 = 1 - Math.pow(beta1, state.t)
  const bc2 = 1 - Math.pow(beta2, state.t)

  for (let i = 0; i < params.length; i++) {
    m[i] = beta1 * m[i] + (1 - beta1) * grads[i]
    v[i] = beta2 * v[i] + (1 - beta2) * grads[i] * grads[i]
    const mHat = m[i] / bc1
    const vHat = v[i] / bc2
    params[i] -= lr * mHat / (Math.sqrt(vHat) + eps)
  }
}

// ============================================================
// Data loading (same format as winrate-training.ts)
// ============================================================

function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

type DataSample = { observation: Float32Array, gameResult: Float32Array, day: number }

function loadData(path: string): { samples: DataSample[], stats: { villageWins: number, wolfWins: number, foxWins: number } } {
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  const samples: DataSample[] = raw.observations.map((obs: string, i: number) => ({
    observation: base64ToFloat32(obs),
    gameResult: base64ToFloat32(raw.labels[i]),
    day: raw.days[i],
  }))
  return { samples, stats: raw.stats }
}

// ============================================================
// Training
// ============================================================

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function evaluate(model: WinrateMLP, samples: DataSample[]): { preds: Float32Array[], labels: Float32Array[] } {
  const preds: Float32Array[] = []
  const labels: Float32Array[] = []
  for (const s of samples) {
    preds.push(model.forward(s.observation))
    labels.push(s.gameResult)
  }
  return { preds, labels }
}

async function main() {
  const { values } = parseArgs({
    options: {
      epochs: { type: 'string', default: '30' },
      lr: { type: 'string', default: '1e-3' },
      'batch-size': { type: 'string', default: '64' },
      'focal-gamma': { type: 'string', default: '2.0' },
      'data-path': { type: 'string', default: 'tmp/winrate/data.json' },
    },
    strict: true,
  })

  const epochs = parseInt(values.epochs!)
  const lr = parseFloat(values.lr!)
  const batchSize = parseInt(values['batch-size']!)
  const focalGamma = parseFloat(values['focal-gamma']!)
  const dataPath = values['data-path']!

  console.log(`Loading data from ${dataPath}...`)
  const { samples, stats } = loadData(dataPath)
  console.log(`Loaded ${samples.length} samples (village=${stats.villageWins} wolf=${stats.wolfWins} fox=${stats.foxWins})`)

  // Train/test split (80/20)
  const shuffled = shuffle([...samples])
  const splitIdx = Math.floor(shuffled.length * 0.8)
  const trainSamples = shuffled.slice(0, splitIdx)
  const testSamples = shuffled.slice(splitIdx)
  console.log(`Train: ${trainSamples.length}, Test: ${testSamples.length}`)

  const model = new WinrateMLP()
  const adam = createAdamState()
  console.log(`MLP params: ${model.totalParams}`)
  console.log(`Config: epochs=${epochs} lr=${lr} batch=${batchSize} focal_gamma=${focalGamma}`)
  console.log('')

  for (let epoch = 0; epoch < epochs; epoch++) {
    const epochSamples = shuffle([...trainSamples])
    let epochLoss = 0
    let epochCount = 0

    for (let b = 0; b < epochSamples.length; b += batchSize) {
      const end = Math.min(b + batchSize, epochSamples.length)
      let batchLoss = 0

      for (let i = b; i < end; i++) {
        const s = epochSamples[i]
        const probs = model.forward(s.observation)

        // Focal CE loss
        let pCorrect = 0
        for (let c = 0; c < NUM_CLASSES; c++) pCorrect += probs[c] * s.gameResult[c]
        const focalWeight = focalGamma > 0 ? Math.pow(1 - pCorrect, focalGamma) : 1
        const loss = -focalWeight * Math.log(Math.max(pCorrect, 1e-7))
        batchLoss += loss

        model.backward(probs, s.gameResult, focalGamma)
      }

      // Average gradients and update
      model.update(lr / (end - b), adam)
      epochLoss += batchLoss
      epochCount += (end - b)
    }

    const avgLoss = epochLoss / epochCount

    if ((epoch + 1) % 5 === 0 || epoch === 0 || epoch === epochs - 1) {
      const { preds, labels } = evaluate(model, testSamples)
      const metrics = evaluateWinrate(preds, labels)
      console.log(`Epoch ${epoch + 1}/${epochs}: loss=${avgLoss.toFixed(4)} | test_brier=${metrics.brierScore.toFixed(4)} test_acc=${(metrics.accuracy * 100).toFixed(1)}%`)
    } else {
      console.log(`Epoch ${epoch + 1}/${epochs}: loss=${avgLoss.toFixed(4)}`)
    }
  }

  // Final evaluation
  console.log('\n=== Final Evaluation (Test Set) ===')
  const { preds, labels } = evaluate(model, testSamples)
  const finalMetrics = evaluateWinrate(preds, labels)
  const baselineBrier = marginalBaselineBrierScore(finalMetrics.perClassCount)
  console.log(formatWinrateMetrics(finalMetrics, baselineBrier))

  // Day別
  console.log('\n=== Per-Day Brier Score ===')
  const byDay = new Map<number, { preds: Float32Array[], labels: Float32Array[] }>()
  for (let i = 0; i < testSamples.length; i++) {
    const day = testSamples[i].day
    if (!byDay.has(day)) byDay.set(day, { preds: [], labels: [] })
    const d = byDay.get(day)!
    d.preds.push(preds[i])
    d.labels.push(labels[i])
  }
  for (const [day, data] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const dayMetrics = evaluateWinrate(data.preds, data.labels)
    console.log(`  Day ${day}: brier=${dayMetrics.brierScore.toFixed(4)} acc=${(dayMetrics.accuracy * 100).toFixed(1)}% (n=${data.preds.length})`)
  }

  // PoC Go/No-Go
  console.log('\n=== PoC Go/No-Go (MLP baseline) ===')
  console.log(`Brier Score: ${finalMetrics.brierScore.toFixed(4)} (target: < 0.35, baseline: ${baselineBrier.toFixed(4)})`)
  console.log(`Calibration slope: ${finalMetrics.calibrationSlope.toFixed(3)} (target: 0.6 ~ 1.4)`)
  console.log(`Accuracy: ${(finalMetrics.accuracy * 100).toFixed(1)}% (target: > 55%)`)
}

main().catch(console.error)
