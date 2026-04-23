import { test } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  METHOD_HEAD_MAP,
  aliveBitmaskToMask,
  loadJsonlSamples,
  configForRole,
  obsModeForRole,
  trainPhase2MultiHead,
} from './trainer.ts'
import { OBSERVATION_SIZE } from '../../fenrir/src/observation.ts'

test('METHOD_HEAD_MAP covers all collector-emitted methods', () => {
  const expectedMethods = [
    'claim', 'forecast', 'defensive_claim', 'comm', 'leader',
    'target', 'propose', 'bodyguard_targets', 'predict',
  ]
  for (const m of expectedMethods) {
    assert.ok(METHOD_HEAD_MAP[m], `method '${m}' missing from METHOD_HEAD_MAP`)
    const spec = METHOD_HEAD_MAP[m]
    assert.ok(['perSeatSoftmax', 'globalSoftmax', 'perSeatSigmoid'].includes(spec.headType))
    assert.ok(spec.outputSize > 0)
  }
})

test('aliveBitmaskToMask: alive seats get 0, dead get -1e9', () => {
  // Alive bitmask: seat 1, 2, 3 alive (bits 2, 4, 8) = 0b00001110 = 14
  const mask = aliveBitmaskToMask(0b00001110)
  assert.strictEqual(mask.length, 14)
  assert.strictEqual(mask[0], 0)
  assert.strictEqual(mask[1], 0)
  assert.strictEqual(mask[2], 0)
  for (let i = 3; i < 14; i++) {
    assert.strictEqual(mask[i], -1e9)
  }
})

test('aliveBitmaskToMask: all alive', () => {
  // All 14 seats alive: bits 1..14 = 0x7FFE = 32766
  const mask = aliveBitmaskToMask(0x7FFE)
  for (let i = 0; i < 14; i++) {
    assert.strictEqual(mask[i], 0)
  }
})

test('configForRole / obsModeForRole: per-role mapping', () => {
  assert.strictEqual(configForRole('werewolf').inputSize, 1212)
  assert.strictEqual(obsModeForRole('werewolf'), 'wolf_collective')

  assert.strictEqual(obsModeForRole('mason'), 'mason_collective')

  assert.strictEqual(obsModeForRole('villager'), 'individual')
  assert.strictEqual(obsModeForRole('seer'), 'individual')
  assert.strictEqual(obsModeForRole('fanatic'), 'individual')
})

test('loadJsonlSamples: softmax head builds one-hot label + mask', () => {
  const dir = join(tmpdir(), `phase2-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'sample.jsonl')
  try {
    // target head: per-seat softmax (14 dims)
    const obs = Array.from({ length: 100 }, (_, i) => i * 0.01)
    const line = JSON.stringify({
      role: 'villager', method: 'target',
      obs, actionIdx: 3,
      meta: { gameId: 0, day: 1, seat: 5, alive: 0b0111_1110 },  // seats 1-6 alive
    })
    writeFileSync(path, line + '\n')

    const spec = METHOD_HEAD_MAP.target
    const loaded = loadJsonlSamples(path, spec)
    assert.strictEqual(loaded.length, 1)
    assert.strictEqual(loaded[0].label.length, 14)
    assert.strictEqual(loaded[0].label[3], 1)
    let hotCount = 0
    for (const v of loaded[0].label) if (v > 0) hotCount++
    assert.strictEqual(hotCount, 1)

    assert.ok(loaded[0].mask, 'per-seat softmax should have mask')
    assert.strictEqual(loaded[0].mask![0], 0)
    assert.strictEqual(loaded[0].mask![5], 0)
    assert.strictEqual(loaded[0].mask![6], -1e9)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadJsonlSamples: global softmax head builds one-hot label without mask', () => {
  const dir = join(tmpdir(), `phase2-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'sample.jsonl')
  try {
    const obs = Array.from({ length: 100 }, () => 0)
    const line = JSON.stringify({
      role: 'villager', method: 'claim',
      obs, actionIdx: 7,
      meta: { gameId: 0, day: 1, seat: 5, alive: 0 },
    })
    writeFileSync(path, line + '\n')

    const spec = METHOD_HEAD_MAP.claim
    const loaded = loadJsonlSamples(path, spec)
    assert.strictEqual(loaded[0].label.length, 10)
    assert.strictEqual(loaded[0].label[7], 1)
    assert.strictEqual(loaded[0].mask, undefined, 'global softmax should not need mask')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadJsonlSamples: sigmoid head preserves multi-hot vector', () => {
  const dir = join(tmpdir(), `phase2-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'sample.jsonl')
  try {
    const obs = Array.from({ length: 100 }, () => 0)
    const actionVec = new Array(14).fill(0)
    actionVec[2] = 1
    actionVec[9] = 1
    const line = JSON.stringify({
      role: 'villager', method: 'propose',
      obs, actionVec,
      meta: { gameId: 0, day: 1, seat: 5, alive: 0 },
    })
    writeFileSync(path, line + '\n')

    const spec = METHOD_HEAD_MAP.propose
    const loaded = loadJsonlSamples(path, spec)
    assert.strictEqual(loaded[0].label.length, 14)
    assert.strictEqual(loaded[0].label[2], 1)
    assert.strictEqual(loaded[0].label[9], 1)
    assert.strictEqual(loaded[0].label[0], 0)
    assert.strictEqual(loaded[0].mask, undefined, 'sigmoid should not use mask')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ============================================================================
// Multi-head joint training
// ============================================================================

/** テスト用: villager (individual obs) で claim + propose の fake data を書き出す */
function writeFakeVillagerData(baseDir: string): void {
  mkdirSync(join(baseDir, 'villager'), { recursive: true })
  const obsZeros = new Array(OBSERVATION_SIZE).fill(0)

  // claim: globalSoftmax 10dim
  const claimLines: string[] = []
  for (let i = 0; i < 40; i++) {
    claimLines.push(JSON.stringify({
      role: 'villager', method: 'claim',
      obs: obsZeros, actionIdx: i % 2 === 0 ? 3 : 4,
      meta: { gameId: 0, day: 1, seat: 1, alive: 0x7FFE },
    }))
  }
  writeFileSync(join(baseDir, 'villager', 'claim.jsonl'), claimLines.join('\n'))

  // propose: perSeatSigmoid 14dim
  const proposeVec = new Array(14).fill(0)
  proposeVec[2] = 1
  proposeVec[5] = 1
  const proposeLines: string[] = []
  for (let i = 0; i < 40; i++) {
    proposeLines.push(JSON.stringify({
      role: 'villager', method: 'propose',
      obs: obsZeros, actionVec: proposeVec,
      meta: { gameId: 0, day: 1, seat: 1, alive: 0x7FFE },
    }))
  }
  writeFileSync(join(baseDir, 'villager', 'propose.jsonl'), proposeLines.join('\n'))
}

test('trainPhase2MultiHead: 2 method joint で両 head が学習され checkpoint が保存される', async () => {
  const dir = join(tmpdir(), `phase2-multi-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  const ckptPath = join(dir, 'villager.json')
  try {
    writeFakeVillagerData(dir)

    const result = await trainPhase2MultiHead({
      role: 'villager',
      dataDir: dir,
      outputCheckpointPath: ckptPath,
      batchSize: 16,
      epochs: 3,
      learningRate: 3e-4,
      evalRatio: 0.2,
      patience: 5,
      seed: 42,
    })

    assert.strictEqual(result.perMethod.size, 2, 'should have 2 methods in result')
    assert.ok(result.perMethod.has('claim'), 'claim method should be in result')
    assert.ok(result.perMethod.has('propose'), 'propose method should be in result')
    assert.ok(result.bestEpoch >= 1, `bestEpoch should be >= 1, got ${result.bestEpoch}`)
    assert.ok(Number.isFinite(result.bestTotalEvalLoss), 'bestTotalEvalLoss should be finite')
    assert.ok(existsSync(ckptPath), 'checkpoint should be written')

    const claimResult = result.perMethod.get('claim')!
    assert.ok(claimResult.trainSamples > 0, 'claim train samples > 0')
    assert.ok(claimResult.evalSamples > 0, 'claim eval samples > 0')

    const proposeResult = result.perMethod.get('propose')!
    assert.ok(proposeResult.trainSamples > 0, 'propose train samples > 0')
    assert.ok(proposeResult.evalSamples > 0, 'propose eval samples > 0')

    // epochHistory が epoch ごとの perMethod を持つ
    assert.ok(result.epochHistory.length >= 1)
    for (const e of result.epochHistory) {
      assert.ok(e.perMethod.has('claim'))
      assert.ok(e.perMethod.has('propose'))
      assert.ok(Number.isFinite(e.totalEvalLoss))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('trainPhase2MultiHead: skipMethods で指定した method は学習対象から除外される', async () => {
  const dir = join(tmpdir(), `phase2-multi-skip-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  try {
    writeFakeVillagerData(dir)

    const result = await trainPhase2MultiHead({
      role: 'villager',
      dataDir: dir,
      batchSize: 16,
      epochs: 2,
      learningRate: 3e-4,
      evalRatio: 0.2,
      patience: 5,
      seed: 42,
      skipMethods: ['propose'],
    })

    assert.strictEqual(result.perMethod.size, 1, 'should have only claim after skipping propose')
    assert.ok(result.perMethod.has('claim'))
    assert.ok(!result.perMethod.has('propose'), 'propose should be excluded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadJsonlSamples: sigmoid rejects mismatched vector length', () => {
  const dir = join(tmpdir(), `phase2-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'sample.jsonl')
  try {
    const obs = Array.from({ length: 100 }, () => 0)
    const actionVec = new Array(10).fill(0)  // wrong length for propose (expects 14)
    const line = JSON.stringify({
      role: 'villager', method: 'propose',
      obs, actionVec,
      meta: { gameId: 0, day: 1, seat: 5, alive: 0 },
    })
    writeFileSync(path, line + '\n')

    assert.throws(() => loadJsonlSamples(path, METHOD_HEAD_MAP.propose), /length/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
