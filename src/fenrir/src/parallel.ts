/**
 * 並列ゲーム生成の準備
 *
 * worker_threads でゲーム生成を並列化するための設計:
 *
 * 課題: NeuralAgent は TransformerNetwork インスタンスを保持しており、
 * worker_threads 間で共有できない。
 *
 * 解決策: 重みを SharedArrayBuffer で共有し、各workerが独自のNN を構築。
 *
 * アーキテクチャ:
 *   Main thread:
 *     - TransformerNetwork (canonical weights)
 *     - PPO update
 *     - SharedWeights → worker に配布
 *
 *   Worker threads (N個):
 *     - SharedWeights から TransformerNetwork を構築
 *     - generateGame() を実行
 *     - TrajectoryStep[] をメインに返す
 *
 * このファイルは共有重みの変換ユーティリティを提供する。
 * 実際の worker_threads 起動は将来の実装。
 */

import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { NetworkConfig, AnyNetwork } from './ml/nn.ts'
import { TransformerNetwork } from './ml/transformer-network.ts'
import type { ObservationMode } from './observation.ts'
import type { TrainingConfig } from './training.ts'
import type { TrajectoryStep } from './ml/trajectory.ts'
import { WinrateNetwork, type WinrateNetworkConfig } from './ml/winrate-network.ts'

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

/**
 * ネットワークの重みを SharedArrayBuffer にパック（cloneWeights()経由）
 */
export function packWeights(network: AnyNetwork): SharedWeights {
  const namedWeights = network.cloneWeights()
  let totalLength = 0
  for (const w of namedWeights.values()) totalLength += w.length

  const buffer = new SharedArrayBuffer(totalLength * 4)  // Float32 = 4 bytes
  const view = new Float32Array(buffer)
  const layout: SharedWeights['layout'] = []
  let offset = 0

  for (const [name, w] of namedWeights) {
    layout.push({ name, offset, length: w.length })
    view.set(w, offset)
    offset += w.length
  }

  return { config: network.config, buffer, layout }
}

/** SharedArrayBuffer からネットワークに重みを展開 */
export function unpackWeights(network: AnyNetwork, shared: SharedWeights): void {
  const view = new Float32Array(shared.buffer)
  const weights = new Map<string, Float32Array>()

  for (const { name, offset, length } of shared.layout) {
    weights.set(name, new Float32Array(view.buffer, offset * 4, length))
  }

  network.loadWeights(weights)
}

/** SharedWeightsからネットワークを構築 */
export function buildNetworkFromShared(shared: SharedWeights, mode: ObservationMode | boolean = false): AnyNetwork {
  const net: AnyNetwork = new TransformerNetwork(shared.config, mode)
  unpackWeights(net, shared)
  return net
}

// ============================================================
// WRE (Win-Rate Estimator) 共有重み — 軽量 JSON-safe 形式
// ============================================================

/** WRE用の共有重み（~84KB、JSON-serializable） */
export type WreSharedWeights = {
  config: WinrateNetworkConfig
  weights: Record<string, number[]>
}

/** WinrateNetwork → WreSharedWeights */
export function packWreWeights(net: WinrateNetwork): WreSharedWeights {
  const weights: Record<string, number[]> = {}
  for (const [name, arr] of net.cloneWeights()) {
    weights[name] = Array.from(arr)
  }
  return { config: net.config, weights }
}

/** WreSharedWeights → WinrateNetwork */
export function unpackWreWeights(shared: WreSharedWeights): WinrateNetwork {
  const net = new WinrateNetwork(shared.config)
  const map = new Map<string, Float32Array>()
  for (const [name, arr] of Object.entries(shared.weights)) {
    map.set(name, new Float32Array(arr))
  }
  net.loadWeights(map)
  return net
}

// ============================================================
// Worker メッセージ型
// ============================================================

/** メインスレッド → Worker */
export type WorkerRequest = {
  type: 'generate'
  /** 各モデルグループのエージェント種別 (宣言的割り当て) */
  agentAssignment: import('./curriculum.ts').AgentAssignment
  /** 個人エージェントの重み（単一モデルモード） */
  weights: SharedWeights
  /** 狼チームの重み (Phase 2+) */
  wolfTeamWeights?: SharedWeights
  /** 共有者チームの重み (Phase 2+) */
  masonTeamWeights?: SharedWeights
  /** プール用過去チェックポイントの重み */
  poolWeights?: SharedWeights[]
  /** モデルグループ別の重み (Phase 2 マルチモデルモード、heuristicOnly グループは含まない) */
  modelGroupWeights?: Record<string, SharedWeights>
  /** ゲーム設定 (JSON-safe) */
  trainingConfig: TrainingConfig
  /** このバッチの seed 範囲 */
  seeds: number[]
  /** Phase: 1=heuristic, 2=self-play, 3=pool */
  phase: number
  /** Phase 1でMLにする役職 */
  mlRoles?: string[]
  /** MLにする最大席数 (カリキュラム学習用、未指定=制限なし) */
  mlMaxSeats?: number
  /** frozen村NNの重み (集団NN/狂信者の村NN出力注入用) */
  villageFrozenWeights?: SharedWeights
  /** Seed Bank スナップショットからリプレイ（seeds と同じ長さ、各ゲームに1つ） */
  snapshots?: import('../../lupa/types.ts').GameSnapshot[]
  /** frozen mason 個人NNの重み（Phase 1: mason席にfrozen戦略を注入） */
  frozenMasonWeights?: SharedWeights
  /** inspect サンプリング対象の seed リスト */
  inspectSeeds?: number[]
  /** Mason takeover: ML mason 死亡時に生存パートナーに strategy を移す */
  enableMasonTakeover?: boolean
  /** WRE PBRS: frozen勝率NNの重み（有効時のみ） */
  wreWeights?: WreSharedWeights
}

/** 1ゲーム分のタイミング情報 */
export type GameTiming = {
  totalMs: number
  gameMs: number
  retarMs: number
  retarCount: number
  inferMs: number
  inferCount: number
  tsumiMs: number
  tsumiCount: number
}

/** 1ゲーム分の結果 */
export type SerializedGameResult = {
  /** 個人エージェントのトラジェクトリ: seat → steps */
  individualSteps: Array<{ seat: number, role: string, steps: SerializedStep[] }>
  /** 狼チームのトラジェクトリ */
  wolfTeamSteps: SerializedStep[]
  /** 共有者チームのトラジェクトリ */
  masonTeamSteps: SerializedStep[]
  /** ゲーム結果 */
  result: string
  /** タイミング計測 */
  timing?: GameTiming
  /** inspect サンプリング: Howl テキスト */
  howl?: string
  /** inspect サンプリング: プレイヤー情報 */
  players?: Array<{ seat: number, role: string, alive: boolean }>
  /** inspect サンプリング: ゲーム seed */
  seed?: number
  /** inspect サンプリング: ゲーム長（日数） */
  gameLength?: number
  /** inspect サンプリング: 全プレイヤーの observation（日ごと） */
  allObservations?: Array<{ seat: number, role: string, day: number, observation: unknown, proposals?: unknown }>
}

/** Worker → メインスレッド */
export type WorkerResult = {
  type: 'result'
  games: SerializedGameResult[]
}

/** TrajectoryStep のシリアライズ形式（worker_threads メッセージ用） */
export type SerializedStep = {
  seat: number
  day?: number
  observation: number[]
  actionHead: string
  actionIdx: number
  logProb: number
  reward: number
  value: number
  done: boolean
  sigmoidActions?: number[]
  trueRoles?: number[]
  planActions?: number[]
  planLogProbs?: number[]
  source?: string
}

/** TrajectoryStep → SerializedStep */
export function serializeStep(step: TrajectoryStep): SerializedStep {
  return {
    seat: step.seat,
    day: step.day,
    observation: Array.from(step.observation),
    actionHead: step.actionHead,
    actionIdx: step.actionIdx,
    logProb: step.logProb,
    reward: step.reward,
    value: step.value,
    done: step.done,
    sigmoidActions: step.sigmoidActions ? Array.from(step.sigmoidActions) : undefined,
    trueRoles: step.trueRoles ? Array.from(step.trueRoles) : undefined,
    planActions: step.planActions,
    planLogProbs: step.planLogProbs,
    source: step.source,
  }
}

/** SerializedStep → TrajectoryStep */
export function deserializeStep(s: SerializedStep): TrajectoryStep {
  return {
    seat: s.seat,
    day: s.day,
    observation: new Float32Array(s.observation),
    actionHead: s.actionHead,
    actionIdx: s.actionIdx,
    logProb: s.logProb,
    reward: s.reward,
    value: s.value,
    done: s.done,
    sigmoidActions: s.sigmoidActions ? new Float32Array(s.sigmoidActions) : undefined,
    trueRoles: s.trueRoles ? new Float32Array(s.trueRoles) : undefined,
    planActions: s.planActions,
    planLogProbs: s.planLogProbs,
    source: s.source,
  }
}

// ============================================================
// ワーカープール管理
// ============================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const WORKER_PATH = join(__dirname, 'game-worker.ts')

let workerPool: Worker[] = []

export function initGameWorkerPool(numWorkers?: number): void {
  const n = numWorkers ?? Math.max(1, (availableParallelism?.() ?? 4) - 1)
  for (let i = 0; i < n; i++) {
    const w = new Worker(WORKER_PATH, {
      execArgv: ['--experimental-strip-types'],
    })
    workerPool.push(w)
  }
  console.error(`Game worker pool initialized: ${n} workers`)
}

export function terminateGameWorkerPool(): void {
  for (const w of workerPool) w.terminate()
  workerPool = []
}

export function gameWorkerPoolSize(): number {
  return workerPool.length
}

/**
 * ゲーム生成をワーカープールに分散
 * seeds を均等分割し、各ワーカーに配布。全結果を collect して返す。
 */
export function generateGamesParallel(
  request: Omit<WorkerRequest, 'type' | 'seeds'>,
  seeds: number[],
): Promise<SerializedGameResult[]> {
  const n = workerPool.length
  if (n === 0) throw new Error('Game worker pool not initialized')

  // seeds を均等分割
  const chunks: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < seeds.length; i++) {
    chunks[i % n].push(seeds[i])
  }

  return new Promise((resolve, reject) => {
    const allResults: SerializedGameResult[][] = new Array(n)
    let completed = 0
    let rejected = false

    for (let i = 0; i < n; i++) {
      if (chunks[i].length === 0) {
        allResults[i] = []
        completed++
        if (completed === n) resolve(allResults.flat())
        continue
      }

      const worker = workerPool[i]

      const onMessage = (result: WorkerResult) => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        allResults[i] = result.games
        completed++
        if (completed === n) resolve(allResults.flat())
      }

      const onError = (err: Error) => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        if (!rejected) {
          rejected = true
          reject(err)
        }
      }

      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.postMessage({ type: 'generate', ...request, seeds: chunks[i] } satisfies WorkerRequest)
    }
  })
}
