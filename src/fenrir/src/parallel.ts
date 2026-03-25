/**
 * 並列ゲーム生成の準備
 *
 * worker_threads でゲーム生成を並列化するための設計:
 *
 * 課題: FenrirStrategy は NeuralNetwork インスタンスを保持しており、
 * worker_threads 間で共有できない。
 *
 * 解決策: 重みを SharedArrayBuffer で共有し、各workerが独自のNN を構築。
 *
 * アーキテクチャ:
 *   Main thread:
 *     - NeuralNetwork (canonical weights)
 *     - PPO update
 *     - SharedWeights → worker に配布
 *
 *   Worker threads (N個):
 *     - SharedWeights から NeuralNetwork を構築
 *     - generateGame() を実行
 *     - TrajectoryStep[] をメインに返す
 *
 * このファイルは共有重みの変換ユーティリティを提供する。
 * 実際の worker_threads 起動は将来の実装。
 */

import type { NeuralNetwork, NetworkConfig } from './ml/nn.ts'
import type { TrainingConfig } from './training.ts'
import type { TrajectoryStep } from './ml/trajectory.ts'

// ============================================================
// 共有重みフォーマット
// ============================================================

export type SharedWeights = {
  /** ネットワーク構成（worker側で同一アーキテクチャを再構築するため） */
  config: NetworkConfig
  /** 全パラメータを1つのバッファに連結 */
  buffer: SharedArrayBuffer
  /** 各パラメータの [offset, length] */
  layout: Array<{ name: string, offset: number, length: number }>
}

/** NeuralNetwork の重みを SharedArrayBuffer にパック */
export function packWeights(network: NeuralNetwork): SharedWeights {
  const params = network.getParams()
  const totalLength = params.reduce((sum, p) => sum + p.length, 0)
  const buffer = new SharedArrayBuffer(totalLength * 4)  // Float32 = 4 bytes
  const view = new Float32Array(buffer)

  const layout: SharedWeights['layout'] = []
  let offset = 0

  // Trunk
  for (let i = 0; i < network.trunk.length; i++) {
    layout.push({ name: `trunk_${i}_w`, offset, length: network.trunk[i].weights.length })
    view.set(network.trunk[i].weights, offset)
    offset += network.trunk[i].weights.length

    layout.push({ name: `trunk_${i}_b`, offset, length: network.trunk[i].biases.length })
    view.set(network.trunk[i].biases, offset)
    offset += network.trunk[i].biases.length
  }

  // Heads
  for (const [name, head] of network.heads) {
    layout.push({ name: `head_${name}_w`, offset, length: head.weights.length })
    view.set(head.weights, offset)
    offset += head.weights.length

    layout.push({ name: `head_${name}_b`, offset, length: head.biases.length })
    view.set(head.biases, offset)
    offset += head.biases.length
  }

  // Sigmoid heads
  for (const [name, head] of network.sigmoidHeads) {
    layout.push({ name: `head_${name}_w`, offset, length: head.weights.length })
    view.set(head.weights, offset)
    offset += head.weights.length

    layout.push({ name: `head_${name}_b`, offset, length: head.biases.length })
    view.set(head.biases, offset)
    offset += head.biases.length
  }

  // Value head
  layout.push({ name: 'value_w', offset, length: network.valueHead.weights.length })
  view.set(network.valueHead.weights, offset)
  offset += network.valueHead.weights.length

  layout.push({ name: 'value_b', offset, length: network.valueHead.biases.length })
  view.set(network.valueHead.biases, offset)

  return { config: network.config, buffer, layout }
}

/** SharedArrayBuffer から NeuralNetwork に重みを展開 */
export function unpackWeights(network: NeuralNetwork, shared: SharedWeights): void {
  const view = new Float32Array(shared.buffer)
  const weights = new Map<string, Float32Array>()

  for (const { name, offset, length } of shared.layout) {
    weights.set(name, new Float32Array(view.buffer, offset * 4, length))
  }

  network.loadWeights(weights)
}

// ============================================================
// Worker メッセージ型
// ============================================================

/** メインスレッド → Worker */
export type WorkerRequest = {
  type: 'generate'
  /** 個人エージェントの重み */
  weights: SharedWeights
  /** 狼チームの重み (Phase 2+) */
  wolfTeamWeights?: SharedWeights
  /** 共有者チームの重み (Phase 2+) */
  masonTeamWeights?: SharedWeights
  /** ゲーム設定 (JSON-safe) */
  trainingConfig: TrainingConfig
  /** このバッチの seed 範囲 */
  seeds: number[]
  /** Phase: 1=heuristic, 2=self-play, 3=pool */
  phase: number
}

/** Worker → メインスレッド */
export type WorkerResult = {
  type: 'result'
  /** 個人エージェントのトラジェクトリ: seat → steps */
  individualSteps: Array<{ seat: number, steps: SerializedStep[] }>
  /** 狼チームのトラジェクトリ */
  wolfTeamSteps: SerializedStep[]
  /** 共有者チームのトラジェクトリ */
  masonTeamSteps: SerializedStep[]
}

/** TrajectoryStep のシリアライズ形式（worker_threads メッセージ用） */
export type SerializedStep = {
  seat: number
  observation: number[]
  actionHead: string
  actionIdx: number
  logProb: number
  reward: number
  value: number
  done: boolean
  sigmoidActions?: number[]
}

/** TrajectoryStep → SerializedStep */
export function serializeStep(step: TrajectoryStep): SerializedStep {
  return {
    seat: step.seat,
    observation: Array.from(step.observation),
    actionHead: step.actionHead,
    actionIdx: step.actionIdx,
    logProb: step.logProb,
    reward: step.reward,
    value: step.value,
    done: step.done,
    sigmoidActions: step.sigmoidActions ? Array.from(step.sigmoidActions) : undefined,
  }
}

/** SerializedStep → TrajectoryStep */
export function deserializeStep(s: SerializedStep): TrajectoryStep {
  return {
    seat: s.seat,
    observation: new Float32Array(s.observation),
    actionHead: s.actionHead,
    actionIdx: s.actionIdx,
    logProb: s.logProb,
    reward: s.reward,
    value: s.value,
    done: s.done,
    sigmoidActions: s.sigmoidActions ? new Float32Array(s.sigmoidActions) : undefined,
  }
}
