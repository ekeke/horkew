import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PLAN_VOCAB, parseDualPlanSlots } from './plan-vocab.ts'
import { planToVote, nooseCount, ENDGAME_ALIVE_THRESHOLD, type PlanState } from './plan-helpers.ts'
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

/** 12-token plan を簡潔に作るヘルパー（残りは STOP 埋め） */
function plan(...tokens: number[]): number[] {
  const p = new Array(12).fill(STOP)
  for (let i = 0; i < tokens.length; i++) p[i] = tokens[i]
  return p
}

/** planActions + parseDualPlanSlots から PlanState を構築 */
function makePlanState(planActions: number[], aliveCount: number): PlanState {
  const { forwardSlots, endgameSlots } = parseDualPlanSlots(planActions)
  return {
    slots: forwardSlots,
    endgameSlots,
    initialNooseCount: nooseCount(aliveCount),
    mlMasonSeat: null,
    masonTakeoverDone: false,
  }
}

describe('planToVote', () => {
  // ════════════════════════════════════════════
  // 閾値確認
  // ════════════════════════════════════════════

  it('ENDGAME_ALIVE_THRESHOLD is 6', () => {
    assert.equal(ENDGAME_ALIVE_THRESHOLD, 6)
  })

  // ════════════════════════════════════════════
  // Forward（alive > 6 → forwardSlots[0]）
  // ════════════════════════════════════════════

  it('alive > 6: resolves first forward slot', () => {
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
    assert.equal(planToVote(plan(2), ctx), 3)  // seat3
  })

  it('alive > 6: uses first slot even with multiple slots', () => {
    // forward: seat3, seat7 (2 slots)
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8] })  // 8人
    assert.equal(planToVote(plan(2, 6), ctx), 3)
  })

  it('alive > 6: all-STOP plan returns null', () => {
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
    assert.equal(planToVote(plan(), ctx), null)
  })

  it('alive > 6: dead seat returns null', () => {
    const ctx = makeCtx({ alivePlayers: [1, 2, 4, 6, 7, 8, 9, 10] })  // seat3, seat5 dead
    assert.equal(planToVote(plan(2), ctx), null)  // seat3 is dead
  })

  it('alive > 6: excludes own seat', () => {
    const ctx = makeCtx({ mySeat: 3, alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8] })
    assert.equal(planToVote(plan(2), ctx), null)  // seat3 = mySeat
  })

  // ════════════════════════════════════════════
  // Endgame: alive 5-6 → endgameSlots[1]（末尾-1）
  // ════════════════════════════════════════════

  it('alive 6: uses endgameSlots[1] (position 10)', () => {
    // endgame tokens at positions 8-11: [seat10, seat11, seat12, seat13]
    // reversed → endgameSlots = [seat13(pos11), seat12(pos10), seat11(pos9), seat10(pos8)]
    // alive 6 → endgameSlots[1] = seat12
    const p = plan()
    p[8] = 9    // seat10
    p[9] = 10   // seat11
    p[10] = 11  // seat12
    p[11] = 12  // seat13
    const ctx = makeCtx({ alivePlayers: [1, 2, 10, 11, 12, 13] })
    assert.equal(planToVote(p, ctx), 12)  // endgameSlots[1] = seat12
  })

  it('alive 5: uses endgameSlots[1] (position 10)', () => {
    const p = plan()
    p[10] = 11  // seat12 at position 10
    p[11] = 12  // seat13 at position 11
    const ctx = makeCtx({ alivePlayers: [1, 2, 11, 12, 13] })
    assert.equal(planToVote(p, ctx), 12)  // endgameSlots[1] = seat12
  })

  it('alive 5-6: endgameSlots[1] missing, forward empty → random excluding endgameSlots[0]', () => {
    // only position 11 has a token → endgameSlots = [seat13], no [1]
    // forward: all STOP → no forward slots
    // → random from alive excluding mySeat(1) and protected seat13
    const p = plan()
    p[11] = 12  // seat13 at position 11
    const ctx = makeCtx({ alivePlayers: [1, 2, 11, 12, 13] })
    const result = planToVote(p, ctx)
    assert.ok(result !== null, 'should return a seat')
    assert.ok(result !== 1, 'should exclude mySeat')
    assert.ok(result !== 13, 'should exclude endgameSlots[0] target (seat13)')
    assert.ok([2, 11, 12].includes(result!), `expected 2, 11, or 12, got ${result}`)
  })

  it('alive 5-6: endgameSlots[1] missing, forward available → uses forward', () => {
    const p = plan(4)  // forward: seat5
    p[11] = 12  // endgame: seat13 at position 11
    const ctx = makeCtx({ alivePlayers: [1, 5, 11, 12, 13] })
    // endgameSlots[1] missing → fallback to forward[0] = seat5
    assert.equal(planToVote(p, ctx), 5)
  })

  it('alive 5-6: endgameSlots[1] dead → forward fallback', () => {
    // endgameSlots[1] = seat12 (dead), endgameSlots[0] = seat13
    // forward = seat5
    const p = plan(4)      // forward: seat5
    p[10] = 11             // endgame pos 10: seat12
    p[11] = 12             // endgame pos 11: seat13
    const ctx = makeCtx({ alivePlayers: [1, 5, 11, 13, 14] })  // seat12 dead
    // endgameSlots[1] = seat12 dead → forward[0] = seat5
    assert.equal(planToVote(p, ctx), 5)
  })

  it('alive 5-6: endgameSlots[1] dead, forward dead → random excluding endgameSlots[0]', () => {
    // endgameSlots[1] = seat12 (dead), forward = seat5 (dead), endgameSlots[0] = seat13
    const p = plan(4)      // forward: seat5 (dead)
    p[10] = 11             // endgame pos 10: seat12 (dead)
    p[11] = 12             // endgame pos 11: seat13 (alive, protected)
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 13, 14], seed: 1 })  // alive=5, seat5/seat12 dead
    const result = planToVote(p, ctx)
    assert.ok(result !== null)
    assert.ok(result !== 1, 'should exclude mySeat')
    assert.ok(result !== 13, 'should not use protected endgameSlots[0] target')
    assert.ok([2, 3, 14].includes(result!), `expected 2, 3, or 14, got ${result}`)
  })

  // ════════════════════════════════════════════
  // Endgame: alive ≤ 4 → endgameSlots[0]（末尾）
  // ════════════════════════════════════════════

  it('alive 4: uses endgameSlots[0] (position 11)', () => {
    const p = plan()
    p[10] = 11  // seat12
    p[11] = 12  // seat13
    const ctx = makeCtx({ alivePlayers: [1, 12, 13, 14] })
    assert.equal(planToVote(p, ctx), 13)  // endgameSlots[0] = seat13
  })

  it('alive 3: uses endgameSlots[0] (position 11)', () => {
    const p = plan()
    p[11] = 12  // seat13
    const ctx = makeCtx({ alivePlayers: [1, 12, 13] })
    assert.equal(planToVote(p, ctx), 13)
  })

  // ════════════════════════════════════════════
  // Endgame fallback to forward
  // ════════════════════════════════════════════

  it('alive ≤ 6 with no endgame tokens: falls back to forward', () => {
    // forward: seat3, endgame: all STOP
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4] })
    assert.equal(planToVote(plan(2), ctx), 3)
  })

  it('alive ≤ 6 with dead endgame target: falls back to forward', () => {
    const p = plan(2)  // forward: seat3
    p[11] = 12  // endgame: seat13 (dead)
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4] })  // seat13 is dead
    assert.equal(planToVote(p, ctx), 3)  // fallback to forward
  })

  // ════════════════════════════════════════════
  // Role token
  // ════════════════════════════════════════════

  it('resolves role token to CO player', () => {
    const ctx = makeCtx({
      publicEvents: [{ type: 'seer_claim', actor: 5, results: [] }],
    })
    assert.equal(planToVote(plan(ROLE_START), ctx), 5)
  })

  it('returns null when role has no CO player', () => {
    const ctx = makeCtx({})
    assert.equal(planToVote(plan(ROLE_START + 1), ctx), null)
  })

  it('excludes dead CO player from role resolution', () => {
    const ctx = makeCtx({
      alivePlayers: [1, 2, 3, 4, 6, 7, 8, 9, 10],
      publicEvents: [{ type: 'seer_claim', actor: 5, results: [] }],
    })
    assert.equal(planToVote(plan(ROLE_START), ctx), null)
  })

  // ════════════════════════════════════════════
  // Grayran token
  // ════════════════════════════════════════════

  it('resolves grayran to non-CO player', () => {
    const ctx = makeCtx({
      alivePlayers: [1, 2, 3, 4, 5],
      mySeat: 1,
      publicEvents: [
        { type: 'seer_claim', actor: 2, results: [] },
        { type: 'medium_claim', actor: 3 },
      ],
    })
    const result = planToVote(plan(GRAYRAN), ctx)
    assert.ok(result === 4 || result === 5, `expected 4 or 5, got ${result}`)
  })

  it('grayran excludes own seat', () => {
    const ctx = makeCtx({ alivePlayers: [1, 2], mySeat: 1 })
    assert.equal(planToVote(plan(GRAYRAN), ctx), 2)
  })

  it('grayran falls back to CO players when no grays left', () => {
    const ctx = makeCtx({
      alivePlayers: [1, 2, 3],
      mySeat: 1,
      publicEvents: [
        { type: 'seer_claim', actor: 2, results: [] },
        { type: 'medium_claim', actor: 3 },
      ],
    })
    const result = planToVote(plan(GRAYRAN), ctx)
    assert.ok(result === 2 || result === 3, `expected 2 or 3, got ${result}`)
  })

  // ════════════════════════════════════════════
  // OR（同スロット内代替候補）
  // ════════════════════════════════════════════

  it('uses first alive target in OR slot', () => {
    const ctx = makeCtx({ alivePlayers: [1, 3, 5, 7] })
    assert.equal(planToVote(plan(2, OR, 4), ctx), 3)  // seat3 alive
  })

  it('falls back to second target when first is dead', () => {
    const ctx = makeCtx({ alivePlayers: [1, 5, 7] })  // seat3 dead
    assert.equal(planToVote(plan(2, OR, 4), ctx), 5)   // seat5 alive
  })

  // ════════════════════════════════════════════
  // PlanState ありパス
  // ════════════════════════════════════════════

  it('planState: forward routing (alive > 6)', () => {
    const p = plan(2, 6)
    const planState = makePlanState(p, 10)
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
    assert.equal(planToVote(p, ctx, planState), 3)
  })

  it('planState: endgame routing (alive ≤ 4)', () => {
    const p = plan()
    p[11] = 12  // seat13
    const planState = makePlanState(p, 10)
    const ctx = makeCtx({ alivePlayers: [1, 12, 13, 14] })
    assert.equal(planToVote(p, ctx, planState), 13)
  })

  it('null planState falls back to on-the-fly parse', () => {
    const ctx = makeCtx({ alivePlayers: [1, 3, 5, 7, 8, 9, 10] })
    assert.equal(planToVote(plan(2), ctx, null), 3)
  })

  it('planState with empty slots falls back to on-the-fly parse', () => {
    const emptyState: PlanState = {
      slots: [],
      endgameSlots: [],
      initialNooseCount: 5,
      mlMasonSeat: null,
      masonTakeoverDone: false,
    }
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8] })
    assert.equal(planToVote(plan(2), ctx, emptyState), 3)
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
})
