import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PLAN_VOCAB, parsePlanSlots } from './plan-vocab.ts'
import { planToVote, nooseCount, type PlanState } from './plan-helpers.ts'
import { Rng } from '../../../lupa/random.ts'
import type { DecisionContext } from '../agents/agent.ts'

const { OR, STOP, GRAYRAN, ROLE_START } = PLAN_VOCAB

/** planToVote が使うフィールドだけの最小 DecisionContext */
function makeCtx(overrides: {
  mySeat?: number
  alivePlayers?: number[]
  publicEvents?: any[]
  seed?: number
}): DecisionContext {
  return {
    mySeat: overrides.mySeat ?? 1,
    alivePlayers: overrides.alivePlayers ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    publicEvents: overrides.publicEvents ?? [],
    rng: new Rng(overrides.seed ?? 42),
  } as unknown as DecisionContext
}

/** planActions から PlanState を構築するヘルパー */
function makePlanState(planActions: number[], aliveCount: number): PlanState {
  return {
    slots: parsePlanSlots(planActions),
    initialNooseCount: nooseCount(aliveCount),
    mlMasonSeat: null,
    masonTakeoverDone: false,
  }
}

describe('planToVote', () => {
  // ════════════════════════════════════════════
  // 基本: planState なし（on-the-fly パース）
  // ════════════════════════════════════════════

  it('resolves single seat token (no planState)', () => {
    // [seat3, STOP, ...] → seat 3
    const planActions = [2, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({})
    assert.equal(planToVote(planActions, ctx), 3)
  })

  it('returns null for all-STOP plan (no planState)', () => {
    const planActions = [STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({})
    assert.equal(planToVote(planActions, ctx), null)
  })

  it('uses first slot only when no planState (ignores tokens after OR)', () => {
    // [seat3, OR, seat7, STOP, ...] → seat 3 (先頭スロット)
    const planActions = [2, OR, 6, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({})
    assert.equal(planToVote(planActions, ctx), 3)
  })

  it('skips dead seat and returns null if no fallback', () => {
    // seat5 だが seat5 は死亡
    const planActions = [4, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4, 6, 7] })
    assert.equal(planToVote(planActions, ctx), null)
  })

  it('excludes own seat', () => {
    // seat1 を指定しているが mySeat=1 → 除外 → null
    const planActions = [0, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({ mySeat: 1 })
    assert.equal(planToVote(planActions, ctx), null)
  })

  // ════════════════════════════════════════════
  // Role token
  // ════════════════════════════════════════════

  it('resolves role token to CO player', () => {
    // role=seer (ROLE_START+0) → seat 5 が占いCO
    const planActions = [ROLE_START, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({
      publicEvents: [{ type: 'seer_claim', actor: 5, results: [] }],
    })
    assert.equal(planToVote(planActions, ctx), 5)
  })

  it('returns null when role has no CO player', () => {
    // role=medium (ROLE_START+1) だが誰も霊能COしていない
    const planActions = [ROLE_START + 1, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({})
    assert.equal(planToVote(planActions, ctx), null)
  })

  it('excludes dead CO player from role resolution', () => {
    // seer CO した seat5 が死亡
    const planActions = [ROLE_START, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({
      alivePlayers: [1, 2, 3, 4, 6, 7],
      publicEvents: [{ type: 'seer_claim', actor: 5, results: [] }],
    })
    assert.equal(planToVote(planActions, ctx), null)
  })

  // ════════════════════════════════════════════
  // Grayran token
  // ════════════════════════════════════════════

  it('resolves grayran to non-CO player', () => {
    // grayran → CO していない生存者
    const planActions = [GRAYRAN, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({
      alivePlayers: [1, 2, 3, 4, 5],
      mySeat: 1,
      publicEvents: [
        { type: 'seer_claim', actor: 2, results: [] },
        { type: 'medium_claim', actor: 3 },
      ],
    })
    // CO: 2, 3。自分: 1。残り: 4, 5 のどちらか
    const result = planToVote(planActions, ctx)
    assert.ok(result === 4 || result === 5, `expected 4 or 5, got ${result}`)
  })

  it('grayran excludes own seat', () => {
    // 全員 CO なし、mySeat=1
    const planActions = [GRAYRAN, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({ alivePlayers: [1, 2], mySeat: 1 })
    assert.equal(planToVote(planActions, ctx), 2)
  })

  it('grayran falls back to CO players when no grays left', () => {
    // 全員 CO 済み → フォールバックで CO 者から選択
    const planActions = [GRAYRAN, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({
      alivePlayers: [1, 2, 3],
      mySeat: 1,
      publicEvents: [
        { type: 'seer_claim', actor: 2, results: [] },
        { type: 'medium_claim', actor: 3 },
      ],
    })
    const result = planToVote(planActions, ctx)
    assert.ok(result === 2 || result === 3, `expected 2 or 3, got ${result}`)
  })

  // ════════════════════════════════════════════
  // PlanState（縄数ベーススロット消費）
  // ════════════════════════════════════════════

  it('uses slot[0] when no noose consumed', () => {
    // 10人生存: noose=5, initialNooseCount=5 → consumed=0 → slot[0]
    const planActions = [2, OR, 6, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const planState = makePlanState(planActions, 10)  // initial noose = 5
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })  // 10人 → noose=5
    assert.equal(planToVote(planActions, ctx, planState), 3)
  })

  it('advances to slot[1] after one noose consumed', () => {
    // plan: seat3, seat7, STOP → 2 slots (隣接 target = 別スロット)
    // initial 10人(noose=5), now 8人(noose=4) → consumed=1 → slot[1]
    const planActions = [2, 6, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const planState = makePlanState(planActions, 10)  // initial noose = 5
    const ctx = makeCtx({ alivePlayers: [1, 2, 4, 5, 6, 7, 8, 9] })  // 8人 → noose=4
    assert.equal(planToVote(planActions, ctx, planState), 7)
  })

  it('returns null when all slots consumed', () => {
    // plan: seat3, STOP → 1 slot
    // initial 10人(noose=5), now 6人(noose=3) → consumed=2 → slot[2] doesn't exist
    const planActions = [2, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const planState = makePlanState(planActions, 10)  // initial noose = 5
    const ctx = makeCtx({ alivePlayers: [1, 2, 4, 5, 6, 7] })  // 6人 → noose=3, consumed=2
    assert.equal(planToVote(planActions, ctx, planState), null)
  })

  it('returns null with planState but all-STOP plan', () => {
    const planActions = [STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const planState = makePlanState(planActions, 10)
    assert.equal(planState.slots.length, 0)
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
    assert.equal(planToVote(planActions, ctx, planState), null)
  })

  it('null planState falls back to on-the-fly parse', () => {
    const planActions = [2, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({ alivePlayers: [1, 3, 5, 7] })
    assert.equal(planToVote(planActions, ctx, null), 3)
  })

  // ════════════════════════════════════════════
  // Multi-target slot (roller)
  // ════════════════════════════════════════════

  it('resolves multi-target slot: first alive wins', () => {
    // slot: [seat3, seat5] → seat3 が生存ならそれ
    const planActions = [2, 4, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({ alivePlayers: [1, 3, 5, 7] })
    assert.equal(planToVote(planActions, ctx), 3)
  })

  it('resolves multi-target slot: skips dead, uses second', () => {
    // slot: [seat3 OR seat5] → seat3 死亡 → seat5
    const planActions = [2, OR, 4, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({ alivePlayers: [1, 5, 7] })
    assert.equal(planToVote(planActions, ctx), 5)
  })

  // ════════════════════════════════════════════
  // 縄数の計算確認
  // ════════════════════════════════════════════

  it('nooseCount is correct', () => {
    assert.equal(nooseCount(14), 7)
    assert.equal(nooseCount(10), 5)
    assert.equal(nooseCount(7), 3)
    assert.equal(nooseCount(4), 2)
    assert.equal(nooseCount(3), 1)
  })

  // ════════════════════════════════════════════
  // 複数スロットの段階的消費
  // ════════════════════════════════════════════

  it('multi-slot plan consumes correctly over days', () => {
    // plan: seat3, seat7, seat12, STOP → 3 slots (隣接 target = 別スロット)
    const planActions = [2, 6, 11, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const planState = makePlanState(planActions, 10)  // initial noose = 5
    assert.equal(planState.slots.length, 3)

    // Day 1: 10人 → noose=5, consumed=0 → slot[0]=seat3
    const ctx1 = makeCtx({ alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
    assert.equal(planToVote(planActions, ctx1, planState), 3)

    // Day 2: 8人 → noose=4, consumed=1 → slot[1]=seat7
    const ctx2 = makeCtx({ alivePlayers: [1, 2, 4, 5, 6, 7, 8, 9] })
    assert.equal(planToVote(planActions, ctx2, planState), 7)

    // Day 3: 6人 → noose=3, consumed=2 → slot[2]=seat12
    const ctx3 = makeCtx({ alivePlayers: [1, 2, 5, 6, 9, 12] })
    assert.equal(planToVote(planActions, ctx3, planState), 12)
  })

  it('skips dead target in later slots', () => {
    // plan: seat3, OR, seat7, STOP → 2 slots
    const planActions = [2, OR, 6, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const planState = makePlanState(planActions, 10)

    // Day 2: 8人 → noose=4, consumed=1 → slot[1]=seat7, but seat7 is dead
    const ctx = makeCtx({ alivePlayers: [1, 2, 4, 5, 6, 8, 9, 10] })
    assert.equal(planToVote(planActions, ctx, planState), null)
  })
})
