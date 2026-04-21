/**
 * Phase 2 hook の動作確認 demo。
 *
 * fullAdapter で 1 ゲーム回し、villager 席に VillageZeroAgent + phase2Net を
 * 注入。decideDayClaim の console.log で NN の claim head 出力が実際の判断に
 * 流れていることを観察する。
 *
 * 用例:
 *   node --experimental-strip-types src/skoll/phase2/play-demo.ts \
 *     --checkpoint tmp/phase2-smoke/villager-claim.json --seed 42
 */

import type { SystemRole } from '../../types/index.ts'
import type { Agent } from '../../fenrir/src/agents/agent.ts'
import type { FenrirExtEvent } from '../../fenrir/src/events.ts'
import type { GameHandlers } from '../../lupa/handlers.ts'
import { runGame } from '../../lupa/engine.ts'
import { fullAdapter } from '../../fenrir/src/adapters/full-adapter.ts'
import { SkollMasterAgent } from '../skoll-master-agent.ts'
import { loadNetworkFromCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'
import { VillageZeroAgent } from '../../skoll-zero/selfplay/role-zero-agents.ts'
import { TrainingBuffer } from '../../skoll-zero/selfplay/buffer.ts'
import { DummyNN } from '../../skoll-zero/mcts/nn.ts'

const DEFAULT_ROLES = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])

export type PlayDemoOptions = {
  checkpoint: string
  seed: number
}

export async function runPlayDemo(opts: PlayDemoOptions): Promise<void> {
  process.stderr.write(`[play-demo] loading phase2 checkpoint: ${opts.checkpoint}\n`)
  const phase2Net = loadNetworkFromCheckpoint(opts.checkpoint, 'individual')
  // 単一 checkpoint なので villager-claim 固定で map に入れる
  const phase2Nets = new Map<string, typeof phase2Net>([['villager-claim', phase2Net]])

  const roles = DEFAULT_ROLES
  const buffer = new TrainingBuffer()
  const villageAgent = new VillageZeroAgent({
    nn: new DummyNN(),
    setup: roles,
    buffer,
    phase2Nets,
    selectionMode: 'argmax',
  })

  const agents = new Map<number, Agent>()
  const handlers = fullAdapter({
    agents,
    defaultAgent: new SkollMasterAgent(),
    enableRetar: true,
    roles,
    seed: opts.seed,
    onRolesAssigned: (seatRoles) => {
      for (const [seat, role] of seatRoles) {
        if (role === 'villager') agents.set(seat, villageAgent)
      }
      const villagerSeats = [...seatRoles.entries()].filter(([, r]) => r === 'villager').map(([s]) => s)
      process.stderr.write(`[play-demo] villager seats: [${villagerSeats.join(', ')}]\n`)
    },
  })

  process.stderr.write(`[play-demo] starting game (seed=${opts.seed})\n`)
  const gameResult = await runGame(
    { roles, seed: opts.seed, hasFirstGhost: true },
    handlers as unknown as GameHandlers<FenrirExtEvent>,
  )
  process.stderr.write(`[play-demo] result: ${gameResult.state.result}\n`)
}

function parseArgs(): PlayDemoOptions {
  const opts: Partial<PlayDemoOptions> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--checkpoint': opts.checkpoint = args[++i]; break
      case '--seed': opts.seed = parseInt(args[++i], 10); break
    }
  }
  return { checkpoint: opts.checkpoint ?? 'tmp/phase2-smoke/villager-claim.json', seed: opts.seed ?? 42 }
}

if (process.argv[1]?.endsWith('play-demo.ts')) {
  runPlayDemo(parseArgs()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
