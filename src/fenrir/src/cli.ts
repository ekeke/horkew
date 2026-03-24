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
  --help, -h                このヘルプを表示

Examples:
  # クイックテスト (2分程度)
  npm run train -- --iterations 100 --batch 8 --eval-interval 50

  # フル学習
  npm run train

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
  ${d.checkpointDir}/final.json              学習完了時の最終モデル`)
  process.exit(0)
}

function parseArgs(): Partial<TrainingConfig> & { help?: boolean } {
  const args = process.argv.slice(2)
  const config: Partial<TrainingConfig> & { help?: boolean } = {}

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
    }
  }

  return config
}

const { help, ...overrides } = parseArgs()
if (help) showHelp()

const config: TrainingConfig = { ...DEFAULT_TRAINING_CONFIG, ...overrides }

console.error('Fenrir - Werewolf ML Agent')
console.error('Configuration:')
console.error(`  Total iterations: ${config.totalIterations}`)
console.error(`  Games per batch: ${config.gamesPerBatch}`)
console.error(`  Learning rate: ${config.learningRate}`)
console.error(`  Retar: ${config.enableRetar ? 'enabled' : 'disabled'}`)
console.error(`  Checkpoint dir: ${config.checkpointDir}`)
console.error('')

train(config)
