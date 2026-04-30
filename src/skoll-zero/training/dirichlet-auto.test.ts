/**
 * Dirichlet ε auto-decay 関連の純関数テスト。
 *
 * 対象:
 *   - `visitEntropyRatio` — root visit エントロピー比 (0..1)
 *   - `applyDirichletDecay` — per-slot ε 減衰規則
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { visitEntropyRatio } from '../mcts/ISMCTS.ts'
import { applyDirichletDecay, DEFAULT_DIRICHLET_AUTO_CONFIG, type DirichletAutoConfig } from './schedule.ts'

describe('visitEntropyRatio', () => {
  it('returns 0 for empty visits', () => {
    assert.equal(visitEntropyRatio(new Map()), 0)
  })

  it('returns 0 for single action (k <= 1 → undefined entropy)', () => {
    assert.equal(visitEntropyRatio(new Map([[1, 100]])), 0)
  })

  it('returns 0 for one-hot distribution (fully decisive)', () => {
    const visits = new Map<number, number>([[1, 100], [2, 0], [3, 0]])
    assert.equal(visitEntropyRatio(visits), 0)
  })

  it('returns 1 for uniform distribution (fully undecided)', () => {
    const visits = new Map<number, number>([[1, 50], [2, 50], [3, 50], [4, 50]])
    const ratio = visitEntropyRatio(visits)
    assert.ok(Math.abs(ratio - 1.0) < 1e-9, `expected ~1.0, got ${ratio}`)
  })

  it('returns intermediate value (0 < ratio < 1) for skewed distribution', () => {
    // 1 action heavily favored, others equal but smaller
    const visits = new Map<number, number>([[1, 80], [2, 5], [3, 5], [4, 5], [5, 5]])
    const ratio = visitEntropyRatio(visits)
    assert.ok(ratio > 0 && ratio < 1, `expected 0 < ratio < 1, got ${ratio}`)
    // 80% concentrated → must be on the low side of [0, 1]
    assert.ok(ratio < 0.6, `expected < 0.6, got ${ratio}`)
  })

  it('ignores zero-visit entries (numerically stable)', () => {
    const a = new Map<number, number>([[1, 50], [2, 50]])
    const b = new Map<number, number>([[1, 50], [2, 50], [3, 0], [4, 0]])
    // k differs, so normalized ratio differs — but both should be defined and finite
    assert.ok(Number.isFinite(visitEntropyRatio(a)))
    assert.ok(Number.isFinite(visitEntropyRatio(b)))
  })

  it('returns 0 when total visits is 0', () => {
    const visits = new Map<number, number>([[1, 0], [2, 0]])
    assert.equal(visitEntropyRatio(visits), 0)
  })
})

describe('applyDirichletDecay', () => {
  const cfg: DirichletAutoConfig = {
    enabled: true,
    targetRatio: 0.5,
    decay: 0.9,
    floor: 0.1,
    streak: 3,
  }

  it('returns input unchanged when disabled', () => {
    const disabled = { ...cfg, enabled: false }
    const out = applyDirichletDecay({ eps: 0.5, streak: 0 }, 0.1, 100, disabled)
    assert.deepEqual(out, { eps: 0.5, streak: 0 })
  })

  it('returns input unchanged when sample count is 0', () => {
    const out = applyDirichletDecay({ eps: 0.5, streak: 5 }, 0.1, 0, cfg)
    assert.deepEqual(out, { eps: 0.5, streak: 5 })
  })

  it('increments streak when entropy below target but streak unmet', () => {
    const out = applyDirichletDecay({ eps: 0.5, streak: 0 }, 0.3, 100, cfg)
    assert.deepEqual(out, { eps: 0.5, streak: 1 })
  })

  it('triggers decay and resets streak when consecutive low-entropy reaches threshold', () => {
    const out = applyDirichletDecay({ eps: 0.5, streak: 2 }, 0.3, 100, cfg)
    // streak 2 → 3 == cfg.streak → decay applied
    assert.equal(out.streak, 0)
    assert.ok(Math.abs(out.eps - 0.45) < 1e-9, `expected 0.45, got ${out.eps}`)
  })

  it('clamps ε to floor on decay', () => {
    const out = applyDirichletDecay({ eps: 0.105, streak: 2 }, 0.3, 100, cfg)
    // 0.105 * 0.9 = 0.0945 < floor 0.1 → clamped
    assert.equal(out.eps, 0.1)
    assert.equal(out.streak, 0)
  })

  it('keeps ε at floor across multiple decay events', () => {
    let state = { eps: 0.1, streak: 2 }
    for (let i = 0; i < 5; i++) {
      state = applyDirichletDecay(state, 0.3, 100, cfg)
      // streak 2 → 3 → reset to 0, 0+1, 1+1, 2+1=3 → reset...
      // ε never goes below floor
      assert.ok(state.eps >= cfg.floor)
    }
    assert.equal(state.eps, 0.1)
  })

  it('resets streak when entropy meets or exceeds target', () => {
    const out = applyDirichletDecay({ eps: 0.5, streak: 2 }, 0.6, 100, cfg)
    // streak should reset (entropy too high → not decisive)
    assert.deepEqual(out, { eps: 0.5, streak: 0 })
  })

  it('treats target threshold as strict inequality (entropy == target → reset)', () => {
    const out = applyDirichletDecay({ eps: 0.5, streak: 2 }, 0.5, 100, cfg)
    // 0.5 < 0.5 is false → reset path
    assert.deepEqual(out, { eps: 0.5, streak: 0 })
  })

  it('default config is disabled (safe default)', () => {
    assert.equal(DEFAULT_DIRICHLET_AUTO_CONFIG.enabled, false)
  })

  it('multi-round simulation: decisive run triggers monotone decay', () => {
    // 入力: 6 round 連続で entropy=0.3 (< target 0.5)、3 round ごとに decay
    let state = { eps: 0.5, streak: 0 }
    const epsHistory: number[] = []
    for (let i = 0; i < 6; i++) {
      state = applyDirichletDecay(state, 0.3, 100, cfg)
      epsHistory.push(state.eps)
    }
    // round 1: eps=0.5 streak=1
    // round 2: eps=0.5 streak=2
    // round 3: eps=0.45 streak=0 (decay)
    // round 4: eps=0.45 streak=1
    // round 5: eps=0.45 streak=2
    // round 6: eps=0.405 streak=0 (decay)
    assert.ok(Math.abs(epsHistory[0] - 0.5) < 1e-9)
    assert.ok(Math.abs(epsHistory[2] - 0.45) < 1e-9)
    assert.ok(Math.abs(epsHistory[5] - 0.405) < 1e-9)
  })

  it('mixed entropy: high entropy round between low entropy rounds resets streak', () => {
    let state = { eps: 0.5, streak: 0 }
    state = applyDirichletDecay(state, 0.3, 100, cfg)  // streak 1
    state = applyDirichletDecay(state, 0.3, 100, cfg)  // streak 2
    state = applyDirichletDecay(state, 0.7, 100, cfg)  // streak 0 (high entropy reset)
    assert.deepEqual(state, { eps: 0.5, streak: 0 })
    state = applyDirichletDecay(state, 0.3, 100, cfg)  // streak 1
    state = applyDirichletDecay(state, 0.3, 100, cfg)  // streak 2
    state = applyDirichletDecay(state, 0.3, 100, cfg)  // streak 3 → decay
    assert.equal(state.streak, 0)
    assert.ok(Math.abs(state.eps - 0.45) < 1e-9)
  })
})
