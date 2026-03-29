/**
 * 処刑プラン vote head 事前学習スクリプト
 *
 * 合成データでvote headをcross-entropy学習し、チェックポイントを出力する。
 * 実行: node --experimental-strip-types src/fenrir/src/ml/pretrain-plan.ts [--output PATH] [--lr LR] [--epochs N] [--batch-size N]
 */

import { createTfNetwork, createNetwork } from '../training.ts'
import { generatePlanTrainingBatch } from './execution-plan-data.ts'
import { saveCheckpoint } from './checkpoint.ts'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    output: { type: 'string', default: 'checkpoints/pretrained-plan/checkpoint.json' },
    lr: { type: 'string', default: '1e-3' },
    epochs: { type: 'string', default: '5000' },
    'batch-size': { type: 'string', default: '1024' },
    'target-accuracy': { type: 'string', default: '0.95' },
    'log-interval': { type: 'string', default: '50' },
  },
})

const OUTPUT_PATH = args.output!
const LR = parseFloat(args.lr!)
const MAX_EPOCHS = parseInt(args.epochs!)
const BATCH_SIZE = parseInt(args['batch-size']!)
const TARGET_ACCURACY = parseFloat(args['target-accuracy']!)
const LOG_INTERVAL = parseInt(args['log-interval']!)

async function main() {
  console.log('=== 処刑プラン vote head 事前学習 ===')
  console.log(`  lr=${LR}, epochs=${MAX_EPOCHS}, batch=${BATCH_SIZE}, target_acc=${TARGET_ACCURACY}`)
  console.log(`  output=${OUTPUT_PATH}`)
  console.log()

  // フルネットワーク作成（trunk + 全head）
  const tfNet = createTfNetwork(LR)
  console.log(`  params=${tfNet.totalParams}`)
  console.log()

  let bestAccuracy = 0

  for (let epoch = 1; epoch <= MAX_EPOCHS; epoch++) {
    // 毎エポック新しい合成データを生成（過学習防止）
    const samples = generatePlanTrainingBatch(BATCH_SIZE, epoch)

    const { loss, accuracy } = tfNet.trainSupervisedVote({
      observations: samples.map(s => s.observation),
      labels: samples.map(s => s.voteLabel),
      masks: samples.map(s => s.voteMask),
    })

    if (accuracy > bestAccuracy) bestAccuracy = accuracy

    if (epoch % LOG_INTERVAL === 0 || epoch === 1) {
      console.log(`  epoch=${epoch}  loss=${loss.toFixed(4)}  acc=${(accuracy * 100).toFixed(1)}%  best=${(bestAccuracy * 100).toFixed(1)}%`)
    }

    if (accuracy >= TARGET_ACCURACY) {
      console.log()
      console.log(`  Target accuracy ${(TARGET_ACCURACY * 100).toFixed(0)}% reached at epoch ${epoch}`)
      break
    }
  }

  // TfNeuralNetwork → NeuralNetwork → checkpoint
  console.log()
  console.log('  Saving checkpoint...')
  const weights = tfNet.cloneWeights()
  const cpNet = createNetwork()
  cpNet.loadWeights(weights)
  saveCheckpoint(cpNet, OUTPUT_PATH, { iteration: 0, winRate: 0 })
  console.log(`  Saved to ${OUTPUT_PATH}`)
  console.log()
  console.log(`  Final best accuracy: ${(bestAccuracy * 100).toFixed(1)}%`)

  tfNet.dispose()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
