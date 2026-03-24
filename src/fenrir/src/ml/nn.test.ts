import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DenseLayer, NeuralNetwork, softmax } from './nn.ts'
import { AdamOptimizer } from './optimizer.ts'

describe('DenseLayer', () => {
  it('forward produces correct shape', () => {
    const layer = new DenseLayer(4, 3)
    const input = new Float32Array([1, 2, 3, 4])
    assert.equal(layer.forward(input).length, 3)
  })

  it('backward produces correct gradient shape', () => {
    const layer = new DenseLayer(4, 3)
    const input = new Float32Array([1, 2, 3, 4])
    layer.forward(input)
    const gradOutput = new Float32Array([0.1, 0.2, 0.3])
    const gradInput = layer.backward(gradOutput)
    assert.equal(gradInput.length, 4)
  })

  it('numerical gradient check', () => {
    const layer = new DenseLayer(3, 2)
    const input = new Float32Array([1.0, -0.5, 0.3])

    // Forward
    layer.zeroGrad()
    layer.forward(input)
    // Use sum of outputs as loss
    const gradOutput = new Float32Array([1.0, 1.0])
    layer.backward(gradOutput)

    // Numerical gradients for weights
    const eps = 1e-4
    for (let idx = 0; idx < Math.min(6, layer.weights.length); idx++) {
      const orig = layer.weights[idx]

      layer.weights[idx] = orig + eps
      const outPlus = layer.forward(input)
      const lossPlus = outPlus[0] + outPlus[1]

      layer.weights[idx] = orig - eps
      const outMinus = layer.forward(input)
      const lossMinus = outMinus[0] + outMinus[1]

      layer.weights[idx] = orig

      const numerical = (lossPlus - lossMinus) / (2 * eps)
      const analytical = layer.weightGrads[idx]

      assert.ok(
        Math.abs(numerical - analytical) < 1e-3,
        `Weight grad mismatch at ${idx}: numerical=${numerical}, analytical=${analytical}`
      )
    }
  })
})

describe('NeuralNetwork', () => {
  it('forward produces correct output structure', () => {
    const net = new NeuralNetwork({
      inputSize: 10,
      hiddenSizes: [8, 4],
      heads: { vote: 5, claim: 3 },
    })

    const input = new Float32Array(10).fill(0.5)
    const result = net.forward(input)

    assert.equal(result.policies.size, 2)
    assert.equal(result.policies.get('vote')!.length, 5)
    assert.equal(result.policies.get('claim')!.length, 3)
    assert.ok(typeof result.value === 'number')
    assert.ok(result.value >= -1 && result.value <= 1, `value ${result.value} out of [-1, 1]`)
  })

  it('total params are correct', () => {
    const net = new NeuralNetwork({
      inputSize: 10,
      hiddenSizes: [8, 4],
      heads: { vote: 5 },
    })
    // trunk: (10*8+8) + (8*4+4) = 88 + 36 = 124
    // vote head: 4*5+5 = 25
    // value head: 4*1+1 = 5
    // total: 154
    assert.equal(net.totalParams, 154)
  })

  it('backward does not throw', () => {
    const net = new NeuralNetwork({
      inputSize: 10,
      hiddenSizes: [8, 4],
      heads: { vote: 5 },
    })

    const input = new Float32Array(10).fill(0.5)
    net.zeroGrad()
    net.forward(input)

    const policyGrads = new Map<string, Float32Array>()
    policyGrads.set('vote', new Float32Array(5).fill(0.1))

    net.backward(policyGrads, 0.5)

    // Check gradients are non-zero
    const grads = net.getGrads()
    const hasNonZero = grads.some(g => g.some(v => v !== 0))
    assert.ok(hasNonZero, 'All gradients are zero after backward')
  })

  it('clone and load weights', () => {
    const net = new NeuralNetwork({
      inputSize: 4,
      hiddenSizes: [3],
      heads: { a: 2 },
    })

    const input = new Float32Array([1, 2, 3, 4])
    const before = net.forward(input)

    const weights = net.cloneWeights()

    // Corrupt weights
    net.trunk[0].weights.fill(999)

    const corrupted = net.forward(input)
    assert.notDeepEqual(corrupted.value, before.value)

    // Restore
    net.loadWeights(weights)
    const after = net.forward(input)
    assert.equal(after.value, before.value)
  })
})

describe('softmax', () => {
  it('produces valid probability distribution', () => {
    const logits = new Float32Array([1, 2, 3])
    const probs = softmax(logits)

    assert.equal(probs.length, 3)
    const sum = probs[0] + probs[1] + probs[2]
    assert.ok(Math.abs(sum - 1.0) < 1e-6, `Sum ${sum} != 1.0`)
    assert.ok(probs[2] > probs[1] && probs[1] > probs[0])
  })

  it('handles large values without overflow', () => {
    const logits = new Float32Array([1000, 1001, 1002])
    const probs = softmax(logits)
    const sum = probs[0] + probs[1] + probs[2]
    assert.ok(Math.abs(sum - 1.0) < 1e-6)
    assert.ok(!probs.some(p => isNaN(p)))
  })

  it('handles -Infinity masking', () => {
    const logits = new Float32Array([1, -Infinity, 3])
    const probs = softmax(logits)
    assert.ok(probs[1] < 1e-10, `Masked action has prob ${probs[1]}`)
    assert.ok(probs[0] + probs[2] > 0.999)
  })
})

describe('Adam optimizer', () => {
  it('reduces loss on simple quadratic', () => {
    // Minimize f(x) = x² where x starts at 5.0
    const params = [new Float32Array([5.0])]
    const grads = [new Float32Array(1)]
    const optimizer = new AdamOptimizer(params, { lr: 0.1 })

    let prevLoss = params[0][0] ** 2
    for (let i = 0; i < 200; i++) {
      grads[0][0] = 2 * params[0][0]  // d(x²)/dx = 2x
      optimizer.update(params, grads)
    }
    const finalLoss = params[0][0] ** 2

    assert.ok(finalLoss < prevLoss, `Loss did not decrease: ${prevLoss} → ${finalLoss}`)
    assert.ok(finalLoss < 0.1, `Loss ${finalLoss} not close to 0`)
  })
})

describe('NeuralNetwork training', () => {
  it('can learn XOR-like function', () => {
    const net = new NeuralNetwork({
      inputSize: 2,
      hiddenSizes: [8],
      heads: { out: 2 },
    })

    const optimizer = new AdamOptimizer(net.getParams(), { lr: 0.01 })

    // XOR: (0,0)→0, (0,1)→1, (1,0)→1, (1,1)→0
    const data = [
      { input: [0, 0], target: 0 },
      { input: [0, 1], target: 1 },
      { input: [1, 0], target: 1 },
      { input: [1, 1], target: 0 },
    ]

    let lastLoss = Infinity
    for (let epoch = 0; epoch < 500; epoch++) {
      let totalLoss = 0
      net.zeroGrad()

      for (const d of data) {
        const input = new Float32Array(d.input)
        const result = net.forward(input)
        const logits = result.policies.get('out')!
        const probs = softmax(logits)

        // Cross-entropy loss
        const loss = -Math.log(probs[d.target] + 1e-8)
        totalLoss += loss

        // Gradient of cross-entropy w.r.t. logits
        const grad = new Float32Array(2)
        grad[0] = probs[0] - (d.target === 0 ? 1 : 0)
        grad[1] = probs[1] - (d.target === 1 ? 1 : 0)

        net.backward(new Map([['out', grad]]), 0)
      }

      optimizer.update(net.getParams(), net.getGrads())
      lastLoss = totalLoss / 4
    }

    // Verify predictions
    let correct = 0
    for (const d of data) {
      const result = net.forward(new Float32Array(d.input))
      const probs = softmax(result.policies.get('out')!)
      const pred = probs[1] > probs[0] ? 1 : 0
      if (pred === d.target) correct++
    }

    assert.ok(correct >= 3, `Only ${correct}/4 correct on XOR`)
    assert.ok(lastLoss < 0.5, `Loss ${lastLoss} still high`)
  })
})
