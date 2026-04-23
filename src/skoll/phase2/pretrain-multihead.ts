/**
 * Phase 2.5 consolidation — 各 role で全 method を 1 NN に join SL 学習する CLI。
 *
 * 入力: tmp/phase2-data-v1/{role}/{method}.jsonl (pretrain-all.ts と共通)
 * 出力: {outputDir}/{role}.json (10 役職分の multi-head checkpoint) + summary.json
 *
 * 仕様:
 * - `--role` 省略時は data-dir 下の全 role を順次学習
 * - `--skip-existing` で既存 checkpoint のある role を skip (再開可能)
 * - summary.json に per-role / per-method の bestEvalAcc を記録
 * - `--baseline-summary` で Phase 2 single-head の summary.json を指定すると diff を記録
 * - 失敗時は当該 role を skip して次へ
 *
 * usage:
 *   node --experimental-strip-types src/skoll/phase2/pretrain-multihead.ts \
 *     --data-dir tmp/phase2-data-v1 \
 *     --output-dir tmp/phase2-multihead-v1 \
 *     --baseline-summary tmp/phase2-pretrain-v1/summary.json \
 *     --epochs 20 --skip-existing
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  trainPhase2MultiHead,
  DEFAULT_MULTIHEAD_OPTIONS,
  METHOD_HEAD_MAP,
} from './trainer.ts'

type RoleStatus = 'ok' | 'skip_no_data' | 'skip_existing' | 'failed'

type PerMethodEntry = {
  samples: number
  trainSamples: number
  evalSamples: number
  bestEvalLoss: number
  bestEvalAcc: number
  /** Phase 2 single-head の同 (role, method) の bestEvalAcc (baseline-summary から) */
  baselineAcc?: number
  /** multi - baseline の符号付き差 (+ は改善、- は悪化) */
  accDiff?: number
}

type RoleResult = {
  role: string
  status: RoleStatus
  outputPath?: string
  bestEpoch?: number
  bestTotalEvalLoss?: number
  durationMs?: number
  perMethod?: Record<string, PerMethodEntry>
  error?: string
}

type CliOptions = {
  dataDir: string
  outputDir: string
  baselineSummary?: string
  epochs: number
  batchSize: number
  learningRate: number
  patience: number
  evalRatio: number
  seed: number
  skipExisting: boolean
  dryRun: boolean
  onlyRole?: string
  skipMethods: string[]
}

function parseCli(): CliOptions {
  const opts: CliOptions = {
    dataDir: 'tmp/phase2-data-v1',
    outputDir: 'tmp/phase2-multihead-v1',
    epochs: DEFAULT_MULTIHEAD_OPTIONS.epochs,
    batchSize: DEFAULT_MULTIHEAD_OPTIONS.batchSize,
    learningRate: DEFAULT_MULTIHEAD_OPTIONS.learningRate,
    patience: DEFAULT_MULTIHEAD_OPTIONS.patience,
    evalRatio: DEFAULT_MULTIHEAD_OPTIONS.evalRatio,
    seed: DEFAULT_MULTIHEAD_OPTIONS.seed,
    skipExisting: false,
    dryRun: false,
    skipMethods: [],
  }
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--data-dir':         opts.dataDir = args[++i]; break
      case '--output-dir':       opts.outputDir = args[++i]; break
      case '--baseline-summary': opts.baselineSummary = args[++i]; break
      case '--epochs':           opts.epochs = parseInt(args[++i], 10); break
      case '--batch':            opts.batchSize = parseInt(args[++i], 10); break
      case '--lr':               opts.learningRate = parseFloat(args[++i]); break
      case '--patience':         opts.patience = parseInt(args[++i], 10); break
      case '--eval-ratio':       opts.evalRatio = parseFloat(args[++i]); break
      case '--seed':             opts.seed = parseInt(args[++i], 10); break
      case '--skip-existing':    opts.skipExisting = true; break
      case '--dry-run':          opts.dryRun = true; break
      case '--role':             opts.onlyRole = args[++i]; break
      case '--skip-method':      opts.skipMethods.push(args[++i]); break
      default:
        if (args[i].startsWith('--')) {
          throw new Error(`unknown flag: ${args[i]}`)
        }
    }
  }
  return opts
}

/** data-dir 配下の role ディレクトリを列挙 (中身 jsonl を持つものだけ)。 */
function enumerateRoles(dataDir: string): string[] {
  const entries = readdirSync(dataDir).filter(r => {
    try { return statSync(join(dataDir, r)).isDirectory() } catch { return false }
  }).sort()
  const roles: string[] = []
  for (const role of entries) {
    // 何か 1 つでも method の jsonl があれば対象
    const methods = Object.keys(METHOD_HEAD_MAP)
    const hasAny = methods.some(m => {
      const p = join(dataDir, role, `${m}.jsonl`)
      try { return existsSync(p) && statSync(p).size > 0 } catch { return false }
    })
    if (hasAny) roles.push(role)
  }
  return roles
}

/** Phase 2 single-head summary.json を (role, method) → bestEvalAcc の map に変換 */
function loadBaselineAccMap(path: string): Map<string, number> {
  const map = new Map<string, number>()
  const data = JSON.parse(readFileSync(path, 'utf8')) as {
    results: Array<{ role: string, method: string, status: string, bestEvalAcc?: number }>
  }
  for (const r of data.results) {
    if (r.status === 'ok' && typeof r.bestEvalAcc === 'number') {
      map.set(`${r.role}/${r.method}`, r.bestEvalAcc)
    }
  }
  return map
}

function writeSummary(summaryPath: string, results: RoleResult[]): void {
  writeFileSync(summaryPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    results,
  }, null, 2))
}

async function main(): Promise<void> {
  const opts = parseCli()
  mkdirSync(opts.outputDir, { recursive: true })
  const summaryPath = join(opts.outputDir, 'summary.json')

  const baseline = opts.baselineSummary && existsSync(opts.baselineSummary)
    ? loadBaselineAccMap(opts.baselineSummary)
    : new Map<string, number>()

  const allRoles = enumerateRoles(opts.dataDir)
  const roles = opts.onlyRole ? allRoles.filter(r => r === opts.onlyRole) : allRoles

  process.stderr.write(`[pretrain-multihead] enumerated ${roles.length} roles from ${opts.dataDir}\n`)
  for (const r of roles) process.stderr.write(`  - ${r}\n`)

  if (opts.dryRun) {
    process.stderr.write(`[pretrain-multihead] dry-run: no training performed\n`)
    return
  }

  if (opts.baselineSummary) {
    process.stderr.write(`[pretrain-multihead] baseline: ${opts.baselineSummary} (${baseline.size} entries)\n`)
  }

  const results: RoleResult[] = []
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i]
    const outputPath = join(opts.outputDir, `${role}.json`)
    const header = `[pretrain-multihead ${i + 1}/${roles.length}] ${role}`

    if (opts.skipExisting && existsSync(outputPath)) {
      process.stderr.write(`${header} → skip (existing ${outputPath})\n`)
      results.push({ role, status: 'skip_existing', outputPath })
      writeSummary(summaryPath, results)
      continue
    }

    process.stderr.write(`${header} → training\n`)
    const t0 = Date.now()
    try {
      const r = await trainPhase2MultiHead({
        role,
        dataDir: opts.dataDir,
        outputCheckpointPath: outputPath,
        batchSize: opts.batchSize,
        epochs: opts.epochs,
        learningRate: opts.learningRate,
        evalRatio: opts.evalRatio,
        patience: opts.patience,
        seed: opts.seed,
        skipMethods: opts.skipMethods.length > 0 ? opts.skipMethods : undefined,
      })
      const durationMs = Date.now() - t0

      const perMethod: Record<string, PerMethodEntry> = {}
      for (const [method, m] of r.perMethod) {
        const baselineAcc = baseline.get(`${role}/${method}`)
        const entry: PerMethodEntry = {
          samples: m.samples,
          trainSamples: m.trainSamples,
          evalSamples: m.evalSamples,
          bestEvalLoss: m.bestEvalLoss,
          bestEvalAcc: m.bestEvalAcc,
        }
        if (baselineAcc !== undefined) {
          entry.baselineAcc = baselineAcc
          entry.accDiff = m.bestEvalAcc - baselineAcc
        }
        perMethod[method] = entry
      }

      results.push({
        role, status: 'ok', outputPath,
        bestEpoch: r.bestEpoch,
        bestTotalEvalLoss: r.bestTotalEvalLoss,
        durationMs, perMethod,
      })

      const diffSummary = Object.entries(perMethod)
        .map(([m, e]) => {
          if (e.accDiff === undefined) return `${m}=${e.bestEvalAcc.toFixed(3)}`
          const sign = e.accDiff >= 0 ? '+' : ''
          return `${m}=${e.bestEvalAcc.toFixed(3)}(${sign}${e.accDiff.toFixed(3)})`
        })
        .join(' ')
      process.stderr.write(
        `${header} ← done bestEpoch=${r.bestEpoch} (${(durationMs / 1000).toFixed(1)}s) ${diffSummary}\n`,
      )
    } catch (err) {
      const durationMs = Date.now() - t0
      const message = String((err as Error).message ?? err)
      results.push({ role, status: 'failed', outputPath, error: message, durationMs })
      process.stderr.write(`${header} ← FAILED: ${message}\n`)
    }
    writeSummary(summaryPath, results)
  }

  const ok = results.filter(r => r.status === 'ok').length
  const skipped = results.filter(r => r.status.startsWith('skip')).length
  const failed = results.filter(r => r.status === 'failed').length
  process.stderr.write(
    `[pretrain-multihead] DONE: ${ok} ok / ${skipped} skipped / ${failed} failed (summary: ${summaryPath})\n`,
  )
}

if (process.argv[1]?.endsWith('pretrain-multihead.ts')) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
