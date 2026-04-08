/**
 * Endgame ラベル生成のデモ
 *
 * --quiz  NNになったつもりで回答するクイズモード
 * なし    ラベル生成を可視化するダンプモード
 *
 * Usage:
 *   node --experimental-strip-types src/fenrir/src/ml/endgame-label-demo.ts
 *   node --experimental-strip-types src/fenrir/src/ml/endgame-label-demo.ts --quiz
 */

import * as readline from 'node:readline'
import { Rng } from '../../../lupa/random.ts'
import { generateSyntheticRetar, buildEndgameLabels } from './execution-plan-data.ts'
import { PLAN_VOCAB } from '../plan/plan-vocab.ts'
import { SEATS } from '../observation.ts'
import type { SystemRole } from '../../../types/index.ts'

// ============================================================
// Shared helpers
// ============================================================

function describePossibilities(possibilities: Map<number, Set<SystemRole>>): Map<number, string> {
  const result = new Map<number, string>()
  for (const [seat, roles] of possibilities) {
    const hasWolf = roles.has('werewolf') || roles.has('fanatic')
    const hasFox = roles.has('werehamster') || roles.has('immoralist')
    if (!hasWolf && !hasFox) result.set(seat, 'village_only')
    else if (hasFox && !hasWolf) result.set(seat, 'fox_no_wolf')
    else if (hasWolf && !hasFox) result.set(seat, 'wolf_no_fox')
    else result.set(seat, 'all_roles')
  }
  return result
}

function tokenLabel(idx: number): string {
  if (idx >= 0 && idx < 14) return `seat${idx + 1}`
  if (idx === PLAN_VOCAB.STOP) return 'STOP'
  if (idx === PLAN_VOCAB.OR) return 'OR'
  if (idx === PLAN_VOCAB.GRAYRAN) return 'grayran'
  return `?${idx}`
}

type Sample = {
  aliveSeats: number[]
  mySeat: number
  claims: Map<number, SystemRole>
  possibilities: Map<number, Set<SystemRole>>
  foxSeats: number[]
  wolfSeats: number[]
  wolfOnly: number[]
  labels: number[]
  mask: boolean[]
}

function generateSample(rng: Rng): Sample {
  const aliveCount = 7 + Math.floor(rng.next() * 7)
  const allSeats = Array.from({ length: SEATS }, (_, j) => j + 1)
  const shuffled = [...allSeats].sort(() => rng.next() - 0.5)
  const aliveSeats = shuffled.slice(0, aliveCount).sort((a, b) => a - b)
  const mySeat = aliveSeats[Math.floor(rng.next() * aliveSeats.length)]

  const claims = new Map<number, SystemRole>()
  const coRole: SystemRole = (['seer', 'medium', 'bodyguard'] as SystemRole[])[Math.floor(rng.next() * 3)]
  const coSeats = aliveSeats.filter(s => s !== mySeat).slice(0, 2)
  for (const s of coSeats) claims.set(s, coRole)

  const retar = generateSyntheticRetar(aliveSeats, mySeat, claims, rng)
  const foxSeats = retar.foxSeats.filter(s => s !== mySeat)
  const wolfSeats = retar.wolfSeats.filter(s => s !== mySeat)
  const eg = buildEndgameLabels(foxSeats, wolfSeats, rng)

  return {
    aliveSeats, mySeat, claims,
    possibilities: retar.possibilities,
    foxSeats, wolfSeats, wolfOnly: eg.wolfOnly,
    labels: eg.labels, mask: eg.mask,
  }
}

function printBoard(s: Sample, showCandidates: boolean = true) {
  const desc = describePossibilities(s.possibilities)
  console.log(`Alive: [${s.aliveSeats.join(', ')}] (${s.aliveSeats.length}人)  mySeat: ${s.mySeat}`)
  console.log(`CO: ${[...s.claims.entries()].map(([seat, r]) => `seat${seat}=${r}`).join(', ') || 'なし'}`)
  console.log('Retar:')
  for (const seat of s.aliveSeats) {
    const d = desc.get(seat) ?? '?'
    const marker = seat === mySeat(s) ? ' (me)' : ''
    console.log(`  seat${seat}: ${d}${marker}`)
  }
  if (showCandidates) {
    console.log(`Fox candidates: [${s.foxSeats.join(', ')}]`)
    console.log(`Wolf candidates: [${s.wolfSeats.join(', ')}]`)
  }
}

function mySeat(s: Sample): number { return s.mySeat }

function printAnswer(s: Sample) {
  const hasEndgame = s.mask.some(m => m)
  console.log(`Wolf-only (狼∩非狐): [${s.wolfOnly.map(v => `seat${v}`).join(', ') || 'なし'}]`)
  console.log(`Endgame labels: [${s.labels.map(tokenLabel).join(', ')}]`)
  console.log(`Endgame mask:   [${s.mask.map(m => m ? '✓' : '·').join(', ')}]`)
  if (hasEndgame) {
    console.log(`  → [0] 最終日(alive≤4): ${tokenLabel(s.labels[0])} (wolfOnly)`)
    console.log(`  → [1] 前日(alive5-6):  ${tokenLabel(s.labels[1])} (fox)`)
  } else if (s.foxSeats.length === 0) {
    console.log(`  → endgame 空 — 狐候補なし`)
  } else {
    console.log(`  → endgame 空 — wolfOnly なし（区別不能）`)
  }
}

// ============================================================
// Dump mode
// ============================================================

function runDump() {
  const NUM_SAMPLES = 20
  const rng = new Rng(42)
  let endgameActive = 0
  let endgameEmpty = 0
  let noFox = 0
  let noWolfOnly = 0

  for (let i = 0; i < NUM_SAMPLES; i++) {
    const s = generateSample(rng)
    const hasEndgame = s.mask.some(m => m)
    if (hasEndgame) {
      endgameActive++
    } else {
      endgameEmpty++
      if (s.foxSeats.length === 0) noFox++
      else noWolfOnly++
    }

    const tag = hasEndgame ? 'endgame あり' : s.foxSeats.length === 0 ? '狐なし' : 'wolfOnly なし'
    console.log(`\n=== Sample ${i + 1}: ${tag} ===`)
    printBoard(s)
    printAnswer(s)
  }

  console.log(`\n=== 分布 ===`)
  console.log(`endgame あり:   ${endgameActive}/${NUM_SAMPLES} (${(endgameActive / NUM_SAMPLES * 100).toFixed(0)}%)`)
  console.log(`endgame 空:     ${endgameEmpty}/${NUM_SAMPLES}`)
  console.log(`  狐なし:       ${noFox}`)
  console.log(`  wolfOnly なし: ${noWolfOnly}`)
}

// ============================================================
// Quiz mode
// ============================================================

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve))
}

function parseAnswer(input: string): number {
  const trimmed = input.trim().toLowerCase()
  if (trimmed === 'stop' || trimmed === 'x' || trimmed === '') return PLAN_VOCAB.STOP
  const m = trimmed.match(/^(?:seat)?(\d+)$/)
  if (m) return parseInt(m[1]) - 1  // seat number → vocab index
  return -1  // invalid
}

async function runQuiz() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const rng = new Rng(Date.now())
  const NUM_QUESTIONS = 10

  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║           Endgame Plan Token クイズ                     ║')
  console.log('╠══════════════════════════════════════════════════════════╣')
  console.log('║ あなたは NN です。Retar の出力を見て、endgame plan の   ║')
  console.log('║ 4トークンを出力してください。                          ║')
  console.log('║                                                        ║')
  console.log('║ ルール:                                                ║')
  console.log('║  [0] = 狼だけの候補 (wolf_no_fox) から1つ              ║')
  console.log('║  [1] = 狐候補から1つ                                   ║')
  console.log('║  [2],[3] = STOP                                        ║')
  console.log('║  狐候補なし or 狼だけの候補なし → 全 STOP              ║')
  console.log('║                                                        ║')
  console.log('║ 候補のどれかに一致すれば正解（手順が合っていればOK）   ║')
  console.log('║                                                        ║')
  console.log('║ 入力: seat番号(例: 5 or seat5) / stop / Enter=STOP     ║')
  console.log('║ q で終了                                               ║')
  console.log('╚══════════════════════════════════════════════════════════╝')

  let correct = 0
  let total = 0
  let perfectRounds = 0

  for (let i = 0; i < NUM_QUESTIONS; i++) {
    const s = generateSample(rng)
    const hasFox = s.foxSeats.length > 0

    console.log(`\n━━━ Q${i + 1}/${NUM_QUESTIONS} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    printBoard(s, false)  // 候補リストは隠す（NNは見えない）

    console.log('')

    // 4トークンを順に入力
    const answers: number[] = []
    const tokenNames = ['[0] 最終日の狼', '[1] 前日の狐', '[2]', '[3]']
    for (let t = 0; t < 4; t++) {
      const input = await ask(rl, `  ${tokenNames[t]}: `)
      if (input.trim().toLowerCase() === 'q') {
        console.log(`\n中断。${total} 問中 ${correct} トークン正解。`)
        rl.close()
        return
      }
      const parsed = parseAnswer(input)
      if (parsed === -1) {
        console.log('    (無効な入力 → STOP として扱います)')
        answers.push(PLAN_VOCAB.STOP)
      } else {
        answers.push(parsed)
      }
    }

    // 採点（手順として正しければ正解）
    // [0]: wolfOnly のどれかに一致 → 正解
    // [1]: foxSeats のどれかに一致 → 正解
    // [2]: STOP → 正解
    // mask が false のトークン → STOP なら正解
    const wolfOnlyIndices = new Set(s.wolfOnly.map(seat => seat - 1))
    const foxIndices = new Set(s.foxSeats.map(seat => seat - 1))
    const hasEndgame = s.mask.some(m => m)

    console.log('\n  ── 結果 ──')
    let roundCorrect = 0
    let roundTotal = 0
    for (let t = 0; t < 4; t++) {
      const yours = tokenLabel(answers[t])
      total++
      roundTotal++

      let ok: boolean
      let expected: string
      if (!hasEndgame) {
        // endgame 空 → 全トークン STOP が正解
        ok = answers[t] === PLAN_VOCAB.STOP
        expected = 'STOP (endgame 空)'
      } else if (t === 0) {
        ok = wolfOnlyIndices.has(answers[t])
        expected = `wolfOnly のどれか: [${s.wolfOnly.map(s => `seat${s}`).join(', ')}]`
      } else if (t === 1) {
        ok = foxIndices.has(answers[t])
        expected = `fox のどれか: [${s.foxSeats.map(s => `seat${s}`).join(', ')}]`
      } else {
        ok = answers[t] === PLAN_VOCAB.STOP
        expected = 'STOP'
      }

      if (ok) { correct++; roundCorrect++ }
      const mark = ok ? '✓' : '✗'
      console.log(`  [${t}] ${mark}  あなた: ${yours}  正解: ${expected}`)
    }

    if (roundCorrect === roundTotal) perfectRounds++

    // 正解の背景を表示
    console.log(`\n  ── 解説 ──`)
    console.log(`  Fox candidates: [${s.foxSeats.map(v => `seat${v}`).join(', ') || 'なし'}]`)
    console.log(`  Wolf-only (狼∩非狐): [${s.wolfOnly.map(v => `seat${v}`).join(', ') || 'なし'}]`)
    if (hasEndgame) {
      console.log(`  → [0] wolfOnly から1つ、[1] fox から1つ、[2] STOP`)
    } else if (s.foxSeats.length === 0) {
      console.log(`  → 狐候補なし → endgame 空（全 STOP）`)
    } else {
      console.log(`  → wolfOnly なし（狐と狼が区別不能）→ endgame 空（全 STOP）`)
    }

    console.log(`\n  累計: ${correct}/${total} (${total > 0 ? (correct / total * 100).toFixed(0) : 0}%)`)
  }

  console.log('\n══════════════════════════════════════════════════════')
  console.log(`最終結果: ${correct}/${total} トークン正解 (${total > 0 ? (correct / total * 100).toFixed(0) : 0}%)`)
  console.log(`完答ラウンド: ${perfectRounds}/${NUM_QUESTIONS}`)
  if (perfectRounds === NUM_QUESTIONS) {
    console.log('パーフェクト！ あなたは優秀な NN です。')
  } else if (correct / total >= 0.8) {
    console.log('良い精度です。pretrain 卒業レベル。')
  } else if (correct / total >= 0.5) {
    console.log('まだ学習が必要です。Retar の読み方を復習しましょう。')
  } else {
    console.log('pretrain やり直し。ルールを確認してください。')
  }
  console.log('══════════════════════════════════════════════════════')
  rl.close()
}

// ============================================================
// Main
// ============================================================

const isQuiz = process.argv.includes('--quiz')
if (isQuiz) {
  runQuiz()
} else {
  runDump()
}
