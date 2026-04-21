/**
 * Phase 2 multi-head SL trainer。
 *
 * runner.ts が出した JSONL (`{outputDir}/{role}/{method}.jsonl`) を読み、
 * role に対応する TF network の該当 head を supervised 学習する。
 *
 * - train/eval split (デフォルト 90/10)
 * - epoch ごとに eval、early stopping (patience)
 * - checkpoint 保存 (既存 saveCheckpoint 形式)
 */

import { readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { TfTransformerNetwork } from '../../fenrir/src/ml/nn-tf-transformer.ts'
import { TransformerNetwork } from '../../fenrir/src/ml/transformer-network.ts'
import { saveCheckpoint, loadNetworkFromCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'
import { SEATS } from '../../fenrir/src/observation.ts'
import type { NetworkConfig } from '../../fenrir/src/ml/nn.ts'
import {
  SKOLL_ZERO_NETWORK_CONFIG,
  STANDARD_ZERO_NETWORK_CONFIG,
  WOLF_ZERO_NETWORK_CONFIG,
} from '../../skoll-zero/network/config.ts'

export type HeadType = 'perSeatSoftmax' | 'globalSoftmax' | 'perSeatSigmoid'

export type MethodSpec = {
  headName: string
  headType: HeadType
  /** 出力次元。softmax は categorical 数、perSeatSigmoid は SEATS × perDim */
  outputSize: number
}

/** method → head info のマッピング。runner.ts の capturing-agents.ts が出す method 名に対応。 */
export const METHOD_HEAD_MAP: Record<string, MethodSpec> = {
  claim:             { headName: 'claim',   headType: 'globalSoftmax',   outputSize: 10 },
  forecast:          { headName: 'claim',   headType: 'globalSoftmax',   outputSize: 10 },
  defensive_claim:   { headName: 'claim',   headType: 'globalSoftmax',   outputSize: 10 },
  comm:              { headName: 'comm',    headType: 'globalSoftmax',   outputSize: 119 },
  leader:            { headName: 'leader',  headType: 'globalSoftmax',   outputSize: 3 },
  target:            { headName: 'target',  headType: 'perSeatSoftmax',  outputSize: 14 },
  propose:           { headName: 'propose', headType: 'perSeatSigmoid',  outputSize: 14 },
  bodyguard_targets: { headName: 'propose', headType: 'perSeatSigmoid',  outputSize: 14 },
  predict:           { headName: 'predict', headType: 'perSeatSigmoid',  outputSize: 154 },
}

/** role → NN config のマッピング。 */
export function configForRole(role: string): NetworkConfig {
  if (role === 'werewolf') return WOLF_ZERO_NETWORK_CONFIG
  if (role === 'mason') return SKOLL_ZERO_NETWORK_CONFIG
  return STANDARD_ZERO_NETWORK_CONFIG
}

/** role → observationMode (TransformerNetwork のコンストラクタに渡す) */
export function obsModeForRole(role: string): 'wolf_collective' | 'mason_collective' | 'individual' {
  if (role === 'werewolf') return 'wolf_collective'
  if (role === 'mason') return 'mason_collective'
  return 'individual'
}

/** JSONL 1 行のスキーマ (sample-collector.ts sampleToJson と一致) */
type SampleJson = {
  role: string
  method: string
  obs: number[]
  actionIdx?: number
  actionVec?: number[]
  meta: { gameId: number, day: number, seat: number, alive: number }
}

export type LoadedSample = {
  observation: Float32Array
  label: Float32Array
  /** perSeatSoftmax のみ使う (alive bitmask → 加算マスク) */
  mask?: Float32Array
}

/** alive bitmask (1-based) から per-seat 加算マスクを作る。illegal = -1e9。 */
export function aliveBitmaskToMask(alive: number): Float32Array {
  const mask = new Float32Array(SEATS)
  for (let i = 0; i < SEATS; i++) {
    const bit = 1 << (i + 1)
    mask[i] = (alive & bit) !== 0 ? 0 : -1e9
  }
  return mask
}

/** JSONL ファイルを読み、spec に応じて label (one-hot / multi-hot) と mask を構築。 */
export function loadJsonlSamples(path: string, spec: MethodSpec): LoadedSample[] {
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n').filter(l => l.length > 0)
  const samples: LoadedSample[] = []
  const needMask = spec.headType === 'perSeatSoftmax'
  const isSoftmax = spec.headType !== 'perSeatSigmoid'

  for (const line of lines) {
    const obj = JSON.parse(line) as SampleJson
    const observation = Float32Array.from(obj.obs)

    let label: Float32Array
    if (isSoftmax) {
      if (typeof obj.actionIdx !== 'number') {
        throw new Error(`softmax head expects actionIdx, got ${JSON.stringify(obj).slice(0, 100)}`)
      }
      label = new Float32Array(spec.outputSize)
      if (obj.actionIdx >= 0 && obj.actionIdx < spec.outputSize) {
        label[obj.actionIdx] = 1
      }
    } else {
      if (!Array.isArray(obj.actionVec)) {
        throw new Error(`sigmoid head expects actionVec, got ${JSON.stringify(obj).slice(0, 100)}`)
      }
      label = Float32Array.from(obj.actionVec)
      if (label.length !== spec.outputSize) {
        throw new Error(`sigmoid label length ${label.length} != outputSize ${spec.outputSize}`)
      }
    }

    const mask = needMask ? aliveBitmaskToMask(obj.meta.alive) : undefined
    samples.push({ observation, label, mask })
  }
  return samples
}

/** Mulberry32 PRNG */
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

export type TrainerOptions = {
  role: string
  method: string
  inputJsonl: string
  outputCheckpointPath?: string
  batchSize: number
  epochs: number
  learningRate: number
  evalRatio: number
  patience: number
  seed: number
  /** 既存 checkpoint を warm-start 元に使う (partial load) */
  warmStartFrom?: string
}

export const DEFAULT_TRAINER_OPTIONS: Omit<TrainerOptions, 'role' | 'method' | 'inputJsonl'> = {
  batchSize: 128,
  epochs: 20,
  learningRate: 3e-4,
  evalRatio: 0.1,
  patience: 5,
  seed: 42,
}

export type EpochResult = {
  epoch: number
  trainLoss: number
  trainAcc: number
  evalLoss: number
  evalAcc: number
}

export type TrainerResult = {
  epochResults: EpochResult[]
  bestEpoch: number
  bestEvalLoss: number
  bestEvalAcc: number
}

/**
 * 1 (role, method) を学習する。
 *
 * - TfTransformerNetwork を role config から作成
 * - train/eval split → epoch loop → early stopping
 * - checkpoint は最終ベスト eval epoch のものを outputCheckpointPath に保存 (省略可)
 */
export async function trainPhase2Head(opts: TrainerOptions): Promise<TrainerResult> {
  const spec = METHOD_HEAD_MAP[opts.method]
  if (!spec) throw new Error(`unknown method: ${opts.method}`)

  const samples = loadJsonlSamples(opts.inputJsonl, spec)
  if (samples.length === 0) {
    throw new Error(`no samples loaded from ${opts.inputJsonl}`)
  }

  const rng = makeRng(opts.seed)
  shuffleInPlace(samples, rng)
  const evalN = Math.max(1, Math.floor(samples.length * opts.evalRatio))
  const trainSet = samples.slice(evalN)
  const evalSet = samples.slice(0, evalN)

  const config = configForRole(opts.role)
  const mode = obsModeForRole(opts.role)
  const tfNet = new TfTransformerNetwork(config, opts.learningRate, mode)

  if (opts.warmStartFrom) {
    // Pure JS 経由で partial load (prefix filter は TransformerNetwork.loadWeights が対応)
    const donor = loadNetworkFromCheckpoint(opts.warmStartFrom, mode)
    tfNet.loadWeights(donor.cloneWeights())
  }

  // Pure JS 版は eval 時のみ使う
  const evalNet = new TransformerNetwork(config, mode)

  const results: EpochResult[] = []
  let bestEpoch = -1
  let bestEvalLoss = Infinity
  let bestEvalAcc = 0
  let patienceCounter = 0
  let bestWeights: Map<string, Float32Array> | null = null

  for (let epoch = 0; epoch < opts.epochs; epoch++) {
    shuffleInPlace(trainSet, rng)
    let trainLoss = 0
    let trainAcc = 0
    let trainCount = 0
    for (let start = 0; start < trainSet.length; start += opts.batchSize) {
      const batch = trainSet.slice(start, Math.min(start + opts.batchSize, trainSet.length))
      const out = tfNet.trainSupervisedHead({
        observations: batch.map(s => s.observation),
        labels: batch.map(s => s.label),
        masks: spec.headType === 'perSeatSoftmax' ? batch.map(s => s.mask!) : undefined,
        headName: spec.headName,
        headType: spec.headType,
      })
      trainLoss += out.loss * batch.length
      trainAcc += out.accuracy * batch.length
      trainCount += batch.length
    }
    trainLoss /= Math.max(1, trainCount)
    trainAcc /= Math.max(1, trainCount)

    // Eval: TF → Pure JS 同期 → forward
    evalNet.loadWeights(tfNet.cloneWeights())
    const evalStats = evalHead(evalNet, evalSet, spec)

    const epochResult: EpochResult = {
      epoch: epoch + 1,
      trainLoss,
      trainAcc,
      evalLoss: evalStats.loss,
      evalAcc: evalStats.accuracy,
    }
    results.push(epochResult)
    process.stderr.write(
      `[phase2-train ${opts.role}/${opts.method}] epoch ${epoch + 1}/${opts.epochs} ` +
      `trainLoss=${trainLoss.toFixed(4)} trainAcc=${trainAcc.toFixed(3)} ` +
      `evalLoss=${evalStats.loss.toFixed(4)} evalAcc=${evalStats.accuracy.toFixed(3)}\n`,
    )

    if (evalStats.loss < bestEvalLoss) {
      bestEvalLoss = evalStats.loss
      bestEvalAcc = evalStats.accuracy
      bestEpoch = epoch + 1
      bestWeights = tfNet.cloneWeights()
      patienceCounter = 0
    } else {
      patienceCounter++
      if (patienceCounter >= opts.patience) {
        process.stderr.write(`[phase2-train ${opts.role}/${opts.method}] early stop at epoch ${epoch + 1}\n`)
        break
      }
    }
  }

  if (opts.outputCheckpointPath && bestWeights) {
    // Pure JS 版経由で保存 (saveCheckpoint は AnyNetwork 期待)
    evalNet.loadWeights(bestWeights)
    mkdirSync(dirname(opts.outputCheckpointPath), { recursive: true })
    saveCheckpoint(evalNet, opts.outputCheckpointPath, { iteration: bestEpoch, winRate: bestEvalAcc })
  }

  return { epochResults: results, bestEpoch, bestEvalLoss, bestEvalAcc }
}

/**
 * Pure JS 版で eval set の loss / accuracy を計算。
 *
 * 注: mask は loaded sample にある場合のみ per-seat softmax で適用。
 */
function evalHead(
  net: TransformerNetwork,
  samples: LoadedSample[],
  spec: MethodSpec,
): { loss: number, accuracy: number } {
  if (samples.length === 0) return { loss: 0, accuracy: 0 }

  let totalLoss = 0
  let correct = 0
  let labelCount = 0  // sigmoid の場合: 全 label 数
  let sampleCount = 0  // softmax の場合: sample 数

  for (const s of samples) {
    const result = net.forward(s.observation)
    const logits = result.policies.get(spec.headName)
    if (!logits) throw new Error(`eval: head '${spec.headName}' not found in policies`)

    if (spec.headType === 'perSeatSoftmax' || spec.headType === 'globalSoftmax') {
      // masked softmax
      const masked = new Float32Array(spec.outputSize)
      for (let i = 0; i < spec.outputSize; i++) {
        masked[i] = logits[i] + (s.mask ? s.mask[i] : 0)
      }
      let maxL = -Infinity
      for (const v of masked) if (v > maxL) maxL = v
      let sumExp = 0
      const probs = new Float32Array(spec.outputSize)
      for (let i = 0; i < spec.outputSize; i++) {
        probs[i] = Math.exp(masked[i] - maxL)
        sumExp += probs[i]
      }
      let ce = 0
      let argMaxPred = 0
      let maxP = -Infinity
      for (let i = 0; i < spec.outputSize; i++) {
        probs[i] /= sumExp
        if (s.label[i] > 0) ce -= s.label[i] * Math.log(probs[i] + 1e-8)
        if (probs[i] > maxP) { maxP = probs[i]; argMaxPred = i }
      }
      let argMaxLabel = 0
      let maxLabel = -Infinity
      for (let i = 0; i < spec.outputSize; i++) {
        if (s.label[i] > maxLabel) { maxLabel = s.label[i]; argMaxLabel = i }
      }
      totalLoss += ce
      if (argMaxPred === argMaxLabel) correct++
      sampleCount++
    } else {
      // sigmoid BCE
      let bce = 0
      let matches = 0
      for (let i = 0; i < spec.outputSize; i++) {
        const p = 1 / (1 + Math.exp(-logits[i]))
        bce -= s.label[i] * Math.log(p + 1e-8) + (1 - s.label[i]) * Math.log(1 - p + 1e-8)
        const predBin = p >= 0.5 ? 1 : 0
        if (predBin === s.label[i]) matches++
      }
      totalLoss += bce / spec.outputSize
      correct += matches
      labelCount += spec.outputSize
      sampleCount++
    }
  }

  const loss = totalLoss / Math.max(1, sampleCount)
  const accuracy = spec.headType === 'perSeatSigmoid'
    ? correct / Math.max(1, labelCount)
    : correct / Math.max(1, sampleCount)
  return { loss, accuracy }
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(): Partial<TrainerOptions> {
  const opts: Partial<TrainerOptions> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--role':        opts.role = args[++i]; break
      case '--method':      opts.method = args[++i]; break
      case '--input':       opts.inputJsonl = args[++i]; break
      case '--output':      opts.outputCheckpointPath = args[++i]; break
      case '--batch':       opts.batchSize = parseInt(args[++i], 10); break
      case '--epochs':      opts.epochs = parseInt(args[++i], 10); break
      case '--lr':          opts.learningRate = parseFloat(args[++i]); break
      case '--eval-ratio':  opts.evalRatio = parseFloat(args[++i]); break
      case '--patience':    opts.patience = parseInt(args[++i], 10); break
      case '--seed':        opts.seed = parseInt(args[++i], 10); break
      case '--warm-start':  opts.warmStartFrom = args[++i]; break
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('trainer.ts') && process.argv[1].includes('phase2')) {
  const cli = parseArgs()
  if (!cli.role || !cli.method || !cli.inputJsonl) {
    console.error('usage: --role <role> --method <method> --input <jsonl> [--output <ckpt>] [--epochs N] [--warm-start <ckpt>]')
    process.exit(1)
  }
  const full: TrainerOptions = { ...DEFAULT_TRAINER_OPTIONS, ...cli } as TrainerOptions
  trainPhase2Head(full).then(r => {
    process.stderr.write(`[phase2-train DONE] bestEpoch=${r.bestEpoch} bestEvalLoss=${r.bestEvalLoss.toFixed(4)} bestEvalAcc=${r.bestEvalAcc.toFixed(3)}\n`)
  }).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
