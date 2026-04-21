/**
 * Phase 2 本番 pretrain (M5) — 全 role × method を順次学習する CLI。
 *
 * 入力: tmp/phase2-data-v1/{role}/{method}.jsonl (runner.ts が 1000 games で収集済)
 * 出力: {outputDir}/{role}-{method}.json (独立 checkpoint) + summary.json
 *
 * 仕様:
 * - データ無しの組合せは skip
 * - `--skip-existing` で既存 checkpoint のある組合せを skip (再開可能)
 * - 各組合せの結果 (bestEpoch / bestEvalLoss / bestEvalAcc / status) を summary.json に追記
 * - 失敗時は当該組合せを skip して次へ (全体 abort しない)
 *
 * usage:
 *   node --experimental-strip-types src/skoll/phase2/pretrain-all.ts \
 *     --data-dir tmp/phase2-data-v1 \
 *     --output-dir tmp/phase2-pretrain-v1 \
 *     --epochs 20 --skip-existing
 */

import { existsSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { trainPhase2Head, METHOD_HEAD_MAP, DEFAULT_TRAINER_OPTIONS } from './trainer.ts'

type ComboStatus = 'ok' | 'skip_no_data' | 'skip_existing' | 'failed'

type ComboResult = {
  role: string
  method: string
  status: ComboStatus
  inputPath?: string
  outputPath?: string
  samples?: number
  bestEpoch?: number
  bestEvalLoss?: number
  bestEvalAcc?: number
  error?: string
  durationMs?: number
}

type CliOptions = {
  dataDir: string
  outputDir: string
  epochs: number
  batchSize: number
  learningRate: number
  patience: number
  evalRatio: number
  seed: number
  skipExisting: boolean
  dryRun: boolean
  /** 単一組合せだけテスト実行したい場合 (smoke 用) */
  onlyRole?: string
  onlyMethod?: string
}

function parseCli(): CliOptions {
  const opts: CliOptions = {
    dataDir: 'tmp/phase2-data-v1',
    outputDir: 'tmp/phase2-pretrain-v1',
    epochs: DEFAULT_TRAINER_OPTIONS.epochs,
    batchSize: DEFAULT_TRAINER_OPTIONS.batchSize,
    learningRate: DEFAULT_TRAINER_OPTIONS.learningRate,
    patience: DEFAULT_TRAINER_OPTIONS.patience,
    evalRatio: DEFAULT_TRAINER_OPTIONS.evalRatio,
    seed: DEFAULT_TRAINER_OPTIONS.seed,
    skipExisting: false,
    dryRun: false,
  }
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--data-dir':      opts.dataDir = args[++i]; break
      case '--output-dir':    opts.outputDir = args[++i]; break
      case '--epochs':        opts.epochs = parseInt(args[++i], 10); break
      case '--batch':         opts.batchSize = parseInt(args[++i], 10); break
      case '--lr':            opts.learningRate = parseFloat(args[++i]); break
      case '--patience':      opts.patience = parseInt(args[++i], 10); break
      case '--eval-ratio':    opts.evalRatio = parseFloat(args[++i]); break
      case '--seed':          opts.seed = parseInt(args[++i], 10); break
      case '--skip-existing': opts.skipExisting = true; break
      case '--dry-run':       opts.dryRun = true; break
      case '--only-role':     opts.onlyRole = args[++i]; break
      case '--only-method':   opts.onlyMethod = args[++i]; break
      default:
        if (args[i].startsWith('--')) {
          throw new Error(`unknown flag: ${args[i]}`)
        }
    }
  }
  return opts
}

/** data-dir 配下の全 (role, method) を列挙。method は METHOD_HEAD_MAP にあるものだけ。 */
function enumerateCombos(dataDir: string): Array<{ role: string, method: string, inputPath: string, samples: number }> {
  const out: Array<{ role: string, method: string, inputPath: string, samples: number }> = []
  const roles = readdirSync(dataDir).filter(r => {
    try { return statSync(join(dataDir, r)).isDirectory() } catch { return false }
  }).sort()
  const methods = Object.keys(METHOD_HEAD_MAP).sort()
  for (const role of roles) {
    for (const method of methods) {
      const inputPath = join(dataDir, role, `${method}.jsonl`)
      if (!existsSync(inputPath)) continue
      const size = statSync(inputPath).size
      if (size === 0) continue
      out.push({ role, method, inputPath, samples: -1 })  // samples は実学習時に判明
    }
  }
  return out
}

function appendSummary(summaryPath: string, results: ComboResult[]): void {
  writeFileSync(summaryPath, JSON.stringify({ updatedAt: new Date().toISOString(), results }, null, 2))
}

async function main(): Promise<void> {
  const opts = parseCli()
  mkdirSync(opts.outputDir, { recursive: true })
  const summaryPath = join(opts.outputDir, 'summary.json')

  const combos = enumerateCombos(opts.dataDir)
    .filter(c => !opts.onlyRole || c.role === opts.onlyRole)
    .filter(c => !opts.onlyMethod || c.method === opts.onlyMethod)

  process.stderr.write(`[pretrain-all] enumerated ${combos.length} combos from ${opts.dataDir}\n`)
  for (const c of combos) process.stderr.write(`  - ${c.role}/${c.method}\n`)

  if (opts.dryRun) {
    process.stderr.write(`[pretrain-all] dry-run: no training performed\n`)
    return
  }

  const results: ComboResult[] = []
  for (let i = 0; i < combos.length; i++) {
    const c = combos[i]
    const outputPath = join(opts.outputDir, `${c.role}-${c.method}.json`)
    const header = `[pretrain-all ${i + 1}/${combos.length}] ${c.role}/${c.method}`

    if (opts.skipExisting && existsSync(outputPath)) {
      process.stderr.write(`${header} → skip (existing ${outputPath})\n`)
      results.push({
        role: c.role, method: c.method, status: 'skip_existing',
        inputPath: c.inputPath, outputPath,
      })
      appendSummary(summaryPath, results)
      continue
    }

    process.stderr.write(`${header} → training\n`)
    const t0 = Date.now()
    try {
      const r = await trainPhase2Head({
        role: c.role,
        method: c.method,
        inputJsonl: c.inputPath,
        outputCheckpointPath: outputPath,
        batchSize: opts.batchSize,
        epochs: opts.epochs,
        learningRate: opts.learningRate,
        evalRatio: opts.evalRatio,
        patience: opts.patience,
        seed: opts.seed,
      })
      const durationMs = Date.now() - t0
      results.push({
        role: c.role, method: c.method, status: 'ok',
        inputPath: c.inputPath, outputPath,
        bestEpoch: r.bestEpoch,
        bestEvalLoss: r.bestEvalLoss,
        bestEvalAcc: r.bestEvalAcc,
        durationMs,
      })
      process.stderr.write(
        `${header} ← done bestEpoch=${r.bestEpoch} bestEvalAcc=${r.bestEvalAcc.toFixed(3)} ` +
        `(${(durationMs / 1000).toFixed(1)}s)\n`,
      )
    } catch (err) {
      const durationMs = Date.now() - t0
      const message = String((err as Error).message ?? err)
      results.push({
        role: c.role, method: c.method, status: 'failed',
        inputPath: c.inputPath, outputPath,
        error: message, durationMs,
      })
      process.stderr.write(`${header} ← FAILED: ${message}\n`)
    }
    appendSummary(summaryPath, results)
  }

  // 完了サマリ
  const ok = results.filter(r => r.status === 'ok').length
  const skipped = results.filter(r => r.status.startsWith('skip')).length
  const failed = results.filter(r => r.status === 'failed').length
  process.stderr.write(
    `[pretrain-all] DONE: ${ok} ok / ${skipped} skipped / ${failed} failed (summary: ${summaryPath})\n`,
  )
}

if (process.argv[1]?.endsWith('pretrain-all.ts')) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
