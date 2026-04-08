import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generatePlanTrainingBatch, buildEndgameLabels, generatePlanTokenTrainingBatch } from './execution-plan-data.ts'
import { PLAN_VOCAB } from '../plan/plan-vocab.ts'
import { OBSERVATION_SIZE, SEATS } from '../observation.ts'
import { Rng } from '../../../lupa/random.ts'

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

// ============================================================
// buildEndgameLabels
// ============================================================

describe('buildEndgameLabels', () => {
  it('no fox → all STOP, mask all false', () => {
    const rng = new Rng(42)
    const { labels, mask } = buildEndgameLabels([], [3, 5], rng)
    assert.deepEqual(labels, [PLAN_VOCAB.STOP, PLAN_VOCAB.STOP, PLAN_VOCAB.STOP, PLAN_VOCAB.STOP])
    assert.deepEqual(mask, [false, false, false, false])
  })

  it('fox + wolf → [0]=wolf, [1]=fox, [2]=STOP', () => {
    const rng = new Rng(42)
    const { labels, mask } = buildEndgameLabels([3], [5], rng)
    // [0] = wolf seat 5 → index 4, [1] = fox seat 3 → index 2
    assert.equal(labels[0], 4)   // seat5 (wolf)
    assert.equal(labels[1], 2)   // seat3 (fox)
    assert.equal(labels[2], PLAN_VOCAB.STOP)
    assert.equal(labels[3], PLAN_VOCAB.STOP)
    assert.deepEqual(mask, [true, true, true, false])
  })

  it('fox + wolf full overlap → empty (indistinguishable)', () => {
    // fox=[3,5], wolf=[3,5] → wolfOnly is empty → can't distinguish → empty
    const rng = new Rng(42)
    const { labels, mask, wolfOnly } = buildEndgameLabels([3, 5], [3, 5], rng)
    assert.equal(wolfOnly.length, 0)
    assert.deepEqual(mask, [false, false, false, false])
  })

  it('fox only, no wolf → empty (no wolfOnly)', () => {
    const rng = new Rng(42)
    const { labels, mask, wolfOnly } = buildEndgameLabels([7], [], rng)
    assert.equal(wolfOnly.length, 0)
    assert.deepEqual(mask, [false, false, false, false])
  })

  it('partial overlap → wolfOnly used for [0]', () => {
    // fox=[3,5], wolf=[3,5,8] → wolfOnly=[8]
    const rng = new Rng(42)
    const { labels, mask, wolfOnly } = buildEndgameLabels([3, 5], [3, 5, 8], rng)
    assert.deepEqual(wolfOnly, [8])
    assert.equal(labels[0], 7)  // seat8 → index 7
    assert.ok([2, 4].includes(labels[1]), `fox: got index ${labels[1]}`)  // seat3 or seat5
    assert.deepEqual(mask, [true, true, true, false])
  })

  it('multiple fox + multiple wolf → picks one each', () => {
    const rng = new Rng(99)
    const foxSeats = [2, 4, 6]
    const wolfSeats = [8, 10]
    const { labels, mask } = buildEndgameLabels(foxSeats, wolfSeats, rng)
    // [0] = one of wolf seats (8 or 10) → index 7 or 9
    assert.ok([7, 9].includes(labels[0]), `wolf: got index ${labels[0]}`)
    // [1] = one of fox seats (2, 4, 6) → index 1, 3, or 5
    assert.ok([1, 3, 5].includes(labels[1]), `fox: got index ${labels[1]}`)
    assert.deepEqual(mask, [true, true, true, false])
  })
})

// ============================================================
// generatePlanTokenTrainingBatch — endgame integration
// ============================================================

describe('generatePlanTokenTrainingBatch endgame', () => {
  it('generates samples with correct endgame structure', () => {
    const samples = generatePlanTokenTrainingBatch(50, 12345)
    assert.equal(samples.length, 50)
    for (const s of samples) {
      assert.equal(s.endgameLabels.length, 4)
      assert.equal(s.endgameMask.length, 4)
    }
  })

  it('produces both fox-present and fox-absent endgames', () => {
    const samples = generatePlanTokenTrainingBatch(200, 777)
    let foxPresent = 0
    let foxAbsent = 0
    for (const s of samples) {
      if (s.endgameMask.some(m => m)) {
        foxPresent++
      } else {
        foxAbsent++
      }
    }
    assert.ok(foxPresent > 0, `should have fox-present samples, got ${foxPresent}`)
    assert.ok(foxAbsent > 0, `should have fox-absent samples, got ${foxAbsent}`)
  })

  it('fox-present endgame: [0]=seat, [1]=seat, [2]=STOP', () => {
    const samples = generatePlanTokenTrainingBatch(200, 333)
    const foxSamples = samples.filter(s => s.endgameMask[1] === true)
    assert.ok(foxSamples.length > 0)
    for (const s of foxSamples) {
      // [1] must be a seat token (0-13)
      assert.ok(s.endgameLabels[1] >= 0 && s.endgameLabels[1] < 14,
        `endgame[1] should be seat, got ${s.endgameLabels[1]}`)
      // [2] must be STOP
      assert.equal(s.endgameLabels[2], PLAN_VOCAB.STOP)
    }
  })
})
