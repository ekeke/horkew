/**
 * skoll-zero-pretrain curriculum runner — fenrir orchestrate から呼ばれる entry point。
 *
 * Phase 2.5 multi-head consolidation: 役職別 10 NN に per-method pretrain データを join SL。
 *
 * phase-indexed layout:
 *   {checkpointBase}/phases/00-skoll-zero-pretrain/
 *     {role}/final.json       — checkpoint (role 別 multi-head NN)
 *     phase.done              — 完了マーカー
 *     phase-summary.json      — per-role baseline diff + per-method acc
 *     role-{role}.log         — role 別学習ログ (stderr redirect、option)
 *
 * 完了条件: 全 10 役職が final.json を持つ、または phase.done が既存 (再実行で skip)。
 * resume: 既存 {role}/final.json があれば役職粒度で skip。
 *
 * 環境変数 override:
 *   SKOLLZP_DATA_DIR       (default: tmp/phase2-data-v1)
 *   SKOLLZP_BASELINE       (default: tmp/phase2-pretrain-v1/summary.json、無くても可)
 *   SKOLLZP_EPOCHS, SKOLLZP_PATIENCE, SKOLLZP_BATCH, SKOLLZP_LR, SKOLLZP_EVAL_RATIO, SKOLLZP_SEED
 *   SKOLLZP_ONLY_ROLE      (debug 用: 単一役職のみ実行)
 *   SKOLLZP_SKIP_METHODS   (comma-separated)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  trainPhase2MultiHead,
  DEFAULT_MULTIHEAD_OPTIONS,
  METHOD_HEAD_MAP,
} from './trainer.ts'

const ROLES = [
  'bodyguard', 'fanatic', 'immoralist', 'mason', 'medium',
  'nekomata', 'seer', 'villager', 'werehamster', 'werewolf',
] as const

export type SkollZeroPretrainOptions = {
  checkpointBase: string
  dataDir: string
  baselineSummary?: string
  batchSize: number
  epochs: number
  learningRate: number
  evalRatio: number
  patience: number
  seed: number
  onlyRole?: string
  skipMethods: string[]
}

export const DEFAULT_SKOLL_ZERO_PRETRAIN_OPTIONS: SkollZeroPretrainOptions = {
  checkpointBase: '',
  dataDir: 'tmp/phase2-data-v1',
  baselineSummary: 'tmp/phase2-pretrain-v1/summary.json',
  batchSize: DEFAULT_MULTIHEAD_OPTIONS.batchSize,
  epochs: DEFAULT_MULTIHEAD_OPTIONS.epochs,
  learningRate: DEFAULT_MULTIHEAD_OPTIONS.learningRate,
  evalRatio: DEFAULT_MULTIHEAD_OPTIONS.evalRatio,
  patience: DEFAULT_MULTIHEAD_OPTIONS.patience,
  seed: DEFAULT_MULTIHEAD_OPTIONS.seed,
  skipMethods: [],
}

function envOverrides(): Partial<SkollZeroPretrainOptions> {
  const out: Partial<SkollZeroPretrainOptions> = {}
  if (process.env.SKOLLZP_DATA_DIR) out.dataDir = process.env.SKOLLZP_DATA_DIR
  if (process.env.SKOLLZP_BASELINE) out.baselineSummary = process.env.SKOLLZP_BASELINE
  if (process.env.SKOLLZP_EPOCHS) out.epochs = parseInt(process.env.SKOLLZP_EPOCHS, 10)
  if (process.env.SKOLLZP_PATIENCE) out.patience = parseInt(process.env.SKOLLZP_PATIENCE, 10)
  if (process.env.SKOLLZP_BATCH) out.batchSize = parseInt(process.env.SKOLLZP_BATCH, 10)
  if (process.env.SKOLLZP_LR) out.learningRate = parseFloat(process.env.SKOLLZP_LR)
  if (process.env.SKOLLZP_EVAL_RATIO) out.evalRatio = parseFloat(process.env.SKOLLZP_EVAL_RATIO)
  if (process.env.SKOLLZP_SEED) out.seed = parseInt(process.env.SKOLLZP_SEED, 10)
  if (process.env.SKOLLZP_ONLY_ROLE) out.onlyRole = process.env.SKOLLZP_ONLY_ROLE
  if (process.env.SKOLLZP_SKIP_METHODS) out.skipMethods = process.env.SKOLLZP_SKIP_METHODS.split(',').map(s => s.trim()).filter(s => s.length > 0)
  return out
}

function log(msg: string): void {
  process.stderr.write(`[skoll-zero-pretrain] ${msg}\n`)
}

type PerMethodSummary = {
  samples: number
  trainSamples: number
  evalSamples: number
  bestEvalLoss: number
  bestEvalAcc: number
  baselineAcc?: number
  accDiff?: number
}

type RoleSummary = {
  role: string
  status: 'ok' | 'skip_no_data' | 'skip_existing' | 'failed'
  bestEpoch?: number
  bestTotalEvalLoss?: number
  durationMs?: number
  perMethod?: Record<string, PerMethodSummary>
  error?: string
}

function loadBaselineAccMap(path: string): Map<string, number> {
  const map = new Map<string, number>()
  if (!existsSync(path)) return map
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      results: Array<{ role: string, method: string, status: string, bestEvalAcc?: number }>
    }
    for (const r of data.results) {
      if (r.status === 'ok' && typeof r.bestEvalAcc === 'number') {
        map.set(`${r.role}/${r.method}`, r.bestEvalAcc)
      }
    }
  } catch (err) {
    log(`WARN: failed to parse baseline ${path}: ${String((err as Error).message ?? err)}`)
  }
  return map
}

function writeSummary(phaseDir: string, started: string, options: SkollZeroPretrainOptions, roles: RoleSummary[]): void {
  writeFileSync(join(phaseDir, 'phase-summary.json'), JSON.stringify({
    started,
    updatedAt: new Date().toISOString(),
    options: {
      dataDir: options.dataDir,
      baselineSummary: options.baselineSummary,
      epochs: options.epochs,
      batchSize: options.batchSize,
      learningRate: options.learningRate,
      patience: options.patience,
      evalRatio: options.evalRatio,
      seed: options.seed,
    },
    roles,
  }, null, 2))
}

function anyMethodHasData(dataDir: string, role: string): boolean {
  const methods = Object.keys(METHOD_HEAD_MAP)
  return methods.some(m => {
    const p = join(dataDir, role, `${m}.jsonl`)
    try {
      if (!existsSync(p)) return false
      return readFileSync(p, 'utf8').length > 0
    } catch { return false }
  })
}

export async function runSkollZeroPretrain(opts: Partial<SkollZeroPretrainOptions> = {}): Promise<void> {
  const options: SkollZeroPretrainOptions = {
    ...DEFAULT_SKOLL_ZERO_PRETRAIN_OPTIONS,
    ...opts,
    ...envOverrides(),
  }
  if (!options.checkpointBase) throw new Error('skoll-zero-pretrain: checkpointBase is required')

  const phaseDir = join(options.checkpointBase, 'phases', '00-skoll-zero-pretrain')
  mkdirSync(phaseDir, { recursive: true })

  const doneFile = join(phaseDir, 'phase.done')
  if (existsSync(doneFile)) {
    log(`phase already done (${doneFile}). Delete to re-run.`)
    return
  }

  const started = new Date().toISOString()
  log(`output: ${phaseDir}`)
  log(`dataDir=${options.dataDir} epochs=${options.epochs} batch=${options.batchSize} lr=${options.learningRate} patience=${options.patience}`)

  const baseline = options.baselineSummary
    ? loadBaselineAccMap(options.baselineSummary)
    : new Map<string, number>()
  if (options.baselineSummary && baseline.size > 0) {
    log(`baseline: ${options.baselineSummary} (${baseline.size} entries)`)
  }

  const targetRoles = options.onlyRole
    ? ROLES.filter(r => r === options.onlyRole)
    : [...ROLES]
  if (targetRoles.length === 0) {
    log(`WARN: no roles matched (onlyRole=${options.onlyRole ?? ''})`)
    return
  }

  const roleSummaries: RoleSummary[] = []
  for (let i = 0; i < targetRoles.length; i++) {
    const role = targetRoles[i]
    const roleDir = join(phaseDir, role)
    mkdirSync(roleDir, { recursive: true })
    const finalPath = join(roleDir, 'final.json')
    const header = `[${i + 1}/${targetRoles.length}] ${role}`

    if (existsSync(finalPath)) {
      log(`${header} → skip (existing ${finalPath})`)
      roleSummaries.push({ role, status: 'skip_existing' })
      writeSummary(phaseDir, started, options, roleSummaries)
      continue
    }

    if (!anyMethodHasData(options.dataDir, role)) {
      log(`${header} → skip (no data under ${options.dataDir}/${role})`)
      roleSummaries.push({ role, status: 'skip_no_data' })
      writeSummary(phaseDir, started, options, roleSummaries)
      continue
    }

    log(`${header} → training`)
    const t0 = Date.now()
    try {
      const r = await trainPhase2MultiHead({
        role,
        dataDir: options.dataDir,
        outputCheckpointPath: finalPath,
        batchSize: options.batchSize,
        epochs: options.epochs,
        learningRate: options.learningRate,
        evalRatio: options.evalRatio,
        patience: options.patience,
        seed: options.seed,
        skipMethods: options.skipMethods.length > 0 ? options.skipMethods : undefined,
      })
      const durationMs = Date.now() - t0

      const perMethod: Record<string, PerMethodSummary> = {}
      for (const [method, m] of r.perMethod) {
        const baselineAcc = baseline.get(`${role}/${method}`)
        const entry: PerMethodSummary = {
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

      roleSummaries.push({
        role, status: 'ok',
        bestEpoch: r.bestEpoch,
        bestTotalEvalLoss: r.bestTotalEvalLoss,
        durationMs, perMethod,
      })

      const diffs = Object.entries(perMethod).map(([m, e]) => {
        if (e.accDiff === undefined) return `${m}=${e.bestEvalAcc.toFixed(3)}`
        const sign = e.accDiff >= 0 ? '+' : ''
        return `${m}=${e.bestEvalAcc.toFixed(3)}(${sign}${e.accDiff.toFixed(3)})`
      }).join(' ')
      log(`${header} ← done bestEpoch=${r.bestEpoch} (${(durationMs / 1000).toFixed(1)}s) ${diffs}`)
    } catch (err) {
      const durationMs = Date.now() - t0
      const message = String((err as Error).message ?? err)
      roleSummaries.push({ role, status: 'failed', error: message, durationMs })
      log(`${header} ← FAILED: ${message}`)
    }
    writeSummary(phaseDir, started, options, roleSummaries)
  }

  const ok = roleSummaries.filter(r => r.status === 'ok').length
  const skipExisting = roleSummaries.filter(r => r.status === 'skip_existing').length
  const skipNoData = roleSummaries.filter(r => r.status === 'skip_no_data').length
  const failed = roleSummaries.filter(r => r.status === 'failed').length
  log(`DONE: ${ok} ok / ${skipExisting} skip(existing) / ${skipNoData} skip(no-data) / ${failed} failed`)

  // phase.done は「全対象役職が ok or skip_existing、かつ failed なし」で書き込む
  const completedCount = ok + skipExisting
  if (failed === 0 && completedCount === targetRoles.length && !options.onlyRole) {
    writeFileSync(doneFile, JSON.stringify({
      phaseName: 'skoll-zero-pretrain',
      graduatedAt: new Date().toISOString(),
      roles: roleSummaries.length,
      ok,
      skipExisting,
      skipNoData,
    }, null, 2))
    log(`phase complete (${doneFile})`)
  } else if (options.onlyRole) {
    log(`phase.done not written (onlyRole run)`)
  } else {
    log(`phase.done not written (${failed} failed, ${skipNoData} no-data)`)
  }
}
