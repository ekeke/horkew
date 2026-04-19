/**
 * Stage 4: held-out 評価
 *
 * 学習に使ったゲームとは異なる seed 範囲で skoll 教師データを再収集し、
 * 学習済み NN の top-1 / top-3 accuracy を計測する。
 *
 * 3-way 勝率比較（skoll-mason vs NN-mason vs heuristic-mason）は別スコープ。
 */

import { collectAndSave } from './data-collector.ts'
import { createMasonBrainNetwork } from '../training.ts'
import { loadCheckpoint } from '../ml/checkpoint.ts'
import { SEATS } from '../observation.ts'
import { readFileSync } from 'node:fs'

export type EvalOptions = {
  checkpointPath: string
  /** held-out 用 seed (学習に使った範囲と被らないこと) */
  baseSeed: number
  numGames: number
  /** Stage 1 と同じ温度を使う（教師信号の性質を揃える） */
  temperature: number
  /** held-out サンプル JSONL の出力先 */
  samplesOutputPath: string
}

export const DEFAULT_EVAL_OPTIONS: EvalOptions = {
  checkpointPath: 'tmp/skoll-trainer/ckpt-skoll/checkpoint.json',
  baseSeed: 99000,
  numGames: 50,
  temperature: 0.3,
  samplesOutputPath: 'tmp/skoll-eval/heldout-samples.jsonl',
}

function argmax(arr: Float32Array): number {
  let bestIdx = 0
  let bestVal = arr[0]
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > bestVal) { bestVal = arr[i]; bestIdx = i }
  }
  return bestIdx
}

export async function evaluateCheckpoint(opts: Partial<EvalOptions> = {}): Promise<{
  numSamples: number
  top1: number
  top3: number
  /** 同点を許容した top-1: NN argmax が skoll の top-margin 内に入っていれば正解 */
  top1WithTies: number
}> {
  const options = { ...DEFAULT_EVAL_OPTIONS, ...opts }

  process.stderr.write(`[skoll-eval] collecting held-out samples (seed ${options.baseSeed}..)\n`)
  await collectAndSave({
    numGames: options.numGames,
    baseSeed: options.baseSeed,
    temperature: options.temperature,
    outputPath: options.samplesOutputPath,
  })

  process.stderr.write(`[skoll-eval] loading checkpoint ${options.checkpointPath}\n`)
  const net = createMasonBrainNetwork()
  loadCheckpoint(net, options.checkpointPath)

  const raw = readFileSync(options.samplesOutputPath, 'utf8')
  const lines = raw.split('\n').filter(l => l.length > 0)

  let totalTop1 = 0
  let totalTop3 = 0
  let totalTop1WithTies = 0
  let total = 0

  for (const line of lines) {
    const obj = JSON.parse(line)
    const obs = Float32Array.from(obj.observation as number[])
    const label = Float32Array.from(obj.label as number[])
    const mask = Float32Array.from(obj.mask as number[])
    const rawWinRates = obj.metadata.rawWinRates as Array<{ seat: number, winRate: number }>

    const fwd = net.forward(obs)
    const voteLogits = fwd.policies.get('vote')
    if (!voteLogits) continue

    const masked = new Float32Array(SEATS)
    for (let i = 0; i < SEATS; i++) masked[i] = voteLogits[i] + mask[i]

    const labelIdx = argmax(label)
    const predIdx = argmax(masked)
    if (predIdx === labelIdx) totalTop1++

    const ranked = Array.from({ length: SEATS }, (_, i) => i).sort((a, b) => masked[b] - masked[a])
    if (ranked.slice(0, 3).includes(labelIdx)) totalTop3++

    // 同点許容: pred の winRate が skoll の最大 winRate と (ほぼ) 等しいか
    const predSeat = predIdx + 1
    const predWinRate = rawWinRates.find(r => r.seat === predSeat)?.winRate
    if (predWinRate !== undefined) {
      const maxWinRate = Math.max(...rawWinRates.map(r => r.winRate))
      if (Math.abs(predWinRate - maxWinRate) < 1e-6) totalTop1WithTies++
    }

    total++
  }

  const result = {
    numSamples: total,
    top1: total > 0 ? totalTop1 / total : 0,
    top3: total > 0 ? totalTop3 / total : 0,
    top1WithTies: total > 0 ? totalTop1WithTies / total : 0,
  }

  process.stderr.write(`[skoll-eval] === Result ===\n`)
  process.stderr.write(`[skoll-eval] samples: ${result.numSamples}\n`)
  process.stderr.write(`[skoll-eval] top1 (strict):     ${result.top1.toFixed(3)}\n`)
  process.stderr.write(`[skoll-eval] top1 (with ties): ${result.top1WithTies.toFixed(3)}\n`)
  process.stderr.write(`[skoll-eval] top3:              ${result.top3.toFixed(3)}\n`)

  return result
}

function parseCli(): Partial<EvalOptions> {
  const opts: Partial<EvalOptions> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--checkpoint': opts.checkpointPath = args[++i]; break
      case '--seed': opts.baseSeed = parseInt(args[++i], 10); break
      case '--games': opts.numGames = parseInt(args[++i], 10); break
      case '--temperature': opts.temperature = parseFloat(args[++i]); break
      case '--samples-output': opts.samplesOutputPath = args[++i]; break
      case '--help':
        process.stderr.write('Usage: eval.ts [--checkpoint PATH] [--seed S] [--games N] [--temperature T] [--samples-output PATH]\n')
        process.exit(0)
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('eval.ts')) {
  evaluateCheckpoint(parseCli()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
