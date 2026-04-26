/**
 * BB protocol で skoll-zero NN を評価する。
 *
 * brain-battle-adapter の `mason_brain` / `wolf_brain` 枠に skoll-zero の
 * MasonRoleAgent / WolfRoleAgent をラップして載せる。通信フェーズ無し、
 * 配役・hasFirstGhost は bb-eval と同一の条件で勝率を出す。
 *
 * Stage 3+ の MCTS rollout は cross-module dispatch (claim_*_true / claim_*_fake /
 * morning phase) を経由するので、mason/wolf 以外の 4 役職 Module も bundle に
 * 乗せる必要がある。eval は `--ckpt-base` で `tmp/orch-skollz-...-v1/phases/00-skoll-zero`
 * を指定し、6 slot final.json を一括ロードする。
 *
 * 用例:
 *   node --experimental-strip-types src/skoll-zero/eval/bb-style.ts \
 *     --ckpt-base tmp/orch-skollz-stage5b-v1/phases/00-skoll-zero \
 *     --games 100 --rollouts 50 --selection-mode argmax
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { SystemRole } from '../../types/index.ts'
import type { GameHandlers } from '../../lupa/handlers.ts'
import type { FenrirExtEvent } from '../../fenrir/src/events.ts'
import type { FenrirExt } from '../../fenrir/src/ext.ts'
import type { TeamDecisionContext, WolfNightAction } from '../../fenrir/src/agents/agent.ts'
import { runGame } from '../../lupa/engine.ts'
import { BrainBattleAdapter } from '../../fenrir/src/adapters/brain-battle-adapter.ts'
import type { MasonBrainAgent } from '../../fenrir/src/agents/mason-brain.ts'
import type {
  WolfBrainAgent, WolfFormation,
} from '../../fenrir/src/agents/wolf-brain.ts'
import { SkollMasterAgent } from '../../skoll/skoll-master-agent.ts'
import { loadCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'

import { MasonZeroNetwork } from '../network/mason-zero.ts'
import {
  createSkollZeroNetwork, createStandardZeroNetwork,
  createWolfZeroNetwork, createFanaticZeroNetwork,
} from '../network/config.ts'
import { MasonRoleAgent } from '../selfplay/mason-zero-agent.ts'
import { WolfRoleAgent } from '../selfplay/role-zero-agents.ts'
import { TrainingBuffer } from '../selfplay/buffer.ts'
import { DEFAULT_MCTS_CONFIG, type MCTSConfig } from '../mcts/ISMCTS.ts'
import {
  VillageIndividualModule, FanaticIndividualModule, ThirdIndividualModule,
} from '../module/individual-modules.ts'
import type { ModuleBundle } from '../mcts/dispatch.ts'

const DEFAULT_ROLES: Map<SystemRole, number> = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])

/**
 * MasonRoleAgent を BB adapter の `mason_brain` interface に適合させる薄い wrapper。
 */
class SkollZeroMasonBrainStub {
  totalCalls = 0
  fallbackCalls = 0
  private agent: MasonRoleAgent

  constructor(agent: MasonRoleAgent) {
    this.agent = agent
  }

  clearDayCache(): void { /* no-op */ }

  decideExecution(ctx: TeamDecisionContext): number {
    this.totalCalls++
    return this.agent.decideVote(ctx)
  }
}

/**
 * WolfRoleAgent を BB adapter の `wolf_brain` interface に適合させる wrapper。
 *
 * - `getFormation`: skoll-zero wolf NN は formation 概念を持たないので、bb-eval の
 *   SkollWolfBrainStub と同じく「全狼 villager_co (= 偽 CO 無し)」固定で返す
 * - `decideNightAction.attacker`: WolfRoleAgent の `decideNightAction` は target seat
 *   のみ返す。最小実装として最初の生存狼を attacker に
 */
class SkollZeroWolfBrainStub {
  totalCalls = 0
  fallbackCalls = 0
  private agent: WolfRoleAgent

  constructor(agent: WolfRoleAgent) {
    this.agent = agent
  }

  clearDayCache(): void { /* no-op */ }

  decideExecution(ctx: TeamDecisionContext): number {
    this.totalCalls++
    return this.agent.decideVote(ctx)
  }

  decideNightAction(ctx: TeamDecisionContext): WolfNightAction {
    const action = this.agent.decideNightAction(ctx)
    const aliveWolves = ctx.teamPlayers.filter(p => p.alive)
    const attacker = aliveWolves[0]?.seat ?? ctx.teamSeats[0] ?? 1
    if (action.type === 'attack') {
      return { target: action.target, attacker }
    }
    return { target: ctx.alivePlayers[0] ?? 1, attacker }
  }

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

type EvalOptions = {
  ckptBase: string
  games: number
  seed: number
  rollouts: number
  selectionMode: 'sample' | 'argmax'
}

type EvalStats = {
  village: number
  wolf: number
  hamster: number
  draw: number
}

/** ckptBase 配下 6 slot の final.json をロードして Pure JS net を返す */
function loadAllNets(ckptBase: string) {
  const paths = {
    mason: join(ckptBase, 'mason', 'final.json'),
    village: join(ckptBase, 'village', 'final.json'),
    wolf: join(ckptBase, 'wolf', 'final.json'),
    fanatic: join(ckptBase, 'fanatic', 'final.json'),
    hamster: join(ckptBase, 'hamster', 'final.json'),
    immoralist: join(ckptBase, 'immoralist', 'final.json'),
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

async function runEval(opts: EvalOptions): Promise<EvalStats> {
  const nets = loadAllNets(opts.ckptBase)

  const masonZeroNet = new MasonZeroNetwork(nets.masonNet, { zeroValueHead: false })
  const villageZeroNet = new MasonZeroNetwork(nets.villageNet, { zeroValueHead: false })
  const wolfZeroNet = new MasonZeroNetwork(nets.wolfNet, { zeroValueHead: false })
  const fanaticZeroNet = new MasonZeroNetwork(nets.fanaticNet, { zeroValueHead: false })
  const hamsterZeroNet = new MasonZeroNetwork(nets.hamsterNet, { zeroValueHead: false })
  const immoralistZeroNet = new MasonZeroNetwork(nets.immoralistNet, { zeroValueHead: false })

  const mctsConfig: MCTSConfig = { ...DEFAULT_MCTS_CONFIG, nRollouts: opts.rollouts }

  const stats: EvalStats = { village: 0, wolf: 0, hamster: 0, draw: 0 }

  for (let g = 0; g < opts.games; g++) {
    const seed = opts.seed + g

    // BB adapter から呼ばれる mason / wolf agent
    const masonAgent = new MasonRoleAgent({
      nn: masonZeroNet, setup: DEFAULT_ROLES, buffer: new TrainingBuffer(),
      mctsConfig, selectionMode: opts.selectionMode,
    })
    const wolfAgent = new WolfRoleAgent({
      nn: wolfZeroNet, setup: DEFAULT_ROLES, buffer: new TrainingBuffer(),
      mctsConfig, selectionMode: opts.selectionMode,
    })

    // cross-module dispatch 用の bundle 完備 (claim/morning phase で使われる)。
    // 4 module は BB adapter からは直接呼ばれず、MCTS rollout 内 expand 専用。
    const bundle: ModuleBundle = {
      mason: masonAgent.getModule(),
      wolf: wolfAgent.getModule(),
      standard: new VillageIndividualModule({
        nn: villageZeroNet, setup: DEFAULT_ROLES, buffer: new TrainingBuffer(), mctsConfig,
      }),
      fanatic: new FanaticIndividualModule({
        nn: fanaticZeroNet, setup: DEFAULT_ROLES, buffer: new TrainingBuffer(), mctsConfig,
      }),
      hamster: new ThirdIndividualModule({
        nn: hamsterZeroNet, setup: DEFAULT_ROLES, buffer: new TrainingBuffer(), mctsConfig,
      }),
      immoralist: new ThirdIndividualModule({
        nn: immoralistZeroNet, setup: DEFAULT_ROLES, buffer: new TrainingBuffer(), mctsConfig,
      }),
    }
    masonAgent.setBundle(bundle)
    wolfAgent.setBundle(bundle)

    const masonStub = new SkollZeroMasonBrainStub(masonAgent)
    const wolfStub = new SkollZeroWolfBrainStub(wolfAgent)

    const handlers = new BrainBattleAdapter({
      wolfBrain: wolfStub as unknown as WolfBrainAgent,
      masonBrain: masonStub as unknown as MasonBrainAgent,
      agents: new Map(),
      defaultAgent: new SkollMasterAgent(),
      seed,
      enableRetar: true,
      roles: DEFAULT_ROLES,
      onRolesAssigned: () => {},
    })

    const result = await runGame(
      { roles: DEFAULT_ROLES, seed, hasFirstGhost: true },
      handlers as unknown as GameHandlers<FenrirExtEvent, FenrirExt>,
    )

    const r = result.state.result
    if (r === 'villager_won') stats.village++
    else if (r === 'werewolf_won') stats.wolf++
    else if (r === 'werehamster_won') stats.hamster++
    else stats.draw++

    if ((g + 1) % 10 === 0 || g + 1 === opts.games) {
      const total = stats.village + stats.wolf + stats.hamster + stats.draw
      process.stderr.write(
        `[bb-style] ${g + 1}/${opts.games}: v ${stats.village} w ${stats.wolf} h ${stats.hamster} d ${stats.draw} (vill ${(stats.village / total * 100).toFixed(1)}%)\n`,
      )
    }
  }

  return stats
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const opts: EvalOptions = {
    ckptBase: '',
    games: 100,
    seed: 1,
    rollouts: 50,
    selectionMode: 'argmax',
  }
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--ckpt-base': opts.ckptBase = args[++i]; break
      case '--games': opts.games = parseInt(args[++i], 10); break
      case '--seed': opts.seed = parseInt(args[++i], 10); break
      case '--rollouts': opts.rollouts = parseInt(args[++i], 10); break
      case '--selection-mode': opts.selectionMode = args[++i] as 'sample' | 'argmax'; break
      case '-h': case '--help':
        process.stderr.write([
          'Usage: bb-style.ts [options]',
          '  --ckpt-base PATH    skoll-zero phase dir (e.g. tmp/orch-skollz-stage5b-v1/phases/00-skoll-zero) (required)',
          '  --games N           number of games (default: 100)',
          '  --seed N            base seed (default: 1)',
          '  --rollouts N        MCTS rollouts (default: 50)',
          '  --selection-mode M  sample | argmax (default: argmax)',
        ].join('\n') + '\n')
        process.exit(0)
    }
  }

  if (!opts.ckptBase) {
    process.stderr.write('error: --ckpt-base required\n')
    process.exit(1)
  }

  const t0 = Date.now()
  const stats = await runEval(opts)
  const elapsed = (Date.now() - t0) / 1000

  const total = stats.village + stats.wolf + stats.hamster + stats.draw
  const fmt = (n: number): string => `${n} (${(n / total * 100).toFixed(1)}%)`
  process.stdout.write([
    '=== bb-style eval (skoll-zero on BrainBattleAdapter) ===',
    `ckpt-base: ${opts.ckptBase}`,
    `games: ${total}, rollouts: ${opts.rollouts}, mode: ${opts.selectionMode}, elapsed: ${elapsed.toFixed(1)}s`,
    `village: ${fmt(stats.village)}`,
    `wolf:    ${fmt(stats.wolf)}`,
    `hamster: ${fmt(stats.hamster)}`,
    `draw:    ${fmt(stats.draw)}`,
  ].join('\n') + '\n')
}

main().catch(e => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
  process.exit(1)
})
