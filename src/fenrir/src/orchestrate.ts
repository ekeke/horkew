#!/usr/bin/env node
/**
 * Fenrir Training Orchestrator
 *
 * Phase 1 の6モデル並列学習 → Phase 2 自己対戦を自動管理する。
 *
 * 機能:
 * - baseline eval で heuristic の陣営別勝率を取得
 * - 6モデルを並列起動、勝率が baseline を超えたら自動卒業
 * - モデル終了時にコアを再配分（SIGTERM + --resume + --workers 増）
 * - 全 Phase 1 完了後に Phase 2 を自動起動
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { createInterface } from 'node:readline'
import { evaluate, createNetwork, DEFAULT_TRAINING_CONFIG } from './training.ts'

// ============================================================
// Model Group Definitions
// ============================================================

const MODEL_GROUPS = {
  mason:      { roles: ['mason'], faction: 'villageWin' },
  village:    { roles: ['villager', 'seer', 'medium', 'bodyguard', 'nekomata'], faction: 'villageWin' },
  werewolf:   { roles: ['werewolf'], faction: 'wolfWin' },
  fanatic:    { roles: ['fanatic'], faction: 'wolfWin' },
  hamster:    { roles: ['werehamster'], faction: 'hamsterWin' },
  immoralist: { roles: ['immoralist'], faction: 'hamsterWin' },
} as const

type ModelName = keyof typeof MODEL_GROUPS
const MODEL_NAMES = Object.keys(MODEL_GROUPS) as ModelName[]

const COLORS: Record<ModelName, string> = {
  mason: '\x1b[36m',       // cyan
  village: '\x1b[33m',     // yellow
  werewolf: '\x1b[31m',    // red
  fanatic: '\x1b[35m',     // magenta
  hamster: '\x1b[32m',     // green
  immoralist: '\x1b[34m',  // blue
}
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

// ============================================================
// Config
// ============================================================

type OrchestratorConfig = {
  cores: number
  iterations: number
  phase2Iterations: number
  batch: number
  checkpointBase: string
  noRetar: boolean
  evalInterval: number
  checkpointInterval: number
  phase1Only: boolean
  phase2Only: boolean
  targetWinRate?: number  // override: baseline の代わりに固定値
  resume: boolean
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  cores: Math.min(6, availableParallelism?.() ?? 6),
  iterations: 50000,
  phase2Iterations: 40000,
  batch: 64,
  checkpointBase: './checkpoints',
  noRetar: false,
  evalInterval: 1000,
  checkpointInterval: 100,
  phase1Only: false,
  phase2Only: false,
  resume: false,
}

// ============================================================
// CLI Parsing
// ============================================================

function parseArgs(): OrchestratorConfig {
  const args = process.argv.slice(2)
  const config = { ...DEFAULT_CONFIG }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--cores': config.cores = parseInt(args[++i]); break
      case '--iterations': config.iterations = parseInt(args[++i]); break
      case '--phase2-iterations': config.phase2Iterations = parseInt(args[++i]); break
      case '--batch': config.batch = parseInt(args[++i]); break
      case '--checkpoint-base': config.checkpointBase = args[++i]; break
      case '--no-retar': config.noRetar = true; break
      case '--eval-interval': config.evalInterval = parseInt(args[++i]); break
      case '--checkpoint-interval': config.checkpointInterval = parseInt(args[++i]); break
      case '--phase1-only': config.phase1Only = true; break
      case '--phase2-only': config.phase2Only = true; break
      case '--target-winrate': config.targetWinRate = parseFloat(args[++i]); break
      case '--resume': config.resume = true; break
      case '--help': case '-h': showHelp(); break
    }
  }
  return config
}

function showHelp(): never {
  console.log(`Fenrir Training Orchestrator

Usage: npm run orchestrate [-- options]

Options:
  --cores <n>              使用CPUコア数 (default: ${DEFAULT_CONFIG.cores})
  --iterations <n>         Phase 1 上限イテレーション (default: ${DEFAULT_CONFIG.iterations})
  --phase2-iterations <n>  Phase 2 イテレーション (default: ${DEFAULT_CONFIG.phase2Iterations})
  --batch <n>              バッチサイズ (default: ${DEFAULT_CONFIG.batch})
  --checkpoint-base <dir>  ベースDir (default: ${DEFAULT_CONFIG.checkpointBase})
  --eval-interval <n>      評価間隔 (default: ${DEFAULT_CONFIG.evalInterval})
  --checkpoint-interval <n> チェックポイント間隔 (default: ${DEFAULT_CONFIG.checkpointInterval})
  --no-retar               Retar無効化
  --phase1-only            Phase 2 をスキップ
  --phase2-only            Phase 1 をスキップ
  --target-winrate <n>     目標勝率の上書き (default: baseline eval から自動算出)
  --resume                 既存チェックポイントから再開
  --help, -h               このヘルプを表示`)
  process.exit(0)
}

// ============================================================
// Baseline Eval
// ============================================================

function runBaselineEval(): Record<string, number> {
  log(`${BOLD}Running baseline eval (all heuristic, 100 games)...${RESET}`)
  const network = createNetwork()
  const config = {
    ...DEFAULT_TRAINING_CONFIG,
    enableRetar: false,  // baseline は速度優先
  }
  // mlRoles を設定しない + network は未学習 → 事実上全 heuristic
  // ただし evaluate は mlRoles が無いと偶数seatがML になる
  // → mlRoles を空のリストではなく存在しない役職に設定してフル heuristic にする
  // → 実はもっと簡単: 未学習 network はランダムなので heuristic baseline にはならない
  // → heuristic 同士の対戦には evaluate を使えない。直接 runGame を使う。

  // 簡易実装: evaluate に mlRoles=['_none_'] のような値を渡すと全 seat が heuristic になるが、
  // 既存の evaluate は mlRoles が null のとき偶数seat=ML。
  // mlRoles=[] (空配列) だと mlRolesSet は truthy で onRolesAssigned が走るが誰も ML にならない。
  // → config.mlRoles = [] で全 heuristic になる。
  const baselineConfig = { ...config, mlRoles: [] as any[] }
  const result = evaluate(network, baselineConfig, 100)
  log(`Baseline: ${Object.entries(result.winRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')}`)
  return result.winRates
}

// ============================================================
// Process Management
// ============================================================

type ModelState = {
  name: ModelName
  status: 'pending' | 'running' | 'done' | 'failed'
  child?: ChildProcess
  killedForRealloc: boolean
  retries: number
}

function computeWorkers(totalCores: number, numRunning: number): number {
  // workers=0 → 1 thread (main only). workers=N → N+1 threads.
  // 全コアを使い切る: floor(cores / numRunning) - 1
  return Math.max(0, Math.floor(totalCores / numRunning) - 1)
}

function spawnTraining(
  model: ModelState,
  workers: number,
  config: OrchestratorConfig,
  targetWinRate: number,
  targetFaction: string,
): ChildProcess {
  const group = MODEL_GROUPS[model.name]
  const args = [
    '--experimental-strip-types', 'src/fenrir/src/cli.ts',
    '--ml-roles', group.roles.join(','),
    '--iterations', String(config.iterations),
    '--phase1-end', String(config.iterations),  // Phase 1 のみ
    '--phase2-end', String(config.iterations),
    '--checkpoint-dir', `${config.checkpointBase}/ckpt-${model.name}`,
    '--checkpoint-interval', String(config.checkpointInterval),
    '--eval-interval', String(config.evalInterval),
    '--workers', String(workers),
    '--batch', String(config.batch),
    '--target-winrate', String(targetWinRate),
    '--target-faction', targetFaction,
  ]
  if (config.noRetar) args.push('--no-retar')
  if (config.resume || model.retries > 0) args.push('--resume')

  const child = spawn('node', args, { stdio: ['ignore', 'ignore', 'pipe'] })

  // stderr をプレフィックス付きで転送
  const prefix = `${COLORS[model.name]}[${model.name.padEnd(10)}]${RESET}`
  const rl = createInterface({ input: child.stderr! })
  rl.on('line', line => {
    // progress bar の \r をハンドル: プレフィックスを付けて出力
    process.stderr.write(`${prefix} ${line}\n`)
  })

  return child
}

// ============================================================
// Phase 1
// ============================================================

function runPhase1(
  config: OrchestratorConfig,
  baselineRates: Record<string, number>,
): Promise<void> {
  return new Promise((resolve) => {
    const models = new Map<ModelName, ModelState>()
    for (const name of MODEL_NAMES) {
      models.set(name, { name, status: 'pending', killedForRealloc: false, retries: 0 })
    }

    const remaining = () => [...models.values()].filter(m => m.status !== 'done' && m.status !== 'failed')
    const running = () => [...models.values()].filter(m => m.status === 'running')

    let reallocationScheduled = false

    function startAll() {
      const toStart = remaining().filter(m => m.status !== 'running')
      const rem = remaining()
      if (rem.length === 0) { resolve(); return }

      const workers = computeWorkers(config.cores, rem.length)
      log(`Starting ${toStart.length} model(s) with --workers ${workers}`)

      for (const model of toStart) {
        const group = MODEL_GROUPS[model.name]
        const targetRate = config.targetWinRate ?? (baselineRates[group.faction] ?? 0.5)
        model.status = 'running'
        model.killedForRealloc = false
        model.child = spawnTraining(model, workers, config, targetRate, group.faction)

        model.child.on('close', (code, _signal) => {
          model.child = undefined
          if (model.killedForRealloc) {
            model.status = 'pending'
            return
          }

          if (code === 0) {
            model.status = 'done'
            log(`${BOLD}>>> ${COLORS[model.name]}${model.name} GRADUATED${RESET} ${BOLD}<<<${RESET}`)
          } else {
            if (model.retries < 1) {
              log(`>>> ${model.name} crashed (code=${code}), retrying... <<<`)
              model.retries++
              model.status = 'pending'
            } else {
              model.status = 'failed'
              log(`>>> ${model.name} FAILED permanently (code=${code}) <<<`)
            }
          }

          if (!reallocationScheduled && remaining().length > 0) {
            reallocationScheduled = true
            setImmediate(() => {
              reallocationScheduled = false
              reallocate()
            })
          }

          if (remaining().length === 0) {
            resolve()
          }
        })
      }

      printStatus(models)
    }

    function reallocate() {
      const rem = remaining()
      if (rem.length === 0) return

      const currentRunning = running()
      const newWorkers = computeWorkers(config.cores, rem.length)

      log(`Reallocating: ${rem.length} remaining, ${newWorkers} workers/model`)

      // 実行中のプロセスを SIGTERM
      for (const model of currentRunning) {
        model.killedForRealloc = true
        model.child?.kill('SIGTERM')
      }

      // 少し待ってから再起動（チェックポイント書き込み猶予）
      setTimeout(() => {
        // killedForRealloc で pending に戻ったプロセスを再起動
        startAll()
      }, 2000)
    }

    // 初回起動
    startAll()
  })
}

// ============================================================
// Phase 2
// ============================================================

function runPhase2(config: OrchestratorConfig): Promise<void> {
  const dirs = MODEL_NAMES.map(name => `${config.checkpointBase}/ckpt-${name}`).join(',')
  const args = [
    '--experimental-strip-types', 'src/fenrir/src/cli.ts',
    '--phase2-models', dirs,
    '--iterations', String(config.phase2Iterations),
    '--workers', String(Math.max(0, config.cores - 1)),
    '--checkpoint-dir', `${config.checkpointBase}/phase2`,
    '--batch', String(config.batch),
    '--eval-interval', String(config.evalInterval),
    '--checkpoint-interval', String(config.checkpointInterval),
  ]
  if (config.noRetar) args.push('--no-retar')

  return new Promise((resolve, reject) => {
    const child = spawn('node', args, { stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Phase 2 exited with code ${code}`))
    })
  })
}

// ============================================================
// Utilities
// ============================================================

function log(msg: string): void {
  process.stderr.write(`${BOLD}[orchestrator]${RESET} ${msg}\n`)
}

function printStatus(models: Map<ModelName, ModelState>): void {
  const lines = [...models.values()].map(m => {
    const icon = m.status === 'done' ? 'OK'
      : m.status === 'failed' ? 'FAIL'
      : m.status === 'running' ? '..'
      : '--'
    return `  ${COLORS[m.name]}[${icon.padEnd(4)}] ${m.name}${RESET}`
  })
  log('Status:\n' + lines.join('\n'))
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const config = parseArgs()

  log(`${BOLD}Fenrir Training Orchestrator${RESET}`)
  log(`Cores: ${config.cores}, Iterations: ${config.iterations}, Phase2: ${config.phase2Iterations}`)
  log(`Checkpoint base: ${config.checkpointBase}`)

  // Baseline eval
  let baselineRates: Record<string, number> = {}
  if (!config.phase2Only) {
    baselineRates = runBaselineEval()
  }

  // Phase 1
  if (!config.phase2Only) {
    log(`${BOLD}=== Phase 1: Training vs Heuristic ===${RESET}`)
    await runPhase1(config, baselineRates)

    log(`${BOLD}=== Phase 1 Complete ===${RESET}`)
  }

  // Phase 2
  if (!config.phase1Only) {
    log(`${BOLD}=== Phase 2: Self-Play (all models) ===${RESET}`)
    await runPhase2(config)
    log(`${BOLD}=== Phase 2 Complete ===${RESET}`)
  }

  log(`${BOLD}All training complete!${RESET}`)
}

main().catch(e => { console.error(e); process.exit(1) })
