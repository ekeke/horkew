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

/**
 * Dirichlet ε auto-decay 設定。
 *
 * 各 slot 独立に root visit エントロピー比 (visitEntropyRatio) を round 単位で集計し、
 * 平均が targetRatio を streak round 連続で下回ったら ε を decay 倍に減衰する。
 * 一方向 (減衰のみ)、復活なし。floor で下限を保証する。
 */
export type DirichletAutoConfig = {
  /** 自動減衰の有効化フラグ */
  enabled: boolean
  /** 平均 visit エントロピー比の閾値。これ以下で「decisive」と判定 (default 0.5) */
  targetRatio: number
  /** ε に乗ずる減衰係数 (default 0.9) */
  decay: number
  /** ε の下限。これ以下には下げない (default 0.1) */
  floor: number
  /** 閾値割れの連続 round 数。これに達すると 1 段減衰 (default 3) */
  streak: number
}

export const DEFAULT_DIRICHLET_AUTO_CONFIG: DirichletAutoConfig = {
  enabled: false,
  targetRatio: 0.5,
  decay: 0.9,
  floor: 0.1,
  streak: 3,
}

/**
 * Dirichlet ε auto-decay の純関数版規則。MultiSkollZeroTrainer から呼ばれる。
 *
 * 入力: 現在の ε / streak、観測 meanEntropyRatio、auto-decay config。
 * 出力: 次 round 用の ε / streak。
 *
 * 規則:
 * - 無効化されている / sample 0 件 → ε / streak は据え置き
 * - meanEntropyRatio < targetRatio が streak round 連続 → ε *= decay (floor で clamp、streak リセット)
 * - meanEntropyRatio >= targetRatio → streak リセット (ε は据え置き)
 */
export function applyDirichletDecay(
  state: { eps: number, streak: number },
  meanEntropyRatio: number,
  sampleCount: number,
  cfg: DirichletAutoConfig,
): { eps: number, streak: number } {
  if (!cfg.enabled || sampleCount === 0) {
    return { eps: state.eps, streak: state.streak }
  }
  if (meanEntropyRatio < cfg.targetRatio) {
    const newStreak = state.streak + 1
    if (newStreak >= cfg.streak) {
      const eps = Math.max(state.eps * cfg.decay, cfg.floor)
      return { eps, streak: 0 }
    }
    return { eps: state.eps, streak: newStreak }
  }
  return { eps: state.eps, streak: 0 }
}

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
  /** Dirichlet ε auto-decay 設定 (省略時 DEFAULT_DIRICHLET_AUTO_CONFIG) */
  dirichletAuto?: DirichletAutoConfig
  /**
   * Day bonus 係数 (0 で無効、SKOLLZ_DAY_BONUS_COEF)。
   * MCTS の value 評価で `+sign(faction) * coef * state.day` を加算し、
   * 14D-12-猫構造の長期化インセンティブを village/wolf に与える (hamster は逆方向)。
   */
  dayBonusCoef?: number
  /**
   * Endgame bonus 係数 (0 で無効、SKOLLZ_ENDGAME_BONUS_COEF)。
   * 観測上 fox 死亡確認後 (viewer の retar で werehamster 候補ゼロ) に村/狼へ
   * `+endgameBonusCoef` を一発加算 (累積させない)。狐排除をマイルストーン化。
   */
  endgameBonusCoef?: number
  /**
   * Night phase 並列化フラグ (SKOLLZ_NIGHT_PARALLEL)。
   * true: night_attack/divine/guard を atomic な 1 step として処理し、
   *   敵 night phase を NN policy sample で通り抜けて simulateNight で 1 step leaf 評価する。
   * false (default): 既存挙動 (各 night phase で MCTS expand)。
   */
  nightParallel?: boolean
  /**
   * Retar narrowing reward 係数 (0 で無効、SKOLLZ_NARROW_COEF)。
   * 村陣営の MCTS leaf value に `+coef × narrowProgress` を加算する shaping。
   * narrowProgress は global retar 可能性総和の root → leaf 縮小率 (alive×11 で正規化、[0,1])。
   * 「真占/真霊の自滅吊」を減らすため真贋判別を learning で獲得させる狙い。
   * 狼/狐側は対称シェイプを行わない (handoff 2026-05-05 設計議論)。
   * `recomputeRetarInRollout=true` (= SKOLLZ_ROLLOUT_RETAR=1) と組合せて初めて意味がある。
   */
  narrowBonusCoef?: number
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
