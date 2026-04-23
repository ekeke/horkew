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
import {
  createSkollZeroNetwork,
  createStandardZeroNetwork,
  createWolfZeroNetwork,
} from '../network/config.ts'
import {
  createSkollZeroTfNetwork,
  createStandardZeroTfNetwork,
  createWolfZeroTfNetwork,
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
  /**
   * Phase 3: Outcome-weighted SL head (claim/comm/leader/target/propose/predict) 学習を有効化。
   * false では従来の MCTS-π head のみ学習。
   */
  enableOutcomeSL: boolean
  /** Outcome-SL 時の KL anchor 係数。0 で KL 計算スキップ */
  klCoeff: number
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
  enableOutcomeSL: false,
  klCoeff: 0.1,
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
  if (process.env.SKOLLZ_OUTCOME_SL) out.enableOutcomeSL = process.env.SKOLLZ_OUTCOME_SL === '1'
  if (process.env.SKOLLZ_KL_COEFF) out.klCoeff = parseFloat(process.env.SKOLLZ_KL_COEFF)
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
  enableOutcomeSL: boolean,
  klCoeff: number,
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
  } else {
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

  // Outcome-SL 有効時、同アーキテクチャの frozen refNet を初期重みで作って KL anchor に使う。
  // refNet は学習中も一切更新されない。
  let refNet: typeof pureNet | undefined
  if (enableOutcomeSL && klCoeff > 0) {
    if (slotKey === 'mason') refNet = createSkollZeroNetwork()
    else if (slotKey === 'wolf') refNet = createWolfZeroNetwork()
    else refNet = createStandardZeroNetwork()
    refNet.loadWeights(pureNet.cloneWeights())
    log(`${slotKey}: refNet initialized (outcome-SL KL anchor, klCoeff=${klCoeff})`)
  }

  return { masonZeroNet, tfNet, buffer: new TrainingBuffer(), refNet }
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
  if (options.enableOutcomeSL) {
    log(`outcome-SL enabled (klCoeff=${options.klCoeff})`)
  }

  const slots: MultiTrainerSlots = {}
  for (const key of SLOT_KEYS) {
    slots[key] = buildSlot(phaseDir, key, options.learningRate, options.enableOutcomeSL, options.klCoeff)
  }

  const config = {
    ...DEFAULT_SKOLL_ZERO_TRAIN_CONFIG,
    learningRate: options.learningRate,
    batchSize: options.batchSize,
    stepsPerRound: options.stepsPerRound,
    gamesPerRound: options.gamesPerRound,
    mctsRollouts: options.rollouts,
    rngSeed: options.seed,
    enableOutcomeSL: options.enableOutcomeSL,
    klCoeff: options.klCoeff,
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
      const klPart = options.enableOutcomeSL ? ` kl=${s.avgKlLoss.toFixed(3)}` : ''
      log(`  ${key.padEnd(11)} +${s.recordsAdded} buf=${s.bufferSize} steps=${s.stepsRun} loss=${s.avgLoss.toFixed(4)}${klPart}`)
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
