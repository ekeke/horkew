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

import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
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
import {
  initSkollZeroWorkerPool,
  terminateSkollZeroWorkerPool,
  initSkollZeroForwardServer,
  runSelfPlayParallel,
} from '../parallel/index.ts'
import type { ForwardServerSlots } from '../parallel/forward-server.ts'
import type { SlotMap, AgentSlot } from '../selfplay/multi-runner.ts'
import type { SkollZeroTrainConfig } from '../training/schedule.ts'

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

/**
 * Eval セッション: numGames 件の self-play を `selectionMode='argmax'` で実行し、
 * outcomes を集計する。学習 buffer は temp で捨てるので、main slot.buffer に
 * record は merge されない (= 学習に影響なし)。SKOLLZ_EVAL_EVERY env で間隔指定。
 */
async function runEvalSession(
  slots: MultiTrainerSlots,
  config: SkollZeroTrainConfig,
  numGames: number,
  evalSeed: number,
): Promise<{
  outcomes: { villagerWon: number, werewolfWon: number, werehamsterWon: number, draw: number }
  elapsedSec: number
}> {
  const evalSlots: SlotMap = {}
  for (const k of SLOT_KEYS) {
    const s = slots[k]
    if (!s) continue
    const slot: AgentSlot = { nn: s.inferNet ?? s.masonZeroNet, buffer: new TrainingBuffer() }
    evalSlots[k] = slot
  }
  const t0 = Date.now()
  const { outcomes } = await runSelfPlayParallel(
    {
      slots: evalSlots,
      seed: evalSeed,
      mctsConfig: {
        cPuct: config.cPuct,
        nRollouts: config.mctsRollouts,
        rootDirichletAlpha: config.rootDirichletAlpha,
        rootDirichletEps: config.rootDirichletEps,
      },
      selectionMode: 'argmax',
      // rolloutRetar: 学習時の env を維持 (worker 起動時の SKOLLZ_ROLLOUT_RETAR を使う)
    },
    numGames,
  )
  const elapsedSec = (Date.now() - t0) / 1000
  return { outcomes, elapsedSec }
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

  // カリキュラム: SKOLLZ_OFF_ROUNDS=N で「最初 N round は retar OFF、残り ON」を指示。
  // 0 (default) なら全 round で worker 起動時 env (= SKOLLZ_ROLLOUT_RETAR) を維持 (後方互換)。
  const offRoundsEnv = process.env.SKOLLZ_OFF_ROUNDS
  const offRounds = offRoundsEnv ? parseInt(offRoundsEnv, 10) : 0

  log(`output: ${phaseDir}`)
  log(`rounds=${options.rounds} games/round=${options.gamesPerRound} rollouts=${options.rollouts} steps/round=${options.stepsPerRound}`)
  if (offRounds > 0) {
    log(`カリキュラム: 1..${offRounds} = retar OFF, ${offRounds + 1}..${options.rounds} = retar ON (SKOLLZ_OFF_ROUNDS=${offRounds})`)
  }

  const slots: MultiTrainerSlots = {}
  for (const key of SLOT_KEYS) {
    slots[key] = buildSlot(phaseDir, key, options.learningRate)
  }

  const numWorkersEnv = process.env.SKOLLZ_WORKERS
  const numWorkers = numWorkersEnv ? parseInt(numWorkersEnv, 10) : undefined
  initSkollZeroWorkerPool(numWorkers)

  // Stage 2: SKOLLZ_PARALLEL_GPU=1 で proxy NN 経路を有効化。
  // worker 内 forwardBatch を main GPU (Atomics+SAB) に投げる。
  if (process.env.SKOLLZ_PARALLEL_GPU === '1') {
    const tfSlots: ForwardServerSlots = {}
    for (const key of SLOT_KEYS) {
      const s = slots[key]
      if (s) tfSlots[key] = new TfMasonZeroNetwork(s.tfNet)
    }
    initSkollZeroForwardServer(tfSlots)
    log('SKOLLZ_PARALLEL_GPU=1 -> forward server 起動 (Stage 2: GPU forward via Atomics+SAB)')
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

  // Resume: phaseDir/resume.json があれば lastCompletedRound + 1 から再開、
  // gameSeedCounter も復元する。weights は buildSlot 内で {slot}/final.json から resume 済み。
  // TrainingBuffer は persist しないので空で再開 (1-2 round で再蓄積される)。
  const resumeStatePath = join(phaseDir, 'resume.json')
  let startRound = 1
  let initialGameSeedCounter: number | undefined
  if (existsSync(resumeStatePath)) {
    try {
      const raw = JSON.parse(readFileSync(resumeStatePath, 'utf-8')) as {
        lastCompletedRound: number
        gameSeedCounter: number
      }
      if (raw.lastCompletedRound >= options.rounds) {
        log(`resume.json: 既に ${raw.lastCompletedRound} round 完了済み (target ${options.rounds})、追加 round なし`)
      } else {
        startRound = raw.lastCompletedRound + 1
        initialGameSeedCounter = raw.gameSeedCounter
        log(`resume: round ${startRound} から再開 (前回 ${raw.lastCompletedRound} 完了、gameSeedCounter=${raw.gameSeedCounter})`)
      }
    } catch (e) {
      log(`WARN: resume.json 読み込み失敗、最初から開始: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const trainer = new MultiSkollZeroTrainer({ slots, config, initialGameSeedCounter })

  // Eval セッション設定: SKOLLZ_EVAL_EVERY=N で N round ごとに argmax self-play で勝率推移を記録
  const evalEvery = parseInt(process.env.SKOLLZ_EVAL_EVERY ?? '0', 10)
  const evalGames = parseInt(process.env.SKOLLZ_EVAL_GAMES ?? '100', 10)
  const evalLogPath = join(phaseDir, 'eval_log.jsonl')
  if (evalEvery > 0) {
    log(`eval: ${evalEvery} round ごとに ${evalGames} game eval (argmax)、出力 ${evalLogPath}`)
  }

  const roundSummaries: Array<{ round: number, outcomes: { villagerWon: number, werewolfWon: number, werehamsterWon: number, draw: number } }> = []

  try {
    for (let r = startRound; r <= options.rounds; r++) {
      const rolloutRetar: boolean | undefined = offRounds > 0 ? r > offRounds : undefined
      const retarTag = rolloutRetar === undefined ? 'env' : (rolloutRetar ? 'on' : 'off')
      const t0 = Date.now()
      const stats = await trainer.trainRound(r, phaseDir, { rolloutRetar })
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      log(`round ${r}/${options.rounds} retar=${retarTag} elapsed=${elapsed}s vill=${stats.outcomes.villagerWon} wolf=${stats.outcomes.werewolfWon} ham=${stats.outcomes.werehamsterWon} draw=${stats.outcomes.draw}`)
      for (const key of SLOT_KEYS) {
        const s = stats.perSlot[key]
        if (!s) continue
        log(`  ${key.padEnd(11)} +${s.recordsAdded} buf=${s.bufferSize} steps=${s.stepsRun} loss=${s.avgLoss.toFixed(4)}`)
      }
      writeRoundMeta(phaseDir, stats)
      roundSummaries.push({ round: r, outcomes: stats.outcomes })

      // Resume 用: round 完了時に resume.json を atomically 上書き
      writeFileSync(resumeStatePath, JSON.stringify({
        lastCompletedRound: r,
        gameSeedCounter: trainer.getGameSeedCounter(),
        timestamp: new Date().toISOString(),
      }, null, 2))

      // Eval セッション (SKOLLZ_EVAL_EVERY > 0 のとき N round ごとに実行)
      if (evalEvery > 0 && r % evalEvery === 0) {
        log(`eval@R${r} starting (n=${evalGames}, argmax)...`)
        const { outcomes: evalOut, elapsedSec: evalElapsed } = await runEvalSession(
          slots,
          config,
          evalGames,
          options.seed + 1_000_000 + r,  // run-static seed offset (round 番号で variation)
        )
        log(`eval@R${r} elapsed=${evalElapsed.toFixed(1)}s vill=${evalOut.villagerWon} wolf=${evalOut.werewolfWon} ham=${evalOut.werehamsterWon} draw=${evalOut.draw}`)
        appendFileSync(evalLogPath, JSON.stringify({
          round: r,
          games: evalGames,
          elapsedSec: evalElapsed,
          outcomes: evalOut,
          timestamp: new Date().toISOString(),
        }) + '\n')
      }
    }
  } finally {
    terminateSkollZeroWorkerPool()
    for (const key of SLOT_KEYS) slots[key]?.tfNet.dispose()
  }

  const summary = {
    options,
    rounds: roundSummaries,
    finishedAt: new Date().toISOString(),
  }
  writeFileSync(join(phaseDir, 'phase-summary.json'), JSON.stringify(summary, null, 2))
  writeFileSync(doneFile, JSON.stringify({ phaseName: 'skoll-zero', graduatedAt: new Date().toISOString() }, null, 2))
  log('phase complete')
}
