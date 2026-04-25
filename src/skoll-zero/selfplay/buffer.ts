import type { HeadName } from '../mcts/nn.ts'
import type { RootObs } from './observation.ts'
import { OUTCOME_INDEX, OUTCOME_DIST_SIZE, type FinalOutcome } from '../network/config.ts'

/**
 * 1 意思決定点で buffer に蓄積するレコード。
 *
 * MCTS-π head で visits + pi を持つ。CE(π) policy loss + CE(outcome 分布) value loss で学習。
 */
export type PendingRecord = {
  obs: RootObs
  day: number
  masonSeat: number
  /** 決定時点の生存 bitmask (1-based)。legal action mask を Float32Array に変換するのに使う */
  alive: number
  /** この記録が学習すべき head 名。trainer が head ごとに分割 */
  headName: HeadName
  /** action → visit 数 (action ID 空間は phase ごとに異なる) */
  visits: Map<number, number>
  /** 正規化済み policy target π = N(a) / Σ N(b) */
  pi: Map<number, number>
}

export type TrainingRecord = PendingRecord & {
  /**
   * 終局 outcome の one-hot Float32Array (size = OUTCOME_DIST_SIZE = 4)。
   * 順序は network/config.ts の OUTCOME_ORDER。Stage 4: outcome distribution head の
   * categorical CE loss target として使う。陣営非依存 (3 陣営どれでも同じレコードから学べる)。
   */
  outcomeTarget: Float32Array
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

  /**
   * ゲーム終了時に呼び出し、pending records に outcome one-hot を貼って finalized へ移送。
   *
   * @param outcome 終局結果。OUTCOME_ORDER に含まれない (例: 'ongoing') 場合は uniform に
   *   フォールバック (理論上発生しないが安全側)。
   */
  finalize(outcome: FinalOutcome): void {
    const target = outcomeOneHot(outcome)
    for (const p of this.pending) {
      // 各 record で独立した Float32Array を持たせる (mutate 防止)
      const t = new Float32Array(target)
      this.finalized.push({ ...p, outcomeTarget: t })
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

/** FinalOutcome → one-hot Float32Array (size = OUTCOME_DIST_SIZE) */
export function outcomeOneHot(outcome: FinalOutcome): Float32Array {
  const out = new Float32Array(OUTCOME_DIST_SIZE)
  const idx = OUTCOME_INDEX.get(outcome)
  if (idx !== undefined) out[idx] = 1
  // OUTCOME_ORDER に無い outcome (例: 'ongoing') はゼロのまま (理論上 finalize 時に来ない前提)
  return out
}
