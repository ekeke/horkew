/**
 * モデルチェックポイントの保存/読込
 * JSON + base64 Float32Array形式
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import type { AnyNetwork, NetworkConfig } from './nn.ts'
import { TransformerNetwork } from './transformer-network.ts'
import type { ObservationMode } from '../observation.ts'
import {
  OBSERVATION_SIZE, TEAM_OBSERVATION_SIZE,
  WOLF_COLLECTIVE_OBSERVATION_SIZE, MASON_COLLECTIVE_OBSERVATION_SIZE,
  FANATIC_OBSERVATION_SIZE,
} from '../observation.ts'

export type CheckpointData = {
  version: number
  config: NetworkConfig
  weights: Record<string, string>  // name → base64
  metadata: {
    iteration: number
    winRate: number
    timestamp: string
  }
}

function float32ToBase64(arr: Float32Array): string {
  const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
  return buf.toString('base64')
}

function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

export function saveCheckpoint(
  network: AnyNetwork,
  path: string,
  metadata: { iteration: number, winRate: number },
): void {
  const weights: Record<string, string> = {}
  for (const [name, arr] of network.cloneWeights()) {
    weights[name] = float32ToBase64(arr)
  }

  const data: CheckpointData = {
    version: 1,
    config: network.config,
    weights,
    metadata: {
      ...metadata,
      timestamp: new Date().toISOString(),
    },
  }

  const dir = path.substring(0, path.lastIndexOf('/'))
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(path, JSON.stringify(data))
}

export function loadCheckpoint(
  network: AnyNetwork,
  path: string,
): CheckpointData {
  const raw = readFileSync(path, 'utf-8')
  const data: CheckpointData = JSON.parse(raw)

  const weights = new Map<string, Float32Array>()
  for (const [name, b64] of Object.entries(data.weights)) {
    weights.set(name, base64ToFloat32(b64))
  }

  network.loadWeights(weights)
  return data
}

/**
 * config.inputSize から ObservationMode を自動判定。
 * 一致しないサイズは 'individual' にフォールバック。
 */
export function inferObservationMode(config: NetworkConfig): ObservationMode {
  switch (config.inputSize) {
    case MASON_COLLECTIVE_OBSERVATION_SIZE: return 'mason_collective'
    case WOLF_COLLECTIVE_OBSERVATION_SIZE: return 'wolf_collective'
    case FANATIC_OBSERVATION_SIZE: return 'fanatic'
    case TEAM_OBSERVATION_SIZE: return 'team'
    case OBSERVATION_SIZE: return 'individual'
    default: return 'individual'
  }
}

/**
 * チェックポイント単体から Pure JS TransformerNetwork を構築。
 * TF.js 非依存で動くため、ブラウザ/demo/推論専用パスで利用可。
 * training.ts の create*Network を介さないので config 定数の import も不要。
 *
 * @param mode ObservationMode (省略時は config.inputSize から自動判定)
 */
export function loadNetworkFromCheckpoint(
  path: string,
  mode?: ObservationMode,
): TransformerNetwork {
  const raw = readFileSync(path, 'utf-8')
  const data: CheckpointData = JSON.parse(raw)
  const resolvedMode = mode ?? inferObservationMode(data.config)
  const net = new TransformerNetwork(data.config, resolvedMode)
  const weights = new Map<string, Float32Array>()
  for (const [name, b64] of Object.entries(data.weights)) {
    weights.set(name, base64ToFloat32(b64))
  }
  net.loadWeights(weights)
  return net
}
