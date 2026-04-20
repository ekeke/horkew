/**
 * skoll-zero M5 smoke-train。warm start checkpoint から N round 自己対戦 + 学習を回す。
 *
 * 本訓練ではなく「Trainer が end-to-end で動くか」の確認用。
 * 既定 3 rounds × 10 games × 100 MCTS rollouts。
 *
 * 使い方:
 *   node --experimental-strip-types src/skoll-zero/training/smoke-train.ts \
 *     --ckpt tmp/skoll-mb-large-v2/phases/00-skoll-supervised/ckpt-mason_collective/collective_final.json \
 *     --output tmp/skoll-zero-smoke \
 *     --rounds 3 --games 10 --rollouts 100
 *
 * --ckpt を省略すると Phase 1 の SL checkpoint デフォルト path を使う。
 */

import { existsSync } from 'node:fs'

import { MasonZeroNetwork } from '../network/mason-zero.ts'
import { createSkollZeroTfNetwork } from '../network/tf-config.ts'
import { loadSkollSupervisedWeights } from '../network/warm-start.ts'
import { TrainingBuffer } from '../selfplay/buffer.ts'
import { SkollZeroTrainer } from './trainer.ts'
import { DEFAULT_SKOLL_ZERO_TRAIN_CONFIG } from './schedule.ts'

type Args = {
  ckptPath: string | null
  outputDir: string
  rounds: number
  games: number
  rollouts: number
  batchSize: number
  stepsPerRound: number
  lr: number
  seed: number
}

const DEFAULT_CKPT_PATH = 'tmp/skoll-mb-large-v2/phases/00-skoll-supervised/ckpt-mason_collective/collective_final.json'

function parseCli(): Args {
  const argv = process.argv.slice(2)
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(name)
    return idx >= 0 ? argv[idx + 1] : undefined
  }
  return {
    ckptPath: get('--ckpt') ?? DEFAULT_CKPT_PATH,
    outputDir: get('--output') ?? 'tmp/skoll-zero-smoke',
    rounds: parseInt(get('--rounds') ?? '3', 10),
    games: parseInt(get('--games') ?? '10', 10),
    rollouts: parseInt(get('--rollouts') ?? '100', 10),
    batchSize: parseInt(get('--batch') ?? '32', 10),
    stepsPerRound: parseInt(get('--steps') ?? '20', 10),
    lr: parseFloat(get('--lr') ?? '3e-4'),
    seed: parseInt(get('--seed') ?? '42', 10),
  }
}

async function main(): Promise<void> {
  const args = parseCli()
  const log = (s: string): void => { process.stderr.write(`[skoll-zero-smoke] ${s}\n`) }

  log(`warm start from: ${args.ckptPath ?? '(none, random init)'}`)
  log(`output: ${args.outputDir}`)
  log(`rounds=${args.rounds} games/round=${args.games} rollouts/mcts=${args.rollouts} batch=${args.batchSize} steps/round=${args.stepsPerRound} lr=${args.lr}`)

  const masonZeroNet = new MasonZeroNetwork()

  if (args.ckptPath) {
    if (!existsSync(args.ckptPath)) {
      log(`WARN: ckpt not found at ${args.ckptPath}; random init で継続`)
    } else {
      const warm = loadSkollSupervisedWeights(masonZeroNet, args.ckptPath)
      log(`warm start: iter=${warm.metadata.iteration} winRate=${warm.metadata.winRate}`)
    }
  }

  const tfNet = createSkollZeroTfNetwork(args.lr)
  tfNet.loadWeights(masonZeroNet.net.cloneWeights())

  const buffer = new TrainingBuffer()
  const config = {
    ...DEFAULT_SKOLL_ZERO_TRAIN_CONFIG,
    learningRate: args.lr,
    batchSize: args.batchSize,
    stepsPerRound: args.stepsPerRound,
    gamesPerRound: args.games,
    mctsRollouts: args.rollouts,
    rngSeed: args.seed,
  }
  const trainer = new SkollZeroTrainer({ masonZeroNet, tfNet, buffer, config })

  for (let r = 1; r <= args.rounds; r++) {
    const t0 = Date.now()
    const stats = await trainer.trainRound(r, args.outputDir)
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    log(`round ${r}/${args.rounds} elapsed=${elapsed}s records+=${stats.recordsAdded} buf=${stats.bufferSize} expired=${stats.bufferExpired} steps=${stats.stepsRun}`)
    log(`  loss=${stats.avgLoss.toFixed(4)} policy=${stats.avgPolicyLoss.toFixed(4)} value=${stats.avgValueLoss.toFixed(4)}`)
    log(`  outcomes: vill=${stats.outcomes.villagerWon} wolf=${stats.outcomes.werewolfWon} hamster=${stats.outcomes.werehamsterWon} draw=${stats.outcomes.draw}`)
  }

  tfNet.dispose()
  log('done')
}

main().catch((err) => {
  process.stderr.write(`[skoll-zero-smoke] ERROR: ${err?.stack ?? err}\n`)
  process.exit(1)
})
