/**
 * TrainableNetwork の checkpoint save/load.
 *
 * ファイル形式 (fenrir 既存 phase2 と揃える):
 *   {
 *     "version": 1,
 *     "config": TrainableConfig,
 *     "weights": { "<name>.W": "<base64>", "<name>.b": "<base64>", ... }
 *   }
 *
 * 依存: node:fs のみ. huginn 独立モジュールの境界を保つ.
 * 重み名は stable (層構造に対応) にして backbone 流用時のキー一致を可能にする.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { TrainableNetwork, type TrainableConfig } from './trainable-network.ts'
import type { Linear, LayerNorm } from './transformer.ts'

export const CHECKPOINT_VERSION = 1

export type HuginnCheckpoint = {
  version: number
  config: TrainableConfig
  weights: Record<string, string>
}

// ============================================================
// base64 ↔ Float32Array (little-endian、Node/browser どちらでも動く)
// ============================================================

function encodeFloat32(arr: Float32Array): string {
  // Float32Array.buffer を直接 Buffer で包んで base64 へ.
  const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
  return Buffer.from(view).toString('base64')
}

function decodeFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  if (buf.byteLength % 4 !== 0) {
    throw new Error(`decodeFloat32: buffer length ${buf.byteLength} not divisible by 4`)
  }
  const out = new Float32Array(buf.byteLength / 4)
  for (let i = 0; i < out.length; i++) {
    out[i] = buf.readFloatLE(i * 4)
  }
  return out
}

// ============================================================
// Linear / LayerNorm の単体 collect/load
// ============================================================

function collectLinear(prefix: string, layer: Linear, out: Record<string, string>): void {
  out[`${prefix}.W`] = encodeFloat32(layer.weights)
  out[`${prefix}.b`] = encodeFloat32(layer.biases)
}

function loadLinear(prefix: string, layer: Linear, weights: Record<string, string>): void {
  const wKey = `${prefix}.W`
  const bKey = `${prefix}.b`
  if (!(wKey in weights)) throw new Error(`loadLinear: missing key ${wKey}`)
  if (!(bKey in weights)) throw new Error(`loadLinear: missing key ${bKey}`)
  const w = decodeFloat32(weights[wKey])
  const b = decodeFloat32(weights[bKey])
  if (w.length !== layer.weights.length) {
    throw new Error(`loadLinear ${prefix}: weights length mismatch (got ${w.length}, expected ${layer.weights.length})`)
  }
  if (b.length !== layer.biases.length) {
    throw new Error(`loadLinear ${prefix}: biases length mismatch (got ${b.length}, expected ${layer.biases.length})`)
  }
  layer.weights.set(w)
  layer.biases.set(b)
}

function collectLayerNorm(prefix: string, ln: LayerNorm, out: Record<string, string>): void {
  out[`${prefix}.scale`] = encodeFloat32(ln.scale)
  out[`${prefix}.bias`] = encodeFloat32(ln.bias)
}

function loadLayerNorm(prefix: string, ln: LayerNorm, weights: Record<string, string>): void {
  const sKey = `${prefix}.scale`
  const bKey = `${prefix}.bias`
  if (!(sKey in weights)) throw new Error(`loadLayerNorm: missing key ${sKey}`)
  if (!(bKey in weights)) throw new Error(`loadLayerNorm: missing key ${bKey}`)
  const s = decodeFloat32(weights[sKey])
  const b = decodeFloat32(weights[bKey])
  if (s.length !== ln.scale.length) {
    throw new Error(`loadLayerNorm ${prefix}: scale length mismatch (got ${s.length}, expected ${ln.scale.length})`)
  }
  if (b.length !== ln.bias.length) {
    throw new Error(`loadLayerNorm ${prefix}: bias length mismatch (got ${b.length}, expected ${ln.bias.length})`)
  }
  ln.scale.set(s)
  ln.bias.set(b)
}

// ============================================================
// TrainableNetwork 全体の export/import
// ============================================================

export function exportWeights(network: TrainableNetwork): Record<string, string> {
  const out: Record<string, string> = {}
  collectLinear('proj_cls', network.projCls, out)
  collectLinear('proj_agent', network.projAgent, out)
  for (let l = 0; l < network.encoder.blocks.length; l++) {
    const block = network.encoder.blocks[l]
    collectLayerNorm(`enc.block${l}.ln1`, block.ln1, out)
    collectLinear(`enc.block${l}.attn.wq`, block.attn.wq, out)
    collectLinear(`enc.block${l}.attn.wk`, block.attn.wk, out)
    collectLinear(`enc.block${l}.attn.wv`, block.attn.wv, out)
    collectLinear(`enc.block${l}.attn.wo`, block.attn.wo, out)
    collectLayerNorm(`enc.block${l}.ln2`, block.ln2, out)
    collectLinear(`enc.block${l}.ffn.fc1`, block.ffn.fc1, out)
    collectLinear(`enc.block${l}.ffn.fc2`, block.ffn.fc2, out)
  }
  collectLayerNorm('enc.finalLN', network.encoder.finalLN, out)
  collectLinear('head_message', network.headMessage, out)
  collectLinear('head_vote', network.headVote, out)
  collectLinear('head_value', network.headValue, out)
  return out
}

export function importWeights(network: TrainableNetwork, weights: Record<string, string>): void {
  loadLinear('proj_cls', network.projCls, weights)
  loadLinear('proj_agent', network.projAgent, weights)
  for (let l = 0; l < network.encoder.blocks.length; l++) {
    const block = network.encoder.blocks[l]
    loadLayerNorm(`enc.block${l}.ln1`, block.ln1, weights)
    loadLinear(`enc.block${l}.attn.wq`, block.attn.wq, weights)
    loadLinear(`enc.block${l}.attn.wk`, block.attn.wk, weights)
    loadLinear(`enc.block${l}.attn.wv`, block.attn.wv, weights)
    loadLinear(`enc.block${l}.attn.wo`, block.attn.wo, weights)
    loadLayerNorm(`enc.block${l}.ln2`, block.ln2, weights)
    loadLinear(`enc.block${l}.ffn.fc1`, block.ffn.fc1, weights)
    loadLinear(`enc.block${l}.ffn.fc2`, block.ffn.fc2, weights)
  }
  loadLayerNorm('enc.finalLN', network.encoder.finalLN, weights)
  loadLinear('head_message', network.headMessage, weights)
  loadLinear('head_vote', network.headVote, weights)
  loadLinear('head_value', network.headValue, weights)
}

// ============================================================
// save/load エントリポイント
// ============================================================

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
