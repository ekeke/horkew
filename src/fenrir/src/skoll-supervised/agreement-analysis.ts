/**
 * raw-skoll vs nn-skoll の一致率 詳細 breakdown
 *
 * eval.ts と同じデータ（held-out JSONL）を読んで、以下の切り口で集計:
 *   - 全体: top1, top1WithTies, top3
 *   - day 別 (1, 2, 3, ...)
 *   - alive 別 (12-13, 10-11, 8-9, 7)
 *   - topMargin 別 (=0 / 0-0.05 / 0.05-0.1 / >0.1)
 *
 * skoll を完全コピーしたい時、どこで NN が苦戦しているか見るため。
 */

import { readFileSync } from 'node:fs'

import { createMasonBrainNetwork } from '../training.ts'
import { loadCheckpoint } from '../ml/checkpoint.ts'
import { SEATS } from '../observation.ts'

type Sample = {
  observation: Float32Array
  label: Float32Array
  mask: Float32Array
  metadata: {
    day: number
    aliveCount: number
    topMargin: number
    rawWinRates: Array<{ seat: number, winRate: number }>
    bestExecution: number
  }
}

type Bucket = {
  name: string
  predicate: (s: Sample) => boolean
}

function loadJsonl(path: string): Sample[] {
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n').filter(l => l.length > 0)
  return lines.map(line => {
    const obj = JSON.parse(line)
    return {
      observation: Float32Array.from(obj.observation),
      label: Float32Array.from(obj.label),
      mask: Float32Array.from(obj.mask),
      metadata: obj.metadata,
    }
  })
}

function argmax(arr: Float32Array): number {
  let bestIdx = 0
  let bestVal = arr[0]
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > bestVal) { bestVal = arr[i]; bestIdx = i }
  }
  return bestIdx
}

type Stats = { count: number, top1: number, top1WithTies: number, top3: number }

function evalBucket(net: ReturnType<typeof createMasonBrainNetwork>, samples: Sample[]): Stats {
  let total = 0, t1 = 0, t1Ties = 0, t3 = 0
  for (const s of samples) {
    const fwd = net.forward(s.observation)
    const voteLogits = fwd.policies.get('vote')
    if (!voteLogits) continue

    const masked = new Float32Array(SEATS)
    for (let i = 0; i < SEATS; i++) masked[i] = voteLogits[i] + s.mask[i]

    const labelIdx = argmax(s.label)
    const predIdx = argmax(masked)
    if (predIdx === labelIdx) t1++

    const ranked = Array.from({ length: SEATS }, (_, i) => i).sort((a, b) => masked[b] - masked[a])
    if (ranked.slice(0, 3).includes(labelIdx)) t3++

    // top1WithTies: pred の rawWinRate が skoll の最大と一致
    const predSeat = predIdx + 1
    const predWinRate = s.metadata.rawWinRates.find(r => r.seat === predSeat)?.winRate
    if (predWinRate !== undefined) {
      const maxRate = Math.max(...s.metadata.rawWinRates.map(r => r.winRate))
      if (Math.abs(predWinRate - maxRate) < 1e-6) t1Ties++
    }

    total++
  }
  return {
    count: total,
    top1: total > 0 ? t1 / total : 0,
    top1WithTies: total > 0 ? t1Ties / total : 0,
    top3: total > 0 ? t3 / total : 0,
  }
}

export async function runAgreementAnalysis(checkpointPath: string, samplesPath: string): Promise<void> {
  process.stderr.write(`[agreement] loading checkpoint ${checkpointPath}\n`)
  const net = createMasonBrainNetwork()
  loadCheckpoint(net, checkpointPath)

  process.stderr.write(`[agreement] loading samples ${samplesPath}\n`)
  const samples = loadJsonl(samplesPath)
  process.stderr.write(`[agreement] ${samples.length} samples loaded\n\n`)

  const overall = evalBucket(net, samples)
  process.stderr.write(`=== Overall ===\n`)
  process.stderr.write(`  count=${overall.count}  top1=${(overall.top1 * 100).toFixed(1)}%  top1WithTies=${(overall.top1WithTies * 100).toFixed(1)}%  top3=${(overall.top3 * 100).toFixed(1)}%\n\n`)

  const dayBuckets: Bucket[] = []
  const days = [...new Set(samples.map(s => s.metadata.day))].sort((a, b) => a - b)
  for (const d of days) {
    dayBuckets.push({ name: `day=${d}`, predicate: s => s.metadata.day === d })
  }
  process.stderr.write(`=== By day ===\n`)
  for (const b of dayBuckets) {
    const subset = samples.filter(b.predicate)
    if (subset.length === 0) continue
    const s = evalBucket(net, subset)
    process.stderr.write(`  ${b.name.padEnd(10)} count=${String(s.count).padStart(4)}  top1=${(s.top1 * 100).toFixed(1)}%  top1WithTies=${(s.top1WithTies * 100).toFixed(1)}%  top3=${(s.top3 * 100).toFixed(1)}%\n`)
  }

  process.stderr.write(`\n=== By alive count ===\n`)
  const aliveBuckets: Bucket[] = [
    { name: 'alive=12-13', predicate: s => s.metadata.aliveCount >= 12 },
    { name: 'alive=10-11', predicate: s => s.metadata.aliveCount >= 10 && s.metadata.aliveCount < 12 },
    { name: 'alive=8-9',   predicate: s => s.metadata.aliveCount >= 8 && s.metadata.aliveCount < 10 },
    { name: 'alive=7',     predicate: s => s.metadata.aliveCount === 7 },
  ]
  for (const b of aliveBuckets) {
    const subset = samples.filter(b.predicate)
    if (subset.length === 0) continue
    const s = evalBucket(net, subset)
    process.stderr.write(`  ${b.name.padEnd(12)} count=${String(s.count).padStart(4)}  top1=${(s.top1 * 100).toFixed(1)}%  top1WithTies=${(s.top1WithTies * 100).toFixed(1)}%  top3=${(s.top3 * 100).toFixed(1)}%\n`)
  }

  process.stderr.write(`\n=== By topMargin (skoll の決定的さ) ===\n`)
  const marginBuckets: Bucket[] = [
    { name: 'margin=0',        predicate: s => s.metadata.topMargin < 1e-6 },
    { name: 'margin<0.05',     predicate: s => s.metadata.topMargin >= 1e-6 && s.metadata.topMargin < 0.05 },
    { name: 'margin 0.05-0.1', predicate: s => s.metadata.topMargin >= 0.05 && s.metadata.topMargin < 0.1 },
    { name: 'margin >=0.1',    predicate: s => s.metadata.topMargin >= 0.1 },
  ]
  for (const b of marginBuckets) {
    const subset = samples.filter(b.predicate)
    if (subset.length === 0) continue
    const s = evalBucket(net, subset)
    process.stderr.write(`  ${b.name.padEnd(20)} count=${String(s.count).padStart(4)}  top1=${(s.top1 * 100).toFixed(1)}%  top1WithTies=${(s.top1WithTies * 100).toFixed(1)}%  top3=${(s.top3 * 100).toFixed(1)}%\n`)
  }
}

function parseCli(): { checkpoint: string, samples: string } {
  const args = process.argv.slice(2)
  let checkpoint = 'tmp/skoll-mb/phases/00-skoll-supervised/ckpt-mason_collective/collective_final.json'
  let samples = 'tmp/skoll-mb/phases/00-skoll-supervised/data/heldout-samples.jsonl'
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--checkpoint': checkpoint = args[++i]; break
      case '--samples': samples = args[++i]; break
      case '--help':
        process.stderr.write('Usage: agreement-analysis.ts [--checkpoint PATH] [--samples PATH]\n')
        process.exit(0)
    }
  }
  return { checkpoint, samples }
}

if (process.argv[1]?.endsWith('agreement-analysis.ts')) {
  const { checkpoint, samples } = parseCli()
  runAgreementAnalysis(checkpoint, samples).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
