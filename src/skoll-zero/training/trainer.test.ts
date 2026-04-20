import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TrainingBuffer } from '../selfplay/buffer.ts'
import type { TrainingRecord } from '../selfplay/buffer.ts'
import { MasonZeroNetwork } from '../network/mason-zero.ts'
import { createSkollZeroNetwork } from '../network/config.ts'
import { createSkollZeroTfNetwork } from '../network/tf-config.ts'
import { loadCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'
import { DEFAULT_SKOLL_ZERO_TRAIN_CONFIG } from './schedule.ts'
import { SkollZeroTrainer, recordsToBatchInputs } from './trainer.ts'

/** テスト用の seat/role 数 (MASON_COLLECTIVE input size) を取得 */
function getInputSize(): number {
  return createSkollZeroNetwork().config.inputSize
}

/** 合成 record: alive bitmask と pi を指定、obs はランダム */
function makeRecord(opts: {
  masonSeat: number
  alive: number
  pi: Map<number, number>
  z: number
  day?: number
  rng?: () => number
}): TrainingRecord {
  const inputSize = getInputSize()
  const obs = new Float32Array(inputSize)
  const rng = opts.rng ?? Math.random
  for (let i = 0; i < inputSize; i++) obs[i] = (rng() - 0.5) * 0.1
  const visits = new Map<number, number>()
  // 簡易: pi と同じ分布で visits も埋める (計100 visits)
  for (const [seat, p] of opts.pi) visits.set(seat, Math.round(p * 100))
  return {
    obs,
    visits,
    pi: opts.pi,
    day: opts.day ?? 1,
    masonSeat: opts.masonSeat,
    alive: opts.alive,
    z: opts.z,
  }
}

function aliveOf(seats: number[]): number {
  let mask = 0
  for (const s of seats) mask |= (1 << s)
  return mask
}

/** 簡易 deterministic RNG */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  if (s === 0) s = 1
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('recordsToBatchInputs', () => {
  it('visits Map → dense Float32Array (illegal seats = -1e9 in mask)', () => {
    const rec = makeRecord({
      masonSeat: 3,
      alive: aliveOf([1, 2, 3, 4, 5]),  // seat 3 は mason 自身
      pi: new Map([[1, 0.5], [4, 0.3], [5, 0.2]]),
      z: 1.0,
    })
    const { policyTargets, masks, valueTargets } = recordsToBatchInputs([rec])
    assert.equal(policyTargets.length, 1)
    assert.equal(policyTargets[0].length, 14)
    assert.equal(masks[0].length, 14)

    // pi が正しくセットされているか (seat s は index s-1)。Float32 なので近似比較
    const approxEq = (a: number, b: number, msg: string) =>
      assert.ok(Math.abs(a - b) < 1e-6, `${msg} (got ${a}, want ${b})`)
    approxEq(policyTargets[0][0], 0.5, 'seat 1 → idx 0')
    approxEq(policyTargets[0][3], 0.3, 'seat 4 → idx 3')
    approxEq(policyTargets[0][4], 0.2, 'seat 5 → idx 4')
    // pi に入ってない seat は 0
    assert.equal(policyTargets[0][1], 0, 'seat 2 not in pi → 0')

    // mask: seat 1,2,4,5 legal (= 0)、seat 3 (mason), 6..14 illegal (= -1e9)
    assert.equal(masks[0][0], 0, 'seat 1 legal')
    assert.equal(masks[0][1], 0, 'seat 2 legal')
    assert.equal(masks[0][2], -1e9, 'seat 3 = mason self, illegal')
    assert.equal(masks[0][3], 0, 'seat 4 legal')
    assert.equal(masks[0][4], 0, 'seat 5 legal')
    assert.equal(masks[0][5], -1e9, 'seat 6 dead, illegal')
    assert.equal(masks[0][13], -1e9, 'seat 14 dead, illegal')

    assert.equal(valueTargets[0], 1.0)
  })
})

describe('SkollZeroTrainer', () => {
  it('trainStep: 単一 batch で有限 loss を返す (NaN なし)', () => {
    const masonZeroNet = new MasonZeroNetwork()
    const tfNet = createSkollZeroTfNetwork(3e-4)
    tfNet.loadWeights(masonZeroNet.net.cloneWeights())
    const buffer = new TrainingBuffer()
    const rng = makeRng(1)
    for (let i = 0; i < 4; i++) {
      const rec = makeRecord({
        masonSeat: 1,
        alive: aliveOf([1, 2, 3, 4, 5]),
        pi: new Map([[2, 0.4], [3, 0.3], [4, 0.2], [5, 0.1]]),
        z: 1.0,
        rng,
      })
      buffer.appendPending(rec)
    }
    buffer.finalize(1.0)

    const trainer = new SkollZeroTrainer({
      masonZeroNet,
      tfNet,
      buffer,
      config: { ...DEFAULT_SKOLL_ZERO_TRAIN_CONFIG, batchSize: 4, rngSeed: 42 },
    })
    const st = trainer.trainStep()
    assert.ok(Number.isFinite(st.loss), `loss finite (got ${st.loss})`)
    assert.ok(Number.isFinite(st.policyLoss), 'policyLoss finite')
    assert.ok(Number.isFinite(st.valueLoss), 'valueLoss finite')
    assert.equal(st.batchSize, 4)
    tfNet.dispose()
  })

  it('trainStep: 同じ batch で 50 step ループ → loss が減る (overfit smoke)', () => {
    const masonZeroNet = new MasonZeroNetwork()
    const tfNet = createSkollZeroTfNetwork(1e-3)  // smoke では強めの lr
    tfNet.loadWeights(masonZeroNet.net.cloneWeights())
    const buffer = new TrainingBuffer()
    const rng = makeRng(7)
    // 4 record で同じ π / z を与え、完全 overfit 可能な状況を作る
    for (let i = 0; i < 4; i++) {
      buffer.appendPending(makeRecord({
        masonSeat: 1,
        alive: aliveOf([1, 2, 3, 4, 5]),
        pi: new Map([[2, 0.7], [3, 0.1], [4, 0.1], [5, 0.1]]),
        z: 1.0,
        rng,
      }))
    }
    buffer.finalize(1.0)

    const trainer = new SkollZeroTrainer({
      masonZeroNet,
      tfNet,
      buffer,
      config: { ...DEFAULT_SKOLL_ZERO_TRAIN_CONFIG, batchSize: 4, rngSeed: 42 },
    })
    const first = trainer.trainStep()
    let last = first
    for (let s = 0; s < 50; s++) last = trainer.trainStep()
    assert.ok(last.policyLoss < first.policyLoss * 0.95,
      `policy loss が 5% 以上減る (first=${first.policyLoss.toFixed(4)} → last=${last.policyLoss.toFixed(4)})`)
    assert.ok(last.valueLoss < first.valueLoss * 0.95,
      `value loss が 5% 以上減る (first=${first.valueLoss.toFixed(4)} → last=${last.valueLoss.toFixed(4)})`)
    tfNet.dispose()
  })

  it('saveRoundCheckpoint → loadNetworkFromCheckpoint → forward 出力一致', () => {
    const masonZeroNet = new MasonZeroNetwork()
    const tfNet = createSkollZeroTfNetwork(3e-4)
    tfNet.loadWeights(masonZeroNet.net.cloneWeights())
    const buffer = new TrainingBuffer()
    // training で重みを動かす (checkpoint が初期と違う状態になるように)
    const rng = makeRng(11)
    for (let i = 0; i < 4; i++) {
      buffer.appendPending(makeRecord({
        masonSeat: 1,
        alive: aliveOf([1, 2, 3, 4, 5]),
        pi: new Map([[2, 0.5], [3, 0.5]]),
        z: 1.0,
        rng,
      }))
    }
    buffer.finalize(1.0)
    const trainer = new SkollZeroTrainer({
      masonZeroNet, tfNet, buffer,
      config: { ...DEFAULT_SKOLL_ZERO_TRAIN_CONFIG, batchSize: 4, rngSeed: 13 },
    })
    for (let s = 0; s < 10; s++) trainer.trainStep()
    trainer.syncWeights()

    const tmpDir = mkdtempSync(join(tmpdir(), 'skoll-zero-ckpt-'))
    try {
      const weightsPath = trainer.saveRoundCheckpoint(tmpDir, 1, {
        round: 1,
        gamesPlayed: 0,
        recordsAdded: 0,
        bufferSize: buffer.size(),
        bufferExpired: 0,
        stepsRun: 10,
        avgLoss: 0,
        avgPolicyLoss: 0,
        avgValueLoss: 0,
        outcomes: { villagerWon: 0, werewolfWon: 0, werehamsterWon: 0, draw: 0 },
      })
      assert.ok(existsSync(weightsPath))
      assert.ok(existsSync(join(tmpDir, 'final.json')))
      assert.ok(existsSync(join(tmpDir, 'round_0001', 'meta.json')))

      // load → 同じ obs で forward が同じ value を返す
      // NOTE: loadNetworkFromCheckpoint は observationMode を 'team' 固定で復元するため、
      // mason_collective では不整合。正しくは createSkollZeroNetwork() + loadCheckpoint。
      const reloaded = createSkollZeroNetwork()
      loadCheckpoint(reloaded, weightsPath)
      const testObs = new Float32Array(getInputSize())
      for (let i = 0; i < testObs.length; i++) testObs[i] = ((i * 31) % 17) / 17
      const original = masonZeroNet.net.forward(testObs)
      const restored = reloaded.forward(testObs)
      assert.ok(Math.abs(original.value - restored.value) < 1e-6,
        `value 一致 (orig=${original.value}, restored=${restored.value})`)
      const origVote = original.policies.get('vote')!
      const restVote = restored.policies.get('vote')!
      for (let i = 0; i < origVote.length; i++) {
        assert.ok(Math.abs(origVote[i] - restVote[i]) < 1e-6,
          `vote[${i}] 一致 (orig=${origVote[i]}, restored=${restVote[i]})`)
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
      tfNet.dispose()
    }
  })
})
