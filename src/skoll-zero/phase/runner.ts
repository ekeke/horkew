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

import type { SystemRole } from '../../types/index.ts'
import { MasonZeroNetwork } from '../network/mason-zero.ts'
import { TfMasonZeroNetwork } from '../network/tf-mason-zero.ts'
import {
  createSkollZeroNetwork,
  createStandardZeroNetwork,
  createWolfZeroNetwork,
  createFanaticZeroNetwork,
  createWolfImitationZeroNetwork,
} from '../network/config.ts'
import {
  createSkollZeroTfNetwork,
  createStandardZeroTfNetwork,
  createWolfZeroTfNetwork,
  createFanaticZeroTfNetwork,
  createWolfImitationZeroTfNetwork,
} from '../network/tf-config.ts'
import { WolfImitationNetwork } from '../network/wolf-imitation-network.ts'
import { loadCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'
import { TrainingBuffer } from '../selfplay/buffer.ts'
import {
  MultiSkollZeroTrainer,
  writeRoundMeta,
  type MultiTrainerSlots,
} from '../training/multi-trainer.ts'
import { DEFAULT_SKOLL_ZERO_TRAIN_CONFIG, DEFAULT_DIRICHLET_AUTO_CONFIG } from '../training/schedule.ts'
import {
  initSkollZeroWorkerPool,
  terminateSkollZeroWorkerPool,
  initSkollZeroForwardServer,
  runSelfPlayParallel,
} from '../parallel/index.ts'
import type { ForwardServerSlots } from '../parallel/forward-server.ts'
import type { SlotMap, AgentSlot } from '../selfplay/multi-runner.ts'
import type { SkollZeroTrainConfig } from '../training/schedule.ts'
import type { ClaimMatrix, ClaimedRoleKey, DayOneDeathCounts } from '../eval/claim-matrix.ts'
import { RUN_PROFILES } from '../eval/run-profile.ts'

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

const WARM_START_PATHS: Record<keyof MultiTrainerSlots, string> = {
  mason: 'src/skoll/models/mason.json',
  village: 'src/skoll/models/village.json',
  wolf: 'src/skoll/models/wolf.json',
  fanatic: 'src/skoll/models/fanatic.json',
  hamster: 'src/skoll/models/hamster.json',
  immoralist: 'src/skoll/models/immoralist.json',
}

function log(msg: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  process.stderr.write(`[${ts}] [skoll-zero] ${msg}\n`)
}

/**
 * Eval セッション: numGames 件の self-play を `selectionMode='argmax'` で実行し、
 * outcomes を集計する。学習 buffer は temp で捨てるので、main slot.buffer に
 * record は merge されない (= 学習に影響なし)。SKOLLZ_EVAL_EVERY env で間隔指定。
 */
/**
 * Eval session: NN-only 一発勝負 (selectionMode='policy_argmax')。
 *
 * 設計意図: eval は「学習設定に依らない単純な性能評価」のためのベンチ。
 *   - MCTS を介さず NN forward 1 回 + argmax で意思決定
 *   - 学習側 SKOLLZ_ROLLOUTS や Dirichlet ε を変えても eval 結果に影響しない
 *   - 純粋な NN policy quality を勝率で測る
 *
 * mctsConfig は policy_argmax モードでは不使用だが、型上 required なのでダミー値を渡す。
 */
async function runEvalSession(
  slots: MultiTrainerSlots,
  config: SkollZeroTrainConfig,
  numGames: number,
  evalSeed: number,
): Promise<{
  outcomes: { villagerWon: number, werewolfWon: number, werehamsterWon: number, draw: number }
  elapsedSec: number
  claimMatrix: ClaimMatrix
  dayOneDeaths: DayOneDeathCounts
}> {
  const evalSlots: SlotMap = {}
  for (const k of SLOT_KEYS) {
    const s = slots[k]
    if (!s) continue
    const slot: AgentSlot = { nn: s.inferNet ?? s.masonZeroNet, buffer: new TrainingBuffer() }
    evalSlots[k] = slot
  }
  const t0 = Date.now()
  const { outcomes, claimMatrix, dayOneDeaths } = await runSelfPlayParallel(
    {
      slots: evalSlots,
      seed: evalSeed,
      // policy_argmax モードでは MCTS 不使用、mctsConfig はダミー値で OK
      mctsConfig: {
        cPuct: config.cPuct,
        nRollouts: 1,
        rootDirichletAlpha: 0,
        rootDirichletEps: 0,
      },
      selectionMode: RUN_PROFILES.eval.selectionMode,
      // rolloutRetar: 学習時の env を維持 (worker 起動時の SKOLLZ_ROLLOUT_RETAR を使う)
    },
    numGames,
  )
  const elapsedSec = (Date.now() - t0) / 1000
  return { outcomes, elapsedSec, claimMatrix, dayOneDeaths }
}

const ALL_SYSTEM_ROLES: readonly SystemRole[] = [
  'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
  'werewolf', 'fanatic', 'werehamster', 'immoralist', 'possessed', 'paparazzi',
]

const CLAIM_COL_KEYS: readonly ClaimedRoleKey[] = [
  'seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'villager', 'none',
]

const ROLE_SHORT_LABELS: Record<SystemRole, string> = {
  villager: 'villager', seer: 'seer', medium: 'medium', bodyguard: 'bg',
  mason: 'mason', nekomata: 'neko', werewolf: 'wolf', fanatic: 'fanat',
  werehamster: 'fox', immoralist: 'immo', possessed: 'poss', paparazzi: 'pap',
  kogitsune: 'kogi',
}

const CLAIM_COL_LABELS: Record<ClaimedRoleKey, string> = {
  villager: 'vill', seer: 'seer', medium: 'med', bodyguard: 'bg',
  mason: 'mason', nekomata: 'neko', werewolf: 'wolf', fanatic: 'fanat',
  werehamster: 'fox', immoralist: 'immo', possessed: 'poss', paparazzi: 'pap',
  kogitsune: 'kogi', none: 'none',
}

/** claim matrix を 1 行 1 役職の表として整形 */
function formatClaimMatrixRows(matrix: ClaimMatrix, indent: string): string[] {
  const colWidth = 6
  const roleColWidth = 11
  const header = 'role'.padEnd(roleColWidth) + CLAIM_COL_KEYS.map(k => CLAIM_COL_LABELS[k].padStart(colWidth)).join('')
  const rows: string[] = [`${indent}${header}`]
  for (const role of ALL_SYSTEM_ROLES) {
    const row = matrix[role]
    if (!row) continue
    const total = Object.values(row).reduce((s, v) => s + (v ?? 0), 0)
    if (total === 0) continue
    const cells = CLAIM_COL_KEYS.map(k => String(row[k] ?? 0).padStart(colWidth)).join('')
    rows.push(`${indent}${ROLE_SHORT_LABELS[role].padEnd(roleColWidth)}${cells}`)
  }
  return rows
}

/** day1 deaths を 1 行で整形: `vill=12 seer=8 ... (total=N)` */
function formatDayOneDeaths(counts: DayOneDeathCounts): string {
  const parts: string[] = []
  let total = 0
  for (const role of ALL_SYSTEM_ROLES) {
    const n = counts[role] ?? 0
    if (n === 0) continue
    parts.push(`${ROLE_SHORT_LABELS[role]}=${n}`)
    total += n
  }
  return `${parts.join(' ')} (total=${total})`
}

function buildSlot(
  phaseDir: string,
  slotKey: keyof MultiTrainerSlots,
  lr: number,
): MultiTrainerSlots[keyof MultiTrainerSlots] {
  // SKOLLZ_WOLF_IMITATION=1 で wolf slot のみ Imitation 構造 (frozen 村 NN + deviation/α)。
  const wolfImitationEnabled = process.env.SKOLLZ_WOLF_IMITATION === '1' && slotKey === 'wolf'

  // Pure JS 推論用 + TF.js 学習用
  let pureNet
  let tfNet
  if (slotKey === 'mason') {
    pureNet = createSkollZeroNetwork()
    tfNet = createSkollZeroTfNetwork(lr)
  } else if (slotKey === 'wolf') {
    if (wolfImitationEnabled) {
      pureNet = createWolfImitationZeroNetwork()
      tfNet = createWolfImitationZeroTfNetwork(lr)
    } else {
      pureNet = createWolfZeroNetwork()
      tfNet = createWolfZeroTfNetwork(lr)
    }
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
  // 注: wolf imitation 有効時は head 構造が異なるため、既存の wolf checkpoint からは
  //     resume できない (loadCheckpoint が head 名 mismatch で失敗 or 部分 load)。Phase 1 では
  //     wolf imitation 専用 ckpt が無ければ random init で開始する想定。
  const resumePath = join(phaseDir, slotKey, 'final.json')
  if (existsSync(resumePath)) {
    try {
      loadCheckpoint(pureNet, resumePath)
      log(`${slotKey}: resume from ${resumePath}`)
    } catch (e) {
      log(`${slotKey}: resume FAILED (${e instanceof Error ? e.message : String(e)}), random init`)
    }
  } else {
    const warmPath = WARM_START_PATHS[slotKey]
    if (!wolfImitationEnabled && existsSync(warmPath)) {
      loadCheckpoint(pureNet, warmPath)
      log(`${slotKey}: warm-start from ${warmPath}`)
    } else {
      log(`${slotKey}: WARN ${warmPath} missing, random init${wolfImitationEnabled ? ' (wolf imitation, no compatible warm-start)' : ''}`)
    }
  }

  tfNet.loadWeights(pureNet.cloneWeights())

  // wolf imitation の場合は WolfImitationNetwork で wrap (frozen village を内蔵)。
  // frozen village 用に Pure JS の standard NN を別途構築 (random init、
  // multi-trainer.syncWolfImitationFrozen が round 0 冒頭で village slot から weights をコピー)。
  let masonZeroNet
  let wolfImitationFrozen
  if (wolfImitationEnabled) {
    const frozenVillagePure = createStandardZeroNetwork()
    const frozenVillageTf = createStandardZeroTfNetwork(lr)
    masonZeroNet = new WolfImitationNetwork(frozenVillagePure, pureNet, { zeroValueHead: false })
    wolfImitationFrozen = { tfNet: frozenVillageTf, pureJsNet: frozenVillagePure }
    log(`${slotKey}: SKOLLZ_WOLF_IMITATION=1 -> WolfImitationNetwork (frozen village + deviation/α)`)
  } else {
    masonZeroNet = new MasonZeroNetwork(pureNet, { zeroValueHead: false })
  }

  // SKOLLZ_INFER_GPU=1 で self-play 推論を tfNet (TF.js GPU) に切替。
  // tfNet 自体を wrap するため、学習で更新された重みは推論にも即反映される。
  // 未指定なら inferNet=undefined で multi-trainer が masonZeroNet (Pure JS) を使う。
  // 注: wolf imitation 時は GPU 推論 + mix forward の整合が未対応なので Pure JS 経路を使う。
  const useGpuInfer = process.env.SKOLLZ_INFER_GPU === '1' && !wolfImitationEnabled
  const inferNet = useGpuInfer ? new TfMasonZeroNetwork(tfNet) : undefined
  if (useGpuInfer) log(`${slotKey}: SKOLLZ_INFER_GPU=1 -> TfMasonZeroNetwork (TF.js GPU 推論)`)

  return { masonZeroNet, tfNet, buffer: new TrainingBuffer(), inferNet, wolfImitationFrozen }
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
    // Wolf Imitation の frozen village TF NN も forward server に登録
    // (claim_decision phase の 4 viewer obs を 1 batched forward で処理する)。
    // wolf slot が wolfImitationFrozen を持つ場合のみ追加。
    const wolfSlot = slots.wolf
    if (wolfSlot?.wolfImitationFrozen) {
      tfSlots.frozenVillage = new TfMasonZeroNetwork(wolfSlot.wolfImitationFrozen.tfNet)
      log('frozenVillage TF NN registered to forward server (claim_decision batched forward)')
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

  // Dirichlet noise の env override (policy collapse 対策で root exploration 強化)
  if (process.env.SKOLLZ_DIRICHLET_EPS) {
    const eps = parseFloat(process.env.SKOLLZ_DIRICHLET_EPS)
    if (Number.isFinite(eps) && eps >= 0 && eps <= 1) {
      config.rootDirichletEps = eps
      log(`SKOLLZ_DIRICHLET_EPS=${eps} (default ${DEFAULT_SKOLL_ZERO_TRAIN_CONFIG.rootDirichletEps})`)
    }
  }
  if (process.env.SKOLLZ_DIRICHLET_ALPHA) {
    const alpha = parseFloat(process.env.SKOLLZ_DIRICHLET_ALPHA)
    if (Number.isFinite(alpha) && alpha > 0) {
      config.rootDirichletAlpha = alpha
      log(`SKOLLZ_DIRICHLET_ALPHA=${alpha} (default ${DEFAULT_SKOLL_ZERO_TRAIN_CONFIG.rootDirichletAlpha})`)
    }
  }

  // Dirichlet ε auto-decay (visit エントロピー比に基づく per-slot 自動減衰)。
  // SKOLLZ_DIRICHLET_AUTO=1 で有効化、各パラメータは個別 env で上書き可能。
  if (process.env.SKOLLZ_DIRICHLET_AUTO === '1') {
    const auto = { ...DEFAULT_DIRICHLET_AUTO_CONFIG, enabled: true }
    if (process.env.SKOLLZ_DIRICHLET_TARGET_RATIO) {
      const v = parseFloat(process.env.SKOLLZ_DIRICHLET_TARGET_RATIO)
      if (Number.isFinite(v) && v > 0 && v < 1) auto.targetRatio = v
    }
    if (process.env.SKOLLZ_DIRICHLET_DECAY) {
      const v = parseFloat(process.env.SKOLLZ_DIRICHLET_DECAY)
      if (Number.isFinite(v) && v > 0 && v < 1) auto.decay = v
    }
    if (process.env.SKOLLZ_DIRICHLET_FLOOR) {
      const v = parseFloat(process.env.SKOLLZ_DIRICHLET_FLOOR)
      if (Number.isFinite(v) && v >= 0 && v <= 1) auto.floor = v
    }
    if (process.env.SKOLLZ_DIRICHLET_STREAK) {
      const v = parseInt(process.env.SKOLLZ_DIRICHLET_STREAK, 10)
      if (Number.isFinite(v) && v >= 1) auto.streak = v
    }
    config.dirichletAuto = auto
    log(`SKOLLZ_DIRICHLET_AUTO=1 (per-slot decay, target=${auto.targetRatio} decay=${auto.decay} floor=${auto.floor} streak=${auto.streak})`)
  }

  // Day bonus reward shaping (14D-12-猫: 12/14 が長期化を望む)。
  // village/wolf=+coef×day、hamster=-coef×day を MCTS の value 評価に加算。
  // value head 自体 (outcome 分布) は変更しない。
  if (process.env.SKOLLZ_DAY_BONUS_COEF) {
    const coef = parseFloat(process.env.SKOLLZ_DAY_BONUS_COEF)
    if (Number.isFinite(coef)) {
      config.dayBonusCoef = coef
      log(`SKOLLZ_DAY_BONUS_COEF=${coef} (village/wolf=+coef×day [foxAlive], hamster=-coef×day)`)
    }
  }

  // Endgame bonus reward shaping (狐排除マイルストーン)。
  // viewer の retar で fox 候補ゼロになった時点で village/wolf に固定 +endgameCoef を加算。
  // 累積させない (最終日到達と同等の単発報酬)。狐排除を「次フェーズへの遷移点」として policy に学習させる。
  if (process.env.SKOLLZ_ENDGAME_BONUS_COEF) {
    const coef = parseFloat(process.env.SKOLLZ_ENDGAME_BONUS_COEF)
    if (Number.isFinite(coef)) {
      config.endgameBonusCoef = coef
      log(`SKOLLZ_ENDGAME_BONUS_COEF=${coef} (village/wolf に foxAlive=false 時に +coef 一発)`)
    }
  }

  // Night phase 並列化 (SKOLLZ_NIGHT_PARALLEL=1)。
  // night_attack/divine/guard を atomic な 1 step として扱い、敵 night phase を NN sample で通り抜けて
  // simulateNight を 1 step で leaf 評価に到達させる。LW 猫又自滅等の即時帰結が学習信号として直接 backup される。
  if (process.env.SKOLLZ_NIGHT_PARALLEL === '1') {
    config.nightParallel = true
    log('SKOLLZ_NIGHT_PARALLEL=1 (night phase を atomic 1 step として並列化)')
  }

  // Retar narrowing reward (SKOLLZ_NARROW_COEF)。
  // 村陣営の MCTS leaf value に `+coef × narrowProgress` を加算 (狼/狐は据え置き、非対称)。
  // 真贋判別を learning で獲得させて「真占/真霊の自滅吊」を減らす狙い (handoff 2026-05-05)。
  // SKOLLZ_ROLLOUT_RETAR=1 と組合せて初めて意味がある (rollout retar OFF だと no-op)。
  if (process.env.SKOLLZ_NARROW_COEF) {
    const coef = parseFloat(process.env.SKOLLZ_NARROW_COEF)
    if (Number.isFinite(coef)) {
      config.narrowBonusCoef = coef
      const requiresRetar = process.env.SKOLLZ_ROLLOUT_RETAR === '1' ? '' : ' (注意: SKOLLZ_ROLLOUT_RETAR=1 未設定のため no-op)'
      log(`SKOLLZ_NARROW_COEF=${coef} (village leaf value に +coef×narrowProgress)${requiresRetar}`)
    }
  }

  // Resume: phaseDir/resume.json があれば lastCompletedRound + 1 から再開、
  // gameSeedCounter も復元する。weights は buildSlot 内で {slot}/final.json から resume 済み。
  // TrainingBuffer は persist しないので空で再開 (1-2 round で再蓄積される)。
  const resumeStatePath = join(phaseDir, 'resume.json')
  let startRound = 1
  let initialGameSeedCounter: number | undefined
  let initialDirichletEpsBySlot: Partial<Record<keyof MultiTrainerSlots, number>> | undefined
  let initialLowEntropyStreakBySlot: Partial<Record<keyof MultiTrainerSlots, number>> | undefined
  if (existsSync(resumeStatePath)) {
    try {
      const raw = JSON.parse(readFileSync(resumeStatePath, 'utf-8')) as {
        lastCompletedRound: number
        gameSeedCounter: number
        dirichletEpsBySlot?: Partial<Record<keyof MultiTrainerSlots, number>>
        lowEntropyStreakBySlot?: Partial<Record<keyof MultiTrainerSlots, number>>
      }
      if (raw.lastCompletedRound >= options.rounds) {
        log(`resume.json: 既に ${raw.lastCompletedRound} round 完了済み (target ${options.rounds})、追加 round なし`)
      } else {
        startRound = raw.lastCompletedRound + 1
        initialGameSeedCounter = raw.gameSeedCounter
        initialDirichletEpsBySlot = raw.dirichletEpsBySlot
        initialLowEntropyStreakBySlot = raw.lowEntropyStreakBySlot
        log(`resume: round ${startRound} から再開 (前回 ${raw.lastCompletedRound} 完了、gameSeedCounter=${raw.gameSeedCounter})`)
        if (raw.dirichletEpsBySlot) {
          const epsStr = SLOT_KEYS
            .map(k => raw.dirichletEpsBySlot?.[k] !== undefined ? `${k}=${raw.dirichletEpsBySlot[k]!.toFixed(3)}` : null)
            .filter(s => s !== null)
            .join(' ')
          if (epsStr.length > 0) log(`resume: dirichlet ε ${epsStr}`)
        }
      }
    } catch (e) {
      log(`WARN: resume.json 読み込み失敗、最初から開始: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const trainer = new MultiSkollZeroTrainer({
    slots, config, initialGameSeedCounter,
    initialDirichletEpsBySlot, initialLowEntropyStreakBySlot,
  })

  // Eval セッション設定: SKOLLZ_EVAL_EVERY=N で N round ごとに argmax self-play で勝率推移を記録
  const evalEvery = parseInt(process.env.SKOLLZ_EVAL_EVERY ?? '0', 10)
  const evalGames = parseInt(process.env.SKOLLZ_EVAL_GAMES ?? '100', 10)
  const evalLogPath = join(phaseDir, 'eval_log.jsonl')
  if (evalEvery > 0) {
    log(`eval: ${evalEvery} round ごとに ${evalGames} game eval (argmax)、出力 ${evalLogPath}`)
  }

  const roundSummaries: Array<{ round: number, outcomes: { villagerWon: number, werewolfWon: number, werehamsterWon: number, draw: number } }> = []

  try {
    // 起動直後 eval: round ループに入る前に現在の NN 状態で 1 度評価する。
    // resume 時は前回完了 round 直後の状態、新ラン時は pretrain 直後の初期状態を記録。
    // eval_log.jsonl の round は startRound - 1 (= 直前完了 round)、`startup: true` でマーク。
    if (evalEvery > 0) {
      const startupEvalRound = startRound - 1
      log(`eval@R${startupEvalRound} (startup) starting (n=${evalGames}, argmax)...`)
      const startupEval = await runEvalSession(
        slots,
        config,
        evalGames,
        options.seed + 1_000_000 + startupEvalRound,
      )
      log(`eval@R${startupEvalRound} (startup) elapsed=${startupEval.elapsedSec.toFixed(1)}s vill=${startupEval.outcomes.villagerWon} wolf=${startupEval.outcomes.werewolfWon} ham=${startupEval.outcomes.werehamsterWon} draw=${startupEval.outcomes.draw}`)
      log(`eval@R${startupEvalRound} (startup) claim matrix:`)
      for (const row of formatClaimMatrixRows(startupEval.claimMatrix, '  ')) log(row)
      log(`eval@R${startupEvalRound} (startup) day1 deaths: ${formatDayOneDeaths(startupEval.dayOneDeaths)}`)
      appendFileSync(evalLogPath, JSON.stringify({
        round: startupEvalRound,
        startup: true,
        games: evalGames,
        elapsedSec: startupEval.elapsedSec,
        outcomes: startupEval.outcomes,
        claimMatrix: startupEval.claimMatrix,
        dayOneDeaths: startupEval.dayOneDeaths,
        timestamp: new Date().toISOString(),
      }) + '\n')
    }

    for (let r = startRound; r <= options.rounds; r++) {
      const rolloutRetar: boolean | undefined = offRounds > 0 ? r > offRounds : undefined
      const retarTag = rolloutRetar === undefined ? 'env' : (rolloutRetar ? 'on' : 'off')
      log(`round ${r}/${options.rounds} starting...`)
      const t0 = Date.now()
      const stats = await trainer.trainRound(r, phaseDir, { rolloutRetar })
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      log(`round ${r}/${options.rounds} retar=${retarTag} elapsed=${elapsed}s vill=${stats.outcomes.villagerWon} wolf=${stats.outcomes.werewolfWon} ham=${stats.outcomes.werehamsterWon} draw=${stats.outcomes.draw}`)
      for (const key of SLOT_KEYS) {
        const s = stats.perSlot[key]
        if (!s) continue
        // ε / H/streak は auto-decay 有効時のみ末尾に表示 (無効時は ε が動かないので冗長)
        const epsTag = (s.dirichletEpsAfter !== s.dirichletEps)
          ? ` ε=${s.dirichletEps.toFixed(3)}→${s.dirichletEpsAfter.toFixed(3)} streak=0`
          : (config.dirichletAuto?.enabled
            ? ` ε=${s.dirichletEps.toFixed(3)} H=${s.meanEntropyRatio.toFixed(3)} streak=${s.lowEntropyStreak}`
            : '')
        log(`  ${key.padEnd(11)} +${s.recordsAdded} buf=${s.bufferSize} steps=${s.stepsRun} loss=${s.avgLoss.toFixed(4)} (p=${s.avgPolicyLoss.toFixed(4)} v=${s.avgValueLoss.toFixed(4)})${epsTag}`)
      }
      writeRoundMeta(phaseDir, stats)
      roundSummaries.push({ round: r, outcomes: stats.outcomes })

      // Resume 用: round 完了時に resume.json を atomically 上書き
      writeFileSync(resumeStatePath, JSON.stringify({
        lastCompletedRound: r,
        gameSeedCounter: trainer.getGameSeedCounter(),
        timestamp: new Date().toISOString(),
        dirichletEpsBySlot: trainer.getDirichletEpsBySlot(),
        lowEntropyStreakBySlot: trainer.getLowEntropyStreakBySlot(),
      }, null, 2))

      // Eval セッション (SKOLLZ_EVAL_EVERY > 0 のとき N round ごとに実行)
      if (evalEvery > 0 && r % evalEvery === 0) {
        log(`eval@R${r} starting (n=${evalGames}, argmax)...`)
        const { outcomes: evalOut, elapsedSec: evalElapsed, claimMatrix: evalClaim, dayOneDeaths: evalDeaths } = await runEvalSession(
          slots,
          config,
          evalGames,
          options.seed + 1_000_000 + r,  // run-static seed offset (round 番号で variation)
        )
        log(`eval@R${r} elapsed=${evalElapsed.toFixed(1)}s vill=${evalOut.villagerWon} wolf=${evalOut.werewolfWon} ham=${evalOut.werehamsterWon} draw=${evalOut.draw}`)
        log(`eval@R${r} claim matrix:`)
        for (const row of formatClaimMatrixRows(evalClaim, '  ')) log(row)
        log(`eval@R${r} day1 deaths: ${formatDayOneDeaths(evalDeaths)}`)
        appendFileSync(evalLogPath, JSON.stringify({
          round: r,
          games: evalGames,
          elapsedSec: evalElapsed,
          outcomes: evalOut,
          claimMatrix: evalClaim,
          dayOneDeaths: evalDeaths,
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
