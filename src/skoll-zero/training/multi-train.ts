/**
 * Multi-agent skoll-zero training CLI。
 *
 * mason/village/wolf/fanatic/hamster/immoralist の 6 slot を同時に学習する。
 *
 * 使い方:
 *   node --experimental-strip-types src/skoll-zero/training/multi-train.ts \
 *     --output tmp/skoll-zero-multi \
 *     --rounds 20 --games 50 --rollouts 100
 *
 * warm-start:
 *   - mason:      src/skoll/models/mason.json      (SL)
 *   - wolf:       src/skoll/models/wolf.json       (SL)
 *   - fanatic:    src/skoll/models/fanatic.json    (SL)
 *   - hamster:    src/skoll/models/hamster.json    (SL)
 *   - immoralist: src/skoll/models/immoralist.json (SL)
 *   - village:    random init (SL 非存在)
 *
 * 各 slot の個別 disable: --no-{slot}
 */

import { existsSync } from 'node:fs'

import { MasonZeroNetwork } from '../network/mason-zero.ts'
import {
  createSkollZeroTfNetwork,
  createStandardZeroTfNetwork,
  createWolfZeroTfNetwork,
} from '../network/tf-config.ts'
import {
  createSkollZeroNetwork,
  createStandardZeroNetwork,
  createWolfZeroNetwork,
} from '../network/config.ts'
import { loadCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'
import { TrainingBuffer } from '../selfplay/buffer.ts'
import { MultiSkollZeroTrainer, writeRoundMeta, type MultiTrainerSlots } from './multi-trainer.ts'
import { DEFAULT_SKOLL_ZERO_TRAIN_CONFIG } from './schedule.ts'

type Args = {
  outputDir: string
  rounds: number
  games: number
  rollouts: number
  batchSize: number
  stepsPerRound: number
  lr: number
  seed: number
  enabled: Set<keyof MultiTrainerSlots>
  /** 前回実行の output dir。指定時は {dir}/{slot}/final.json から resume する */
  resumeFrom: string | null
  /** self-play には参加するが weight 更新を止める slot */
  frozen: Set<keyof MultiTrainerSlots>
}

const ALL_SLOTS: (keyof MultiTrainerSlots)[] = [
  'mason', 'village', 'wolf', 'fanatic', 'hamster', 'immoralist',
]

const WARM_START_PATHS: Record<Exclude<keyof MultiTrainerSlots, 'village'>, string> = {
  mason: 'src/skoll/models/mason.json',
  wolf: 'src/skoll/models/wolf.json',
  fanatic: 'src/skoll/models/fanatic.json',
  hamster: 'src/skoll/models/hamster.json',
  immoralist: 'src/skoll/models/immoralist.json',
}

function parseCli(): Args {
  const argv = process.argv.slice(2)
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(name)
    return idx >= 0 ? argv[idx + 1] : undefined
  }
  const enabled = new Set<keyof MultiTrainerSlots>(ALL_SLOTS)
  for (const slot of ALL_SLOTS) {
    if (argv.includes(`--no-${slot}`)) enabled.delete(slot)
  }
  const frozen = new Set<keyof MultiTrainerSlots>()
  for (const slot of ALL_SLOTS) {
    if (argv.includes(`--freeze-${slot}`)) frozen.add(slot)
  }
  return {
    outputDir: get('--output') ?? 'tmp/skoll-zero-multi',
    rounds: parseInt(get('--rounds') ?? '10', 10),
    games: parseInt(get('--games') ?? '20', 10),
    rollouts: parseInt(get('--rollouts') ?? '50', 10),
    batchSize: parseInt(get('--batch') ?? '32', 10),
    stepsPerRound: parseInt(get('--steps') ?? '20', 10),
    lr: parseFloat(get('--lr') ?? '3e-4'),
    seed: parseInt(get('--seed') ?? '42', 10),
    enabled,
    resumeFrom: get('--resume-from') ?? null,
    frozen,
  }
}

const log = (s: string): void => { process.stderr.write(`[multi-train] ${s}\n`) }

function buildSlot(
  slotKey: keyof MultiTrainerSlots,
  args: Args,
): MultiTrainerSlots[keyof MultiTrainerSlots] | null {
  // Pure JS net 構築
  let pureNet
  let tfNet
  if (slotKey === 'mason') {
    pureNet = createSkollZeroNetwork()
    tfNet = createSkollZeroTfNetwork(args.lr)
  } else if (slotKey === 'wolf') {
    pureNet = createWolfZeroNetwork()
    tfNet = createWolfZeroTfNetwork(args.lr)
  } else {
    // village / fanatic / hamster / immoralist は standard obs 1029 dims
    pureNet = createStandardZeroNetwork()
    tfNet = createStandardZeroTfNetwork(args.lr)
  }

  // resume > warm-start > random の順で読み込み先を決定
  const resumePath = args.resumeFrom ? `${args.resumeFrom.replace(/\/$/, '')}/${slotKey}/final.json` : null
  if (resumePath && existsSync(resumePath)) {
    loadCheckpoint(pureNet, resumePath)
    log(`${slotKey}: resume from ${resumePath}`)
  } else if (slotKey !== 'village') {
    const ckptPath = WARM_START_PATHS[slotKey]
    if (existsSync(ckptPath)) {
      loadCheckpoint(pureNet, ckptPath)
      log(`${slotKey}: warm-start from ${ckptPath}`)
    } else {
      log(`${slotKey}: WARN ${ckptPath} not found, random init`)
    }
  } else {
    log(`village: random init (SL 非存在)`)
  }

  // Pure JS → TF に weights 同期
  tfNet.loadWeights(pureNet.cloneWeights())

  const masonZeroNet = new MasonZeroNetwork(pureNet, { zeroValueHead: false })
  const buffer = new TrainingBuffer()
  const frozen = args.frozen.has(slotKey)
  if (frozen) log(`${slotKey}: FROZEN (self-play only, no weight update)`)
  return { masonZeroNet, tfNet, buffer, frozen }
}

async function main(): Promise<void> {
  const args = parseCli()

  log(`output: ${args.outputDir}`)
  log(`enabled slots: ${[...args.enabled].join(', ')}`)
  log(`rounds=${args.rounds} games/round=${args.games} rollouts=${args.rollouts}`)

  const slots: MultiTrainerSlots = {}
  for (const key of ALL_SLOTS) {
    if (!args.enabled.has(key)) continue
    slots[key] = buildSlot(key, args)!
  }

  const config = {
    ...DEFAULT_SKOLL_ZERO_TRAIN_CONFIG,
    learningRate: args.lr,
    batchSize: args.batchSize,
    stepsPerRound: args.stepsPerRound,
    gamesPerRound: args.games,
    mctsRollouts: args.rollouts,
    rngSeed: args.seed,
  }

  const trainer = new MultiSkollZeroTrainer({ slots, config })

  for (let r = 1; r <= args.rounds; r++) {
    const t0 = Date.now()
    const stats = await trainer.trainRound(r, args.outputDir)
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    log(`round ${r}/${args.rounds} elapsed=${elapsed}s outcomes: vill=${stats.outcomes.villagerWon} wolf=${stats.outcomes.werewolfWon} ham=${stats.outcomes.werehamsterWon} draw=${stats.outcomes.draw}`)
    for (const key of ALL_SLOTS) {
      const s = stats.perSlot[key]
      if (!s) continue
      log(`  ${key.padEnd(11)} +${s.recordsAdded} records, buf=${s.bufferSize}, steps=${s.stepsRun}, loss=${s.avgLoss.toFixed(4)} (p=${s.avgPolicyLoss.toFixed(3)}, v=${s.avgValueLoss.toFixed(3)})`)
    }
    writeRoundMeta(args.outputDir, stats)
  }

  for (const key of ALL_SLOTS) {
    slots[key]?.tfNet.dispose()
  }
  log('done')
}

main().catch((err) => {
  process.stderr.write(`[multi-train] ERROR: ${err?.stack ?? err}\n`)
  process.exit(1)
})
