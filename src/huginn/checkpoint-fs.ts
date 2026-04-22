/**
 * checkpoint.ts の Node (node:fs) 依存部分を分離したモジュール.
 *
 * browser / web worker 環境では node:fs が無いため import すると即死する.
 * そこで save/load (ファイル書き出し/読み込み) のみをこのファイルに切り出し、
 * `src/huginn/checkpoint.ts` 本体は browser-safe (types + in-memory import/export) に保つ.
 *
 * 利用側:
 *   - `src/huginn/train.ts` (Node): 学習中の checkpoint 保存
 *   - `src/fenrir/src/huginn-orchestrator.ts` (Node): オーケストレータ
 *   - テスト群 (Node)
 *   - demo worker は `src/huginn/checkpoint.ts` から importWeights のみ使う (fetch 経由)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { TrainableNetwork, type TrainableConfig } from './trainable-network.ts'
import {
  CHECKPOINT_VERSION,
  exportWeights,
  importWeights,
  type HuginnCheckpoint,
} from './checkpoint.ts'

export function saveCheckpoint(network: TrainableNetwork, path: string): void {
  const checkpoint: HuginnCheckpoint = {
    version: CHECKPOINT_VERSION,
    config: { ...network.config },
    weights: exportWeights(network),
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(checkpoint))
}

export function loadCheckpoint(path: string): { network: TrainableNetwork; config: TrainableConfig } {
  const raw = readFileSync(path, 'utf-8')
  const checkpoint = JSON.parse(raw) as HuginnCheckpoint
  if (checkpoint.version !== CHECKPOINT_VERSION) {
    throw new Error(`loadCheckpoint: unsupported version ${checkpoint.version} (expected ${CHECKPOINT_VERSION})`)
  }
  const network = new TrainableNetwork(checkpoint.config)
  importWeights(network, checkpoint.weights)
  return { network, config: checkpoint.config }
}
