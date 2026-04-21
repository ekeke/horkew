/**
 * Phase 2 SL pretrain の (observation, action) サンプル集約と JSONL ダンプ。
 *
 * 各 (role, method) ペアごとに FIFO でサンプルを貯めて JSONL で書き出す。
 * SoftLabel はなく、action は単一 integer (softmax) または Float32Array (sigmoid multi-hot)。
 * observation は Float32Array、JSONL では number[] として記録する。
 */
import { mkdirSync, existsSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type SampleMeta = {
  gameId: number
  day: number
  seat: number
  alive: number  // 1-based bitmask
}

export type Sample = {
  role: string
  method: string  // 'claim' | 'comm' | 'leader' | 'propose' | 'predict' | 'target'
  obs: Float32Array
  /** softmax head の場合は action index (number)、sigmoid head は multi-hot (Float32Array) */
  action: number | Float32Array
  meta: SampleMeta
}

export class SampleCollector {
  private samples: Map<string, Sample[]> = new Map()

  key(role: string, method: string): string {
    return `${role}/${method}`
  }

  add(role: string, method: string, obs: Float32Array, action: number | Float32Array, meta: SampleMeta): void {
    const k = this.key(role, method)
    let bucket = this.samples.get(k)
    if (!bucket) {
      bucket = []
      this.samples.set(k, bucket)
    }
    bucket.push({ role, method, obs, action, meta })
  }

  /** role/method ごとの件数 (debug / progress 用) */
  counts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [k, v] of this.samples) out[k] = v.length
    return out
  }

  /** 全サンプルを {outputDir}/{role}/{method}.jsonl にダンプ */
  writeJsonl(outputDir: string): void {
    for (const [k, bucket] of this.samples) {
      if (bucket.length === 0) continue
      const [role, method] = k.split('/')
      const path = `${outputDir}/${role}/${method}.jsonl`
      if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
      const lines = bucket.map(s => JSON.stringify(sampleToJson(s)))
      writeFileSync(path, lines.join('\n') + '\n')
    }
  }

  /** append モードで 1 件ずつ書き出す場合用 */
  appendOne(outputDir: string, sample: Sample): void {
    const path = `${outputDir}/${sample.role}/${sample.method}.jsonl`
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(sampleToJson(sample)) + '\n')
  }

  clear(): void {
    this.samples.clear()
  }

  totalSize(): number {
    let n = 0
    for (const v of this.samples.values()) n += v.length
    return n
  }
}

function sampleToJson(s: Sample): unknown {
  const actionField = typeof s.action === 'number'
    ? { actionIdx: s.action }
    : { actionVec: Array.from(s.action) }
  return {
    role: s.role,
    method: s.method,
    obs: Array.from(s.obs),
    ...actionField,
    meta: s.meta,
  }
}
