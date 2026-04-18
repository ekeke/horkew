/**
 * Brain Battle 改善評価: skoll-pretrained mason vs random mason
 *
 * BrainBattleAdapter で N ゲーム回し、村陣営勝率を比較する。
 * BB の PPO 学習を一切走らせず、純粋に「初期重みの差が勝率に与える影響」を測る。
 *
 * 比較対象:
 *   - random       : mason_brain も wolf_brain もランダム初期化（BB ベースライン）
 *   - skoll        : mason_brain は skoll-pretrained、wolf_brain はランダム
 *   - (オプション) : 既存 BB 学習済み checkpoint があれば追加比較
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { SystemRole } from '../../../types/index.ts'
import type { GameHandlers } from '../../../lupa/handlers.ts'
import type { FenrirExt } from '../ext.ts'
import type { FenrirExtEvent } from '../events.ts'
import type { TeamDecisionContext, WolfNightAction } from '../agents/agent.ts'
import { runGame } from '../../../lupa/engine.ts'
import { BrainBattleAdapter } from '../adapters/brain-battle-adapter.ts'
import { WolfBrainAgent, type WolfFormation } from '../agents/wolf-brain.ts'
import { MasonBrainAgent } from '../agents/mason-brain.ts'
import { RuleBasedAgent } from '../agents/rule-based-agent.ts'
import { createMasonBrainNetwork, createNetwork, createWolfBrainNetwork } from '../training.ts'
import { loadCheckpoint } from '../ml/checkpoint.ts'
import { SkollMasterAgent } from '../../../skoll/skoll-master-agent.ts'
import { SkollMasonTeamAgent } from '../../../skoll/skoll-mason-agent.ts'
import { SkollWolfTeamAgent } from '../../../skoll/skoll-wolf-agent.ts'
import type { AnyNetwork } from '../ml/nn.ts'

const DEFAULT_ROLES: Map<SystemRole, number> = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])

export type Variant = {
  name: string
  /** mason_brain checkpoint。null/undefined = ランダム。'skoll' でヒューリスティック skoll に置換 */
  masonCkpt: string | null | 'skoll'
  /** wolf_brain checkpoint。null/undefined = ランダム。'skoll' でヒューリスティック skoll に置換 */
  wolfCkpt: string | null | 'skoll'
  /** masonCkpt='skoll' の時に重盤面で fallback する NN checkpoint パス (任意) */
  masonNnFallback?: string
  /** NN フォールバック発火しきい値 (estimateWorldCount.upperBound > N で fallback) */
  masonFallbackThreshold?: number
  /** wolfCkpt='skoll' の時に重盤面で fallback する NN checkpoint パス (任意) */
  wolfNnFallback?: string
  wolfFallbackThreshold?: number
  /** BB adapter の turn owner 固定 (default: mason)。wolf hybrid をテストするときは 'wolf' に */
  turnOwner?: 'mason' | 'wolf'
  /** 非 mason・非 wolf 席 (fanatic/hamster/immoralist) の skoll→NN fallback 設定 */
  fanaticNnFallback?: string
  hamsterNnFallback?: string
  immoralistNnFallback?: string
  /** perspective fallback のしきい値 (default 5_000) */
  perspectiveFallbackThreshold?: number
}

// ════════════════════════════════════════════
// Heuristic skoll stubs (BB adapter の MasonBrainAgent / WolfBrainAgent インターフェイスに従う)
// ════════════════════════════════════════════

/**
 * MasonBrainAgent の代わりに skoll で execution 決定する stub。
 * BB adapter は decideExecution と clearDayCache のみ呼ぶので、それだけ実装すれば OK。
 *
 * オプションの NN フォールバック: 推定世界数が threshold を超えたら mason_brain NN を呼ぶ
 */
class SkollMasonBrainStub {
  private skoll: SkollMasonTeamAgent
  /** デバッグ: フォールバック発火回数 */
  fallbackCount = 0
  totalCalls = 0

  constructor(opts?: { nnFallback?: { network: AnyNetwork, threshold?: number } }) {
    const fallback = opts?.nnFallback
      ? {
          network: opts.nnFallback.network,
          threshold: opts.nnFallback.threshold,
          onFallback: () => { this.fallbackCount++ },
        }
      : undefined
    this.skoll = new SkollMasonTeamAgent({ nnFallback: fallback })
  }
  clearDayCache(): void {}
  decideExecution(ctx: TeamDecisionContext): number {
    this.totalCalls++
    return this.skoll.decideVote(ctx)
  }
}

/**
 * WolfBrainAgent の代わりに skoll で execution / night / formation 決定する stub。
 * BB adapter が呼ぶメソッド: getFormation, decideExecution, decideNightAction, clearDayCache
 *
 * オプションの NN フォールバック: 推定世界数が threshold を超えたら wolf_brain NN を呼ぶ
 */
class SkollWolfBrainStub {
  private skoll: SkollWolfTeamAgent
  fallbackCount = 0
  totalCalls = 0

  constructor(opts?: { nnFallback?: { network: AnyNetwork, threshold?: number } }) {
    const fallback = opts?.nnFallback
      ? {
          network: opts.nnFallback.network,
          threshold: opts.nnFallback.threshold,
          onFallback: () => { this.fallbackCount++ },
        }
      : undefined
    this.skoll = new SkollWolfTeamAgent({ nnFallback: fallback })
  }
  clearDayCache(): void {}
  decideExecution(ctx: TeamDecisionContext): number {
    this.totalCalls++
    return this.skoll.decideVote(ctx)
  }
  decideNightAction(ctx: TeamDecisionContext): WolfNightAction {
    const result = this.skoll.decideNightAction(ctx)
    if ('attacker' in result) return result
    // 'none' などの非 wolf night action は仕様外、最小 fallback
    return { target: ctx.alivePlayers[0] ?? 1, attacker: ctx.teamSeats[0] ?? 1 }
  }
  /** 全狼を「villager_co」(fake CO なし) にする最小フォーメーション */
  getFormation(ctx: TeamDecisionContext): WolfFormation {
    const wolves = ctx.teamSeats.slice(0, 3).map((seat, slot) => ({
      wolfSlot: slot,
      wolfSeat: seat,
      claimRole: 'villager_co' as const,
      fakeTarget: 0,
      fakeResult: 'human' as const,
    }))
    return { wolves }
  }
}

export type VariantStats = {
  name: string
  numGames: number
  villageWin: number
  wolfWin: number
  hamsterWin: number
  draw: number
  villageWinRate: number
}

async function runVariantGames(
  variant: Variant,
  numGames: number,
  baseSeed: number,
  /** 全 variant で共有する wolf NN (random init を固定して比較性を確保) */
  sharedWolfNet?: AnyNetwork | null,
): Promise<VariantStats> {
  // Mason brain: 'skoll' なら stub、checkpoint パスなら NN load、null ならランダム NN
  const masonNet = variant.masonCkpt !== 'skoll' ? createMasonBrainNetwork() : null
  if (masonNet && variant.masonCkpt) {
    loadCheckpoint(masonNet, variant.masonCkpt)
  }

  // wolf: 共有 NN があればそれ、なければ variant ごとに新規 / null (skoll stub)
  let wolfNet: AnyNetwork | null
  if (variant.wolfCkpt === 'skoll') {
    wolfNet = null
  } else if (variant.wolfCkpt) {
    wolfNet = createWolfBrainNetwork()
    loadCheckpoint(wolfNet, variant.wolfCkpt)
  } else {
    wolfNet = sharedWolfNet ?? createWolfBrainNetwork()
  }

  // 'skoll' variant の NN fallback 用 net
  let masonFallbackNet: AnyNetwork | null = null
  if (variant.masonCkpt === 'skoll' && variant.masonNnFallback) {
    masonFallbackNet = createMasonBrainNetwork()
    loadCheckpoint(masonFallbackNet, variant.masonNnFallback)
  }
  let wolfFallbackNet: AnyNetwork | null = null
  if (variant.wolfCkpt === 'skoll' && variant.wolfNnFallback) {
    wolfFallbackNet = createWolfBrainNetwork()
    loadCheckpoint(wolfFallbackNet, variant.wolfNnFallback)
  }
  // perspective (fanatic/hamster/immoralist) fallback NN は skoll-default variant でのみ意味を持つ
  const usingSkollDefaultForPersp = variant.masonCkpt === 'skoll' || variant.wolfCkpt === 'skoll'
  let fanaticFallbackNet: AnyNetwork | null = null
  let hamsterFallbackNet: AnyNetwork | null = null
  let immoralistFallbackNet: AnyNetwork | null = null
  if (usingSkollDefaultForPersp && variant.fanaticNnFallback) {
    fanaticFallbackNet = createNetwork()
    loadCheckpoint(fanaticFallbackNet, variant.fanaticNnFallback)
  }
  if (usingSkollDefaultForPersp && variant.hamsterNnFallback) {
    hamsterFallbackNet = createNetwork()
    loadCheckpoint(hamsterFallbackNet, variant.hamsterNnFallback)
  }
  if (usingSkollDefaultForPersp && variant.immoralistNnFallback) {
    immoralistFallbackNet = createNetwork()
    loadCheckpoint(immoralistFallbackNet, variant.immoralistNnFallback)
  }
  let masonTotalFallbacks = 0
  let masonTotalCalls = 0
  let wolfTotalFallbacks = 0
  let wolfTotalCalls = 0
  let fanaticFallbacks = 0
  let hamsterFallbacks = 0
  let immoralistFallbacks = 0

  const stats: VariantStats = {
    name: variant.name,
    numGames,
    villageWin: 0,
    wolfWin: 0,
    hamsterWin: 0,
    draw: 0,
    villageWinRate: 0,
  }

  for (let g = 0; g < numGames; g++) {
    const seed = baseSeed + g

    // Brain Battle: 探索オフ（greedy）で評価
    const wolfStub = wolfNet ? null : new SkollWolfBrainStub({
      nnFallback: wolfFallbackNet ? {
        network: wolfFallbackNet,
        threshold: variant.wolfFallbackThreshold,
      } : undefined,
    })
    const wolfBrain = wolfNet
      ? new WolfBrainAgent(wolfNet, { explore: false })
      : wolfStub! as unknown as WolfBrainAgent
    const masonStub = masonNet ? null : new SkollMasonBrainStub({
      nnFallback: masonFallbackNet ? {
        network: masonFallbackNet,
        threshold: variant.masonFallbackThreshold,
      } : undefined,
    })
    const masonBrain = masonNet
      ? new MasonBrainAgent(masonNet, { explore: false })
      : masonStub! as unknown as MasonBrainAgent

    // skoll-master variant では非 mason・非 wolf 席（村パワーロール、fanatic、hamster、immoralist）も
    // SkollMasterAgent で動かす。NN variant では従来通り RuleBasedAgent。
    const usingSkollDefault = variant.masonCkpt === 'skoll' || variant.wolfCkpt === 'skoll'
    const perspFallbackThreshold = variant.perspectiveFallbackThreshold
    const defaultAgent = usingSkollDefault
      ? new SkollMasterAgent({
          fanaticFallback: fanaticFallbackNet ? {
            network: fanaticFallbackNet,
            threshold: perspFallbackThreshold,
            onFallback: () => { fanaticFallbacks++ },
          } : undefined,
          hamsterFallback: hamsterFallbackNet ? {
            network: hamsterFallbackNet,
            threshold: perspFallbackThreshold,
            onFallback: () => { hamsterFallbacks++ },
          } : undefined,
          immoralistFallback: immoralistFallbackNet ? {
            network: immoralistFallbackNet,
            threshold: perspFallbackThreshold,
            onFallback: () => { immoralistFallbacks++ },
          } : undefined,
        })
      : new RuleBasedAgent()

    const handlers = new BrainBattleAdapter({
      wolfBrain,
      masonBrain,
      agents: new Map(),
      defaultAgent,
      seed,
      enableRetar: true,  // pretrain 時の観測と分布を揃える（retar dims が観測に含まれる）
      roles: DEFAULT_ROLES,
      onRolesAssigned: () => {},
      ...(variant.turnOwner ? { fixedTurnOwner: variant.turnOwner } : {}),
    })

    const result = await runGame(
      { roles: DEFAULT_ROLES, seed, hasFirstGhost: true },
      handlers as unknown as GameHandlers<FenrirExtEvent, FenrirExt>,
    )

    const r = result.state.result
    if (r === 'villager_won') stats.villageWin++
    else if (r === 'werewolf_won') stats.wolfWin++
    else if (r === 'werehamster_won') stats.hamsterWin++
    else stats.draw++

    if (masonStub) {
      masonTotalFallbacks += masonStub.fallbackCount
      masonTotalCalls += masonStub.totalCalls
    }
    if (wolfStub) {
      wolfTotalFallbacks += wolfStub.fallbackCount
      wolfTotalCalls += wolfStub.totalCalls
    }
  }

  stats.villageWinRate = stats.villageWin / Math.max(1, numGames)
  if (variant.masonNnFallback && masonTotalCalls > 0) {
    process.stderr.write(`[bb-eval]   mason fallback: ${masonTotalFallbacks}/${masonTotalCalls} calls (${(100 * masonTotalFallbacks / masonTotalCalls).toFixed(1)}%)\n`)
  }
  if (variant.wolfNnFallback && wolfTotalCalls > 0) {
    process.stderr.write(`[bb-eval]   wolf fallback:  ${wolfTotalFallbacks}/${wolfTotalCalls} calls (${(100 * wolfTotalFallbacks / wolfTotalCalls).toFixed(1)}%)\n`)
  }
  if (variant.fanaticNnFallback) {
    process.stderr.write(`[bb-eval]   fanatic fallback:    ${fanaticFallbacks} fires\n`)
  }
  if (variant.hamsterNnFallback) {
    process.stderr.write(`[bb-eval]   hamster fallback:    ${hamsterFallbacks} fires\n`)
  }
  if (variant.immoralistNnFallback) {
    process.stderr.write(`[bb-eval]   immoralist fallback: ${immoralistFallbacks} fires\n`)
  }
  return stats
}

export type BbEvalOptions = {
  variants: Variant[]
  numGames: number
  baseSeed: number
  outputPath: string
}

const MASON_NN_CKPT = 'src/skoll/models/mason.json'
const WOLF_NN_CKPT = 'src/skoll/models/wolf.json'
const FANATIC_NN_CKPT = 'src/skoll/models/fanatic.json'
const HAMSTER_NN_CKPT = 'src/skoll/models/hamster.json'
const IMMORALIST_NN_CKPT = 'src/skoll/models/immoralist.json'

export const DEFAULT_BB_EVAL_OPTIONS: BbEvalOptions = {
  variants: [
    // mason turn: mason が execution 決定。wolf side は night attack のみ
    { name: 'mason-turn/skoll-only', masonCkpt: 'skoll', wolfCkpt: null, turnOwner: 'mason' },
    {
      name: 'mason-turn/hybrid',
      masonCkpt: 'skoll', wolfCkpt: null, turnOwner: 'mason',
      masonNnFallback: MASON_NN_CKPT, masonFallbackThreshold: 5_000,
    },
    // wolf turn: wolf が execution 決定。wolf vote skoll/NN がここで効く
    { name: 'wolf-turn/skoll-only', masonCkpt: null, wolfCkpt: 'skoll', turnOwner: 'wolf' },
    {
      name: 'wolf-turn/hybrid',
      masonCkpt: null, wolfCkpt: 'skoll', turnOwner: 'wolf',
      wolfNnFallback: WOLF_NN_CKPT, wolfFallbackThreshold: 5_000,
    },
    // full hybrid: mason + wolf + 3 perspective (fanatic/hamster/immoralist) NN フォールバック
    {
      name: 'mason-turn/full-hybrid',
      masonCkpt: 'skoll', wolfCkpt: null, turnOwner: 'mason',
      masonNnFallback: MASON_NN_CKPT, masonFallbackThreshold: 5_000,
      fanaticNnFallback: FANATIC_NN_CKPT,
      hamsterNnFallback: HAMSTER_NN_CKPT,
      immoralistNnFallback: IMMORALIST_NN_CKPT,
      perspectiveFallbackThreshold: 5_000,
    },
    {
      name: 'wolf-turn/full-hybrid',
      masonCkpt: null, wolfCkpt: 'skoll', turnOwner: 'wolf',
      wolfNnFallback: WOLF_NN_CKPT, wolfFallbackThreshold: 5_000,
      fanaticNnFallback: FANATIC_NN_CKPT,
      hamsterNnFallback: HAMSTER_NN_CKPT,
      immoralistNnFallback: IMMORALIST_NN_CKPT,
      perspectiveFallbackThreshold: 5_000,
    },
  ],
  numGames: 100,
  baseSeed: 300000,
  outputPath: 'tmp/bb-eval/result.json',
}

export async function runBbEval(opts: Partial<BbEvalOptions> = {}): Promise<{
  results: VariantStats[]
  outputPath: string
}> {
  const options = { ...DEFAULT_BB_EVAL_OPTIONS, ...opts }

  // 全 variant で同じ wolf NN を共有して比較性を確保（variant ごとの random init noise を排除）
  // wolfCkpt が明示指定された variant はその checkpoint を使う
  const sharedWolfNet = createWolfBrainNetwork()
  process.stderr.write(`[bb-eval] shared wolf NN created (random init, fixed across variants)\n`)

  const results: VariantStats[] = []
  for (const variant of options.variants) {
    process.stderr.write(`[bb-eval] === ${variant.name} (${options.numGames} games) ===\n`)
    process.stderr.write(`[bb-eval]   mason: ${variant.masonCkpt ?? 'random'}\n`)
    process.stderr.write(`[bb-eval]   wolf : ${variant.wolfCkpt ?? 'shared-random'}\n`)
    const t0 = performance.now()
    const stats = await runVariantGames(variant, options.numGames, options.baseSeed, sharedWolfNet)
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
    process.stderr.write(
      `[bb-eval] ${variant.name}: village=${stats.villageWin} wolf=${stats.wolfWin} `
      + `hamster=${stats.hamsterWin} draw=${stats.draw} | villageWinRate=${(stats.villageWinRate * 100).toFixed(1)}% (${elapsed}s)\n`,
    )
    results.push(stats)
  }

  mkdirSync(dirname(options.outputPath), { recursive: true })
  writeFileSync(options.outputPath, JSON.stringify({ options, results }, null, 2))

  process.stderr.write(`\n[bb-eval] === Summary (numGames=${options.numGames}, baseSeed=${options.baseSeed}) ===\n`)
  for (const s of results) {
    process.stderr.write(`[bb-eval]   ${s.name.padEnd(20)} villageWin=${(s.villageWinRate * 100).toFixed(1)}%\n`)
  }
  process.stderr.write(`[bb-eval] output: ${options.outputPath}\n`)

  return { results, outputPath: options.outputPath }
}

function parseCli(): Partial<BbEvalOptions> {
  const opts: Partial<BbEvalOptions> = {}
  const args = process.argv.slice(2)
  const variantsList: Variant[] = []
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--games': opts.numGames = parseInt(args[++i], 10); break
      case '--seed': opts.baseSeed = parseInt(args[++i], 10); break
      case '--output': opts.outputPath = args[++i]; break
      case '--variant': {
        // 形式: name:masonPath:wolfPath  (path/wolfPath は省略可、'-' で random、'skoll' でヒューリスティック skoll)
        const spec = args[++i]
        const [name, masonPart, wolfPart] = spec.split(':')
        const parseSlot = (s: string | undefined): string | null | 'skoll' => {
          if (!s || s === '-') return null
          if (s === 'skoll') return 'skoll'
          return s
        }
        variantsList.push({
          name,
          masonCkpt: parseSlot(masonPart),
          wolfCkpt: parseSlot(wolfPart),
        })
        break
      }
      case '--help':
        process.stderr.write('Usage: bb-eval.ts [--games N] [--seed S] [--output PATH] [--variant name:masonPath:wolfPath ...]\n')
        process.stderr.write('  --variant の masonPath/wolfPath が "-" または省略でランダム NN、"skoll" で skoll heuristic\n')
        process.stderr.write('  --variant 未指定時は random / skoll-pretrained / skoll-master の 3 変種\n')
        process.exit(0)
    }
  }
  if (variantsList.length > 0) opts.variants = variantsList
  return opts
}

if (process.argv[1]?.endsWith('bb-eval.ts')) {
  runBbEval(parseCli()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
