/**
 * skoll-multiday-NN の spot check
 *
 * bloodhound seed=904995 の Day 5 朝 (LW 露呈時) の盤面を再現し、
 * 学習済み NN の予測 vs recursive skoll 真値を比較する。
 *
 * 起動:
 *   node --experimental-strip-types src/skoll/multiday-spot-check.ts \
 *     --ckpt tmp/multiday-skoll/ckpt.json
 */

import { readFileSync } from 'node:fs'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { retarResultToPossibilities, DEFAULT_RETAR_OPTIONS } from '../fenrir/src/retar-bridge.ts'
import { recursiveSkoll } from './recursive.ts'
import {
  MultidaySkollNetwork,
  DEFAULT_MULTIDAY_SKOLL_CONFIG,
  type MultidaySkollConfig,
} from '../fenrir/src/ml/multiday-skoll-network.ts'

const LOG_PATH = 'logs/bloodhound/2026-05-17T07-17-55-720Z/game.howl'
const CUTOFF_LINE = 238  // Day 5 morning (LW 露呈時)

function parseArg(name: string): string | null {
  const prefix = `--${name}=`
  const found = process.argv.find(a => a.startsWith(prefix))
  if (found) return found.slice(prefix.length)
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1]
  return null
}

const CKPT_PATH = parseArg('ckpt') ?? 'tmp/multiday-skoll/ckpt.json'

// ---- checkpoint load ----
function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

function loadNetwork(path: string): MultidaySkollNetwork {
  const raw = readFileSync(path, 'utf-8')
  const data = JSON.parse(raw) as { config: MultidaySkollConfig, weights: Record<string, string> }
  const config = data.config ?? DEFAULT_MULTIDAY_SKOLL_CONFIG
  const network = new MultidaySkollNetwork(config)
  const weights = new Map<string, Float32Array>()
  for (const [name, b64] of Object.entries(data.weights)) {
    weights.set(name, base64ToFloat32(b64))
  }
  network.loadWeights(weights)
  return network
}

// ---- Day 5 state load ----
function loadDay5State() {
  const fullText = readFileSync(LOG_PATH, 'utf-8')
  const lines = fullText.split('\n')
  const partial = lines.slice(0, CUTOFF_LINE).join('\n') + '\n'
  const { meta, statements } = parse(partial)
  const { vs, setup } = buildVillageStatus(statements, meta)
  if (!vs || !setup) throw new Error('buildVillageStatus failed')
  const options: AnalyzeOptions = DEFAULT_RETAR_OPTIONS
  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyzeSafe()
  if (result.error || !result.result) throw new Error(`Retar failed: ${result.error}`)
  const possibilities = retarResultToPossibilities(
    { possibilities: result.result, maxSurvivingNV: result.maxSurvivingNV },
    setup,
  )
  return { vs, setup, possibilities }
}

function fmt(v: number): string {
  return v.toFixed(4)
}

// ---- main ----
function main(): void {
  console.log(`[spot-check] loading network: ${CKPT_PATH}`)
  const network = loadNetwork(CKPT_PATH)
  console.log(`[spot-check] network params: ${network.totalParams}`)

  console.log('[spot-check] loading Day 5 state...')
  const { vs, setup, possibilities } = loadDay5State()
  const aliveSeats: number[] = []
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }
  aliveSeats.sort((a, b) => a - b)
  console.log(`Alive seats: ${aliveSeats.join(', ')}`)

  // NN inference
  console.log('\n=== NN prediction ===')
  const t0 = Date.now()
  const nnOut = network.forward({
    possibilities: [...possibilities.possibilities],
    aliveSeats,
    setup: Object.fromEntries(setup),
    day: 5,
    maxSurvivingNV: possibilities.maxSurvivingNV,
  })
  const nnMs = Date.now() - t0
  console.log(`(${nnMs}ms)`)
  for (let i = 0; i < nnOut.length; i++) {
    const seat = i + 1
    if (aliveSeats.includes(seat)) {
      console.log(`  seat-${seat}  NN=${fmt(nnOut[i])}`)
    }
  }

  // Recursive skoll ground truth
  console.log('\n=== Recursive skoll (truth) ===')
  const t1 = Date.now()
  const rec = recursiveSkoll(possibilities, setup, vs)
  const recMs = Date.now() - t1
  console.log(`(${recMs}ms)`)
  for (const r of rec.perX) {
    console.log(`  seat-${r.executeToday}  truth=${fmt(r.expectedWinRate)}`)
  }

  // Side-by-side comparison
  console.log('\n=== Comparison (alive seats only) ===')
  console.log('  seat  NN      truth   diff')
  let totalDiff = 0
  let totalAbsDiff = 0
  let n = 0
  for (const seat of aliveSeats) {
    const idx = seat - 1
    const nn = nnOut[idx]
    const truth = rec.perX.find(r => r.executeToday === seat)?.expectedWinRate ?? 0
    const diff = nn - truth
    totalDiff += diff
    totalAbsDiff += Math.abs(diff)
    n++
    console.log(`  ${seat.toString().padStart(4)}  ${fmt(nn)}  ${fmt(truth)}  ${diff >= 0 ? '+' : ''}${fmt(diff)}`)
  }
  const mae = totalAbsDiff / n
  const meanDiff = totalDiff / n
  console.log(`\nMAE: ${fmt(mae)}  mean_diff: ${fmt(meanDiff)}`)

  // Argmax 比較
  let nnBest = aliveSeats[0]
  let nnBestRate = -Infinity
  for (const seat of aliveSeats) {
    if (nnOut[seat - 1] > nnBestRate) { nnBestRate = nnOut[seat - 1]; nnBest = seat }
  }
  const truthBest = rec.perX.reduce((best, r) =>
    r.expectedWinRate > best.expectedWinRate ? r : best, rec.perX[0]).executeToday
  console.log(`\nArgmax: NN says seat-${nnBest}, truth says seat-${truthBest} ${nnBest === truthBest ? '✓' : '✗'}`)
}

main()
