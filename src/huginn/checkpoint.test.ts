/**
 * checkpoint.ts のテスト:
 *   - round-trip (save → load → forward 同値性)
 *   - 全重みが出力されているか (命名網羅性)
 *   - shape mismatch エラー
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TrainableNetwork } from './trainable-network.ts'
import {
  exportWeights, importWeights, saveCheckpoint, loadCheckpoint,
  CHECKPOINT_VERSION, type HuginnCheckpoint,
} from './checkpoint.ts'
import { buildVocabLayout } from './message-vocab.ts'
import { MAX_AGENTS, OFFER_REF_WINDOW } from './types.ts'
import { CLS_FEATURE_DIMS, AGENT_FEATURE_DIMS } from './observation.ts'

function buildTestNetwork(): TrainableNetwork {
  const layout = buildVocabLayout(MAX_AGENTS, OFFER_REF_WINDOW)
  return new TrainableNetwork({
    dModel: 16,
    numLayers: 2,
    numHeads: 2,
    dFf: 32,
    vocabSize: layout.vocabSize,
  })
}

function randomInput(): {
  cls: Float32Array
  agents: Float32Array
  numAgents: number
} {
  const cls = new Float32Array(CLS_FEATURE_DIMS)
  for (let i = 0; i < cls.length; i++) cls[i] = Math.random() - 0.5
  const agents = new Float32Array(MAX_AGENTS * AGENT_FEATURE_DIMS)
  for (let i = 0; i < agents.length; i++) agents[i] = Math.random() - 0.5
  return { cls, agents, numAgents: 14 }
}

describe('huginn checkpoint', () => {
  it('exportWeights covers every parameter of TrainableNetwork', () => {
    const network = buildTestNetwork()
    const weights = exportWeights(network)

    // 期待される key を列挙
    const expected = new Set<string>()
    const addLinear = (prefix: string) => {
      expected.add(`${prefix}.W`)
      expected.add(`${prefix}.b`)
    }
    const addLayerNorm = (prefix: string) => {
      expected.add(`${prefix}.scale`)
      expected.add(`${prefix}.bias`)
    }
    addLinear('proj_cls')
    addLinear('proj_agent')
    for (let l = 0; l < network.encoder.blocks.length; l++) {
      addLayerNorm(`enc.block${l}.ln1`)
      addLinear(`enc.block${l}.attn.wq`)
      addLinear(`enc.block${l}.attn.wk`)
      addLinear(`enc.block${l}.attn.wv`)
      addLinear(`enc.block${l}.attn.wo`)
      addLayerNorm(`enc.block${l}.ln2`)
      addLinear(`enc.block${l}.ffn.fc1`)
      addLinear(`enc.block${l}.ffn.fc2`)
    }
    addLayerNorm('enc.finalLN')
    addLinear('head_message')
    addLinear('head_vote')
    addLinear('head_value')

    const actual = new Set(Object.keys(weights))
    assert.deepStrictEqual(actual, expected, 'weights key set mismatch')
  })

  it('export → import preserves forward output bit-for-bit', () => {
    const src = buildTestNetwork()
    const dst = buildTestNetwork()  // 別 init の network

    const input = randomInput()
    const before = src.forward(input.cls, input.agents, input.numAgents)

    const weights = exportWeights(src)
    importWeights(dst, weights)

    const afterDst = dst.forward(input.cls, input.agents, input.numAgents)

    // msgLogits / voteLogits / value が完全一致すること
    assert.deepStrictEqual(
      Array.from(afterDst.msgLogits), Array.from(before.msgLogits),
      'msgLogits differ after round-trip',
    )
    assert.deepStrictEqual(
      Array.from(afterDst.voteLogits), Array.from(before.voteLogits),
      'voteLogits differ after round-trip',
    )
    assert.strictEqual(afterDst.value, before.value, 'value differs after round-trip')
  })

  it('saveCheckpoint / loadCheckpoint round-trip via file', () => {
    const src = buildTestNetwork()
    const input = randomInput()
    const before = src.forward(input.cls, input.agents, input.numAgents)

    const dir = mkdtempSync(join(tmpdir(), 'huginn-ckpt-'))
    const path = join(dir, 'nested', 'test.json')
    try {
      saveCheckpoint(src, path)
      assert.ok(existsSync(path), 'checkpoint file not written')

      const content = JSON.parse(readFileSync(path, 'utf-8')) as HuginnCheckpoint
      assert.strictEqual(content.version, CHECKPOINT_VERSION)
      assert.strictEqual(content.config.dModel, src.config.dModel)
      assert.strictEqual(content.config.vocabSize, src.config.vocabSize)

      const { network: loaded } = loadCheckpoint(path)
      const after = loaded.forward(input.cls, input.agents, input.numAgents)
      assert.deepStrictEqual(
        Array.from(after.msgLogits), Array.from(before.msgLogits),
      )
      assert.deepStrictEqual(
        Array.from(after.voteLogits), Array.from(before.voteLogits),
      )
      assert.strictEqual(after.value, before.value)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loadCheckpoint throws on version mismatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'huginn-ckpt-'))
    const path = join(dir, 'bad-version.json')
    try {
      const bad: HuginnCheckpoint = {
        version: 999,
        config: { dModel: 16, numLayers: 1, numHeads: 1, dFf: 32, vocabSize: 10 },
        weights: {},
      }
      writeSync(path, JSON.stringify(bad))
      assert.throws(() => loadCheckpoint(path), /unsupported version/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('importWeights throws when a key is missing', () => {
    const network = buildTestNetwork()
    const weights = exportWeights(network)
    delete weights['proj_cls.W']
    assert.throws(
      () => importWeights(network, weights),
      /missing key proj_cls\.W/,
    )
  })

  it('importWeights throws when a shape mismatches', () => {
    const network = buildTestNetwork()
    const weights = exportWeights(network)
    // head_message.W を半分に切り詰める
    const truncated = new Float32Array(Math.floor(network.headMessage.weights.length / 2))
    weights['head_message.W'] = Buffer.from(
      new Uint8Array(truncated.buffer, truncated.byteOffset, truncated.byteLength),
    ).toString('base64')
    assert.throws(
      () => importWeights(network, weights),
      /head_message.*length mismatch/,
    )
  })
})

// mkdtemp は sync だが writeFileSync は './checkpoint.ts' で使っている writeFileSync と別途
// 必要になる. テスト内部で checkpoint の破損ファイルを手動で書くための helper.
import { writeFileSync as writeSync } from 'node:fs'
