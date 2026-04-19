import type { RawObs } from './observation.ts'

export type PendingRecord = {
  obs: RawObs
  /** action (vote 先 seat) → MCTS visit 数 */
  visits: Map<number, number>
  /** 正規化済み policy target π = N(a) / Σ N(b) */
  pi: Map<number, number>
  day: number
  masonSeat: number
}

export type TrainingRecord = PendingRecord & {
  /** ゲーム終了時に貼られる value target [-1.3, +1] (mason 視点) */
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

  /** 全状態クリア（テスト or 新 epoch 用） */
  reset(): void {
    this.pending = []
    this.finalized.length = 0
  }
}
