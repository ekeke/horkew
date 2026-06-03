/**
 * SkollMasterAgent の統合テスト
 *
 * 各役職で適切な perspective skoll が呼び分けられるかを smoke test。
 * full-adapter で 1 ゲーム回し、 SkollMasterAgent が defaultAgent として
 * crash せず動作することを確認する。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { SystemRole } from '../types/index.ts'
import { runGame } from '../lupa/engine.ts'
import { fullAdapter } from '../fenrir/src/adapters/full-adapter.ts'
import { WolfTeamRuleAgent, MasonTeamRuleAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import { resolveRegulation } from '../howl/ruleset.ts'
import { SkollMasterAgent } from './skoll-master-agent.ts'

const SETUP_14D_NEKO: Map<SystemRole, number> = new Map([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])

test('SkollMasterAgent: 1 ゲーム crash なく完走', async () => {
  const handlers = fullAdapter({
    agents: new Map(),
    defaultAgent: new SkollMasterAgent(),
    wolfTeamAgent: new WolfTeamRuleAgent(),
    masonTeamAgent: new MasonTeamRuleAgent(),
    onRolesAssigned: () => {},
    seed: 42,
    enableRetar: true,
    roles: SETUP_14D_NEKO,
    rules: resolveRegulation(),
  })

  const result = await runGame(
    {
      roles: SETUP_14D_NEKO,
      seed: 42,
      hasFirstGhost: true,
      revoteConfig: { maxRevotes: 2, style: 'full_revote', tiebreaker: 'draw' },
    },
    handlers,
  )

  assert.ok(result.state.finished, 'ゲームが終了している')
  assert.ok(['villager_won', 'werewolf_won', 'werehamster_won', 'draw'].includes(result.state.result ?? ''), `result=${result.state.result}`)
})

test('SkollMasterAgent: 複数 seed で安定して完走', async () => {
  for (const seed of [100, 200, 300]) {
    const handlers = fullAdapter({
      agents: new Map(),
      defaultAgent: new SkollMasterAgent(),
      wolfTeamAgent: new WolfTeamRuleAgent(),
      masonTeamAgent: new MasonTeamRuleAgent(),
      onRolesAssigned: () => {},
      seed,
      enableRetar: true,
      roles: SETUP_14D_NEKO,
      rules: resolveRegulation(),
    })

    const result = await runGame(
      {
        roles: SETUP_14D_NEKO,
        seed,
        hasFirstGhost: true,
        revoteConfig: { maxRevotes: 2, style: 'full_revote', tiebreaker: 'draw' },
      },
      handlers,
    )

    assert.ok(result.state.finished, `seed ${seed} で完走しなかった`)
  }
})
