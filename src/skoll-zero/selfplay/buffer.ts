import type { HeadName } from '../mcts/nn.ts'
import type { RootObs } from './observation.ts'

/**
 * 1 意思決定点で buffer に蓄積するレコード。
 *
 * MCTS-π head (vote/attack/divine/guard) で visits + pi を持つ。CE(π) + MSE(z) で学習。
 */
export type PendingRecord = {
  obs: RootObs
  day: number
  masonSeat: number
  /** 決定時点の生存 bitmask (1-based)。legal action mask を Float32Array に変換するのに使う */
  alive: number
  /** この記録が学習すべき head 名。trainer が head ごとに分割 */
  headName: HeadName
  /** action (対象 seat) → visit 数 */
  visits: Map<number, number>
  /** 正規化済み policy target π = N(a) / Σ N(b) */
  pi: Map<number, number>
}

export type TrainingRecord = PendingRecord & {
  /** ゲーム終了時に貼られる value target [-1.3, +1] (faction 視点) */
  z: number
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
