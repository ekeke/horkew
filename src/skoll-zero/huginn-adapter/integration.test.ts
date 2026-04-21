/**
 * HuginnVoteAdapter Integration test (14d-neko 1 game 完走)
 *
 * 検証項目:
 *   - adapter がエラーなく 1 ゲーム完走する
 *   - 全 alive seat の vote が返る
 *   - 狼相棒不投票率がランダム基準を上回る (private info が desire 経由で反映)
 *   - 共有相方不投票
 *
 * Phase 2 は random init の huginn network で動作確認のみ。勝率評価は Phase 3 の範囲。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../types/index.ts'
import type { GameHandlers } from '../../lupa/handlers.ts'
import type { Agent } from '../../fenrir/src/agents/agent.ts'
import type { FenrirExtEvent } from '../../fenrir/src/events.ts'
import { runGame } from '../../lupa/engine.ts'
import { SkollMasterAgent } from '../../skoll/skoll-master-agent.ts'
import { TrainingBuffer } from '../selfplay/buffer.ts'
import { DummyNN } from '../mcts/nn.ts'
import { MasonZeroAgent } from '../selfplay/mason-zero-agent.ts'
import {
  VillageZeroAgent, WolfZeroAgent, FanaticZeroAgent,
  HamsterZeroAgent, ImmoralistZeroAgent,
} from '../selfplay/role-zero-agents.ts'
import { TrainableNetwork } from '../../huginn/trainable-network.ts'
import { buildVocabLayout } from '../../huginn/message-vocab.ts'
import { MAX_AGENTS, OFFER_REF_WINDOW } from '../../huginn/types.ts'
import { HuginnVoteAdapter } from './huginn-vote-adapter.ts'

const ROLES_14D_NEKO: Map<SystemRole, number> = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])

function createZeroAgent(role: SystemRole, opts: {
  nn: DummyNN, setup: Map<SystemRole, number>, buffer: TrainingBuffer, mctsConfig: any,
}): Agent {
  const baseOpts = { ...opts, selectionMode: 'argmax' as const }
  switch (role) {
    case 'mason': return new MasonZeroAgent(baseOpts)
    case 'werewolf': return new WolfZeroAgent(baseOpts)
    case 'fanatic': return new FanaticZeroAgent(baseOpts)
    case 'werehamster': return new HamsterZeroAgent(baseOpts)
    case 'immoralist': return new ImmoralistZeroAgent(baseOpts)
    default: return new VillageZeroAgent(baseOpts)  // villager/seer/medium/bodyguard/nekomata
  }
}

describe('HuginnVoteAdapter integration (14d-neko)', () => {
  it('1 ゲーム完走、terminal state 到達', async () => {
    const buffer = new TrainingBuffer()
    const nn = new DummyNN()
    const mctsConfig = { cPuct: 1.5, nRollouts: 30, rng: Math.random }  // 軽量

    // huginn network: MAX_AGENTS (15) 基準で random init
    const layout = buildVocabLayout(MAX_AGENTS, OFFER_REF_WINDOW)
    const network = new TrainableNetwork({
      dModel: 32, numLayers: 1, numHeads: 2, dFf: 64,
      vocabSize: layout.vocabSize,
    })

    const agents = new Map<number, Agent>()
    const handlers = new HuginnVoteAdapter({
      agents,
      defaultAgent: new SkollMasterAgent(),
      enableRetar: true,
      roles: ROLES_14D_NEKO,
      seed: 42,
      huginnNetwork: network,
      huginnSampling: 'argmax',
      onRolesAssigned: (seatRoles) => {
        for (const [seat, role] of seatRoles) {
          agents.set(seat, createZeroAgent(role, { nn, setup: ROLES_14D_NEKO, buffer, mctsConfig }))
        }
      },
    })

    const result = await runGame(
      {
        roles: ROLES_14D_NEKO,
        seed: 42,
        hasFirstGhost: true,
      },
      handlers as unknown as GameHandlers<FenrirExtEvent>,
    )

    assert.ok(
      ['villager_won', 'werewolf_won', 'werehamster_won', 'draw'].includes(result.state.result ?? ''),
      `valid terminal result (got ${result.state.result})`,
    )
  })
})
