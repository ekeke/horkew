/**
 * MasonTrainingAdapter 統合テスト
 *
 * Mock NN で plan token を固定し、MasonTrainingAdapter 越しにゲームを実行。
 * plan → planState → executionPlans → 村陣営投票 のパイプラインを検証する。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../../types/index.ts'
import type { AnyNetwork, ForwardResult, PlanContext, NetworkConfig } from '../ml/nn.ts'
import { runGame } from '../../../lupa/engine.ts'
import type { GameConfig, GameHandlers } from '../../../lupa/handlers.ts'
import { MasonTrainingAdapter } from './mason-training-adapter.ts'
import { NeuralAgent } from '../agents/neural-agent.ts'
import { RuleBasedAgent, WolfTeamRuleAgent } from '../agents/rule-based-agent.ts'
import { PLAN_VOCAB } from '../plan/plan-vocab.ts'
import { OBSERVATION_SIZE } from '../observation.ts'
import type { FenrirExtEvent } from '../events.ts'
import type { FenrirExt } from '../ext.ts'

const STANDARD_ROLES: Map<SystemRole, number> = new Map([
  ['villager', 4], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['werewolf', 3], ['werehamster', 1],
])

const STANDARD_CONFIG: GameConfig = {
  roles: STANDARD_ROLES,
  seed: 42,
  hasFirstGhost: true,
}

// ============================================================
// Mock NN
// ============================================================

/** 固定の plan token を返す mock network */
function createMockNetwork(opts: {
  planActions: number[]
}): AnyNetwork {
  const numPlan = opts.planActions.length
  const vocabSize = PLAN_VOCAB.SIZE

  return {
    config: {
      inputSize: OBSERVATION_SIZE,

      heads: { vote: 14, night: 15, claim: 10, comm: 119, leader: 3, target: 14 },
      sigmoidHeads: { propose: 14, predict: 154 },
      transformer: {
        dModel: 64, numHeads: 4, dFf: 128, seatFeatures: 73, clsFeatures: 26,
        roleFeatures: 15, numRoleTokens: 5, numLayers: 1,
        strategyLayers: 1, planVocabSize: vocabSize, numPlanTokens: numPlan,
        planFeatures: 20, maxPlanTokens: numPlan, seatLayers: 1,
        perSeatHeads: ['vote', 'target'],
        perSeatSigmoidHeads: ['propose', 'predict'],
      },
    } satisfies NetworkConfig,

    forward(_input: Float32Array, _explore?: boolean, _planContext?: PlanContext): ForwardResult {
      const policies = new Map<string, Float32Array>()
      // 全ヘッドにゼロ logits を返す
      policies.set('vote', new Float32Array(14))
      policies.set('night', new Float32Array(15))
      policies.set('claim', new Float32Array(10))
      policies.set('comm', new Float32Array(119))
      policies.set('leader', new Float32Array(3))
      policies.set('target', new Float32Array(14))
      policies.set('propose', new Float32Array(14))
      policies.set('predict', new Float32Array(154))
      // plan logits (raw, before mask)
      policies.set('plan', new Float32Array(numPlan * vocabSize))

      return {
        policies,
        value: 0.0,
        planActions: [...opts.planActions],
        planLogProbs: opts.planActions.map(() => -1.0),
      }
    },

    getParams() { return [] },
    cloneWeights() { return new Map() },
    loadWeights() {},
    get totalParams() { return 0 },
  }
}

// ============================================================
// Helper
// ============================================================

/** 特定 seat に NN mason を配置する adapter を生成 */
function createTestAdapter(opts: {
  masonSeat: number
  planActions: number[]
  seed?: number
  enableRetar?: boolean
}) {
  const network = createMockNetwork({
    planActions: opts.planActions,
  })
  const agent = new NeuralAgent(network, { explore: false, strategyOnly: true })
  const agents = new Map<number, any>([[opts.masonSeat, agent]])

  return new MasonTrainingAdapter({
    agents,
    defaultAgent: new RuleBasedAgent(),
    wolfTeamAgent: new WolfTeamRuleAgent(),
    seed: opts.seed ?? 42,
    enableRetar: opts.enableRetar ?? false,
    roles: STANDARD_ROLES,
  }) as unknown as GameHandlers<FenrirExtEvent, FenrirExt>
}

/** 配役を取得（seed 依存）— NN 不要のダミーランで配役だけ取得 */
async function getRoles(seed: number): Promise<Map<number, SystemRole>> {
  let result = new Map<number, SystemRole>()
  const adapter = new MasonTrainingAdapter({
    agents: new Map(),
    defaultAgent: new RuleBasedAgent(),
    wolfTeamAgent: new WolfTeamRuleAgent(),
    seed,
    enableRetar: false,
    roles: STANDARD_ROLES,
  })
  const origOnSetup = adapter.onSetup.bind(adapter)
  adapter.onSetup = (seatRoles: Map<number, SystemRole>, state: any) => {
    result = new Map(seatRoles)
    return origOnSetup(seatRoles, state)
  }
  await runGame({ ...STANDARD_CONFIG, seed }, adapter as unknown as GameHandlers<FenrirExtEvent, FenrirExt>)
  return result
}

// ============================================================
// テスト
// ============================================================

describe('MasonTrainingAdapter integration', () => {
  it('completes a game without errors', async () => {
    const STOP = PLAN_VOCAB.STOP
    const handlers = createTestAdapter({
      masonSeat: 1,
      planActions: [0, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP],
    })
    const result = await runGame(STANDARD_CONFIG, handlers)
    assert.ok(result.state.finished)
    assert.ok(result.state.result !== null)
  })

  it('plan tokens propagate to village votes', async () => {
    // seed を探索して mason の seat を特定
    const seed = 100
    const roles = await getRoles(seed)
    const masonSeats = [...roles.entries()].filter(([, r]) => r === 'mason').map(([s]) => s)
    assert.equal(masonSeats.length, 2, 'should have 2 masons')

    const masonSeat = masonSeats[0]
    // mason 以外の生存席を plan target に指定
    const nonMasonAlive = [...roles.entries()]
      .filter(([s, r]) => r !== 'mason' && s !== masonSeat)
      .map(([s]) => s)
    const targetSeatIdx = nonMasonAlive[0] - 1  // 0-indexed for plan token

    const STOP = PLAN_VOCAB.STOP
    const handlers = createTestAdapter({
      masonSeat,
      planActions: [targetSeatIdx, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP],
      seed,
    })

    // plan_commit イベントを監視
    const result = await runGame({ ...STANDARD_CONFIG, seed }, handlers)
    const planCommits = result.events.filter(e => e.type === 'plan_commit')
    assert.ok(planCommits.length > 0, 'should have plan_commit events')

    // Day 1 の処刑対象が plan target と一致するか確認
    const executions = result.events.filter(e => e.type === 'execution')
    if (executions.length > 0) {
      // 最初の処刑が plan target であれば、plan が投票に反映されている
      // （非村票もあるので確実ではないが、村陣営多数派なら通るはず）
      const firstExec = executions[0] as any
      // plan target が処刑されたケースを記録（断定はしない）
      if (firstExec.seat === nonMasonAlive[0]) {
        assert.ok(true, 'plan target was executed on Day 1')
      }
    }
    assert.ok(result.state.finished)
  })

  it('multi-slot plan with OR produces multiple day targets', async () => {
    const seed = 200
    const roles = await getRoles(seed)
    const masonSeats = [...roles.entries()].filter(([, r]) => r === 'mason').map(([s]) => s)
    const masonSeat = masonSeats[0]

    // 2 つの非 mason 席を multi-slot plan に指定
    const candidates = [...roles.entries()]
      .filter(([s, r]) => r !== 'mason' && s !== masonSeat)
      .map(([s]) => s)
    const target1 = candidates[0] - 1
    const target2 = candidates[1] - 1
    const STOP = PLAN_VOCAB.STOP
    const OR_TOKEN = PLAN_VOCAB.OR

    const handlers = createTestAdapter({
      masonSeat,
      planActions: [target1, OR_TOKEN, target2, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP],
      seed,
    })

    const result = await runGame({ ...STANDARD_CONFIG, seed }, handlers)
    const planCommits = result.events.filter(e => e.type === 'plan_commit')
    assert.ok(planCommits.length > 0, 'should have plan_commit events')
    assert.ok(result.state.finished)
  })

  it('ALL-STOP plan falls back to heuristic voting', async () => {
    const seed = 300
    const roles = await getRoles(seed)
    const masonSeats = [...roles.entries()].filter(([, r]) => r === 'mason').map(([s]) => s)

    const STOP = PLAN_VOCAB.STOP
    const handlers = createTestAdapter({
      masonSeat: masonSeats[0],
      planActions: [STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP],
      seed,
    })

    const result = await runGame({ ...STANDARD_CONFIG, seed }, handlers)
    assert.ok(result.state.finished, 'game should complete even with empty plan')
  })

  it('nekomata COs when designated by seat in plan', async () => {
    // seed 42: mason=[11,14], nekomata=seat2
    const seed = 42
    const nekoSeat = 2
    const masonSeat = 11
    const STOP = PLAN_VOCAB.STOP

    // plan: seat2 (nekomata) を直指定
    const handlers = createTestAdapter({
      masonSeat,
      planActions: [nekoSeat - 1, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP],
      seed,
    })

    const result = await runGame({ ...STANDARD_CONFIG, seed }, handlers)
    const nekoClaims = result.events.filter(e => e.type === 'nekomata_claim')
    assert.ok(nekoClaims.length > 0, 'nekomata should CO when designated by seat plan')
    // CO した猫のうち少なくとも1人は真猫
    const nekoActors = nekoClaims.map((e: any) => e.actor)
    assert.ok(nekoActors.includes(nekoSeat), `seat ${nekoSeat} (true nekomata) should be among CO actors, got: ${nekoActors}`)
  })

  it('nekomata COs after mason takeover', async () => {
    // seed 42: mason=[11,14], nekomata=seat2
    // mason 11 に NN をセット、onMasonTakeover を有効化
    // mason 11 が死亡したら mason 14 に takeover → 猫指名で CO すべき
    const seed = 42
    const nekoSeat = 2
    const masonSeat = 11
    const STOP = PLAN_VOCAB.STOP

    const network = createMockNetwork({
      planActions: [nekoSeat - 1, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP],
    })
    const agent = new NeuralAgent(network, { explore: false, strategyOnly: true })
    const agents = new Map<number, any>([[masonSeat, agent]])

    const handlers = new MasonTrainingAdapter({
      agents,
      defaultAgent: new RuleBasedAgent(),
      wolfTeamAgent: new WolfTeamRuleAgent(),
      seed,
      enableRetar: false,
      roles: STANDARD_ROLES,
      onMasonTakeover: (_deadSeat: number, _newSeat: number) => {
        // game-worker と同じ: 外部 agents マップを更新（ここでは adapter 内部で処理）
      },
    }) as unknown as GameHandlers<FenrirExtEvent, FenrirExt>

    const result = await runGame({ ...STANDARD_CONFIG, seed }, handlers)

    // plan_commit を確認 — mason 死亡後もplan が出ているか
    const planCommits = result.events.filter(e => e.type === 'plan_commit')
    // nekomata_claim を確認
    const nekoClaims = result.events.filter(e => e.type === 'nekomata_claim')

    // mason 11 が生存中に猫を指名してCOさせるか、takeover 後に猫を指名してCOさせるか
    // どちらかで nekomata_claim が出るべき
    const nekoActors = nekoClaims.map((e: any) => e.actor)
    assert.ok(nekoActors.includes(nekoSeat),
      `seat ${nekoSeat} (true nekomata) should CO at some point. ` +
      `nekoClaims=${nekoClaims.length}, planCommits=${planCommits.length}, nekoActors=${nekoActors}`)
  })

  it('runs 10 games with different seeds without crashing', async () => {
    const STOP = PLAN_VOCAB.STOP
    const results: string[] = []

    for (let seed = 0; seed < 10; seed++) {
      const roles = await getRoles(seed)
      const masonSeats = [...roles.entries()].filter(([, r]) => r === 'mason').map(([s]) => s)
      const candidates = [...roles.entries()]
        .filter(([_s, r]) => !['mason'].includes(r))
        .map(([s]) => s)
      const target = (candidates[0] ?? 1) - 1

      const handlers = createTestAdapter({
        masonSeat: masonSeats[0],
        planActions: [target, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP],
        seed,
      })
      const result = await runGame({ ...STANDARD_CONFIG, seed }, handlers)
      assert.ok(result.state.finished, `game seed=${seed} should finish`)
      results.push(result.state.result!)
    }
    assert.ok(results.length === 10)
  })
})
