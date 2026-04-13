/**
 * BrainBattleAdapter ディスパッチ実測テスト
 *
 * Per-role NN (seer) を 1 席だけ仕込んで 1 ゲーム回し、FENRIR_TRACE 経由で
 * decideDayClaim / decideNightAction が「Day ごとに何回呼ばれているか」を
 * 観測する。BB+ 訓練で per-role NN trajectory が 1〜2 entries しか溜まらない
 * 現象の再現と原因切り分けが目的。
 *
 * 実行:
 *   FENRIR_TRACE=1 FENRIR_TRACE_SEAT=<seerSeat> \
 *     node --experimental-strip-types --test src/fenrir/src/adapters/brain-battle-trace.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../../types/index.ts'
import type { GameConfig, GameHandlers } from '../../../lupa/handlers.ts'
import type { FenrirExtEvent } from '../events.ts'
import type { FenrirExt } from '../ext.ts'
import { runGame } from '../../../lupa/engine.ts'
import { BrainBattleAdapter } from './brain-battle-adapter.ts'
import { NeuralAgent } from '../agents/neural-agent.ts'
import { RuleBasedAgent } from '../agents/rule-based-agent.ts'
import { WolfBrainAgent } from '../agents/wolf-brain.ts'
import { MasonBrainAgent } from '../agents/mason-brain.ts'
import {
  createNetwork, createWolfBrainNetwork, createMasonBrainNetwork,
} from '../training.ts'

const ROLES: Map<SystemRole, number> = new Map([
  ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['werewolf', 3], ['fanatic', 1],
  ['werehamster', 1], ['immoralist', 1],
])

const CONFIG: GameConfig = {
  roles: ROLES,
  seed: 42,
  hasFirstGhost: true,
}

/** 配役を取得 — 1 ゲームを RuleBased だけで回して seat→role を控える */
async function getRoles(seed: number): Promise<Map<number, SystemRole>> {
  let captured = new Map<number, SystemRole>()
  const wolfBrain = new WolfBrainAgent(createWolfBrainNetwork(), { explore: false })
  const masonBrain = new MasonBrainAgent(createMasonBrainNetwork(), { explore: false })
  const adapter = new BrainBattleAdapter({
    wolfBrain, masonBrain,
    agents: new Map(),
    defaultAgent: new RuleBasedAgent(),
    seed,
    enableRetar: false,
    roles: ROLES,
    onRolesAssigned: (rs) => { captured = new Map(rs) },
  })
  await runGame({ ...CONFIG, seed }, adapter as unknown as GameHandlers<FenrirExtEvent, FenrirExt>)
  return captured
}

describe('BrainBattleAdapter trace dispatch', () => {
  it('dispatches per-seat NN every day the seat is alive', async () => {
    // 配役固定: seer がどの seat に居るか取得
    const seed = 42
    const roles = await getRoles(seed)
    const seerSeat = [...roles.entries()].find(([, r]) => r === 'seer')?.[0]
    assert.ok(seerSeat, 'seer seat must exist')
    process.stderr.write(`[TEST] seer seat = ${seerSeat}\n`)

    // BB+ 模擬: seer 席に NeuralAgent を置く
    const wolfBrain = new WolfBrainAgent(createWolfBrainNetwork(), { explore: true })
    const masonBrain = new MasonBrainAgent(createMasonBrainNetwork(), { explore: true })
    const seerAgent = new NeuralAgent(createNetwork(), { explore: true, strategyOnly: false, truthfulRole: 'seer' })

    const agents = new Map<number, any>()
    agents.set(seerSeat, seerAgent)

    const adapter = new BrainBattleAdapter({
      wolfBrain, masonBrain,
      agents,
      defaultAgent: new RuleBasedAgent(),
      seed,
      enableRetar: true,
      roles: ROLES,
    })

    const result = await runGame({ ...CONFIG, seed }, adapter as unknown as GameHandlers<FenrirExtEvent, FenrirExt>)
    assert.ok(result.state.finished)

    // 死亡日を特定
    const seerPlayer = result.state.players.find(p => p.seat === seerSeat)!
    const aliveDays = result.state.executionHistory.size + 1  // ざっくり
    process.stderr.write(`[TEST] seer alive at end: ${seerPlayer.alive}, gameLen ~ ${aliveDays}\n`)

    // 実トラジェクトリ件数を観測（mock ではないので NN は本当に走る）
    process.stderr.write(`[TEST] seer trajectory entries: ${seerAgent.trajectory.length}\n`)
    const claimSteps = seerAgent.trajectory.filter(s => s.actionHead === 'claim')
    const nightSteps = seerAgent.trajectory.filter(s => s.actionHead === 'night')
    process.stderr.write(`[TEST] claim count=${claimSteps.length} indices=${claimSteps.map(s => s.actionIdx).join(',')}\n`)
    process.stderr.write(`[TEST] night count=${nightSteps.length} indices=${nightSteps.map(s => s.actionIdx).join(',')}\n`)

    // CLAIM 9 = NONE; CLAIM 0/1/2/3/4 = COs; CLAIM 5 = SEER_RESULT; CLAIM 7 = FORECAST
    const noneCount = claimSteps.filter(s => s.actionIdx === 9).length
    process.stderr.write(`[TEST] claim=NONE count = ${noneCount} / ${claimSteps.length}\n`)
  })
})
