/**
 * skoll-multiday-NN 訓練 CLI (standalone)
 *
 * 起動 (例):
 *   node --experimental-strip-types src/skoll/multiday-trainer.ts \
 *     --data data/skoll-multiday-1k.jsonl \
 *     --out tmp/multiday-skoll/ckpt.json \
 *     --epochs 100 --batch 128 --lr 3e-4
 *
 * orchestrate からの呼出は src/skoll/multiday-runner.ts 経由。
 */

import { trainMultiday } from './multiday-train-fn.ts'

function parseArg(name: string): string | null {
  const prefix = `--${name}=`
  const found = process.argv.find(a => a.startsWith(prefix))
  if (found) return found.slice(prefix.length)
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1]
  return null
}

const DATA_PATH = parseArg('data') ?? 'data/skoll-multiday-1k.jsonl'
const OUT_PATH = parseArg('out') ?? 'tmp/multiday-skoll/ckpt.json'
const EPOCHS = parseInt(parseArg('epochs') ?? '30', 10)
const BATCH = parseInt(parseArg('batch') ?? '128', 10)
const LR = parseFloat(parseArg('lr') ?? '3e-4')
const EVAL_RATIO = parseFloat(parseArg('eval-ratio') ?? '0.1')
const SEED = parseInt(parseArg('seed') ?? '42', 10)
const PATIENCE = parseInt(parseArg('patience') ?? '5', 10)

trainMultiday({
  dataPath: DATA_PATH,
  outPath: OUT_PATH,
  epochs: EPOCHS,
  batchSize: BATCH,
  learningRate: LR,
  patience: PATIENCE,
  evalRatio: EVAL_RATIO,
  seed: SEED,
}).then(result => {
  console.log(`\n[done] best eval_mse=${result.bestEvalMse.toFixed(5)} eval_mae=${result.bestEvalMae.toFixed(5)} ckpt=${OUT_PATH}`)
}).catch(e => {
  console.error(e)
  process.exit(1)
})
