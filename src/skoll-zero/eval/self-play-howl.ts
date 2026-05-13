/**
 * skoll-zero self-play playback CLI: ckpt をロードして N ゲームを self-play で
 * 走らせ、各ゲームを howl 形式でファイル出力する。NN の判断異常を診断する用途。
 *
 * **設定の出所**: 必ず eval プロファイル ([eval/run-profile.ts] の `RUN_PROFILES.eval`)
 * を使い、SlotMap 構築は [eval/build-eval-slots.ts] の `buildEvalSlots` を経由する。
 * これにより、学習中の eval ループ ([phase/runner.ts] の `runEvalSession`) と
 * 完全に同じ条件で再生される。CLI から selectionMode を override する余地は
 * 意図的に残していない (設定の乖離を防ぐため)。
 *
 * 用例:
 *   node --experimental-strip-types src/skoll-zero/eval/self-play-howl.ts \
 *     --ckpt-base tmp/orch-skollz-.../phases/00-skoll-zero \
 *     --games 10
 *
 *   # 特定 round の重みで再生
 *   node --experimental-strip-types src/skoll-zero/eval/self-play-howl.ts \
 *     --ckpt-base tmp/orch-skollz-.../phases/00-skoll-zero \
 *     --round 100 --games 5
 *
 * 注: SKOLLZ_WOLF_IMITATION 等の env は学習時と同じ値を渡すこと
 * (= 同じ train-config.json 配下の ckpt を読むなら、その config を export しておく)。
 */

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { LupaConfig } from '../../lupa/types.ts'
import { formatHowl } from '../../lupa/format.ts'

import {
  runMultiAgentSelfPlayGame,
  type GameResult,
} from '../selfplay/multi-runner.ts'
import { DEFAULT_MCTS_CONFIG, type MCTSConfig } from '../mcts/ISMCTS.ts'
import { RUN_PROFILES } from './run-profile.ts'
import { buildEvalSlots } from './build-eval-slots.ts'

type CliOptions = {
  ckptBase: string
  games: number
  seed: number
  rollouts: number
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
  const slots = buildEvalSlots({ ckptBase: opts.ckptBase, round: opts.round })

  // RUN_PROFILES.eval を使う。policy_argmax は MCTS 不使用なので mctsConfig はダミー値で OK
  // (= runner.ts の runEvalSession と同じ扱い)。
  const selectionMode = RUN_PROFILES.eval.selectionMode
  const mctsConfig: MCTSConfig = {
    ...DEFAULT_MCTS_CONFIG,
    nRollouts: opts.rollouts,
    nightParallel: process.env.SKOLLZ_NIGHT_PARALLEL === '1',
  }

  const outDir = opts.out
    ?? (opts.round == null
      ? join(opts.ckptBase, 'self-play-howl')
      : join(opts.ckptBase, 'self-play-howl', `round_${String(opts.round).padStart(4, '0')}`))
  mkdirSync(outDir, { recursive: true })

  const gitSha = readGitSha()

  process.stderr.write(
    `[self-play-howl] ckpt=${opts.ckptBase} round=${opts.round ?? 'final'} games=${opts.games} mode=${selectionMode} (eval profile)\n`,
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
      selectionMode,
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
      selectionMode,
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
    `games: ${total}, rollouts: ${opts.rollouts}, mode: ${selectionMode} (eval profile)`,
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
    round: null,
    out: null,
  }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--ckpt-base': opts.ckptBase = argv[++i]; break
      case '--games': opts.games = parseInt(argv[++i], 10); break
      case '--seed': opts.seed = parseInt(argv[++i], 10); break
      case '--rollouts': opts.rollouts = parseInt(argv[++i], 10); break
      case '--round': opts.round = parseInt(argv[++i], 10); break
      case '--out': opts.out = argv[++i]; break
      case '-h': case '--help':
        process.stderr.write([
          'Usage: self-play-howl.ts [options]',
          '  --ckpt-base PATH    skoll-zero phase dir (e.g. tmp/orch-skollz-.../phases/00-skoll-zero) (required)',
          '  --games N           number of games (default: 10)',
          '  --seed N            base seed (default: 1)',
          '  --rollouts N        MCTS rollouts (default: 50, used only if eval profile uses MCTS)',
          '  --round NNNN        load round_NNNN/weights.json instead of final.json',
          '  --out PATH          output dir (default: <ckpt-base>/self-play-howl[/round_NNNN])',
          '',
          '  selection mode は eval プロファイル ([eval/run-profile.ts]) で固定。',
          '  CLI から override 不可 (学習中 eval と設定を一致させるため)。',
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
