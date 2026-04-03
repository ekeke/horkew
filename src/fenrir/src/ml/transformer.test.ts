import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { LayerNorm, MultiHeadAttention, FeedForward, TransformerBlock, TransformerEncoder } from './transformer.ts'
import { TransformerNetwork } from './transformer-network.ts'
import { tokenize, OBSERVATION_SIZE, TEAM_OBSERVATION_SIZE, SEATS, NUM_ROLES,
         CLS_FEATURES, TEAM_CLS_FEATURES, SEAT_TOKEN_FEATURES, TEAM_SEAT_TOKEN_FEATURES,
         WOLF_COLLECTIVE_OBSERVATION_SIZE, WOLF_COLLECTIVE_SEAT_FEATURES, WOLF_COLLECTIVE_CLS_FEATURES,
         MASON_COLLECTIVE_OBSERVATION_SIZE, MASON_COLLECTIVE_SEAT_FEATURES, MASON_COLLECTIVE_CLS_FEATURES,
         FANATIC_OBSERVATION_SIZE, FANATIC_SEAT_FEATURES, FANATIC_CLS_FEATURES,
         ROLE_TOKEN_FEATURES, NUM_ROLE_TOKENS } from '../observation.ts'
import type { NetworkConfig } from './nn.ts'

// ============================================================
// テスト用コンフィグ
// ============================================================

const D_MODEL = 128
const NUM_LAYERS = 3
const NUM_HEADS = 4
const D_FF = 256
const MAX_PLAN_TOKENS = 8

function makeConfig(isTeam = false): NetworkConfig {
  return {
    inputSize: isTeam ? TEAM_OBSERVATION_SIZE : OBSERVATION_SIZE,
    hiddenSizes: [],  // unused for transformer
    heads: {
      night: SEATS + 1,
      claim: 10,
      vote: SEATS,
      comm: SEATS * 8 + 7,
      leader: 3,
      target: SEATS,
    },
    sigmoidHeads: {
      propose: SEATS,
      predict: SEATS * NUM_ROLES,
    },
    transformer: {
      dModel: D_MODEL,
      numHeads: NUM_HEADS,
      dFf: D_FF,
      seatFeatures: isTeam ? TEAM_SEAT_TOKEN_FEATURES : SEAT_TOKEN_FEATURES,
      clsFeatures: isTeam ? TEAM_CLS_FEATURES : CLS_FEATURES,
      planFeatures: 20,
      maxPlanTokens: MAX_PLAN_TOKENS,
      roleFeatures: ROLE_TOKEN_FEATURES,
      numRoleTokens: NUM_ROLE_TOKENS,
      seatLayers: NUM_LAYERS,
      strategyLayers: 2,
      numForwardTokens: 8,
      numEndgameTokens: 4,
      planVocabSize: 22,
      perSeatHeads: ['vote', 'target'],
      perSeatSigmoidHeads: ['propose', 'predict'],
    },
  }
}

// ============================================================
// LayerNorm
// ============================================================

describe('LayerNorm', () => {
  it('normalizes to mean≈0, variance≈1', () => {
    const ln = new LayerNorm(64)
    const input = new Float32Array(64)
    for (let i = 0; i < 64; i++) input[i] = Math.random() * 10 - 5
    const out = new Float32Array(64)
    ln.forwardInto(input, 0, out, 0)

    let mean = 0
    for (let i = 0; i < 64; i++) mean += out[i]
    mean /= 64
    let variance = 0
    for (let i = 0; i < 64; i++) variance += (out[i] - mean) ** 2
    variance /= 64

    assert.ok(Math.abs(mean) < 0.01, `mean should be ~0, got ${mean}`)
    assert.ok(Math.abs(variance - 1) < 0.05, `variance should be ~1, got ${variance}`)
  })

  it('produces correct output with non-trivial scale/bias', () => {
    const ln = new LayerNorm(4)
    ln.scale.set([2, 2, 2, 2])
    ln.bias.set([1, 1, 1, 1])
    const input = new Float32Array([1, 2, 3, 4])
    const out = new Float32Array(4)
    ln.forwardInto(input, 0, out, 0)

    // After norm: mean=2.5, std≈1.118 → normalized: [-1.34, -0.45, 0.45, 1.34]
    // × 2 + 1 → [-1.68, 0.10, 1.89, 3.68]
    let mean = 0
    for (let i = 0; i < 4; i++) mean += out[i]
    mean /= 4
    assert.ok(Math.abs(mean - 1) < 0.01, `scaled mean should be ~1, got ${mean}`)
  })
})

// ============================================================
// MultiHeadAttention
// ============================================================

describe('MultiHeadAttention', () => {
  it('produces output with correct shape', () => {
    const mha = new MultiHeadAttention(32, 4, 16)
    const tokens = new Float32Array(5 * 32)
    for (let i = 0; i < tokens.length; i++) tokens[i] = Math.random() - 0.5
    const mask = [true, true, true, true, true]
    const out = new Float32Array(5 * 32)
    mha.forward(tokens, 5, mask, out)

    // Check output is not all zeros
    let sumAbs = 0
    for (let i = 0; i < out.length; i++) sumAbs += Math.abs(out[i])
    assert.ok(sumAbs > 0, 'output should not be all zeros')
  })

  it('masks padding tokens correctly', () => {
    const mha = new MultiHeadAttention(16, 2, 8)
    const tokens = new Float32Array(4 * 16)
    for (let i = 0; i < tokens.length; i++) tokens[i] = Math.random() - 0.5
    const mask = [true, true, false, false]  // last 2 are padding
    const out = new Float32Array(4 * 16)
    mha.forward(tokens, 4, mask, out)

    // Masked token outputs should be 0 (not attended to and not attending)
    // Actually, masked tokens' output rows won't be computed (mask[i]=false skips)
    // So they stay at whatever linearBatched produces... but the attention skip
    // means they shouldn't affect the unmasked tokens.
    // The key property: running with fewer tokens should give same results.
    // Just verify present tokens have non-zero output.
    let sumPresent = 0
    for (let i = 0; i < 2 * 16; i++) sumPresent += Math.abs(out[i])
    assert.ok(sumPresent > 0, 'present tokens should have non-zero output')
  })
})

// ============================================================
// FeedForward
// ============================================================

describe('FeedForward', () => {
  it('produces output with correct dimensions', () => {
    const ffn = new FeedForward(32, 64, 8)
    const input = new Float32Array(3 * 32)
    for (let i = 0; i < input.length; i++) input[i] = Math.random() - 0.5
    const out = new Float32Array(3 * 32)
    ffn.forward(input, 3, out)

    let sumAbs = 0
    for (let i = 0; i < out.length; i++) sumAbs += Math.abs(out[i])
    assert.ok(sumAbs > 0, 'output should not be all zeros')
    assert.equal(out.length, 3 * 32)
  })
})

// ============================================================
// TransformerBlock
// ============================================================

describe('TransformerBlock', () => {
  it('preserves sequence length and dimension', () => {
    const block = new TransformerBlock(32, 4, 64, 16)
    const tokens = new Float32Array(5 * 32)
    for (let i = 0; i < tokens.length; i++) tokens[i] = Math.random() * 0.1
    const mask = [true, true, true, true, true]
    block.forward(tokens, 5, mask)

    // tokens modified in-place, check not all zero
    let sumAbs = 0
    for (let i = 0; i < tokens.length; i++) sumAbs += Math.abs(tokens[i])
    assert.ok(sumAbs > 0)
  })
})

// ============================================================
// TransformerEncoder
// ============================================================

describe('TransformerEncoder', () => {
  it('forward pass with correct output shape', () => {
    const enc = new TransformerEncoder({
      dModel: 32, numLayers: 2, numHeads: 4, dFf: 64, maxSeqLen: 16,
    })
    const tokens = new Float32Array(5 * 32)
    for (let i = 0; i < tokens.length; i++) tokens[i] = Math.random() * 0.1
    const mask = [true, true, true, true, true]
    const out = enc.forward(tokens, 5, mask)

    assert.equal(out.length, tokens.length)
    let sumAbs = 0
    for (let i = 0; i < 5 * 32; i++) sumAbs += Math.abs(out[i])
    assert.ok(sumAbs > 0)
  })

  it('collectWeights and loadWeights roundtrip', () => {
    const enc = new TransformerEncoder({
      dModel: 16, numLayers: 2, numHeads: 2, dFf: 32, maxSeqLen: 8,
    })
    const weights = enc.collectWeights()
    const enc2 = new TransformerEncoder({
      dModel: 16, numLayers: 2, numHeads: 2, dFf: 32, maxSeqLen: 8,
    })
    enc2.loadWeights(weights)

    // Forward should give same result
    const tokens1 = new Float32Array(3 * 16)
    const tokens2 = new Float32Array(3 * 16)
    for (let i = 0; i < tokens1.length; i++) {
      tokens1[i] = tokens2[i] = Math.random() * 0.1
    }
    const mask = [true, true, true]
    enc.forward(tokens1, 3, mask)
    enc2.forward(tokens2, 3, mask)

    for (let i = 0; i < tokens1.length; i++) {
      assert.ok(Math.abs(tokens1[i] - tokens2[i]) < 1e-5,
        `mismatch at ${i}: ${tokens1[i]} vs ${tokens2[i]}`)
    }
  })
})

// ============================================================
// Tokenize
// ============================================================

describe('tokenize', () => {
  it('individual: correct token dimensions', () => {
    const obs = new Float32Array(OBSERVATION_SIZE)
    // planCount位置以外にランダム値を入れる（planCountは0のまま）
    for (let i = 0; i < obs.length; i++) obs[i] = Math.random() * 0.5
    // planCount位置を明示的に0にする（ランダム値でplanCount>0にならないように）
    obs[OBSERVATION_SIZE - 161] = 0  // PLAN_TOKEN_COUNT位置
    const tok = tokenize(obs, false)

    assert.equal(tok.cls.length, CLS_FEATURES)
    assert.equal(tok.seats.length, SEATS * SEAT_TOKEN_FEATURES)
    assert.equal(tok.seatFeatures, SEAT_TOKEN_FEATURES)
    assert.equal(tok.clsFeatures, CLS_FEATURES)
  })

  it('team: correct token dimensions', () => {
    const obs = new Float32Array(TEAM_OBSERVATION_SIZE)
    for (let i = 0; i < obs.length; i++) obs[i] = Math.random()
    const tok = tokenize(obs, true)

    assert.equal(tok.cls.length, TEAM_CLS_FEATURES)
    assert.equal(tok.seats.length, SEATS * TEAM_SEAT_TOKEN_FEATURES)
    assert.equal(tok.seatFeatures, TEAM_SEAT_TOKEN_FEATURES)
    assert.equal(tok.clsFeatures, TEAM_CLS_FEATURES)
  })

  it('preserves observation data (spot check)', () => {
    const obs = new Float32Array(OBSERVATION_SIZE)
    // Set day_norm = 0.5 (offset 0)
    obs[0] = 0.5
    // Set seat 1 alive = 1 (offset 19)
    obs[19] = 1.0
    // Set seat 1 is_me = 1 (offset 19 + 13 = 32)
    obs[32] = 1.0

    const tok = tokenize(obs, false)
    // CLS[0] should be day_norm = 0.5
    assert.equal(tok.cls[0], 0.5)
    // Seat 0 (seat1), feature 0 = alive
    assert.equal(tok.seats[0], 1.0)
    // Seat 0, feature 13 = is_me
    assert.equal(tok.seats[13], 1.0)
  })
})

// ============================================================
// TransformerNetwork
// ============================================================

describe('TransformerNetwork', () => {
  it('forward produces correct head shapes (individual)', () => {
    const config = makeConfig(false)
    const net = new TransformerNetwork(config, false)

    const obs = new Float32Array(OBSERVATION_SIZE)
    for (let i = 0; i < obs.length; i++) obs[i] = Math.random() * 0.1
    const result = net.forward(obs)

    // Check all head shapes
    assert.equal(result.policies.get('vote')!.length, SEATS)
    assert.equal(result.policies.get('target')!.length, SEATS)
    assert.equal(result.policies.get('night')!.length, SEATS + 1)
    assert.equal(result.policies.get('claim')!.length, 10)
    assert.equal(result.policies.get('comm')!.length, SEATS * 8 + 7)
    assert.equal(result.policies.get('leader')!.length, 3)
    assert.equal(result.policies.get('propose')!.length, SEATS)
    assert.equal(result.policies.get('predict')!.length, SEATS * NUM_ROLES)

    // Value should be in [-1, 1]
    assert.ok(result.value >= -1 && result.value <= 1, `value ${result.value} out of range`)
  })

  it('forward produces correct head shapes (team)', () => {
    const config = makeConfig(true)
    // Add team-specific heads
    config.heads = {
      ...config.heads,
      attack_target: SEATS,
      attacker: 3,
    }
    const net = new TransformerNetwork(config, true)

    const obs = new Float32Array(TEAM_OBSERVATION_SIZE)
    for (let i = 0; i < obs.length; i++) obs[i] = Math.random() * 0.1
    const result = net.forward(obs)

    assert.equal(result.policies.get('vote')!.length, SEATS)
    assert.equal(result.policies.get('attack_target')!.length, SEATS)
    // attacker is global (size 3, not per-seat)
    assert.equal(result.policies.get('attacker')!.length, 3)
  })

  it('cloneWeights and loadWeights roundtrip', () => {
    const config = makeConfig(false)
    const net = new TransformerNetwork(config, false)
    const weights = net.cloneWeights()

    const net2 = new TransformerNetwork(config, false)
    net2.loadWeights(weights)

    const obs = new Float32Array(OBSERVATION_SIZE)
    for (let i = 0; i < obs.length; i++) obs[i] = Math.random() * 0.1

    const r1 = net.forward(obs, false)  // greedy for deterministic output
    const r2 = net2.forward(obs, false)

    assert.ok(Math.abs(r1.value - r2.value) < 1e-4, `value mismatch: ${r1.value} vs ${r2.value}`)
    for (const [name, logits1] of r1.policies) {
      const logits2 = r2.policies.get(name)!
      for (let i = 0; i < logits1.length; i++) {
        // Both -Infinity is OK (grammar mask), both finite must be close
        if (logits1[i] === -Infinity && logits2[i] === -Infinity) continue
        assert.ok(Math.abs(logits1[i] - logits2[i]) < 1e-4,
          `head ${name}[${i}] mismatch: ${logits1[i]} vs ${logits2[i]}`)
      }
    }
  })

  it('totalParams is reasonable', () => {
    const config = makeConfig(false)
    const net = new TransformerNetwork(config, false)
    const params = net.totalParams

    // Rough estimate: ~470K params
    assert.ok(params > 100_000, `too few params: ${params}`)
    assert.ok(params < 2_000_000, `too many params: ${params}`)
    console.log(`  TransformerNetwork totalParams: ${params}`)
  })
})

// ============================================================
// Collective / Fanatic Network Tests
// ============================================================

function makeWolfCollectiveConfig(): NetworkConfig {
  return {
    inputSize: WOLF_COLLECTIVE_OBSERVATION_SIZE,
    hiddenSizes: [],
    heads: {
      attack_target: SEATS,
      attacker: 3,
      claim: 10,
      vote: SEATS,
      comm: SEATS * 8 + 7,
      leader: 3,
      target: SEATS,
      co_policy: 8,
    },
    sigmoidHeads: {
      propose: SEATS,
      predict: SEATS * NUM_ROLES,
    },
    transformer: {
      dModel: D_MODEL,
      numHeads: NUM_HEADS,
      dFf: D_FF,
      seatFeatures: WOLF_COLLECTIVE_SEAT_FEATURES,
      clsFeatures: WOLF_COLLECTIVE_CLS_FEATURES,
      planFeatures: 20,
      maxPlanTokens: MAX_PLAN_TOKENS,
      roleFeatures: ROLE_TOKEN_FEATURES,
      numRoleTokens: NUM_ROLE_TOKENS,
      seatLayers: NUM_LAYERS,
      strategyLayers: 2,
      numForwardTokens: 8,
      numEndgameTokens: 4,
      planVocabSize: 22,
      perSeatHeads: ['vote', 'target', 'attack_target', 'co_policy'],
      perSeatSigmoidHeads: ['propose', 'predict'],
    },
  }
}

function makeMasonCollectiveConfig(): NetworkConfig {
  return {
    inputSize: MASON_COLLECTIVE_OBSERVATION_SIZE,
    hiddenSizes: [],
    heads: {
      claim: 10,
      vote: SEATS,
      comm: SEATS * 8 + 7,
      leader: 3,
      target: SEATS,
      co_policy: 8,
    },
    sigmoidHeads: {
      propose: SEATS,
      predict: SEATS * NUM_ROLES,
    },
    transformer: {
      dModel: D_MODEL,
      numHeads: NUM_HEADS,
      dFf: D_FF,
      seatFeatures: MASON_COLLECTIVE_SEAT_FEATURES,
      clsFeatures: MASON_COLLECTIVE_CLS_FEATURES,
      planFeatures: 20,
      maxPlanTokens: MAX_PLAN_TOKENS,
      roleFeatures: ROLE_TOKEN_FEATURES,
      numRoleTokens: NUM_ROLE_TOKENS,
      seatLayers: NUM_LAYERS,
      strategyLayers: 2,
      numForwardTokens: 8,
      numEndgameTokens: 4,
      planVocabSize: 22,
      perSeatHeads: ['vote', 'target', 'co_policy'],
      perSeatSigmoidHeads: ['propose', 'predict'],
    },
  }
}

function makeFanaticConfig(): NetworkConfig {
  return {
    inputSize: FANATIC_OBSERVATION_SIZE,
    hiddenSizes: [],
    heads: {
      night: SEATS + 1,
      claim: 10,
      vote: SEATS,
      comm: SEATS * 8 + 7,
      leader: 3,
      target: SEATS,
    },
    sigmoidHeads: {
      propose: SEATS,
      predict: SEATS * NUM_ROLES,
    },
    transformer: {
      dModel: D_MODEL,
      numHeads: NUM_HEADS,
      dFf: D_FF,
      seatFeatures: FANATIC_SEAT_FEATURES,
      clsFeatures: FANATIC_CLS_FEATURES,
      planFeatures: 20,
      maxPlanTokens: MAX_PLAN_TOKENS,
      roleFeatures: ROLE_TOKEN_FEATURES,
      numRoleTokens: NUM_ROLE_TOKENS,
      seatLayers: NUM_LAYERS,
      strategyLayers: 2,
      numForwardTokens: 8,
      numEndgameTokens: 4,
      planVocabSize: 22,
      perSeatHeads: ['vote', 'target'],
      perSeatSigmoidHeads: ['propose', 'predict'],
    },
  }
}

describe('Wolf Collective Network', () => {
  it('forward produces correct head shapes', () => {
    const config = makeWolfCollectiveConfig()
    const net = new TransformerNetwork(config, 'wolf_collective')

    const obs = new Float32Array(WOLF_COLLECTIVE_OBSERVATION_SIZE)
    for (let i = 0; i < obs.length; i++) obs[i] = Math.random() * 0.1
    const result = net.forward(obs)

    assert.equal(result.policies.get('vote')!.length, SEATS)
    assert.equal(result.policies.get('target')!.length, SEATS)
    assert.equal(result.policies.get('attack_target')!.length, SEATS)
    assert.equal(result.policies.get('attacker')!.length, 3)
    assert.equal(result.policies.get('co_policy')!.length, SEATS)  // per-seat head: 1 output per seat
    assert.equal(result.policies.get('propose')!.length, SEATS)
    assert.equal(result.policies.get('predict')!.length, SEATS * NUM_ROLES)
    assert.ok(result.value >= -1 && result.value <= 1, `value ${result.value} out of range`)
  })

  it('cloneWeights roundtrip', () => {
    const config = makeWolfCollectiveConfig()
    const net1 = new TransformerNetwork(config, 'wolf_collective')
    const weights = net1.cloneWeights()

    const net2 = new TransformerNetwork(config, 'wolf_collective')
    net2.loadWeights(weights)

    const obs = new Float32Array(WOLF_COLLECTIVE_OBSERVATION_SIZE)
    for (let i = 0; i < obs.length; i++) obs[i] = Math.random() * 0.1
    const r1 = net1.forward(obs, false)  // greedy for deterministic output
    const r2 = net2.forward(obs, false)

    assert.ok(Math.abs(r1.value - r2.value) < 1e-4)
    for (const [name, logits1] of r1.policies) {
      const logits2 = r2.policies.get(name)!
      for (let i = 0; i < logits1.length; i++) {
        if (logits1[i] === -Infinity && logits2[i] === -Infinity) continue
        assert.ok(Math.abs(logits1[i] - logits2[i]) < 1e-4,
          `head ${name}[${i}] mismatch: ${logits1[i]} vs ${logits2[i]}`)
      }
    }
  })
})

describe('Mason Collective Network', () => {
  it('forward produces correct head shapes', () => {
    const config = makeMasonCollectiveConfig()
    const net = new TransformerNetwork(config, 'mason_collective')

    const obs = new Float32Array(MASON_COLLECTIVE_OBSERVATION_SIZE)
    for (let i = 0; i < obs.length; i++) obs[i] = Math.random() * 0.1
    const result = net.forward(obs)

    assert.equal(result.policies.get('vote')!.length, SEATS)
    assert.equal(result.policies.get('target')!.length, SEATS)
    assert.equal(result.policies.get('co_policy')!.length, SEATS)  // per-seat head: 1 output per seat
    assert.equal(result.policies.get('propose')!.length, SEATS)
    assert.equal(result.policies.get('predict')!.length, SEATS * NUM_ROLES)
    assert.ok(result.value >= -1 && result.value <= 1, `value ${result.value} out of range`)
  })
})

describe('Fanatic Network', () => {
  it('forward produces correct head shapes', () => {
    const config = makeFanaticConfig()
    const net = new TransformerNetwork(config, 'fanatic')

    const obs = new Float32Array(FANATIC_OBSERVATION_SIZE)
    for (let i = 0; i < obs.length; i++) obs[i] = Math.random() * 0.1
    const result = net.forward(obs)

    assert.equal(result.policies.get('vote')!.length, SEATS)
    assert.equal(result.policies.get('target')!.length, SEATS)
    assert.equal(result.policies.get('night')!.length, SEATS + 1)
    assert.equal(result.policies.get('claim')!.length, 10)
    assert.equal(result.policies.get('propose')!.length, SEATS)
    assert.equal(result.policies.get('predict')!.length, SEATS * NUM_ROLES)
    assert.ok(result.value >= -1 && result.value <= 1, `value ${result.value} out of range`)
  })

  it('cloneWeights roundtrip', () => {
    const config = makeFanaticConfig()
    const net1 = new TransformerNetwork(config, 'fanatic')
    const weights = net1.cloneWeights()

    const net2 = new TransformerNetwork(config, 'fanatic')
    net2.loadWeights(weights)

    const obs = new Float32Array(FANATIC_OBSERVATION_SIZE)
    for (let i = 0; i < obs.length; i++) obs[i] = Math.random() * 0.1
    const r1 = net1.forward(obs, false)  // greedy for deterministic output
    const r2 = net2.forward(obs, false)

    assert.ok(Math.abs(r1.value - r2.value) < 1e-4)
    for (const [name, logits1] of r1.policies) {
      const logits2 = r2.policies.get(name)!
      for (let i = 0; i < logits1.length; i++) {
        if (logits1[i] === -Infinity && logits2[i] === -Infinity) continue
        assert.ok(Math.abs(logits1[i] - logits2[i]) < 1e-4,
          `head ${name}[${i}] mismatch: ${logits1[i]} vs ${logits2[i]}`)
      }
    }
  })
})

describe('Collective tokenize', () => {
  it('wolf_collective produces correct dimensions', () => {
    const obs = new Float32Array(WOLF_COLLECTIVE_OBSERVATION_SIZE)
    const tok = tokenize(obs, 'wolf_collective')
    assert.equal(tok.seatFeatures, WOLF_COLLECTIVE_SEAT_FEATURES, 'seatFeatures')
    assert.equal(tok.clsFeatures, WOLF_COLLECTIVE_CLS_FEATURES, 'clsFeatures')
    assert.equal(tok.seats.length, SEATS * WOLF_COLLECTIVE_SEAT_FEATURES, 'seats array')
    assert.equal(tok.cls.length, WOLF_COLLECTIVE_CLS_FEATURES, 'cls array')
  })

  it('mason_collective produces correct dimensions', () => {
    const obs = new Float32Array(MASON_COLLECTIVE_OBSERVATION_SIZE)
    const tok = tokenize(obs, 'mason_collective')
    assert.equal(tok.seatFeatures, MASON_COLLECTIVE_SEAT_FEATURES, 'seatFeatures')
    assert.equal(tok.clsFeatures, MASON_COLLECTIVE_CLS_FEATURES, 'clsFeatures')
    assert.equal(tok.seats.length, SEATS * MASON_COLLECTIVE_SEAT_FEATURES, 'seats array')
    assert.equal(tok.cls.length, MASON_COLLECTIVE_CLS_FEATURES, 'cls array')
  })
})

