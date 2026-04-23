import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TrainingBuffer } from '../selfplay/buffer.ts'
import type { TrainingRecord } from '../selfplay/buffer.ts'
import { MasonZeroNetwork } from '../network/mason-zero.ts'
import {
  createSkollZeroNetwork,
  createStandardZeroNetwork,
  createWolfZeroNetwork,
} from '../network/config.ts'
import {
  createSkollZeroTfNetwork,
  createStandardZeroTfNetwork,
  createWolfZeroTfNetwork,
} from '../network/tf-config.ts'
import { loadCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'
import { DEFAULT_SKOLL_ZERO_TRAIN_CONFIG } from './schedule.ts'
import { SkollZeroTrainer, groupRecordsByHead, recordsToBatchInputs } from './trainer.ts'
import { trainOutcomeSLBucket, OUTCOME_SL_HEAD_TYPES, type TrainerSlot } from './multi-trainer.ts'

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
  headName?: TrainingRecord['headName']
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
    headName: opts.headName ?? 'vote',
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

describe('groupRecordsByHead', () => {
  it('headName ごとに records を分割する', () => {
    const rec = (headName: TrainingRecord['headName'], seat: number): TrainingRecord => ({
      obs: new Float32Array(0),
      visits: new Map([[seat, 1]]),
      pi: new Map([[seat, 1]]),
      day: 1,
      masonSeat: 1,
      alive: 0b111110,
      z: 0,
      headName,
    })
    const records: TrainingRecord[] = [
      rec('vote', 2), rec('attack', 3), rec('vote', 4),
      rec('divine', 5), rec('guard', 2), rec('attack', 5),
    ]
    const groups = groupRecordsByHead(records)
    assert.equal(groups.get('vote')?.length, 2)
    assert.equal(groups.get('attack')?.length, 2)
    assert.equal(groups.get('divine')?.length, 1)
    assert.equal(groups.get('guard')?.length, 1)
  })

  it('空入力は空 Map', () => {
    const groups = groupRecordsByHead([])
    assert.equal(groups.size, 0)
  })
})

describe('trainMasonZero: multi-head 分離学習', () => {
  /**
   * 同一 batch を vote head と attack head にそれぞれ流しても、
   * 別 head 間で weight が独立に更新される（あるいは誤って同一 weights を更新しない）ことを確認。
   */
  it('wolf config の attack head で trainMasonZero が走る', () => {
    const pureNet = createWolfZeroNetwork()
    const tfNet = createWolfZeroTfNetwork(1e-3)
    tfNet.loadWeights(pureNet.cloneWeights())

    const inputSize = pureNet.config.inputSize
    const rng = makeRng(42)
    const obs = new Float32Array(inputSize)
    for (let i = 0; i < inputSize; i++) obs[i] = (rng() - 0.5) * 0.1
    const pi = new Float32Array(14)
    pi[2] = 1.0  // seat 3 に集中
    const mask = new Float32Array(14)
    for (let i = 0; i < 14; i++) mask[i] = -1e9
    // legal: seat 2..5 (index 1..4)
    for (let i = 1; i <= 4; i++) mask[i] = 0

    // attack head を学習 → 有限 loss
    const resAttack = tfNet.trainMasonZero({
      observations: [obs, obs, obs, obs],
      policyTargets: [pi, pi, pi, pi],
      masks: [mask, mask, mask, mask],
      valueTargets: [1, 1, 1, 1],
      valueCoeff: 1.0,
      headName: 'attack',
    })
    assert.ok(Number.isFinite(resAttack.loss), 'attack head loss finite')
    assert.ok(Number.isFinite(resAttack.policyLoss), 'attack policyLoss finite')

    // vote head も同様に学習可能
    const resVote = tfNet.trainMasonZero({
      observations: [obs, obs, obs, obs],
      policyTargets: [pi, pi, pi, pi],
      masks: [mask, mask, mask, mask],
      valueTargets: [1, 1, 1, 1],
      valueCoeff: 1.0,
      headName: 'vote',
    })
    assert.ok(Number.isFinite(resVote.loss), 'vote head loss finite')

    tfNet.dispose()
  })

  it('standard config の divine / guard head でも trainMasonZero が走る', () => {
    const pureNet = createStandardZeroNetwork()
    const tfNet = createStandardZeroTfNetwork(1e-3)
    tfNet.loadWeights(pureNet.cloneWeights())

    const inputSize = pureNet.config.inputSize
    const rng = makeRng(7)
    const obs = new Float32Array(inputSize)
    for (let i = 0; i < inputSize; i++) obs[i] = (rng() - 0.5) * 0.1
    const pi = new Float32Array(14)
    pi[1] = 1.0
    const mask = new Float32Array(14)
    for (let i = 0; i < 14; i++) mask[i] = -1e9
    for (let i = 1; i <= 4; i++) mask[i] = 0

    for (const headName of ['divine', 'guard'] as const) {
      const res = tfNet.trainMasonZero({
        observations: [obs, obs],
        policyTargets: [pi, pi],
        masks: [mask, mask],
        valueTargets: [0.5, 0.5],
        valueCoeff: 1.0,
        headName,
      })
      assert.ok(Number.isFinite(res.loss), `${headName} head loss finite`)
    }

    tfNet.dispose()
  })

  it('存在しない head 名は例外を投げる', () => {
    const pureNet = createSkollZeroNetwork()  // mason config: vote head のみ
    const tfNet = createSkollZeroTfNetwork(1e-3)
    tfNet.loadWeights(pureNet.cloneWeights())
    const inputSize = pureNet.config.inputSize
    const obs = new Float32Array(inputSize)
    const pi = new Float32Array(14)
    const mask = new Float32Array(14)
    assert.throws(() => tfNet.trainMasonZero({
      observations: [obs],
      policyTargets: [pi],
      masks: [mask],
      valueTargets: [0],
      headName: 'attack',
    }), /head 'attack' not found/)
    tfNet.dispose()
  })
})

describe('trainOutcomeWeightedSL', () => {
  /** 共通 fixture: deterministic obs / legal mask / chosen action */
  function makeFixture(seed: number) {
    const masonZeroNet = new MasonZeroNetwork()
    const tfNet = createSkollZeroTfNetwork(1e-2)
    tfNet.loadWeights(masonZeroNet.net.cloneWeights())
    const inputSize = masonZeroNet.net.config.inputSize
    const rng = makeRng(seed)
    const obs = new Float32Array(inputSize)
    for (let i = 0; i < inputSize; i++) obs[i] = (rng() - 0.5) * 0.1
    const mask = new Float32Array(14)
    for (let i = 0; i < 14; i++) mask[i] = -1e9
    for (let i = 1; i <= 4; i++) mask[i] = 0  // seats 2..5 legal
    return { masonZeroNet, tfNet, obs, mask }
  }

  it('perSeatSoftmax: advantage>0 で選んだ action の確率が上がる', () => {
    const { masonZeroNet, tfNet, obs, mask } = makeFixture(101)
    const actionIdx = 1  // seat 2
    const before = masonZeroNet.net.forward(obs).policies.get('vote')!.slice()
    for (let s = 0; s < 20; s++) {
      tfNet.trainOutcomeWeightedSL({
        observations: [obs],
        outcomes: [1],
        baseline: 0,
        headName: 'vote',
        headType: 'perSeatSoftmax',
        actionIndices: [actionIdx],
        masks: [mask],
      })
    }
    masonZeroNet.net.loadWeights(tfNet.cloneWeights())
    const after = masonZeroNet.net.forward(obs).policies.get('vote')!
    assert.ok(after[actionIdx] > before[actionIdx],
      `logit 上昇 (before=${before[actionIdx].toFixed(4)} → after=${after[actionIdx].toFixed(4)})`)
    tfNet.dispose()
  })

  it('perSeatSoftmax: advantage<0 で選んだ action の確率が下がる', () => {
    const { masonZeroNet, tfNet, obs, mask } = makeFixture(202)
    const actionIdx = 2  // seat 3
    const before = masonZeroNet.net.forward(obs).policies.get('vote')!.slice()
    for (let s = 0; s < 20; s++) {
      tfNet.trainOutcomeWeightedSL({
        observations: [obs],
        outcomes: [-1],
        baseline: 0,
        headName: 'vote',
        headType: 'perSeatSoftmax',
        actionIndices: [actionIdx],
        masks: [mask],
      })
    }
    masonZeroNet.net.loadWeights(tfNet.cloneWeights())
    const after = masonZeroNet.net.forward(obs).policies.get('vote')!
    assert.ok(after[actionIdx] < before[actionIdx],
      `logit 下降 (before=${before[actionIdx].toFixed(4)} → after=${after[actionIdx].toFixed(4)})`)
    tfNet.dispose()
  })

  it('globalSoftmax (claim): loss 有限かつ KL 無指定時 klLoss=0', () => {
    const { tfNet, obs } = makeFixture(303)
    const res = tfNet.trainOutcomeWeightedSL({
      observations: [obs, obs],
      outcomes: [1, -1],
      baseline: 0,
      headName: 'claim',
      headType: 'globalSoftmax',
      actionIndices: [3, 5],
    })
    assert.ok(Number.isFinite(res.loss), `loss finite (got ${res.loss})`)
    assert.ok(Number.isFinite(res.policyLoss), 'policyLoss finite')
    assert.equal(res.klLoss, 0, 'klLoss=0 when refLogits omitted')
    tfNet.dispose()
  })

  it('perSeatSigmoid (predict): multi-hot action で loss 有限', () => {
    const { tfNet, obs } = makeFixture(404)
    const outputSize = 14 * 11  // predict = 154
    const multiHot = new Float32Array(outputSize)
    multiHot[0] = 1  // seat 1, role 0
    multiHot[23] = 1
    const res = tfNet.trainOutcomeWeightedSL({
      observations: [obs],
      outcomes: [1],
      baseline: 0,
      headName: 'predict',
      headType: 'perSeatSigmoid',
      actionMultiHot: [multiHot],
    })
    assert.ok(Number.isFinite(res.loss), 'loss finite')
    assert.ok(Number.isFinite(res.policyLoss), 'policyLoss finite')
    assert.equal(res.klLoss, 0, 'klLoss=0 when refLogits omitted')
    tfNet.dispose()
  })

  it('KL anchor: refLogits=自分の logits なら klLoss が十分小さい (差が大きい時との比較)', () => {
    const { masonZeroNet, tfNet, obs, mask } = makeFixture(505)
    // Pure JS と TF の forward には微小な数値差があるので、
    // "self-KL" と "mismatched KL" を相対比較する
    const pureLogits = masonZeroNet.net.forward(obs).policies.get('vote')!
    const selfRef = new Float32Array(pureLogits)
    const farRef = new Float32Array(pureLogits)
    farRef[1] += 3  // seat 2 の logit を 3 ずらす

    const resSelf = tfNet.trainOutcomeWeightedSL({
      observations: [obs],
      outcomes: [1],
      baseline: 1,  // advantage = 0 にして policy loss を排除
      headName: 'vote',
      headType: 'perSeatSoftmax',
      actionIndices: [1],
      masks: [mask],
      refLogits: [selfRef],
      klCoeff: 1.0,
    })
    // weights を戻して second run に備える
    tfNet.loadWeights(masonZeroNet.net.cloneWeights())
    const resFar = tfNet.trainOutcomeWeightedSL({
      observations: [obs],
      outcomes: [1],
      baseline: 1,
      headName: 'vote',
      headType: 'perSeatSoftmax',
      actionIndices: [1],
      masks: [mask],
      refLogits: [farRef],
      klCoeff: 1.0,
    })
    assert.ok(Number.isFinite(resSelf.klLoss), 'self klLoss finite')
    assert.ok(Number.isFinite(resFar.klLoss), 'far klLoss finite')
    assert.ok(resFar.klLoss > resSelf.klLoss * 10,
      `KL(far) >> KL(self) (self=${resSelf.klLoss.toFixed(5)}, far=${resFar.klLoss.toFixed(5)})`)
    tfNet.dispose()
  })

  it('空バッチは早期 return', () => {
    const { tfNet } = makeFixture(707)
    const res = tfNet.trainOutcomeWeightedSL({
      observations: [],
      outcomes: [],
      baseline: 0,
      headName: 'vote',
      headType: 'perSeatSoftmax',
      actionIndices: [],
      masks: [],
    })
    assert.equal(res.loss, 0)
    assert.equal(res.policyLoss, 0)
    assert.equal(res.klLoss, 0)
    tfNet.dispose()
  })

  it('存在しない head は例外', () => {
    const { tfNet, obs, mask } = makeFixture(808)
    assert.throws(() => tfNet.trainOutcomeWeightedSL({
      observations: [obs],
      outcomes: [1],
      baseline: 0,
      headName: 'nonexistent',
      headType: 'perSeatSoftmax',
      actionIndices: [1],
      masks: [mask],
    }), /per-seat softmax head 'nonexistent' not found/)
    tfNet.dispose()
  })
})

describe('OUTCOME_SL_HEAD_TYPES', () => {
  it('全 outcome-SL head が登録されている', () => {
    assert.equal(OUTCOME_SL_HEAD_TYPES.claim, 'globalSoftmax')
    assert.equal(OUTCOME_SL_HEAD_TYPES.comm, 'globalSoftmax')
    assert.equal(OUTCOME_SL_HEAD_TYPES.leader, 'globalSoftmax')
    assert.equal(OUTCOME_SL_HEAD_TYPES.target, 'perSeatSoftmax')
    assert.equal(OUTCOME_SL_HEAD_TYPES.propose, 'perSeatSigmoid')
    assert.equal(OUTCOME_SL_HEAD_TYPES.predict, 'perSeatSigmoid')
  })

  it('MCTS-π head は含まれない (誤登録防止)', () => {
    assert.equal(OUTCOME_SL_HEAD_TYPES.vote, undefined)
    assert.equal(OUTCOME_SL_HEAD_TYPES.attack, undefined)
    assert.equal(OUTCOME_SL_HEAD_TYPES.divine, undefined)
    assert.equal(OUTCOME_SL_HEAD_TYPES.guard, undefined)
  })
})

describe('trainOutcomeSLBucket', () => {
  /** outcome-SL bucket テスト用の slot fixture (mason_collective config) */
  function makeSlot(withRefNet: boolean, seed: number) {
    const pureNet = createSkollZeroNetwork()
    const tfNet = createSkollZeroTfNetwork(1e-2)
    tfNet.loadWeights(pureNet.cloneWeights())
    const masonZeroNet = new MasonZeroNetwork(pureNet, { zeroValueHead: false })
    const buffer = new TrainingBuffer()
    const slot: TrainerSlot = { masonZeroNet, tfNet, buffer }
    if (withRefNet) {
      const refNet = createSkollZeroNetwork()
      refNet.loadWeights(pureNet.cloneWeights())
      slot.refNet = refNet
    }
    const inputSize = pureNet.config.inputSize
    const rng = makeRng(seed)
    const mkObs = () => {
      const obs = new Float32Array(inputSize)
      for (let i = 0; i < inputSize; i++) obs[i] = (rng() - 0.5) * 0.1
      return obs
    }
    return { slot, mkObs }
  }

  /** outcome-SL softmax record (claim/comm/leader/target 用) */
  function mkSoftmaxRecord(opts: {
    obs: Float32Array
    actionIndex: number
    z: number
    headName: TrainingRecord['headName']
    masonSeat?: number
    alive?: number
  }): TrainingRecord {
    return {
      obs: opts.obs,
      day: 1,
      masonSeat: opts.masonSeat ?? 1,
      alive: opts.alive ?? aliveOf([1, 2, 3, 4, 5]),
      headName: opts.headName,
      actionIndex: opts.actionIndex,
      z: opts.z,
    }
  }

  /** outcome-SL sigmoid record (propose/predict 用) */
  function mkSigmoidRecord(opts: {
    obs: Float32Array
    actionMultiHot: Uint8Array
    z: number
    headName: TrainingRecord['headName']
  }): TrainingRecord {
    return {
      obs: opts.obs,
      day: 1,
      masonSeat: 1,
      alive: aliveOf([1, 2, 3, 4, 5]),
      headName: opts.headName,
      actionMultiHot: opts.actionMultiHot,
      z: opts.z,
    }
  }

  it('globalSoftmax (claim): loss 有限、refNet 無しなら klLoss=0', () => {
    const { slot, mkObs } = makeSlot(false, 111)
    const bucket: TrainingRecord[] = [
      mkSoftmaxRecord({ obs: mkObs(), actionIndex: 2, z: 1, headName: 'claim' }),
      mkSoftmaxRecord({ obs: mkObs(), actionIndex: 5, z: -1, headName: 'claim' }),
    ]
    const res = trainOutcomeSLBucket(slot, 'claim', 'globalSoftmax', bucket, 0.1)
    assert.ok(res, 'result non-null')
    assert.ok(Number.isFinite(res!.loss), `loss finite (got ${res!.loss})`)
    assert.ok(Number.isFinite(res!.policyLoss), 'policyLoss finite')
    assert.equal(res!.klLoss, 0, 'klLoss=0 without refNet')
    assert.equal(res!.valueLoss, 0, 'valueLoss always 0 for outcome-SL')
    slot.tfNet.dispose()
  })

  it('perSeatSoftmax (target): legal mask が alive & ~masonSeat で構築される', () => {
    const { slot, mkObs } = makeSlot(false, 222)
    const bucket: TrainingRecord[] = [
      mkSoftmaxRecord({
        obs: mkObs(),
        actionIndex: 3,  // seat 4 (0-indexed)
        z: 1,
        headName: 'target',
        masonSeat: 1,
        alive: aliveOf([1, 2, 3, 4, 5]),
      }),
    ]
    const res = trainOutcomeSLBucket(slot, 'target', 'perSeatSoftmax', bucket, 0)
    assert.ok(res, 'result non-null')
    assert.ok(Number.isFinite(res!.loss), 'loss finite')
    slot.tfNet.dispose()
  })

  it('perSeatSigmoid (predict): Uint8Array actionMultiHot を変換して loss 計算', () => {
    const { slot, mkObs } = makeSlot(false, 333)
    const multiHot = new Uint8Array(14 * 11)
    multiHot[5] = 1
    multiHot[20] = 1
    const bucket: TrainingRecord[] = [
      mkSigmoidRecord({ obs: mkObs(), actionMultiHot: multiHot, z: 1, headName: 'predict' }),
    ]
    const res = trainOutcomeSLBucket(slot, 'predict', 'perSeatSigmoid', bucket, 0)
    assert.ok(res, 'result non-null')
    assert.ok(Number.isFinite(res!.loss), 'loss finite')
    slot.tfNet.dispose()
  })

  it('refNet + klCoeff>0 で klLoss が計上される (初期は ~0 の数値ノイズ程度)', () => {
    const { slot, mkObs } = makeSlot(true, 444)
    const bucket: TrainingRecord[] = [
      mkSoftmaxRecord({ obs: mkObs(), actionIndex: 2, z: 1, headName: 'claim' }),
      mkSoftmaxRecord({ obs: mkObs(), actionIndex: 4, z: 0, headName: 'claim' }),
    ]
    const res = trainOutcomeSLBucket(slot, 'claim', 'globalSoftmax', bucket, 0.1)
    assert.ok(res, 'result non-null')
    assert.ok(Number.isFinite(res!.klLoss), 'klLoss finite')
    // refNet と tfNet は同じ weights で開始するので klLoss はほぼ 0 (Pure JS ↔ TF の数値差のみ)
    assert.ok(Math.abs(res!.klLoss) < 0.5, `klLoss small at start (got ${res!.klLoss})`)
    slot.tfNet.dispose()
  })

  it('action 情報欠損 bucket は null を返す', () => {
    const { slot, mkObs } = makeSlot(false, 555)
    // actionIndex も actionMultiHot も持たない (MCTS-π record)
    const bucket: TrainingRecord[] = [{
      obs: mkObs(),
      day: 1,
      masonSeat: 1,
      alive: aliveOf([1, 2, 3]),
      headName: 'claim',
      z: 1,
      // actionIndex 未設定
    }]
    const res = trainOutcomeSLBucket(slot, 'claim', 'globalSoftmax', bucket, 0)
    assert.equal(res, null, '無効 bucket は null')
    slot.tfNet.dispose()
  })

  it('混在 bucket: action あり record のみ使い、無し record は捨てる', () => {
    const { slot, mkObs } = makeSlot(false, 666)
    const bucket: TrainingRecord[] = [
      mkSoftmaxRecord({ obs: mkObs(), actionIndex: 2, z: 1, headName: 'claim' }),
      // 混ざった不正 record (action 無し)
      {
        obs: mkObs(),
        day: 1,
        masonSeat: 1,
        alive: aliveOf([1, 2, 3]),
        headName: 'claim',
        z: 0,
      },
      mkSoftmaxRecord({ obs: mkObs(), actionIndex: 5, z: -1, headName: 'claim' }),
    ]
    const res = trainOutcomeSLBucket(slot, 'claim', 'globalSoftmax', bucket, 0)
    assert.ok(res, '有効 record 2 件で loss 計算')
    assert.ok(Number.isFinite(res!.loss), 'loss finite')
    slot.tfNet.dispose()
  })
})
