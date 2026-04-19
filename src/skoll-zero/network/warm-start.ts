/**
 * skoll-supervised で学習済み mason_brain checkpoint を MasonZeroNetwork に転送する。
 *
 * 転送対象:
 * - Trunk: proj_* / seat_* / strat_*
 * - Policy head: head_vote_w / head_vote_b（skoll-supervised の vote head = skoll-zero の policy head）
 *
 * 非転送（zero 維持）:
 * - value head: skoll-supervised も一緒に保存しているが、PPO なしで学習シグナルが弱いため
 *   ここでは zero init を保つ。M5 以降で self-play の z をシグナルに学習する。
 *
 * 実装:
 *   loadCheckpoint() は weights を全 load するので、事後に zeroInitValueHead() を呼ぶ。
 *
 * 典型 checkpoint path:
 *   tmp/skoll-mb-large-v2/phases/00-skoll-supervised/ckpt-mason_collective/collective_final.json
 */

import { loadCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'
import type { MasonZeroNetwork } from './mason-zero.ts'

export type WarmStartResult = {
  checkpointPath: string
  /** checkpoint の metadata（iteration, winRate, timestamp） */
  metadata: { iteration: number, winRate: number, timestamp: string }
}

/**
 * skoll-supervised checkpoint を MasonZeroNetwork に load、value head を zero reset。
 *
 * 失敗条件:
 * - checkpoint ファイルが存在しない / JSON が壊れている → 例外
 * - checkpoint の config shape が network と不一致 → loadWeights が例外
 */
export function loadSkollSupervisedWeights(
  network: MasonZeroNetwork,
  checkpointPath: string,
): WarmStartResult {
  const data = loadCheckpoint(network.net, checkpointPath)
  // 事後に value head を zero reset（SL 済みの value_w/b を上書き）
  network.net.zeroInitValueHead()
  return {
    checkpointPath,
    metadata: data.metadata,
  }
}
