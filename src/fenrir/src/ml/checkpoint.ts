/**
 * モデルチェックポイントの保存/読込
 * JSON + base64 Float32Array形式
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import type { NeuralNetwork, NetworkConfig } from './nn.ts'

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
  network: NeuralNetwork,
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
  network: NeuralNetwork,
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
