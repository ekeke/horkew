import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generatePlanTrainingBatch } from './execution-plan-data.ts'
import { OBSERVATION_SIZE, SEATS } from '../observation.ts'

describe('generatePlanTrainingBatch', () => {
  it('generates requested number of samples', () => {
    const samples = generatePlanTrainingBatch(100, 123)
    assert.equal(samples.length, 100)
  })

  it('observations have correct size', () => {
    const samples = generatePlanTrainingBatch(10)
    for (const s of samples) {
      assert.equal(s.observation.length, OBSERVATION_SIZE)
    }
  })

  it('vote labels have correct size and sum to ~1', () => {
    const samples = generatePlanTrainingBatch(50, 456)
    for (const s of samples) {
      assert.equal(s.voteLabel.length, SEATS)
      const sum = s.voteLabel.reduce((a, b) => a + b, 0)
      assert.ok(Math.abs(sum - 1) < 1e-5, `label sum should be ~1, got ${sum}`)
    }
  })

  it('vote masks have correct size', () => {
    const samples = generatePlanTrainingBatch(10)
    for (const s of samples) {
      assert.equal(s.voteMask.length, SEATS)
    }
  })

  it('labels only have weight on valid (unmasked) seats', () => {
    const samples = generatePlanTrainingBatch(100, 789)
    for (const s of samples) {
      for (let i = 0; i < SEATS; i++) {
        if (s.voteLabel[i] > 0) {
          assert.notEqual(s.voteMask[i], -Infinity,
            `label[${i}]=${s.voteLabel[i]} but seat is masked`)
        }
      }
    }
  })

  it('is deterministic with same seed', () => {
    const a = generatePlanTrainingBatch(20, 42)
    const b = generatePlanTrainingBatch(20, 42)
    for (let i = 0; i < 20; i++) {
      assert.deepEqual(a[i].voteLabel, b[i].voteLabel)
    }
  })

  it('produces diverse patterns', () => {
    const samples = generatePlanTrainingBatch(200, 999)
    let oneHot = 0
    let soft = 0
    for (const s of samples) {
      const nonzero = [...s.voteLabel].filter(v => v > 0).length
      if (nonzero === 1) oneHot++
      else soft++
    }
    // one-hot (roller/decision/designated) と soft (grayran) の両方が出ること
    assert.ok(oneHot > 0, 'should have one-hot labels (non-grayran)')
    assert.ok(soft > 0, 'should have soft labels (grayran)')
  })
})
