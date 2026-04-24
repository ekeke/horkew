/**
 * skoll-zero Phase 1 の学習ハイパーパラメータ。
 *
 * これらの値は `tasks/skoll-zero-impl-plan.md` §M5 の Open Questions 暫定回答に準拠する:
 * - c_puct=1.5 (AlphaZero 中央値)
 * - Dirichlet α=0.3 / ε=0.25 (AlphaGo Zero 値)
 * - buffer 50K records (~80MB 想定)
 * - 同期 self-play → train
 *
 * smoke / 本訓練で振る値は trainer.ts 側で override する想定。
 */

export type SkollZeroTrainConfig = {
  /** Adam 学習率 */
  learningRate: number
  /** value loss の係数 c_value (AlphaZero 既定 = 1.0) */
  valueCoeff: number
  /** 1 train step ごとの minibatch サイズ */
  batchSize: number
  /** 1 round で self-play 後に実行する train step 数 */
  stepsPerRound: number
  /** 1 round で実行する self-play ゲーム数 */
  gamesPerRound: number
  /** buffer の上限（FIFO expire） */
  bufferCapacity: number
  /** MCTS の rollout 数 (self-play 時) */
  mctsRollouts: number
  /** MCTS の c_puct */
  cPuct: number
  /** root Dirichlet noise α (α<1 で sharp) */
  rootDirichletAlpha: number
  /** root Dirichlet noise ε (0 で noise 無効、AlphaZero では 0.25) */
  rootDirichletEps: number
  /** Trainer の RNG seed (batch sampling, self-play 初期 seed) */
  rngSeed: number
}

export const DEFAULT_SKOLL_ZERO_TRAIN_CONFIG: SkollZeroTrainConfig = {
  learningRate: 3e-4,
  valueCoeff: 1.0,
  batchSize: 64,
  stepsPerRound: 100,
  gamesPerRound: 100,
  bufferCapacity: 50_000,
  mctsRollouts: 400,
  cPuct: 1.5,
  rootDirichletAlpha: 0.3,
  rootDirichletEps: 0.25,
  rngSeed: 42,
}
