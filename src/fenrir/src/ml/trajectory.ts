/**
 * Trajectory buffer + GAE (Generalized Advantage Estimation)
 */

export type TrajectoryStep = {
  seat: number                    // プレイヤー seat
  day?: number                    // ゲーム内の日数 (inspect 用)
  observation: Float32Array       // 観測ベクトル
  actionHead: string              // どのヘッドのアクションか
  actionIdx: number               // 選択されたアクション (softmax用, sigmoid時は-1)
  logProb: number                 // log π(a|s)
  reward: number                  // 即時報酬
  value: number                   // V(s) 推定値
  done: boolean                   // エピソード終了か
  /** sigmoid head用: 各次元の0/1アクション */
  sigmoidActions?: Float32Array
  /** plan forward tokens: 各位置の選択index (vocab 22) */
  planForwardActions?: number[]
  /** plan forward tokens: 各位置のlog prob */
  planForwardLogProbs?: number[]
  /** plan endgame tokens: 各位置の選択index (vocab 22) */
  planEndgameActions?: number[]
  /** plan endgame tokens: 各位置のlog prob */
  planEndgameLogProbs?: number[]
  /** predict補助損失用: 実際の役職 (14席×11役職 = 154次元one-hot、ゲーム終了後に注入) */
  trueRoles?: Float32Array
  /** デバッグ用: trajectory 記録の呼び出し元 */
  source?: string
}

export type ProcessedStep = TrajectoryStep & {
  advantage: number               // GAE advantage
  returnValue: number             // discounted return
}

/**
 * GAE (Generalized Advantage Estimation) を計算
 *
 * @param steps 時系列順のトラジェクトリ（1プレイヤー分）
 * @param gamma 割引率 (default: 0.99)
 * @param lambda GAEパラメータ (default: 0.95)
 * @param lastValue 最後のステップ後のV(s') (done=trueなら0)
 */
export function computeGAE(
  steps: TrajectoryStep[],
  gamma: number = 0.99,
  lambda: number = 0.95,
  lastValue: number = 0,
): ProcessedStep[] {
  const n = steps.length
  if (n === 0) return []

  const advantages = new Float32Array(n)
  const returns = new Float32Array(n)

  let gae = 0
  for (let t = n - 1; t >= 0; t--) {
    const nextValue = t === n - 1 ? lastValue : steps[t + 1].value
    const nextDone = t === n - 1 ? true : steps[t + 1].done

    const delta = steps[t].reward + (nextDone ? 0 : gamma * nextValue) - steps[t].value
    gae = delta + (nextDone ? 0 : gamma * lambda * gae)
    advantages[t] = gae
    returns[t] = advantages[t] + steps[t].value
  }

  return steps.map((step, i) => ({
    ...step,
    advantage: advantages[i],
    returnValue: returns[i],
  }))
}

/**
 * 複数プレイヤーのトラジェクトリをまとめて処理
 *
 * @param allSteps seat → TrajectoryStep[] のマップ
 * @param gamma
 * @param lambda
 */
export function processTrajectories(
  allSteps: Map<number, TrajectoryStep[]>,
  gamma: number = 0.99,
  lambda: number = 0.95,
): ProcessedStep[] {
  const processed: ProcessedStep[] = []
  for (const [, steps] of allSteps) {
    const result = computeGAE(steps, gamma, lambda, 0)
    processed.push(...result)
  }
  return processed
}

/**
 * Advantage正規化（バッチ全体）
 */
export function normalizeAdvantages(steps: ProcessedStep[]): void {
  if (steps.length === 0) return

  let mean = 0
  for (const s of steps) mean += s.advantage
  mean /= steps.length

  let variance = 0
  for (const s of steps) variance += (s.advantage - mean) ** 2
  variance /= steps.length
  const std = Math.sqrt(variance + 1e-8)

  for (const s of steps) {
    s.advantage = (s.advantage - mean) / std
  }
}
