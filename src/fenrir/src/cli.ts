#!/usr/bin/env node
/**
 * Fenrir Training CLI
 */

import { train, DEFAULT_TRAINING_CONFIG, type TrainingConfig } from './training.ts'

function showHelp(): never {
  const d = DEFAULT_TRAINING_CONFIG
  console.log(`Fenrir - Werewolf ML Agent Training

Usage: npm run train [-- options]

Options:
  --iterations <n>          総イテレーション数 (default: ${d.totalIterations})
  --batch <n>               バッチあたりのゲーム数 (default: ${d.gamesPerBatch})
  --lr <n>                  学習率 (default: ${d.learningRate})
  --checkpoint-dir <dir>    チェックポイント保存先 (default: ${d.checkpointDir})
  --checkpoint-interval <n> 保存間隔 (default: ${d.checkpointInterval})
  --eval-interval <n>       評価間隔 (default: ${d.evalInterval})
  --no-retar                Retar論理推論を無効化
  --resume [dir]            チェックポイントから再開 (default: --checkpoint-dir)
  --help, -h                このヘルプを表示

Examples:
  # クイックテスト (2分程度)
  npm run train -- --iterations 100 --batch 8 --eval-interval 50

  # フル学習
  npm run train

  # 前回の続きから再開
  npm run train -- --resume

  # 特定ディレクトリから再開
  npm run train -- --resume ./checkpoints-v2

  # 学習済みモデルでゲームを実行 (Howl出力)
  npm run play -- --checkpoint ./checkpoints/final.json --seed 42

  # 全員MLでゲーム
  npm run play -- --checkpoint ./checkpoints/final.json --seed 42 --all-ml

  # 評価 (vs ヒューリスティック)
  npm run eval -- --checkpoint ./checkpoints/final.json --games 100

Curriculum:
  Phase 1 (0-${d.phase1End}):   vs ヒューリスティック (基本動作習得)
  Phase 2 (${d.phase1End}-${d.phase2End}):  自己対戦
  Phase 3 (${d.phase2End}+): プール型自己対戦 (過去5チェックポイント)

Output:
  ${d.checkpointDir}/checkpoint_<iter>.json  定期チェックポイント
  ${d.checkpointDir}/wolf_team_<iter>.json   狼チームチェックポイント
  ${d.checkpointDir}/mason_team_<iter>.json  共有者チームチェックポイント
  ${d.checkpointDir}/final.json              学習完了時の最終モデル`)
  process.exit(0)
}

type ParsedArgs = Partial<TrainingConfig> & { help?: boolean, resume?: string | true }

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2)
  const config: ParsedArgs = {}

  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    switch (key) {
      case '--help':
      case '-h':
        config.help = true
        break
      case '--no-retar':
        config.enableRetar = false
        break
      case '--iterations':
        config.totalIterations = parseInt(args[++i])
        break
      case '--batch':
        config.gamesPerBatch = parseInt(args[++i])
        break
      case '--lr':
        config.learningRate = parseFloat(args[++i])
        break
      case '--checkpoint-dir':
        config.checkpointDir = args[++i]
        break
      case '--eval-interval':
        config.evalInterval = parseInt(args[++i])
        break
      case '--checkpoint-interval':
        config.checkpointInterval = parseInt(args[++i])
        break
      case '--resume': {
        // --resume の次が別のフラグか末尾なら true（checkpoint-dir を使う）
        const next = args[i + 1]
        if (next && !next.startsWith('--')) {
          config.resume = args[++i]
        } else {
          config.resume = true
        }
        break
      }
    }
  }

  return config
}

const { help, resume, ...overrides } = parseArgs()
if (help) showHelp()

const config: TrainingConfig = { ...DEFAULT_TRAINING_CONFIG, ...overrides }

// --resume のディレクトリ解決
const resumeDir = resume === true ? config.checkpointDir
  : typeof resume === 'string' ? resume
  : undefined

console.error('Fenrir - Werewolf ML Agent')
console.error('Configuration:')
console.error(`  Total iterations: ${config.totalIterations}`)
console.error(`  Games per batch: ${config.gamesPerBatch}`)
console.error(`  Learning rate: ${config.learningRate}`)
console.error(`  Retar: ${config.enableRetar ? 'enabled' : 'disabled'}`)
console.error(`  Checkpoint dir: ${config.checkpointDir}`)
if (resumeDir) console.error(`  Resume from: ${resumeDir}`)
console.error('')

train(config, resumeDir)
