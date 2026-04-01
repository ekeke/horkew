/**
 * Seed Bank — 中盤スナップショットの事前生成と管理
 *
 * 序盤を Retar ありで1回だけ走らせ、中盤のスナップショットを保存。
 * 学習時はスナップショットから ML でリプレイし、Retar コストを償却する。
 */

import type { SystemRole } from '../../types/index.ts'
import type { GameSnapshot } from '../../lupa/types.ts'
import type { GameConfig } from '../../lupa/handlers.ts'
import { runGame } from '../../lupa/engine.ts'
import { strategyAdapter } from '../../lupa/adapters/strategy-adapter.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from '../../lupa/heuristic.ts'
import type { TrainingConfig } from './training.ts'

export type SeedBank = {
  snapshots: GameSnapshot[]
  snapshotDay: number
  generationTimeMs: number
}

export async function generateSeedBank(opts: {
  snapshotDay: number
  bankSize: number
  trainingConfig: TrainingConfig
  startSeed: number
}): Promise<SeedBank> {
  const { snapshotDay, bankSize, trainingConfig, startSeed } = opts
  const roles = new Map(Object.entries(trainingConfig.roles) as [SystemRole, number][])
  const t0 = performance.now()

  const snapshots: GameSnapshot[] = []
  let seed = startSeed
  let attempts = 0

  while (snapshots.length < bankSize) {
    const config: GameConfig = {
      roles,
      seed: seed++,
      hasFirstGhost: trainingConfig.hasFirstGhost,
      revoteConfig: trainingConfig.revoteConfig,
      rules: trainingConfig.rules,
      captureSnapshotDays: [snapshotDay],
    }

    const handlers = strategyAdapter({
      defaultStrategy: new HeuristicStrategy(),
      wolfTeamStrategy: new WolfTeamHeuristic(),
      masonTeamStrategy: new MasonTeamHeuristic(),
      enableRetar: trainingConfig.enableRetar,
      seed: seed,
      roles,
      rules: trainingConfig.rules,
    })

    const result = await runGame(config, handlers)
    attempts++

    const snapshot = result.snapshots?.get(snapshotDay)
    if (snapshot) {
      snapshots.push(snapshot)
    }
    // snapshotDay に到達せずゲーム終了した場合は破棄
  }

  return {
    snapshots,
    snapshotDay,
    generationTimeMs: performance.now() - t0,
  }
}
