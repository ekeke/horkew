/**
 * skoll-zero self-play playback CLI: ckpt をロードして N ゲームを self-play で
 * 走らせ、各ゲームを howl 形式でファイル出力する。NN の判断異常を診断する用途。
 *
 * 学習時と同じ multi-runner / fullAdapter / 6 slot 構成で走らせるため、cross-module
 * dispatch (claim_*_true / claim_*_fake / morning phase) が機能する。bb-style.ts は
 * BrainBattleAdapter (通信フェーズ無し) で評価するため、両者は補完関係にある。
 *
 * 用例:
 *   node --experimental-strip-types src/skoll-zero/eval/self-play-howl.ts \
 *     --ckpt-base tmp/orch-skollz-stage5c-300r-v1/phases/00-skoll-zero \
 *     --games 5 --rollouts 50 --selection-mode argmax
 *
 *   # 特定 round の重みで再生
 *   node --experimental-strip-types src/skoll-zero/eval/self-play-howl.ts \
 *     --ckpt-base tmp/orch-skollz-stage5c-300r-v1/phases/00-skoll-zero \
 *     --round 1 --games 5
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { LupaConfig } from '../../lupa/types.ts'
import { formatHowl } from '../../lupa/format.ts'
import { loadCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'

import { MasonZeroNetwork } from '../network/mason-zero.ts'
import {
  createSkollZeroNetwork, createStandardZeroNetwork,
  createWolfZeroNetwork, createFanaticZeroNetwork,
} from '../network/config.ts'
import { TrainingBuffer } from '../selfplay/buffer.ts'
import {
  runMultiAgentSelfPlayGame,
  type SlotMap,
  type GameResult,
} from '../selfplay/multi-runner.ts'
import { DEFAULT_MCTS_CONFIG, type MCTSConfig } from '../mcts/ISMCTS.ts'

type CliOptions = {
  ckptBase: string
  games: number
  seed: number
  rollouts: number
  selectionMode: 'sample' | 'argmax' | 'policy_argmax'
  round: number | null
  out: string | null
}

/** result → ファイル名フラグメント */
function resultTag(r: GameResult): string {
  switch (r) {
    case 'villager_won': return 'village'
    case 'werewolf_won': return 'wolf'
    case 'werehamster_won': return 'hamster'
    case 'draw': return 'draw'
    default: return 'unknown'
  }
}

/** ckpt 重みファイルのファイル名: round 指定なら round_NNNN/weights.json、無指定なら final.json */
function weightFileName(round: number | null): string {
  if (round == null) return 'final.json'
  return join(`round_${String(round).padStart(4, '0')}`, 'weights.json')
}

/** ckptBase 配下 6 slot をロードして Pure JS net を返す */
function loadAllNets(ckptBase: string, round: number | null) {
  const fileName = weightFileName(round)
  const paths = {
    mason: join(ckptBase, 'mason', fileName),
    village: join(ckptBase, 'village', fileName),
    wolf: join(ckptBase, 'wolf', fileName),
    fanatic: join(ckptBase, 'fanatic', fileName),
    hamster: join(ckptBase, 'hamster', fileName),
    immoralist: join(ckptBase, 'immoralist', fileName),
  }
  for (const [k, p] of Object.entries(paths)) {
    if (!existsSync(p)) throw new Error(`${k} ckpt not found: ${p}`)
  }
  const masonNet = createSkollZeroNetwork()
  loadCheckpoint(masonNet, paths.mason)
  const villageNet = createStandardZeroNetwork()
  loadCheckpoint(villageNet, paths.village)
  const wolfNet = createWolfZeroNetwork()
  loadCheckpoint(wolfNet, paths.wolf)
  const fanaticNet = createFanaticZeroNetwork()
  loadCheckpoint(fanaticNet, paths.fanatic)
  const hamsterNet = createStandardZeroNetwork()
  loadCheckpoint(hamsterNet, paths.hamster)
  const immoralistNet = createStandardZeroNetwork()
  loadCheckpoint(immoralistNet, paths.immoralist)
  return { masonNet, villageNet, wolfNet, fanaticNet, hamsterNet, immoralistNet }
}

function buildSlotMap(nets: ReturnType<typeof loadAllNets>): SlotMap {
  return {
    mason:      { nn: new MasonZeroNetwork(nets.masonNet,      { zeroValueHead: false }), buffer: new TrainingBuffer() },
    village:    { nn: new MasonZeroNetwork(nets.villageNet,    { zeroValueHead: false }), buffer: new TrainingBuffer() },
    wolf:       { nn: new MasonZeroNetwork(nets.wolfNet,       { zeroValueHead: false }), buffer: new TrainingBuffer() },
    fanatic:    { nn: new MasonZeroNetwork(nets.fanaticNet,    { zeroValueHead: false }), buffer: new TrainingBuffer() },
    hamster:    { nn: new MasonZeroNetwork(nets.hamsterNet,    { zeroValueHead: false }), buffer: new TrainingBuffer() },
    immoralist: { nn: new MasonZeroNetwork(nets.immoralistNet, { zeroValueHead: false }), buffer: new TrainingBuffer() },
  }
}

/** YAML frontmatter 付きの howl 文字列を組み立てる */
function buildHowlWithFrontmatter(
  body: string,
  meta: {
    seed: number
    result: string
    ckptBase: string
    round: number | null
    selectionMode: string
    rollouts: number
    gitSha: string
  },
): string {
  const fm = [
    '---',
    `seed: ${meta.seed}`,
    `result: ${meta.result}`,
    `ckpt: ${meta.ckptBase}`,
    `round: ${meta.round == null ? 'final' : meta.round}`,
    `selectionMode: ${meta.selectionMode}`,
    `rollouts: ${meta.rollouts}`,
    `gitSha: ${meta.gitSha}`,
    '---',
    '',
  ].join('\n')
  return fm + body
}

function readGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

async function runPlayback(opts: CliOptions): Promise<void> {
  const nets = loadAllNets(opts.ckptBase, opts.round)
  const slots = buildSlotMap(nets)

  const mctsConfig: MCTSConfig = { ...DEFAULT_MCTS_CONFIG, nRollouts: opts.rollouts }

  const outDir = opts.out
    ?? (opts.round == null
      ? join(opts.ckptBase, 'self-play-howl')
      : join(opts.ckptBase, 'self-play-howl', `round_${String(opts.round).padStart(4, '0')}`))
  mkdirSync(outDir, { recursive: true })

  const gitSha = readGitSha()

  process.stderr.write(
    `[self-play-howl] ckpt=${opts.ckptBase} round=${opts.round ?? 'final'} games=${opts.games} rollouts=${opts.rollouts} mode=${opts.selectionMode}\n`,
  )
  process.stderr.write(`[self-play-howl] out=${outDir}\n`)

  const tally = { village: 0, wolf: 0, hamster: 0, draw: 0, unknown: 0 }

  for (let g = 0; g < opts.games; g++) {
    const seed = opts.seed + g
    const t0 = Date.now()
    const r = await runMultiAgentSelfPlayGame({
      slots,
      seed,
      mctsConfig,
      selectionMode: opts.selectionMode,
      collectGameRecord: true,
    })
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

    if (!r.record) throw new Error('expected record (collectGameRecord=true)')

    const tag = resultTag(r.result)
    tally[tag as keyof typeof tally]++

    const body = formatHowl(
      r.record.events as readonly unknown[],
      r.record.state,
      r.record.config as unknown as LupaConfig,
    )
    const howl = buildHowlWithFrontmatter(body, {
      seed,
      result: r.result ?? 'unknown',
      ckptBase: opts.ckptBase,
      round: opts.round,
      selectionMode: opts.selectionMode,
      rollouts: opts.rollouts,
      gitSha,
    })

    const fileName = `seed_${String(seed).padStart(4, '0')}_${tag}.howl`
    writeFileSync(join(outDir, fileName), howl)

    process.stderr.write(`[self-play-howl] ${g + 1}/${opts.games} seed=${seed} result=${tag} elapsed=${elapsed}s -> ${fileName}\n`)
  }

  const total = opts.games
  process.stdout.write([
    '=== self-play howl playback ===',
    `ckpt-base: ${opts.ckptBase}`,
    `round: ${opts.round ?? 'final'}`,
    `games: ${total}, rollouts: ${opts.rollouts}, mode: ${opts.selectionMode}`,
    `village: ${tally.village} (${(tally.village / total * 100).toFixed(1)}%)`,
    `wolf:    ${tally.wolf} (${(tally.wolf / total * 100).toFixed(1)}%)`,
    `hamster: ${tally.hamster} (${(tally.hamster / total * 100).toFixed(1)}%)`,
    `draw:    ${tally.draw} (${(tally.draw / total * 100).toFixed(1)}%)`,
    `output: ${outDir}`,
  ].join('\n') + '\n')
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    ckptBase: '',
    games: 10,
    seed: 1,
    rollouts: 50,
    selectionMode: 'argmax',
    round: null,
    out: null,
  }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--ckpt-base': opts.ckptBase = argv[++i]; break
      case '--games': opts.games = parseInt(argv[++i], 10); break
      case '--seed': opts.seed = parseInt(argv[++i], 10); break
      case '--rollouts': opts.rollouts = parseInt(argv[++i], 10); break
      case '--selection-mode': opts.selectionMode = argv[++i] as 'sample' | 'argmax' | 'policy_argmax'; break
      case '--round': opts.round = parseInt(argv[++i], 10); break
      case '--out': opts.out = argv[++i]; break
      case '-h': case '--help':
        process.stderr.write([
          'Usage: self-play-howl.ts [options]',
          '  --ckpt-base PATH    skoll-zero phase dir (e.g. tmp/orch-skollz-...-v1/phases/00-skoll-zero) (required)',
          '  --games N           number of games (default: 10)',
          '  --seed N            base seed (default: 1)',
          '  --rollouts N        MCTS rollouts (default: 50)',
          '  --selection-mode M  sample | argmax | policy_argmax (default: argmax; use policy_argmax for NN-only eval-equivalent)',
          '  --round NNNN        load round_NNNN/weights.json instead of final.json',
          '  --out PATH          output dir (default: <ckpt-base>/self-play-howl[/round_NNNN])',
        ].join('\n') + '\n')
        process.exit(0)
    }
  }
  if (!opts.ckptBase) {
    process.stderr.write('error: --ckpt-base required\n')
    process.exit(1)
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
runPlayback(opts).catch(e => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
  process.exit(1)
})
