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
  --phase1-end <n>          Phase1終了イテレーション (default: ${d.phase1End})
  --phase2-end <n>          Phase2終了イテレーション (default: ${d.phase2End})
  --ml-roles <roles>        Phase1でMLにする役職 (カンマ区切り, 例: villager,seer)
  --phase2-models <dirs>    Phase2マルチモデル: 3モデルのチェックポイントDir
                            (village,wolf,third順、カンマ区切り)
  --target-winrate <n>      目標勝率 (0-1)。evalでこの勝率を超えたら早期終了
  --target-faction <s>      チェックする陣営 (villageWin/wolfWin/hamsterWin)
  --workers <n|auto>        ゲーム生成の並列ワーカー数 (auto=CPU-1, default: 直列)
  --transformer             Transformerアーキテクチャを使用 (default: MLP)
  --no-retar                Retar論理推論を無効化
  --resume [dir]            チェックポイントから再開 (default: --checkpoint-dir)
  --help, -h                このヘルプを表示

Examples:
  # クイックテスト (直列)
  npm run train -- --iterations 100 --batch 8 --eval-interval 50

  # 村人だけML、並列、Retarなし
  npm run train -- --ml-roles villager --workers auto --no-retar

  # ワーカー3つで並列学習
  npm run train -- --workers 3

  # フル学習
  npm run train

  # Transformer で学習
  npm run train -- --transformer --workers auto

  # 前回の続きから再開
  npm run train -- --resume

  # 特定ディレクトリから再開
  npm run train -- --resume ./checkpoints-v2

  # Phase2マルチモデル学習 (3モデルのPhase1チェックポイントから)
  npm run train -- --phase2-models ./ckpt-village,./ckpt-wolf,./ckpt-third

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
      case '--transformer':
        config.useTransformer = true
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
      case '--phase1-end':
        config.phase1End = parseInt(args[++i])
        break
      case '--phase2-end':
        config.phase2End = parseInt(args[++i])
        break
      case '--ml-roles':
        config.mlRoles = args[++i].split(',') as any
        break
      case '--phase2-models':
        config.phase2ModelDirs = args[++i].split(',')
        break
      case '--target-winrate':
        config.targetWinRate = parseFloat(args[++i])
        break
      case '--target-faction':
        config.targetFaction = args[++i]
        break
      case '--workers': {
        const val = args[++i]
        config.numWorkers = val === 'auto' ? -1 : parseInt(val)
        break
      }
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

// checkpoint dir にアーキテクチャサブディレクトリを付与
if (!overrides.checkpointDir) {
  config.checkpointDir = config.useTransformer
    ? './checkpoints/transformer'
    : './checkpoints/nn'
}

// --phase2-models 指定時: Phase 1 をスキップ
if (config.phase2ModelDirs) {
  config.phase1End = 0
}

// --resume のディレクトリ解決
const resumeDir = resume === true ? config.checkpointDir
  : typeof resume === 'string' ? resume
  : undefined

console.error('Fenrir - Werewolf ML Agent')
console.error('Configuration:')
console.error(`  Total iterations: ${config.totalIterations}`)
console.error(`  Games per batch: ${config.gamesPerBatch}`)
console.error(`  Learning rate: ${config.learningRate}`)
console.error(`  Architecture: ${config.useTransformer ? 'Transformer' : 'MLP'}`)
console.error(`  Retar: ${config.enableRetar ? 'enabled' : 'disabled'}`)
console.error(`  Checkpoint dir: ${config.checkpointDir}`)
if (resumeDir) console.error(`  Resume from: ${resumeDir}`)
console.error('')

train(config, resumeDir).catch(e => { console.error(e); process.exit(1) })
