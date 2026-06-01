/**
 * trainWolfImitation (TF graph) の unit test。
 *
 * 検証項目:
 * - KL(α‖0.5) bernoulli 公式 (pure JS) の解析的期待値: α=0.5→0、α≈0/1→大きい有限値、対称性
 * - trainWolfImitation('claim_decision') smoke: 1 step が finite で完走 (loss / policyLoss /
 *   valueLoss / alphaKlLoss が NaN/Inf でない、policyTargets Σ=1 が CE で機能する)
 * - trainWolfImitation('morning') smoke: 1 step が finite で完走
 * - alphaKlCoef=0 では alphaKlLoss が total loss に効かないこと (sanity)
 *
 * 注意: tfjs-node-gpu を import するため、テスト起動時に GPU/CPU の初期化コストが発生する。
 * テスト用に dModel/layers を縮小した config copy を使い、forward / backward の演算量を抑える。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore — tfjs-node-gpu は CJS だが ESM から import 可能
import * as tf from '@tensorflow/tfjs-node-gpu'
import { TfTransformerNetwork } from './nn-tf-transformer.ts'
import {
  WOLF_IMITATION_ZERO_NETWORK_CONFIG,
  STANDARD_ZERO_NETWORK_CONFIG,
  CLAIM_DECISION_HEAD_SIZE,
  MORNING_HEAD_SIZE,
  OUTCOME_DIST_SIZE,
} from '../../../skoll-zero/network/config.ts'
import type { NetworkConfig } from './nn.ts'

// ============================================================
// KL(α‖0.5) bernoulli 公式 (pure JS で TF graph と同じ式を再現して analytical 検証)
// ============================================================

/**
 * KL(α‖0.5) = α log(2α) + (1-α) log(2(1-α))
 *           = log 2 + α log α + (1-α) log(1-α)
 *
 * trainWolfImitation の TF graph 内で計算される式と同一。numeric 比較ベースライン。
 */
function klAlphaVsHalf(alpha: number): number {
  const eps = 1e-6
  const a = Math.min(Math.max(alpha, eps), 1 - eps)
  return a * Math.log(2 * a) + (1 - a) * Math.log(2 * (1 - a))
}

describe('KL(α‖0.5) bernoulli formula (TF graph と同一)', () => {
  it('α=0.5 で KL=0 (= reference 一致点)', () => {
    assert.ok(Math.abs(klAlphaVsHalf(0.5)) < 1e-10,
      `klAlphaVsHalf(0.5) = ${klAlphaVsHalf(0.5)}`)
  })

  it('α=0.01 で正の有限値 ≈ 0.637 (≈ ln 2 - H(α=0.01))', () => {
    const v = klAlphaVsHalf(0.01)
    assert.ok(Number.isFinite(v))
    assert.ok(v > 0)
    // 解析値: log 2 + 0.01*log 0.01 + 0.99*log 0.99 ≈ 0.6371
    assert.ok(Math.abs(v - 0.6371) < 0.01, `expected ≈0.6371, got ${v}`)
  })

  it('α=0.99 で α=0.01 と対称 (同値)', () => {
    const v1 = klAlphaVsHalf(0.99)
    const v2 = klAlphaVsHalf(0.01)
    assert.ok(Math.abs(v1 - v2) < 1e-9, `KL is symmetric around 0.5: ${v1} vs ${v2}`)
  })

  it('α が 0 / 1 に近づくと KL → log 2 ≈ 0.693 (上限)', () => {
    const v = klAlphaVsHalf(1e-6)
    // clipByValue の eps と一致するので解析的上限に張り付く
    assert.ok(Number.isFinite(v))
    assert.ok(v > 0.6 && v < 0.7, `near-extreme α: ${v}`)
  })

  it('α=0.5 が最小、両側に向かって単調増加', () => {
    assert.ok(klAlphaVsHalf(0.4) < klAlphaVsHalf(0.3))
    assert.ok(klAlphaVsHalf(0.3) < klAlphaVsHalf(0.2))
    assert.ok(klAlphaVsHalf(0.5) <= klAlphaVsHalf(0.4))
    assert.ok(klAlphaVsHalf(0.5) <= klAlphaVsHalf(0.6))
  })
})

// ============================================================
// trainWolfImitation TF graph smoke
// ============================================================

/** dModel/layers を縮小した config を作る (テスト高速化) */
function shrink(cfg: NetworkConfig): NetworkConfig {
  return {
    ...cfg,
    transformer: {
      ...cfg.transformer,
      dModel: 16,
      numHeads: 2,
      dFf: 32,
      seatLayers: 1,
      strategyLayers: 1,
    },
  }
}

/** [n, dim] の Float32Array 配列 (各要素は uniform [0, 1)) を生成 */
function randObs(n: number, dim: number): Float32Array[] {
  const out: Float32Array[] = []
  for (let i = 0; i < n; i++) {
    const a = new Float32Array(dim)
    for (let j = 0; j < dim; j++) a[j] = Math.random()
    out.push(a)
  }
  return out
}

/** uniform 確率分布 ([n, dim], 各 row Σ=1) を生成 */
function uniformPolicyTargets(n: number, dim: number): Float32Array[] {
  const out: Float32Array[] = []
  for (let i = 0; i < n; i++) {
    const a = new Float32Array(dim)
    a.fill(1 / dim)
    out.push(a)
  }
  return out
}

/** one-hot outcome target ([n, 4], 各 row 1 つだけ 1) */
function oneHotOutcome(n: number): Float32Array[] {
  const out: Float32Array[] = []
  for (let i = 0; i < n; i++) {
    const a = new Float32Array(OUTCOME_DIST_SIZE)
    a[i % OUTCOME_DIST_SIZE] = 1
    out.push(a)
  }
  return out
}

describe('trainWolfImitation: TF graph smoke', () => {
  let wolfNet: TfTransformerNetwork
  let villageNet: TfTransformerNetwork

  before(() => {
    // tfjs-node-gpu の wasm/CUDA 初期化はここで一度だけ。
    wolfNet = new TfTransformerNetwork(
      shrink(WOLF_IMITATION_ZERO_NETWORK_CONFIG), 1e-3, 'wolf_collective',
    )
    villageNet = new TfTransformerNetwork(
      shrink(STANDARD_ZERO_NETWORK_CONFIG), 1e-3, 'individual',
    )
  })

  after(() => {
    // optimizer state 等を解放
    wolfNet.dispose?.()
    villageNet.dispose?.()
  })

  it('claim_decision: 1 step が finite で完走 (alphaKlCoef=0.01)', () => {
    const n = 2
    const wolfInputSize = WOLF_IMITATION_ZERO_NETWORK_CONFIG.inputSize
    const villageInputSize = STANDARD_ZERO_NETWORK_CONFIG.inputSize

    const result = wolfNet.trainWolfImitation({
      observations: randObs(n, wolfInputSize),
      virtualViewerObsBundle: {
        seer: randObs(n, villageInputSize),
        medium: randObs(n, villageInputSize),
        bodyguard: randObs(n, villageInputSize),
        nekomata: randObs(n, villageInputSize),
      },
      policyTargets: uniformPolicyTargets(n, CLAIM_DECISION_HEAD_SIZE),
      outcomeTargets: oneHotOutcome(n),
      alphaKlCoef: 0.01,
      headName: 'claim_decision',
      frozenVillageNet: villageNet,
    })

    assert.ok(Number.isFinite(result.loss), `loss = ${result.loss}`)
    assert.ok(Number.isFinite(result.policyLoss), `policyLoss = ${result.policyLoss}`)
    assert.ok(Number.isFinite(result.valueLoss), `valueLoss = ${result.valueLoss}`)
    assert.ok(Number.isFinite(result.alphaKlLoss), `alphaKlLoss = ${result.alphaKlLoss}`)
    // KL は非負 (formula 上 0 が下限)
    assert.ok(result.alphaKlLoss >= -1e-5, `alphaKlLoss ≥ 0 expected, got ${result.alphaKlLoss}`)
    // policyLoss は CE なので非負
    assert.ok(result.policyLoss >= -1e-5, `policyLoss ≥ 0 expected, got ${result.policyLoss}`)
  })

  it('morning: 1 step が finite で完走 (alphaKlCoef=0.01)', () => {
    const n = 2
    const wolfInputSize = WOLF_IMITATION_ZERO_NETWORK_CONFIG.inputSize
    const villageInputSize = STANDARD_ZERO_NETWORK_CONFIG.inputSize

    const result = wolfNet.trainWolfImitation({
      observations: randObs(n, wolfInputSize),
      virtualViewerObs: randObs(n, villageInputSize),
      policyTargets: uniformPolicyTargets(n, MORNING_HEAD_SIZE),
      outcomeTargets: oneHotOutcome(n),
      alphaKlCoef: 0.01,
      headName: 'morning',
      frozenVillageNet: villageNet,
    })

    assert.ok(Number.isFinite(result.loss))
    assert.ok(Number.isFinite(result.policyLoss))
    assert.ok(Number.isFinite(result.valueLoss))
    assert.ok(Number.isFinite(result.alphaKlLoss))
    assert.ok(result.alphaKlLoss >= -1e-5)
  })

  it('alphaKlCoef=0 では alphaKlLoss は total loss に効かない (= alphaKlLoss=0)', () => {
    const n = 2
    const wolfInputSize = WOLF_IMITATION_ZERO_NETWORK_CONFIG.inputSize
    const villageInputSize = STANDARD_ZERO_NETWORK_CONFIG.inputSize

    const result = wolfNet.trainWolfImitation({
      observations: randObs(n, wolfInputSize),
      virtualViewerObsBundle: {
        seer: randObs(n, villageInputSize),
        medium: randObs(n, villageInputSize),
        bodyguard: randObs(n, villageInputSize),
        nekomata: randObs(n, villageInputSize),
      },
      policyTargets: uniformPolicyTargets(n, CLAIM_DECISION_HEAD_SIZE),
      outcomeTargets: oneHotOutcome(n),
      alphaKlCoef: 0,
      headName: 'claim_decision',
      frozenVillageNet: villageNet,
    })

    // alphaKlCoef=0 の経路では alphaKlLoss を tf.scalar(0) として返す (実装上の短絡)
    assert.equal(result.alphaKlLoss, 0)
    assert.ok(Number.isFinite(result.loss))
  })

  it('n=0 (empty batch) で短絡 (loss=0、TF graph に入らない)', () => {
    const result = wolfNet.trainWolfImitation({
      observations: [],
      virtualViewerObsBundle: {
        seer: [], medium: [], bodyguard: [], nekomata: [],
      },
      policyTargets: [],
      outcomeTargets: [],
      headName: 'claim_decision',
      frozenVillageNet: villageNet,
    })
    assert.equal(result.loss, 0)
    assert.equal(result.policyLoss, 0)
    assert.equal(result.valueLoss, 0)
    assert.equal(result.alphaKlLoss, 0)
  })
})
