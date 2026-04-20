/**
 * M6: MasonZeroAgent vs baseline の head-to-head 評価。
 *
 * 2 席の mason を被験者として置き、他 12 席を SkollMasterAgent (heuristic) 固定で
 * 同じ seed 列を 2 variant で回し、村陣営勝率を比較する。
 *
 * Variant:
 *   - baseline:  mason 席も SkollMasterAgent
 *   - mason_zero: mason 席に MasonZeroAgent (ISMCTS + warm-start NN)
 *
 * 用例:
 *   node --experimental-strip-types src/skoll-zero/eval/head-to-head.ts \
 *     --ckpt src/skoll/models/mason.json \
 *     --games 100 \
 *     --rollouts 50
 */

import type { SystemRole } from '../../types/index.ts'
import type { GameHandlers } from '../../lupa/handlers.ts'
import type { FenrirExtEvent } from '../../fenrir/src/events.ts'
import type { Agent } from '../../fenrir/src/agents/agent.ts'
import { runGame } from '../../lupa/engine.ts'
import { fullAdapter } from '../../fenrir/src/adapters/full-adapter.ts'
import { SkollMasterAgent } from '../../skoll/skoll-master-agent.ts'
import { resolveRules } from '../../howl/ruleset.ts'
import { loadNetworkFromCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'
import { MasonZeroNetwork } from '../network/mason-zero.ts'
import { MasonZeroAgent } from '../selfplay/mason-zero-agent.ts'
import { TrainingBuffer } from '../selfplay/buffer.ts'
import { DEFAULT_MCTS_CONFIG, type MCTSConfig } from '../mcts/ismcts.ts'

const DEFAULT_ROLES: Map<SystemRole, number> = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])

const DEFAULT_REVOTE = { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const }

export type Variant = 'baseline' | 'mason_zero'

export type VariantStats = {
  variant: Variant
  games: number
  village: number
  wolf: number
  hamster: number
  draw: number
  villageWinRate: number
  elapsedMs: number
  mctsCalls: number
  fallbackCalls: number
}

export type HeadToHeadOptions = {
  ckptPath: string
  games: number
  baseSeed: number
  rollouts: number
}

const DEFAULTS: HeadToHeadOptions = {
  ckptPath: 'src/skoll/models/mason.json',
  games: 100,
  baseSeed: 700000,
  rollouts: 50,
}

async function runSingleGame(
  variant: Variant,
  seed: number,
  zeroAgentFactory: (() => MasonZeroAgent) | null,
): Promise<{ result: string, mctsCalls: number, fallbackCalls: number }> {
  const roles = DEFAULT_ROLES
  const agents = new Map<number, Agent>()
  const zeroAgent = variant === 'mason_zero' ? zeroAgentFactory!() : null

  const handlers = fullAdapter({
    agents,
    defaultAgent: new SkollMasterAgent(),
    onRolesAssigned: (seatRoles) => {
      if (zeroAgent) {
        for (const [seat, role] of seatRoles) {
          if (role === 'mason') agents.set(seat, zeroAgent)
        }
      }
    },
    seed,
    enableRetar: true,
    roles,
    rules: resolveRules(),
  }) as GameHandlers<FenrirExtEvent, unknown>

  const result = await runGame(
    { roles, seed, hasFirstGhost: true, revoteConfig: DEFAULT_REVOTE },
    handlers,
  )

  return {
    result: result.state.result ?? 'draw',
    mctsCalls: zeroAgent?.mctsCalls ?? 0,
    fallbackCalls: zeroAgent?.fallbackCalls ?? 0,
  }
}

export async function runHeadToHead(opts: Partial<HeadToHeadOptions> = {}): Promise<VariantStats[]> {
  const options = { ...DEFAULTS, ...opts }
  process.stderr.write(`[h2h] loading mason_zero NN from ${options.ckptPath}\n`)
  const net = loadNetworkFromCheckpoint(options.ckptPath)
  const masonZeroNet = new MasonZeroNetwork(net)

  const mctsConfig: MCTSConfig = {
    ...DEFAULT_MCTS_CONFIG,
    nRollouts: options.rollouts,
  }

  // MasonZeroAgent factory (game ごとに fresh buffer で作る)
  const zeroAgentFactory = () => new MasonZeroAgent({
    nn: masonZeroNet,
    setup: DEFAULT_ROLES,
    buffer: new TrainingBuffer(),
    mctsConfig,
    selectionMode: 'argmax',
  })

  const results: VariantStats[] = []

  for (const variant of ['baseline', 'mason_zero'] as Variant[]) {
    process.stderr.write(`[h2h] === ${variant} (${options.games} games, rollouts=${options.rollouts}) ===\n`)
    const stats: VariantStats = {
      variant, games: options.games,
      village: 0, wolf: 0, hamster: 0, draw: 0,
      villageWinRate: 0, elapsedMs: 0,
      mctsCalls: 0, fallbackCalls: 0,
    }
    const t0 = performance.now()
    for (let g = 0; g < options.games; g++) {
      const seed = options.baseSeed + g
      const r = await runSingleGame(
        variant, seed,
        variant === 'mason_zero' ? zeroAgentFactory : null,
      )
      if (r.result === 'villager_won') stats.village++
      else if (r.result === 'werewolf_won') stats.wolf++
      else if (r.result === 'werehamster_won') stats.hamster++
      else stats.draw++
      stats.mctsCalls += r.mctsCalls
      stats.fallbackCalls += r.fallbackCalls
      if ((g + 1) % 10 === 0) {
        process.stderr.write(`[h2h] ${variant} ${g + 1}/${options.games}: v=${stats.village} w=${stats.wolf} h=${stats.hamster}\n`)
      }
    }
    stats.elapsedMs = performance.now() - t0
    stats.villageWinRate = stats.village / stats.games
    process.stderr.write(
      `[h2h] ${variant}: v=${stats.village} w=${stats.wolf} h=${stats.hamster} draw=${stats.draw} | `
      + `villageWin=${(stats.villageWinRate * 100).toFixed(1)}% (${(stats.elapsedMs / 1000).toFixed(1)}s)\n`,
    )
    if (variant === 'mason_zero') {
      process.stderr.write(`[h2h]   MCTS calls: ${stats.mctsCalls}, fallback: ${stats.fallbackCalls}\n`)
    }
    results.push(stats)
  }

  const delta = (results[1].villageWinRate - results[0].villageWinRate) * 100
  process.stderr.write(`\n[h2h] === Summary ===\n`)
  process.stderr.write(`[h2h] baseline  villageWin = ${(results[0].villageWinRate * 100).toFixed(1)}%\n`)
  process.stderr.write(`[h2h] mason_zero villageWin = ${(results[1].villageWinRate * 100).toFixed(1)}%\n`)
  process.stderr.write(`[h2h] delta = ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp\n`)

  return results
}

function parseArgs(): Partial<HeadToHeadOptions> {
  const opts: Partial<HeadToHeadOptions> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--ckpt': opts.ckptPath = args[++i]; break
      case '--games': opts.games = parseInt(args[++i], 10); break
      case '--seed': opts.baseSeed = parseInt(args[++i], 10); break
      case '--rollouts': opts.rollouts = parseInt(args[++i], 10); break
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('head-to-head.ts')) {
  runHeadToHead(parseArgs()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
