/**
 * TrainableNetwork の checkpoint 形式定義 + in-memory import/export (browser-safe).
 *
 * ファイル形式 (fenrir 既存 phase2 と揃える):
 *   {
 *     "version": 1,
 *     "config": TrainableConfig,
 *     "weights": { "<name>.W": "<base64>", "<name>.b": "<base64>", ... }
 *   }
 *
 * このファイルは browser / web worker からも import 可 (node:fs 非依存).
 * ファイル save/load の fs 依存部は `./checkpoint-fs.ts` に切り出してある.
 * 重み名は stable (層構造に対応) にして backbone 流用時のキー一致を可能にする.
 */

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
// Node 16+ / modern browser で atob / btoa が globalThis に存在する前提.
// Buffer には依存しないので browser / web worker でも loadCheckpoint できる.
// ============================================================

function encodeFloat32(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
  let binary = ''
  // String.fromCharCode を 0x8000 ずつチャンクで呼ぶ (大きい Float32Array で stack overflow を防ぐ)
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    binary += String.fromCharCode.apply(null, Array.from(slice))
  }
  return btoa(binary)
}

function decodeFloat32(b64: string): Float32Array {
  const binary = atob(b64)
  if (binary.length % 4 !== 0) {
    throw new Error(`decodeFloat32: byte length ${binary.length} not divisible by 4`)
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  // bytes.buffer の byteOffset が 4 の倍数とは限らないので DataView で安全に読む.
  const out = new Float32Array(bytes.byteLength / 4)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true)
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

// save/load (fs 依存) は `./checkpoint-fs.ts` を使う — このファイルは browser-safe に保つ.
// TrainableConfig を使わない場合でも型を上位へ re-export できるよう明示する.
export type { TrainableConfig }
