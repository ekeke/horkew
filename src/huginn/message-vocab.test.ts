import { describe, it } from 'node:test'
import assert from 'node:assert'
import { buildVocabLayout, encodeMessage, decodeMessage, buildLegalMask } from './message-vocab.ts'
import type { Message, HuginnInput } from './types.ts'
import { PRIORITY_LEVELS, HEAT_LEVELS, HEAT_NAMES } from './types.ts'

describe('message vocab', () => {
  const N = 5
  const W = 3
  const layout = buildVocabLayout(N, W)
  const participants = [10, 20, 30, 40, 50]

  it('vocab size formula matches spec', () => {
    assert.strictEqual(layout.vocabSize, 1 + N * 9 + N * N + 2 * W + N)
  })

  it('SILENT roundtrip', () => {
    const msg: Message = { type: 'silent' }
    const id = encodeMessage(msg, participants, layout)
    assert.deepStrictEqual(decodeMessage(id, participants, layout), msg)
  })

  it('PROPOSE roundtrip all combinations', () => {
    for (const target of participants) {
      for (let p = 1; p <= PRIORITY_LEVELS; p++) {
        for (let h = 0; h < HEAT_LEVELS; h++) {
          const msg: Message = { type: 'propose', target, priority: p as 1 | 2 | 3, heat: HEAT_NAMES[h] }
          const id = encodeMessage(msg, participants, layout)
          assert.deepStrictEqual(decodeMessage(id, participants, layout), msg)
        }
      }
    }
  })

  it('OFFER roundtrip all pairs', () => {
    for (const i of participants) {
      for (const j of participants) {
        const msg: Message = { type: 'offer', iVote: i, youVote: j }
        const id = encodeMessage(msg, participants, layout)
        assert.deepStrictEqual(decodeMessage(id, participants, layout), msg)
      }
    }
  })

  it('COMMIT roundtrip', () => {
    for (const target of participants) {
      const msg: Message = { type: 'commit', target }
      const id = encodeMessage(msg, participants, layout)
      assert.deepStrictEqual(decodeMessage(id, participants, layout), msg)
    }
  })

  it('ACCEPT/REJECT roundtrip', () => {
    for (let r = 0; r < W; r++) {
      const a: Message = { type: 'accept', offerRef: r }
      assert.deepStrictEqual(decodeMessage(encodeMessage(a, participants, layout), participants, layout), a)
      const j: Message = { type: 'reject', offerRef: r }
      assert.deepStrictEqual(decodeMessage(encodeMessage(j, participants, layout), participants, layout), j)
    }
  })
})

describe('legal mask', () => {
  const N = 5
  const W = 3
  const layout = buildVocabLayout(N, W)

  function makeInput(self: number, excludedIdx: number[]): HuginnInput {
    const participants = [0, 1, 2, 3, 4]
    const desire = new Float64Array(N)
    const excluded = new Array<boolean>(N).fill(false)
    excluded[self] = true
    for (const i of excludedIdx) excluded[i] = true
    const isDesignationTarget = new Array<boolean>(N).fill(false)
    return { self, participants, desire, excluded, isDesignationTarget }
  }

  it('SILENT always allowed, self/excluded excluded as PROPOSE/COMMIT target', () => {
    const input = makeInput(0, [3])
    const mask = buildLegalMask(input, 0, layout)
    assert.strictEqual(mask[layout.silentBase], 1)
    // PROPOSE for excluded target 0 (self) should all be 0
    for (let p = 0; p < PRIORITY_LEVELS; p++) {
      for (let h = 0; h < HEAT_LEVELS; h++) {
        const idx = layout.proposeBase + 0 * PRIORITY_LEVELS * HEAT_LEVELS + p * HEAT_LEVELS + h
        assert.strictEqual(mask[idx], 0, `PROPOSE(self) should be masked at ${idx}`)
      }
    }
    // PROPOSE for excluded target 3 should all be 0
    for (let p = 0; p < PRIORITY_LEVELS; p++) {
      for (let h = 0; h < HEAT_LEVELS; h++) {
        const idx = layout.proposeBase + 3 * PRIORITY_LEVELS * HEAT_LEVELS + p * HEAT_LEVELS + h
        assert.strictEqual(mask[idx], 0)
      }
    }
    // COMMIT 0 (self) excluded
    assert.strictEqual(mask[layout.commitBase + 0], 0)
    // COMMIT 1 allowed
    assert.strictEqual(mask[layout.commitBase + 1], 1)
  })

  it('OFFER iVote===youVote (unanimous broadcast) is legal except when involving self', () => {
    const input = makeInput(0, [])  // self=0 is excluded
    const mask = buildLegalMask(input, 0, layout)
    for (let i = 0; i < N; i++) {
      if (i === 0) {
        assert.strictEqual(mask[layout.offerBase + i * N + i], 0, `OFFER(self,self) at i=${i} must be masked`)
      } else {
        assert.strictEqual(mask[layout.offerBase + i * N + i], 1, `unanimous OFFER(${i},${i}) must be legal`)
      }
    }
  })

  it('ACCEPT/REJECT enabled only for available offer slots', () => {
    const input = makeInput(0, [])
    const m0 = buildLegalMask(input, 0, layout)
    assert.strictEqual(m0[layout.acceptBase], 0)
    const m1 = buildLegalMask(input, 1, layout)
    assert.strictEqual(m1[layout.acceptBase], 1)
    assert.strictEqual(m1[layout.acceptBase + 1], 0)
    const m3 = buildLegalMask(input, 5, layout)
    for (let r = 0; r < W; r++) {
      assert.strictEqual(m3[layout.acceptBase + r], 1)
      assert.strictEqual(m3[layout.rejectBase + r], 1)
    }
  })
})
