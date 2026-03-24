/** Adam Optimizer */

export type AdamConfig = {
  lr: number       // 学習率 (default: 3e-4)
  beta1: number    // 1st moment decay (default: 0.9)
  beta2: number    // 2nd moment decay (default: 0.999)
  epsilon: number  // 数値安定性 (default: 1e-8)
}

const DEFAULT_CONFIG: AdamConfig = {
  lr: 3e-4,
  beta1: 0.9,
  beta2: 0.999,
  epsilon: 1e-8,
}

export class AdamOptimizer {
  readonly config: AdamConfig
  private m: Float32Array[]  // 1st moment (mean)
  private v: Float32Array[]  // 2nd moment (variance)
  private step: number

  constructor(params: Float32Array[], config?: Partial<AdamConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.m = params.map(p => new Float32Array(p.length))
    this.v = params.map(p => new Float32Array(p.length))
    this.step = 0
  }

  /** パラメータを勾配で更新 */
  update(params: Float32Array[], grads: Float32Array[]): void {
    this.step++
    const { lr, beta1, beta2, epsilon } = this.config
    const bc1 = 1 - Math.pow(beta1, this.step)
    const bc2 = 1 - Math.pow(beta2, this.step)

    for (let p = 0; p < params.length; p++) {
      const param = params[p]
      const grad = grads[p]
      const m = this.m[p]
      const v = this.v[p]

      for (let i = 0; i < param.length; i++) {
        // moment更新
        m[i] = beta1 * m[i] + (1 - beta1) * grad[i]
        v[i] = beta2 * v[i] + (1 - beta2) * grad[i] * grad[i]

        // バイアス補正
        const mHat = m[i] / bc1
        const vHat = v[i] / bc2

        // パラメータ更新
        param[i] -= lr * mHat / (Math.sqrt(vHat) + epsilon)
      }
    }
  }

  /** Optimizer状態のクローン（チェックポイント用） */
  cloneState(): { m: Float32Array[], v: Float32Array[], step: number } {
    return {
      m: this.m.map(arr => new Float32Array(arr)),
      v: this.v.map(arr => new Float32Array(arr)),
      step: this.step,
    }
  }

  /** Optimizer状態のロード */
  loadState(state: { m: Float32Array[], v: Float32Array[], step: number }): void {
    for (let i = 0; i < this.m.length; i++) {
      this.m[i].set(state.m[i])
      this.v[i].set(state.v[i])
    }
    this.step = state.step
  }
}
