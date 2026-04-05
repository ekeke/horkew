/**
 * Pretrain Snapshot — 学習過程の定期的なスナップショット取得・保存
 *
 * 各 pretrain フェーズ (B/B2/D) で固定プローブサンプルに対する
 * NN の予測を記録し、学習進行の可視化に使う。
 */

import type { AnyNetwork, AnyTfNetwork, ForwardResult } from './ml/nn.ts'
import type { PlanTokenTrainingSample } from './ml/execution-plan-data.ts'
import type { PretrainSample } from './ml/pretrain-game-data.ts'
import { writeFileSync } from 'node:fs'
import { SEATS, NUM_ROLES, ROLE_INDEX } from './observation.ts'

// ============================================================
// Types
// ============================================================

export type PretrainSnapshotSample = {
  forwardLabel: number[]
  forwardPred: number[]
  forwardMask: boolean[]
  endgameLabel: number[]
  endgamePred: number[]
  endgameMask: boolean[]
  // Phase D only
  predictLabel?: Array<{ seat: number, top: Array<{ role: string, prob: number }> }>
  predictPred?: Array<{ seat: number, top: Array<{ role: string, prob: number }> }>
  valueLabel?: number
  valuePred?: number
  seat?: number
  role?: string
}

export type PretrainSnapshot = {
  phase: 'B' | 'B2' | 'D'
  epoch: number
  metrics: {
    loss?: number
    accuracy?: number
    nextAccuracy?: number
    stopAccuracy?: number
    predictLoss?: number
    valueLoss?: number
  }
  samples: PretrainSnapshotSample[]
}

export type PretrainSnapshotFile = {
  timestamp: string
  snapshots: PretrainSnapshot[]
}

// ============================================================
// Snapshot epoch schedule
// ============================================================

export const SNAPSHOT_EPOCHS_B = new Set([1, 50, 100, 200, 400, 700, 1000])
export const SNAPSHOT_EPOCHS_B2 = new Set([1, 50, 100, 200, 350, 500])
export const SNAPSHOT_EPOCHS_D = new Set([1, 5, 10, 15, 20, 25, 30])

const PROBE_COUNT = 8

// ============================================================
// Capture
// ============================================================

/** Phase B / B2 用: plan token ラベルとNNの予測を比較 */
export function capturePlanSnapshot(
  phase: 'B' | 'B2',
  epoch: number,
  metrics: { loss: number, accuracy: number, nextAccuracy: number, stopAccuracy: number },
  probeSamples: PlanTokenTrainingSample[],
  villageNetwork: AnyNetwork,
  tfNetwork: AnyTfNetwork,
): PretrainSnapshot {
  // Sync weights from TF to Pure JS for inference
  villageNetwork.loadWeights((tfNetwork as any).cloneWeights())

  const samples: PretrainSnapshotSample[] = []
  for (const probe of probeSamples.slice(0, PROBE_COUNT)) {
    const result: ForwardResult = villageNetwork.forward(probe.observation, false)
    samples.push({
      forwardLabel: [...probe.forwardLabels],
      forwardPred: result.planForwardActions ? [...result.planForwardActions] : [],
      forwardMask: [...probe.forwardMask],
      endgameLabel: [...probe.endgameLabels],
      endgamePred: result.planEndgameActions ? [...result.planEndgameActions] : [],
      endgameMask: [...probe.endgameMask],
    })
  }

  return { phase, epoch, metrics: { ...metrics }, samples }
}

/** Phase D 用: plan + predict + value のスナップショット */
export function captureGameSnapshot(
  epoch: number,
  metrics: { predictLoss: number, valueLoss: number },
  probeSamples: PretrainSample[],
  villageNetwork: AnyNetwork,
  tfNetwork: AnyTfNetwork,
): PretrainSnapshot {
  villageNetwork.loadWeights((tfNetwork as any).cloneWeights())

  const roleNames = [...ROLE_INDEX.keys()]
  const samples: PretrainSnapshotSample[] = []

  for (const probe of probeSamples.slice(0, PROBE_COUNT)) {
    const result: ForwardResult = villageNetwork.forward(probe.observation, false)

    // Extract predict head output
    const predictRaw = result.policies.get('predict')

    samples.push({
      forwardLabel: [...probe.forwardLabels],
      forwardPred: result.planForwardActions ? [...result.planForwardActions] : [],
      forwardMask: [...probe.forwardMask],
      endgameLabel: [],
      endgamePred: [],
      endgameMask: [],
      predictLabel: extractTopRoles(probe.predictLabel, roleNames),
      predictPred: predictRaw ? extractTopRoles(predictRaw, roleNames) : undefined,
      valueLabel: probe.valueLabel,
      valuePred: result.value,
      seat: probe.seat,
      role: probe.role,
    })
  }

  return { phase: 'D', epoch, metrics: { ...metrics }, samples }
}

/** Float32Array[SEATS * NUM_ROLES] → per-seat top-2 roles */
function extractTopRoles(
  data: Float32Array,
  roleNames: string[],
): Array<{ seat: number, top: Array<{ role: string, prob: number }> }> {
  const result: Array<{ seat: number, top: Array<{ role: string, prob: number }> }> = []
  for (let s = 0; s < SEATS; s++) {
    const offset = s * NUM_ROLES
    const entries: Array<{ role: string, prob: number }> = []
    for (let r = 0; r < NUM_ROLES; r++) {
      const prob = data[offset + r]
      if (prob > 0.01) {
        entries.push({ role: roleNames[r], prob: Math.round(prob * 100) / 100 })
      }
    }
    entries.sort((a, b) => b.prob - a.prob)
    result.push({ seat: s, top: entries.slice(0, 2) })
  }
  return result
}

// ============================================================
// Save
// ============================================================

export function savePretrainSnapshots(
  snapshots: PretrainSnapshot[],
  checkpointBase: string,
): void {
  if (snapshots.length === 0) return
  const file: PretrainSnapshotFile = {
    timestamp: new Date().toISOString(),
    snapshots,
  }
  const path = `${checkpointBase}/pretrain-snapshots.json`
  writeFileSync(path, JSON.stringify(file, null, 2))
  console.error(`  [pretrain-snapshot] ${snapshots.length} snapshots saved to ${path}`)
}
