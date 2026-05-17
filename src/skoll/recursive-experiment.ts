/**
 * 単純再帰 skoll 実験スクリプト
 *
 * bloodhound seed=904995 の Day 5 朝 (LW seat-7 露呈時) の盤面を再現し、
 * single-day skoll vs recursive skoll の per-X 期待値を比較する。
 *
 * 仮説:
 *   - single-day skoll: seat-7 (LW) > seat-10 (gray) と判定 (= 短期視点)
 *   - recursive skoll: seat-10 を吊って seer 占い狐確証 → 翌日 LW 確実吊りの
 *     多日期待値で seat-10 ≥ seat-7 になる可能性あり
 *
 * 実行: node --experimental-strip-types src/skoll/recursive-experiment.ts
 */

import { readFileSync } from 'node:fs'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { retarResultToPossibilities, DEFAULT_RETAR_OPTIONS } from '../fenrir/src/retar-bridge.ts'
import { precomputeSkoll } from '../bloodhound/skoll-precompute.ts'
import { recursiveSkoll } from './recursive.ts'

const LOG_PATH = 'logs/bloodhound/2026-05-17T07-17-55-720Z/game.howl'
// Day 5 朝の LW 露呈状態 (seat-13 死亡 まで + seat-4 占いCO 5D seat-7● + seat-12 霊能CO ● ● ●)
const CUTOFF_LINE = 238

function loadDay5State() {
  const fullText = readFileSync(LOG_PATH, 'utf-8')
  const lines = fullText.split('\n')
  const partial = lines.slice(0, CUTOFF_LINE).join('\n') + '\n'

  const { meta, statements } = parse(partial)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) {
    console.error('Parser produced unknown statements:', unknowns.length)
    process.exit(1)
  }

  const { vs, setup } = buildVillageStatus(statements, meta)
  if (!vs || !setup) {
    console.error('buildVillageStatus failed')
    process.exit(1)
  }

  const options: AnalyzeOptions = DEFAULT_RETAR_OPTIONS
  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyzeSafe()
  if (result.error || !result.result) {
    console.error('Retar failed:', result.error)
    process.exit(1)
  }

  const possibilities = retarResultToPossibilities(
    { possibilities: result.result, maxSurvivingNV: result.maxSurvivingNV },
    setup,
  )

  return { vs, setup, possibilities }
}

function fmt(v: number): string {
  return v.toFixed(4)
}

function main() {
  console.log('=== Loading Day 5 state from log (seed=904995) ===')
  const { vs, setup, possibilities } = loadDay5State()

  const alive: number[] = []
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) alive.push(seat)
  }
  alive.sort((a, b) => a - b)
  console.log(`Alive seats: ${alive.join(', ')}`)

  // Per-seat possibilities summary
  console.log('\n=== Per-seat possibilities ===')
  const roleNames = ['vil', 'seer', 'med', 'BG', 'mason', 'neko', 'WOLF', 'poss', 'FANA', 'FOX', 'IMM']
  for (const seat of alive) {
    const mask = possibilities.possibilities[seat]
    const roles: string[] = []
    for (let i = 0; i < 11; i++) {
      if (mask & (1 << i)) roles.push(roleNames[i])
    }
    console.log(`  seat-${seat}: ${roles.join('/')}`)
  }

  // Single-day skoll
  console.log('\n=== Single-day skoll ===')
  const t0 = Date.now()
  const single = precomputeSkoll({ possibilities, vs, setup })
  const t1 = Date.now()
  console.log(`(${single.totalWorlds} worlds${single.truncated ? ' [TRUNCATED]' : ''}, ${t1 - t0}ms)`)
  const singleSorted = [...single.executions].sort((a, b) => b.winRate - a.winRate)
  for (const e of singleSorted) {
    const star = single.bestSeats.includes(e.seat) ? ' ★' : ''
    console.log(`  seat-${e.seat}  ${fmt(e.winRate)}${star}`)
  }

  // Recursive skoll (full polish: Z/G MIN/MAX search + nekomata X handling)
  console.log('\n=== Recursive skoll (depth=1, Z/G MIN/MAX search) ===')
  const t2 = Date.now()
  const rec = recursiveSkoll(possibilities, setup, vs)
  const t3 = Date.now()
  console.log(`(${rec.totalWorlds} worlds${rec.truncated ? ' [TRUNCATED]' : ''}, ${t3 - t2}ms)`)

  // Sort per-X by expectedWinRate desc
  const recSorted = [...rec.perX].sort((a, b) => b.expectedWinRate - a.expectedWinRate)
  console.log('\n  X    bestY  winRate  (vs single-day delta)')
  for (const r of recSorted) {
    const singleRate = single.executions.find(e => e.seat === r.executeToday)?.winRate ?? 0
    const delta = r.expectedWinRate - singleRate
    const sign = delta >= 0 ? '+' : ''
    const yStr = r.bestDivineTonight !== null ? `seat-${r.bestDivineTonight}` : '(none)'
    console.log(`  seat-${r.executeToday}  ${yStr.padEnd(8)} ${fmt(r.expectedWinRate)}  (${sign}${fmt(delta)})`)
  }

  // Per-Y breakdown for top-3 X candidates
  console.log('\n=== Per-Y breakdown (top-3 X) ===')
  for (let i = 0; i < Math.min(3, recSorted.length); i++) {
    const r = recSorted[i]
    console.log(`\n[X=seat-${r.executeToday}] best=${r.bestDivineTonight !== null ? `seat-${r.bestDivineTonight}` : 'none'} (${fmt(r.expectedWinRate)})`)
    const perY = [...r.perDivine].sort((a, b) => b.winRate - a.winRate)
    for (const d of perY) {
      const zStr = d.worstAttack !== null ? `Z=${d.worstAttack}` : 'Z=-'
      const gStr = d.bestGuard !== null ? `G=${d.bestGuard}` : 'G=none'
      console.log(`    Y=seat-${d.divine}  ${fmt(d.winRate)}  termRatio=${fmt(d.terminalRatio)}  ${zStr}  ${gStr}`)
    }
  }

  // Verdict
  console.log('\n=== Verdict ===')
  const lwSeat = 7  // seat-7 = LW
  const graySeat = 10  // seat-10 = key gray
  const lwSingleRate = single.executions.find(e => e.seat === lwSeat)?.winRate ?? 0
  const graySingleRate = single.executions.find(e => e.seat === graySeat)?.winRate ?? 0
  const lwRecRate = rec.perX.find(r => r.executeToday === lwSeat)?.expectedWinRate ?? 0
  const grayRecRate = rec.perX.find(r => r.executeToday === graySeat)?.expectedWinRate ?? 0

  console.log(`Single: seat-${lwSeat}=${fmt(lwSingleRate)}  vs  seat-${graySeat}=${fmt(graySingleRate)}  -> ${lwSingleRate >= graySingleRate ? `seat-${lwSeat} preferred (LW吊り)` : `seat-${graySeat} preferred (gray吊り)`}`)
  console.log(`Recur:  seat-${lwSeat}=${fmt(lwRecRate)}  vs  seat-${graySeat}=${fmt(grayRecRate)}  -> ${lwRecRate >= grayRecRate ? `seat-${lwSeat} preferred (LW吊り)` : `seat-${graySeat} preferred (gray吊り — 多日価値表現成功)`}`)

  if (grayRecRate > lwRecRate && lwSingleRate > graySingleRate) {
    console.log('\n仮説確認 ✓: 再帰 skoll が「狼一日残してグレー吊り → 翌日確実吊り」の多日価値を捉えた')
  } else if (lwRecRate > grayRecRate && lwSingleRate > graySingleRate) {
    console.log('\n仮説不一致 ✗: 再帰 skoll でも seat-7 LW 吊り優位')
  } else {
    console.log('\n要分析: 想定外の結果')
  }
}

main()
