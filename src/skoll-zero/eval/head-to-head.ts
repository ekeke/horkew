/**
 * M6: MasonRoleAgent vs baseline の head-to-head 評価。
 *
 * 2 席の mason を被験者として置き、他 12 席を SkollMasterAgent (heuristic) 固定で
 * 同じ seed 列を 2 variant で回し、村陣営勝率を比較する。
 *
 * Variant:
 *   - baseline:  mason 席も SkollMasterAgent
 *   - mason_zero: mason 席に MasonRoleAgent (ISMCTS + warm-start NN)
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
import type { Agent, DecisionContext } from '../../fenrir/src/agents/agent.ts'
import { runGame } from '../../lupa/engine.ts'
import { fullAdapter } from '../../fenrir/src/adapters/full-adapter.ts'
import { SkollMasterAgent } from '../../skoll/skoll-master-agent.ts'
import { resolveRules } from '../../howl/ruleset.ts'
import { loadNetworkFromCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'
import { MasonZeroNetwork } from '../network/mason-zero.ts'
import { MasonRoleAgent } from '../selfplay/mason-zero-agent.ts'
import { TrainingBuffer } from '../selfplay/buffer.ts'
import { captureObs } from '../selfplay/observation.ts'
import { DEFAULT_MCTS_CONFIG, type MCTSConfig } from '../mcts/ISMCTS.ts'
import { SEATS } from '../../fenrir/src/observation.ts'

const DEFAULT_ROLES: Map<SystemRole, number> = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])

const DEFAULT_REVOTE = { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const }

export type VariantConfig = {
  name: string
  /**
   * モード: 省略 = baseline (SkollMasterAgent heuristic)
   *        'policy_only' = MCTS skip、NN policy head の argmax のみ
   *        'zero' = 通常の MasonRoleAgent (ISMCTS)
   */
  mode?: 'policy_only' | 'zero'
  /** mode='zero' 時のみ使う */
  zero?: {
    rollouts: number
    zeroValueHead: boolean
    selectionMode?: 'sample' | 'argmax'
  }
  /** mode='policy_only' 時のみ使う (default: value head SL 温存) */
  policyOnly?: {
    zeroValueHead: boolean
  }
}

export type VariantStats = {
  name: string
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
  variants: VariantConfig[]
}

const DEFAULT_VARIANTS: VariantConfig[] = [
  { name: 'baseline' },
  { name: 'policy_only',   mode: 'policy_only', policyOnly: { zeroValueHead: false } },
  { name: 'zero/r50/slV',  mode: 'zero', zero: { rollouts: 50, zeroValueHead: false, selectionMode: 'argmax' } },
  { name: 'zero/r200/slV', mode: 'zero', zero: { rollouts: 200, zeroValueHead: false, selectionMode: 'argmax' } },
]

const DEFAULTS: HeadToHeadOptions = {
  ckptPath: 'src/skoll/models/mason.json',
  games: 100,
  baseSeed: 700000,
  variants: DEFAULT_VARIANTS,
}

/**
 * MCTS 無しで NN policy 単体 (argmax) で vote を決める mason agent。
 * 「ISMCTS が本当に policy prior に何か足しているのか」を測る ablation 用。
 * vote 以外は SkollMasterAgent (heuristic) に委譲。
 */
class PolicyOnlyMasonAgent extends SkollMasterAgent {
  voteCalls = 0
  private readonly nn: MasonZeroNetwork
  constructor(nn: MasonZeroNetwork) {
    super()
    this.nn = nn
  }

  override decideVote(ctx: DecisionContext): number {
    this.voteCalls++
    const obs = captureObs(ctx)
    const result = this.nn.net.forward(obs)
    const logits = result.policies.get('execute')
    if (!logits) return super.decideVote(ctx)

    const excluded = new Set<number>([ctx.mySeat])
    if (ctx.masonPartner !== null) excluded.add(ctx.masonPartner)

    let best = -1
    let bestLogit = -Infinity
    for (const seat of ctx.alivePlayers) {
      if (excluded.has(seat)) continue
      if (seat < 1 || seat > SEATS) continue
      if (logits[seat - 1] > bestLogit) {
        bestLogit = logits[seat - 1]
        best = seat
      }
    }
    return best > 0 ? best : super.decideVote(ctx)
  }
}

type VoteAgent = MasonRoleAgent | PolicyOnlyMasonAgent

async function runSingleGame(
  seed: number,
  agentFactory: (() => VoteAgent) | null,
): Promise<{ result: string, mctsCalls: number, fallbackCalls: number, voteCalls: number }> {
  const roles = DEFAULT_ROLES
  const agents = new Map<number, Agent>()
  const masonAgent = agentFactory?.() ?? null

  const handlers = fullAdapter({
    agents,
    defaultAgent: new SkollMasterAgent(),
    onRolesAssigned: (seatRoles) => {
      if (masonAgent) {
        for (const [seat, role] of seatRoles) {
          if (role === 'mason') agents.set(seat, masonAgent)
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

  const mctsCalls = masonAgent instanceof MasonRoleAgent ? masonAgent.mctsCalls : 0
  const fallbackCalls = masonAgent instanceof MasonRoleAgent ? masonAgent.fallbackCalls : 0
  const voteCalls = masonAgent instanceof PolicyOnlyMasonAgent ? masonAgent.voteCalls : 0
  return {
    result: result.state.result ?? 'draw',
    mctsCalls, fallbackCalls, voteCalls,
  }
}

type AgentPool = {
  /** zeroValueHead の true/false ごとに 1 つ保持 */
  getNet: (zeroValueHead: boolean) => MasonZeroNetwork
}

function buildAgentPool(ckptPath: string): AgentPool {
  const cache = new Map<boolean, MasonZeroNetwork>()
  return {
    getNet(zeroValueHead: boolean) {
      const hit = cache.get(zeroValueHead)
      if (hit) return hit
      // 各 variant 独立にロード (zeroInitValueHead が net を mutate するので共有不可)
      const net = loadNetworkFromCheckpoint(ckptPath)
      const mz = new MasonZeroNetwork(net, { zeroValueHead })
      cache.set(zeroValueHead, mz)
      return mz
    },
  }
}

function makeVariantAgentFactory(
  pool: AgentPool,
  variant: VariantConfig,
): (() => VoteAgent) | null {
  if (variant.mode === 'zero' && variant.zero) {
    const cfg = variant.zero
    const mctsConfig: MCTSConfig = { ...DEFAULT_MCTS_CONFIG, nRollouts: cfg.rollouts }
    return () => new MasonRoleAgent({
      nn: pool.getNet(cfg.zeroValueHead),
      setup: DEFAULT_ROLES,
      buffer: new TrainingBuffer(),
      mctsConfig,
      selectionMode: cfg.selectionMode ?? 'argmax',
    })
  }
  if (variant.mode === 'policy_only') {
    const zeroValueHead = variant.policyOnly?.zeroValueHead ?? false
    return () => new PolicyOnlyMasonAgent(pool.getNet(zeroValueHead))
  }
  return null  // baseline
}

export async function runHeadToHead(opts: Partial<HeadToHeadOptions> = {}): Promise<VariantStats[]> {
  const options = { ...DEFAULTS, ...opts }
  process.stderr.write(`[h2h] loading mason_zero NN from ${options.ckptPath}\n`)
  const pool = buildAgentPool(options.ckptPath)

  const results: VariantStats[] = []

  for (const variant of options.variants) {
    const label = variant.mode === 'zero' && variant.zero
      ? `${variant.name} (r=${variant.zero.rollouts}, zeroV=${variant.zero.zeroValueHead})`
      : variant.name
    process.stderr.write(`[h2h] === ${label} (${options.games} games) ===\n`)
    const stats: VariantStats = {
      name: variant.name, games: options.games,
      village: 0, wolf: 0, hamster: 0, draw: 0,
      villageWinRate: 0, elapsedMs: 0,
      mctsCalls: 0, fallbackCalls: 0,
    }
    const factory = makeVariantAgentFactory(pool, variant)
    const t0 = performance.now()
    for (let g = 0; g < options.games; g++) {
      const r = await runSingleGame(options.baseSeed + g, factory)
      if (r.result === 'villager_won') stats.village++
      else if (r.result === 'werewolf_won') stats.wolf++
      else if (r.result === 'werehamster_won') stats.hamster++
      else stats.draw++
      stats.mctsCalls += r.mctsCalls
      stats.fallbackCalls += r.fallbackCalls
      if ((g + 1) % 10 === 0) {
        process.stderr.write(`[h2h] ${variant.name} ${g + 1}/${options.games}: v=${stats.village} w=${stats.wolf} h=${stats.hamster}\n`)
      }
    }
    stats.elapsedMs = performance.now() - t0
    stats.villageWinRate = stats.village / stats.games
    process.stderr.write(
      `[h2h] ${variant.name}: v=${stats.village} w=${stats.wolf} h=${stats.hamster} draw=${stats.draw} | `
      + `villageWin=${(stats.villageWinRate * 100).toFixed(1)}% (${(stats.elapsedMs / 1000).toFixed(1)}s)\n`,
    )
    if (variant.mode === 'zero') {
      process.stderr.write(`[h2h]   MCTS calls: ${stats.mctsCalls}, fallback: ${stats.fallbackCalls}\n`)
    }
    results.push(stats)
  }

  process.stderr.write(`\n[h2h] === Summary (N=${options.games}) ===\n`)
  const baseRate = results[0]?.villageWinRate ?? 0
  for (const s of results) {
    const delta = (s.villageWinRate - baseRate) * 100
    const deltaStr = s === results[0] ? '' : ` (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp vs baseline)`
    process.stderr.write(
      `[h2h]   ${s.name.padEnd(22)} villageWin=${(s.villageWinRate * 100).toFixed(1)}%${deltaStr}\n`,
    )
  }
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
