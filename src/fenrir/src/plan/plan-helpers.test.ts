import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PLAN_VOCAB } from './plan-vocab.ts'
import { planToVote } from './plan-helpers.ts'
import { Rng } from '../../../lupa/random.ts'
import type { DecisionContext } from '../agents/agent.ts'

const { NEXT, STOP, GRAYRAN, ROLE_START } = PLAN_VOCAB

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

describe('planToVote', () => {
  // ════════════════════════════════════════════
  // Forward plan 基本
  // ════════════════════════════════════════════

  it('resolves single seat token', () => {
    // [seat3, STOP, ...] → seat 3
    const forward = [2, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({})
    assert.equal(planToVote(forward, ctx), 3)
  })

  it('returns null for all-STOP plan', () => {
    const forward = [STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({})
    assert.equal(planToVote(forward, ctx), null)
  })

  it('uses first group only (ignores tokens after NEXT)', () => {
    // [seat3, NEXT, seat7, STOP, ...] → seat 3 (今日は groups[0])
    const forward = [2, NEXT, 6, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({})
    assert.equal(planToVote(forward, ctx), 3)
  })

  it('skips dead seat and returns null if no fallback', () => {
    // seat5 だが seat5 は死亡
    const forward = [4, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4, 6, 7] })
    assert.equal(planToVote(forward, ctx), null)
  })

  it('excludes own seat', () => {
    // seat1 を指定しているが mySeat=1 → 除外 → null
    const forward = [0, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({ mySeat: 1 })
    assert.equal(planToVote(forward, ctx), null)
  })

  // ════════════════════════════════════════════
  // Role token
  // ════════════════════════════════════════════

  it('resolves role token to CO player', () => {
    // role=seer (ROLE_START+0) → seat 5 が占いCO
    const forward = [ROLE_START, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({
      publicEvents: [{ type: 'seer_claim', actor: 5, results: [] }],
    })
    assert.equal(planToVote(forward, ctx), 5)
  })

  it('returns null when role has no CO player', () => {
    // role=medium (ROLE_START+1) だが誰も霊能COしていない
    const forward = [ROLE_START + 1, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({})
    assert.equal(planToVote(forward, ctx), null)
  })

  it('excludes dead CO player from role resolution', () => {
    // seer CO した seat5 が死亡
    const forward = [ROLE_START, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({
      alivePlayers: [1, 2, 3, 4, 6, 7],
      publicEvents: [{ type: 'seer_claim', actor: 5, results: [] }],
    })
    assert.equal(planToVote(forward, ctx), null)
  })

  // ════════════════════════════════════════════
  // Grayran token
  // ════════════════════════════════════════════

  it('resolves grayran to non-CO player', () => {
    // grayran → CO していない生存者
    const forward = [GRAYRAN, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({
      alivePlayers: [1, 2, 3, 4, 5],
      mySeat: 1,
      publicEvents: [
        { type: 'seer_claim', actor: 2, results: [] },
        { type: 'medium_claim', actor: 3 },
      ],
    })
    // CO: 2, 3。自分: 1。残り: 4, 5 のどちらか
    const result = planToVote(forward, ctx)
    assert.ok(result === 4 || result === 5, `expected 4 or 5, got ${result}`)
  })

  it('grayran excludes own seat', () => {
    // 全員 CO なし、mySeat=1
    const forward = [GRAYRAN, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({ alivePlayers: [1, 2], mySeat: 1 })
    assert.equal(planToVote(forward, ctx), 2)
  })

  it('grayran falls back to CO players when no grays left', () => {
    // 全員 CO 済み → フォールバックで CO 者から選択
    const forward = [GRAYRAN, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({
      alivePlayers: [1, 2, 3],
      mySeat: 1,
      publicEvents: [
        { type: 'seer_claim', actor: 2, results: [] },
        { type: 'medium_claim', actor: 3 },
      ],
    })
    const result = planToVote(forward, ctx)
    assert.ok(result === 2 || result === 3, `expected 2 or 3, got ${result}`)
  })

  // ════════════════════════════════════════════
  // Endgame 切り替え
  // ════════════════════════════════════════════

  it('uses endgame groups[0] when alive <= 4', () => {
    const forward = [2, STOP, STOP, STOP, STOP, STOP, STOP, STOP]  // seat3
    const endgame = [6, STOP, STOP, STOP]  // seat7
    const ctx = makeCtx({ alivePlayers: [1, 3, 7, 9] })  // 4人
    assert.equal(planToVote(forward, ctx, endgame), 7)
  })

  it('uses endgame groups[1] when alive <= 6 and 2+ groups', () => {
    const forward = [2, STOP, STOP, STOP, STOP, STOP, STOP, STOP]  // seat3
    const endgame = [6, NEXT, 4, STOP]  // groups: [seat7], [seat5]
    const ctx = makeCtx({ alivePlayers: [1, 3, 5, 7, 9, 11] })  // 6人
    assert.equal(planToVote(forward, ctx, endgame), 5)
  })

  it('falls back to forward when alive <= 6 but only 1 endgame group', () => {
    // groups[0] は最終日用（≤4人）なので 6人では使わない
    const forward = [2, STOP, STOP, STOP, STOP, STOP, STOP, STOP]  // seat3
    const endgame = [6, STOP, STOP, STOP]  // 1 group: [seat7] (最終日用)
    const ctx = makeCtx({ alivePlayers: [1, 3, 5, 7, 9, 11] })  // 6人
    assert.equal(planToVote(forward, ctx, endgame), 3)  // forward にフォールバック
  })

  it('falls back to forward when alive > 6 despite endgame', () => {
    const forward = [2, STOP, STOP, STOP, STOP, STOP, STOP, STOP]  // seat3
    const endgame = [6, STOP, STOP, STOP]  // seat7
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4, 5, 6, 7] })  // 7人
    assert.equal(planToVote(forward, ctx, endgame), 3)
  })

  it('falls back to forward when endgame target is dead', () => {
    const forward = [2, STOP, STOP, STOP, STOP, STOP, STOP, STOP]  // seat3
    const endgame = [6, STOP, STOP, STOP]  // seat7 だが死亡
    const ctx = makeCtx({ alivePlayers: [1, 3, 5, 9] })  // 4人, seat7 不在
    assert.equal(planToVote(forward, ctx, endgame), 3)
  })

  it('uses forward when endgame is null', () => {
    const forward = [2, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({ alivePlayers: [1, 3, 5, 7] })  // 4人
    assert.equal(planToVote(forward, ctx, null), 3)
  })

  // ════════════════════════════════════════════
  // Forward 空 (all-STOP) のフォールバック
  // ════════════════════════════════════════════

  it('returns endgame when forward is all-STOP and alive <= 4', () => {
    const forward = [STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const endgame = [6, STOP, STOP, STOP]  // seat7
    const ctx = makeCtx({ alivePlayers: [1, 3, 7, 9] })  // 4人
    assert.equal(planToVote(forward, ctx, endgame), 7)
  })

  it('returns endgame when forward is all-STOP and alive <= 6 with 2 groups', () => {
    const forward = [STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const endgame = [6, NEXT, 4, STOP]  // groups: [seat7], [seat5]
    const ctx = makeCtx({ alivePlayers: [1, 3, 5, 7, 9, 11] })  // 6人
    assert.equal(planToVote(forward, ctx, endgame), 5)
  })

  it('returns null when forward is all-STOP and no endgame', () => {
    const forward = [STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({ alivePlayers: [1, 3, 5, 7] })  // 4人
    assert.equal(planToVote(forward, ctx, null), null)
  })

  it('returns null when forward is all-STOP and alive > 6', () => {
    const forward = [STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const endgame = [6, STOP, STOP, STOP]
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4, 5, 6, 7] })  // 7人
    assert.equal(planToVote(forward, ctx, endgame), null)
  })

  it('returns null when forward is all-STOP, alive <= 6, only 1 endgame group', () => {
    // 6人、endgame groups[0] は最終日用 → 使わない → null
    const forward = [STOP, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const endgame = [6, STOP, STOP, STOP]  // 1 group
    const ctx = makeCtx({ alivePlayers: [1, 3, 5, 7, 9, 11] })  // 6人
    assert.equal(planToVote(forward, ctx, endgame), null)
  })

  // ════════════════════════════════════════════
  // Multi-target group (roller)
  // ════════════════════════════════════════════

  it('resolves multi-target group: first alive wins', () => {
    // group: [seat3, seat5] → seat3 が生存ならそれ
    const forward = [2, 4, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({ alivePlayers: [1, 3, 5, 7] })
    assert.equal(planToVote(forward, ctx), 3)
  })

  it('resolves multi-target group: skips dead, uses second', () => {
    // group: [seat3, seat5] → seat3 死亡 → seat5
    const forward = [2, 4, STOP, STOP, STOP, STOP, STOP, STOP]
    const ctx = makeCtx({ alivePlayers: [1, 5, 7] })
    assert.equal(planToVote(forward, ctx), 5)
  })

  // ════════════════════════════════════════════
  // Endgame 保護（forward が endgame ターゲットを除外）
  // ════════════════════════════════════════════

  it('forward excludes seat protected by endgame', () => {
    // forward: seat3, endgame: seat3 → forward で seat3 は保護 → null
    const forward = [2, STOP, STOP, STOP, STOP, STOP, STOP, STOP]  // seat3
    const endgame = [2, STOP, STOP, STOP]  // seat3（最終日まで保護）
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })  // 10人
    assert.equal(planToVote(forward, ctx, endgame), null)
  })

  it('forward skips endgame-protected seat and uses next target', () => {
    // forward: [seat3, seat5], endgame: seat3 → seat3 保護 → seat5
    const forward = [2, 4, STOP, STOP, STOP, STOP, STOP, STOP]
    const endgame = [2, STOP, STOP, STOP]  // seat3 保護
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
    assert.equal(planToVote(forward, ctx, endgame), 5)
  })

  it('endgame protection applies to role tokens', () => {
    // forward: seer role → seat5 が占いCO、endgame: seat5 → 保護 → null
    const forward = [ROLE_START, STOP, STOP, STOP, STOP, STOP, STOP, STOP]  // seer
    const endgame = [4, STOP, STOP, STOP]  // seat5 保護
    const ctx = makeCtx({
      alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      publicEvents: [{ type: 'seer_claim', actor: 5, results: [] }],
    })
    assert.equal(planToVote(forward, ctx, endgame), null)
  })

  it('endgame role token protects CO players from forward', () => {
    // forward: seat5, endgame: seer role → seat5 が占いCO → 保護 → null
    const forward = [4, STOP, STOP, STOP, STOP, STOP, STOP, STOP]  // seat5
    const endgame = [ROLE_START, STOP, STOP, STOP]  // seer（seat5 を保護）
    const ctx = makeCtx({
      alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      publicEvents: [{ type: 'seer_claim', actor: 5, results: [] }],
    })
    assert.equal(planToVote(forward, ctx, endgame), null)
  })

  it('grayran in forward excludes endgame-protected seats', () => {
    // forward: grayran, endgame: seat4 → seat4 保護
    // CO: seat2, seat3。自分: seat1。グレー: seat4, seat5 → seat4 保護 → seat5
    const forward = [GRAYRAN, STOP, STOP, STOP, STOP, STOP, STOP, STOP]
    const endgame = [3, STOP, STOP, STOP]  // seat4 保護
    const ctx = makeCtx({
      alivePlayers: [1, 2, 3, 4, 5],
      mySeat: 1,
      publicEvents: [
        { type: 'seer_claim', actor: 2, results: [] },
        { type: 'medium_claim', actor: 3 },
      ],
    })
    assert.equal(planToVote(forward, ctx, endgame), 5)
  })

  it('endgame protection does NOT apply when in endgame (alive <= 4)', () => {
    // endgame 発動時は保護不要（endgame 自体がターゲット）
    const forward = [2, STOP, STOP, STOP, STOP, STOP, STOP, STOP]  // seat3
    const endgame = [2, STOP, STOP, STOP]  // seat3
    const ctx = makeCtx({ alivePlayers: [1, 3, 7, 9] })  // 4人 → endgame 発動
    assert.equal(planToVote(forward, ctx, endgame), 3)
  })

  it('no protection when endgame is all-STOP', () => {
    // endgame が空 → 保護なし → forward 通常動作
    const forward = [2, STOP, STOP, STOP, STOP, STOP, STOP, STOP]  // seat3
    const endgame = [STOP, STOP, STOP, STOP]
    const ctx = makeCtx({ alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
    assert.equal(planToVote(forward, ctx, endgame), 3)
  })
})
