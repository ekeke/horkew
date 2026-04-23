import type { HeadName } from '../mcts/nn.ts'
import type { RootObs } from './observation.ts'

/**
 * 1 意思決定点で buffer に蓄積するレコード。
 *
 * 2 系統の学習対象を持つ:
 * - **MCTS-π head** (vote/attack/divine/guard): visits + pi を持つ、CE(π) + MSE(z) で学習
 * - **Outcome-SL head** (claim/comm/leader/propose/predict/target): actionIndex or actionMultiHot を持つ、
 *   outcome-weighted CE + KL anchor で学習 (Phase 3 で導入)
 *
 * どちらの系統かは headName で判定する。
 */
export type PendingRecord = {
  obs: RootObs
  day: number
  masonSeat: number
  /** 決定時点の生存 bitmask (1-based)。legal action mask を Float32Array に変換するのに使う */
  alive: number
  /** この記録が学習すべき head 名。trainer が head ごとに分割 */
  headName: HeadName
  /** MCTS-π head 用: action (対象 seat) → visit 数。Outcome-SL head では undefined。 */
  visits?: Map<number, number>
  /** MCTS-π head 用: 正規化済み policy target π = N(a) / Σ N(b)。Outcome-SL head では undefined。 */
  pi?: Map<number, number>
  /** Outcome-SL softmax head 用 (claim/comm/leader/target): 選んだ action の index (0-based)。 */
  actionIndex?: number
  /** Outcome-SL sigmoid head 用 (propose/predict/bodyguard_targets): 選んだ action の multi-hot。 */
  actionMultiHot?: Uint8Array
}

export type TrainingRecord = PendingRecord & {
  /** ゲーム終了時に貼られる value target [-1.3, +1] (faction 視点) */
  z: number
}

/** MCTS-π head かどうか (vote/attack/divine/guard) */
export function isMctsHead(headName: HeadName): boolean {
  return headName === 'vote' || headName === 'attack' || headName === 'divine' || headName === 'guard'
}

/** Outcome-SL softmax head かどうか (claim/comm/leader/target) */
export function isOutcomeSoftmaxHead(headName: HeadName): boolean {
  return headName === 'claim' || headName === 'comm' || headName === 'leader' || headName === 'target'
}

/** Outcome-SL sigmoid head かどうか (propose/predict) */
export function isOutcomeSigmoidHead(headName: HeadName): boolean {
  return headName === 'propose' || headName === 'predict'
}

/**
 * MCTS 自己対戦の (obs, π, z) buffer。
 *
 * - 各決定点で `appendPending` → pending に追加（z はまだ未確定）
 * - ゲーム終了時に `finalize(z)` → 全 pending に z を貼って finalized へ移送
 * - reset で状態クリア
 *
 * Phase 1 では in-memory のみ。M5 で disk persistence を追加予定。
 */
export class TrainingBuffer {
  private pending: PendingRecord[] = []
  private readonly finalized: TrainingRecord[] = []

  appendPending(rec: PendingRecord): void {
    this.pending.push(rec)
  }

  /** ゲーム終了時に呼び出し、pending records に z を貼って finalized へ移送 */
  finalize(z: number): void {
    for (const p of this.pending) {
      this.finalized.push({ ...p, z })
    }
    this.pending = []
  }

  /** finalized 済みの全 record（snapshot copy） */
  records(): readonly TrainingRecord[] {
    return this.finalized
  }

  size(): number {
    return this.finalized.length
  }

  pendingSize(): number {
    return this.pending.length
  }

  /**
   * FIFO で古い record を落として上限以下に保つ。
   * M5 trainer が round ごとに呼ぶ想定。
   */
  expireOldest(maxSize: number): number {
    const overflow = this.finalized.length - maxSize
    if (overflow <= 0) return 0
    this.finalized.splice(0, overflow)
    return overflow
  }

  /**
   * finalized から size 件を uniform random sampling (with replacement)。
   * 決定的にしたい場合は rng を渡す。
   */
  sample(size: number, rng: () => number = Math.random): TrainingRecord[] {
    const n = this.finalized.length
    if (n === 0 || size <= 0) return []
    const out: TrainingRecord[] = new Array(size)
    for (let i = 0; i < size; i++) {
      const idx = Math.floor(rng() * n)
      out[i] = this.finalized[idx]
    }
    return out
  }

  /** 全状態クリア（テスト or 新 epoch 用） */
  reset(): void {
    this.pending = []
    this.finalized.length = 0
  }
}
