/**
 * skoll-zero curriculum runner — fenrir orchestrate から呼ばれる entry point。
 *
 * phase-indexed layout:
 *   {checkpointBase}/phases/00-skoll-zero/
 *     {slot}/round_NNNN/weights.json
 *     {slot}/final.json
 *     round_NNNN_meta.json
 *     phase.done
 *     phase-summary.json
 *
 * 完了条件: 指定 round 数を消化、または phase.done が既存 (再実行で skip)。
 *
 * 環境変数 override:
 *   SKOLLZ_ROUNDS, SKOLLZ_GAMES, SKOLLZ_ROLLOUTS, SKOLLZ_STEPS,
 *   SKOLLZ_LR, SKOLLZ_SEED, SKOLLZ_OUTCOME_SL (1 で有効), SKOLLZ_KL_COEFF
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { MasonZeroNetwork } from '../network/mason-zero.ts'
import { TfMasonZeroNetwork } from '../network/tf-mason-zero.ts'
import {
  createSkollZeroNetwork,
  createStandardZeroNetwork,
  createWolfZeroNetwork,
  createFanaticZeroNetwork,
} from '../network/config.ts'
import {
  createSkollZeroTfNetwork,
  createStandardZeroTfNetwork,
  createWolfZeroTfNetwork,
  createFanaticZeroTfNetwork,
} from '../network/tf-config.ts'
import { loadCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'
import { TrainingBuffer } from '../selfplay/buffer.ts'
import {
  MultiSkollZeroTrainer,
  writeRoundMeta,
  type MultiTrainerSlots,
} from '../training/multi-trainer.ts'
import { DEFAULT_SKOLL_ZERO_TRAIN_CONFIG } from '../training/schedule.ts'

export type SkollZeroPhaseOptions = {
  checkpointBase: string
  rounds: number
  gamesPerRound: number
  rollouts: number
  stepsPerRound: number
  batchSize: number
  learningRate: number
  seed: number
}

export const DEFAULT_SKOLL_ZERO_PHASE_OPTIONS: SkollZeroPhaseOptions = {
  checkpointBase: '',
  rounds: 30,
  gamesPerRound: 30,
  rollouts: 50,
  stepsPerRound: 40,
  batchSize: 32,
  learningRate: 3e-4,
  seed: 42,
}

function envOverrides(): Partial<SkollZeroPhaseOptions> {
  const out: Partial<SkollZeroPhaseOptions> = {}
  if (process.env.SKOLLZ_ROUNDS) out.rounds = parseInt(process.env.SKOLLZ_ROUNDS, 10)
  if (process.env.SKOLLZ_GAMES) out.gamesPerRound = parseInt(process.env.SKOLLZ_GAMES, 10)
  if (process.env.SKOLLZ_ROLLOUTS) out.rollouts = parseInt(process.env.SKOLLZ_ROLLOUTS, 10)
  if (process.env.SKOLLZ_STEPS) out.stepsPerRound = parseInt(process.env.SKOLLZ_STEPS, 10)
  if (process.env.SKOLLZ_BATCH) out.batchSize = parseInt(process.env.SKOLLZ_BATCH, 10)
  if (process.env.SKOLLZ_LR) out.learningRate = parseFloat(process.env.SKOLLZ_LR)
  if (process.env.SKOLLZ_SEED) out.seed = parseInt(process.env.SKOLLZ_SEED, 10)
  return out
}

const SLOT_KEYS: (keyof MultiTrainerSlots)[] = [
  'mason', 'village', 'wolf', 'fanatic', 'hamster', 'immoralist',
]

const WARM_START_PATHS: Record<Exclude<keyof MultiTrainerSlots, 'village'>, string> = {
  mason: 'src/skoll/models/mason.json',
  wolf: 'src/skoll/models/wolf.json',
  fanatic: 'src/skoll/models/fanatic.json',
  hamster: 'src/skoll/models/hamster.json',
  immoralist: 'src/skoll/models/immoralist.json',
}

function log(msg: string): void {
  process.stderr.write(`[skoll-zero] ${msg}\n`)
}

function buildSlot(
  phaseDir: string,
  slotKey: keyof MultiTrainerSlots,
  lr: number,
): MultiTrainerSlots[keyof MultiTrainerSlots] {
  // Pure JS 推論用 + TF.js 学習用
  let pureNet
  let tfNet
  if (slotKey === 'mason') {
    pureNet = createSkollZeroNetwork()
    tfNet = createSkollZeroTfNetwork(lr)
  } else if (slotKey === 'wolf') {
    pureNet = createWolfZeroNetwork()
    tfNet = createWolfZeroTfNetwork(lr)
  } else if (slotKey === 'fanatic') {
    // FanaticIndividualModule.captureObs は encodeFanaticObservation (1197 dims、
    // village_predict + village_trust 注入) を返すため、専用 NN config が必要。
    pureNet = createFanaticZeroNetwork()
    tfNet = createFanaticZeroTfNetwork(lr)
  } else {
    // village / hamster / immoralist は individual obs (1029 dims)
    pureNet = createStandardZeroNetwork()
    tfNet = createStandardZeroTfNetwork(lr)
  }

  // resume > warm-start > random
  const resumePath = join(phaseDir, slotKey, 'final.json')
  if (existsSync(resumePath)) {
    loadCheckpoint(pureNet, resumePath)
    log(`${slotKey}: resume from ${resumePath}`)
  } else if (slotKey !== 'village') {
    const warmPath = WARM_START_PATHS[slotKey]
    if (existsSync(warmPath)) {
      loadCheckpoint(pureNet, warmPath)
      log(`${slotKey}: warm-start from ${warmPath}`)
    } else {
      log(`${slotKey}: WARN ${warmPath} missing, random init`)
    }
  } else {
    log(`${slotKey}: random init (SL 非存在)`)
  }

  tfNet.loadWeights(pureNet.cloneWeights())
  const masonZeroNet = new MasonZeroNetwork(pureNet, { zeroValueHead: false })

  // SKOLLZ_INFER_GPU=1 で self-play 推論を tfNet (TF.js GPU) に切替。
  // tfNet 自体を wrap するため、学習で更新された重みは推論にも即反映される。
  // 未指定なら inferNet=undefined で multi-trainer が masonZeroNet (Pure JS) を使う。
  const useGpuInfer = process.env.SKOLLZ_INFER_GPU === '1'
  const inferNet = useGpuInfer ? new TfMasonZeroNetwork(tfNet) : undefined
  if (useGpuInfer) log(`${slotKey}: SKOLLZ_INFER_GPU=1 -> TfMasonZeroNetwork (TF.js GPU 推論)`)

  return { masonZeroNet, tfNet, buffer: new TrainingBuffer(), inferNet }
}

export async function runSkollZero(opts: Partial<SkollZeroPhaseOptions> = {}): Promise<void> {
  const options = { ...DEFAULT_SKOLL_ZERO_PHASE_OPTIONS, ...opts, ...envOverrides() }
  if (!options.checkpointBase) throw new Error('skoll-zero: checkpointBase is required')

  const phaseDir = join(options.checkpointBase, 'phases', '00-skoll-zero')
  mkdirSync(phaseDir, { recursive: true })

  const doneFile = join(phaseDir, 'phase.done')
  if (existsSync(doneFile)) {
    log(`phase already done (${doneFile}). Delete to re-run.`)
    return
  }

  log(`output: ${phaseDir}`)
  log(`rounds=${options.rounds} games/round=${options.gamesPerRound} rollouts=${options.rollouts} steps/round=${options.stepsPerRound}`)

  const slots: MultiTrainerSlots = {}
  for (const key of SLOT_KEYS) {
    slots[key] = buildSlot(phaseDir, key, options.learningRate)
  }

  const config = {
    ...DEFAULT_SKOLL_ZERO_TRAIN_CONFIG,
    learningRate: options.learningRate,
    batchSize: options.batchSize,
    stepsPerRound: options.stepsPerRound,
    gamesPerRound: options.gamesPerRound,
    mctsRollouts: options.rollouts,
    rngSeed: options.seed,
  }
  const trainer = new MultiSkollZeroTrainer({ slots, config })

  const roundSummaries: Array<{ round: number, outcomes: { villagerWon: number, werewolfWon: number, werehamsterWon: number, draw: number } }> = []

  for (let r = 1; r <= options.rounds; r++) {
    const t0 = Date.now()
    const stats = await trainer.trainRound(r, phaseDir)
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    log(`round ${r}/${options.rounds} elapsed=${elapsed}s vill=${stats.outcomes.villagerWon} wolf=${stats.outcomes.werewolfWon} ham=${stats.outcomes.werehamsterWon} draw=${stats.outcomes.draw}`)
    for (const key of SLOT_KEYS) {
      const s = stats.perSlot[key]
      if (!s) continue
      log(`  ${key.padEnd(11)} +${s.recordsAdded} buf=${s.bufferSize} steps=${s.stepsRun} loss=${s.avgLoss.toFixed(4)}`)
    }
    writeRoundMeta(phaseDir, stats)
    roundSummaries.push({ round: r, outcomes: stats.outcomes })
  }

  for (const key of SLOT_KEYS) slots[key]?.tfNet.dispose()

  const summary = {
    options,
    rounds: roundSummaries,
    finishedAt: new Date().toISOString(),
  }
  writeFileSync(join(phaseDir, 'phase-summary.json'), JSON.stringify(summary, null, 2))
  writeFileSync(doneFile, JSON.stringify({ phaseName: 'skoll-zero', graduatedAt: new Date().toISOString() }, null, 2))
  log('phase complete')
}
