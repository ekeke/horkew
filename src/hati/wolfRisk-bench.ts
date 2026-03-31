/**
 * wolfRisk ベンチマーク: Lupaでゲーム生成 → 各チェックポイントで wolfRisk 評価
 * 結果をHowlコメントとしてマージして出力する。
 *
 * Usage: node --experimental-strip-types src/hati/wolfRisk-bench.ts [seeds=10]
 */
import type { SystemRole } from '../types/index.ts'
import type { GameEvent, GameState } from '../lupa/types.ts'
import { runGame } from '../lupa/engine.ts'
import { strategyAdapter } from '../lupa/adapters/strategy-adapter.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from '../lupa/heuristic.ts'
import { formatHowl } from '../lupa/format.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions, AnalyzeResult } from '../retar/index.ts'
import { Possibilities, possibilityFromRoles } from '../retar/possibilities.ts'
import { evaluateWolfRisk } from './wolfRisk.ts'
import { forEachSeat } from './types.ts'

// --- 設定 ---

const ROLES = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])

const ANALYZE_OPTIONS: AnalyzeOptions = {
  seerClaimingDueDate: 2,
  mediumClaimingDueDate: 2,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  hasFirstGhost: true,
  assumptions: new Map(),
  wolfPairDenyals: [],
  hocusPocus: new Map(),
}

const numSeeds = parseInt(process.argv[2] ?? '10', 10)

// --- ユーティリティ ---

/** AnalyzeResult → Possibilities（setup付き） */
function resultToPoss(result: AnalyzeResult, setup: Map<SystemRole, number>): Possibilities {
  const p = new Possibilities(setup)
  for (const [seat, roles] of result.result) {
    p.possibilities[seat] = possibilityFromRoles(roles)
  }
  p.maxSurvivingNV = result.maxSurvivingNV
  return p
}

/** 処刑チェックポイントを検出 */
function findExecutionCheckpoints(howl: string): { line: number, day: number }[] {
  const lines = howl.split('\n')
  const result: { line: number, day: number }[] = []
  let day = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/処刑$/)) {
      day++
      result.push({ line: i + 1, day })
    }
  }
  return result
}

/** ゲーム終了行を検出（村勝利/狼勝利/狐勝利/引き分け） */
function findGameOverLine(howl: string): number {
  const lines = howl.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^(村勝利|狼勝利|狐勝利|引き分け)$/)) return i + 1
  }
  return lines.length + 1
}

// --- メイン ---

console.log('=== wolfRisk Benchmark ===\n')

const allTimes: number[] = []
const t0Global = performance.now()

for (let seed = 0; seed < numSeeds; seed++) {
  // ゲーム生成
  let events: GameEvent[], state: GameState
  try {
    const gameConfig = {
      roles: ROLES, seed,
      hasFirstGhost: true,
      revoteConfig: { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const },
    }
    const handlers = strategyAdapter({
      defaultStrategy: new HeuristicStrategy(),
      wolfTeamStrategy: new WolfTeamHeuristic(),
      masonTeamStrategy: new MasonTeamHeuristic(),
      enableRetar: false,
      seed,
      roles: ROLES,
    })
    const result = await runGame(gameConfig, handlers)
    events = result.events
    state = result.state
  } catch (e) {
    console.error(`seed ${seed}: game error:`, e)
    continue
  }

  const config = { roles: ROLES, seed, hasFirstGhost: true }
  const howl = formatHowl(events, state, config)
  const checkpoints = findExecutionCheckpoints(howl)
  const gameOverLine = findGameOverLine(howl)

  // wolfMask 構築
  let wolfMask = 0
  for (const p of state.players) {
    if (p.role === 'werewolf') wolfMask |= (1 << p.seat)
  }

  const playerName = (seat: number) => state.players.find(p => p.seat === seat)!.name

  // チェックポイントごとの評価結果を蓄積: { 挿入先行番号, コメント文字列 }
  const annotations: { line: number, comment: string }[] = []
  const gameTimes: number[] = []

  for (const cp of checkpoints) {
    // ゲーム終了後のチェックポイントはスキップ
    if (cp.line >= gameOverLine) continue

    // 処刑行を含む（処刑後の状態で評価）
    const truncated = howl.split('\n').slice(0, cp.line).join('\n')
    try {
      const { meta, statements } = parse(truncated)
      const { vs, setup } = buildVillageStatus(statements, meta)

      // 村視点 Retar（公開情報のみ）
      const globalRetar = new VillageRetar(vs, setup, ANALYZE_OPTIONS)
      const globalResult = globalRetar.analyzeSafe()
      if (globalResult.error || globalResult.result.size === 0) continue
      const villagePoss = resultToPoss(globalResult, setup)

      // 人狼視点 Retar（仲間既知）
      const wolfAssumptions = new Map<number, SystemRole>()
      for (const p of state.players) {
        if (p.role === 'werewolf') wolfAssumptions.set(p.seat, 'werewolf' as SystemRole)
      }
      const wolfOptions = { ...ANALYZE_OPTIONS, assumptions: wolfAssumptions }
      const wolfRetar = new VillageRetar(vs, setup, wolfOptions)
      const wolfResult = wolfRetar.analyzeSafe()
      if (wolfResult.error || wolfResult.result.size === 0) continue
      const wolfPoss = resultToPoss(wolfResult, setup)

      // evaluateWolfRisk
      const t0 = performance.now()
      const risk = evaluateWolfRisk(wolfPoss, villagePoss, vs, setup, wolfMask)
      const elapsed = performance.now() - t0

      gameTimes.push(elapsed)
      allTimes.push(elapsed)

      // 結果をコメント行にフォーマット
      const parts: string[] = []
      const alive = risk.tsumiRateOnSuccess.length
      // 非狼生存者のみ表示
      for (let seat = 1; seat < alive; seat++) {
        const status = vs.statuses.get(seat)
        if (!status || !status.surviving) continue
        if (wolfMask & (1 << seat)) continue
        const s = risk.tsumiRateOnSuccess[seat]
        const f = risk.tsumiRateOnFailure[seat]
        parts.push(`${playerName(seat)}=${s.toFixed(2)}/${f.toFixed(2)}`)
      }
      const comment = `# wolf-risk (${elapsed.toFixed(2)}ms): ${parts.join(' ')}`
      // 処刑行の直後に挿入（line は処刑行、+1 で次の行に挿入）
      annotations.push({ line: cp.line + 1, comment })
    } catch (e) {
      console.error(`  seed ${seed} day ${cp.day}: parse error:`, e)
      continue
    }
  }

  // Howl にアノテーションをマージ
  const howlLines = howl.split('\n')
  // 挿入位置を逆順で処理（行番号がずれないように）
  for (const ann of annotations.sort((a, b) => b.line - a.line)) {
    howlLines.splice(ann.line - 1, 0, ann.comment)
  }

  // サマリコメント追加
  if (gameTimes.length > 0) {
    const avg = gameTimes.reduce((a, b) => a + b, 0) / gameTimes.length
    const max = Math.max(...gameTimes)
    howlLines.push(`# wolf-risk summary: ${gameTimes.length} checkpoints, avg ${avg.toFixed(2)}ms, max ${max.toFixed(2)}ms`)
  }

  console.log(howlLines.join('\n'))
  if (seed < numSeeds - 1) console.log('\n---\n')
}

// 全体サマリ
console.log('\n=== Summary ===')
if (allTimes.length > 0) {
  allTimes.sort((a, b) => a - b)
  const avg = allTimes.reduce((a, b) => a + b, 0) / allTimes.length
  const max = allTimes[allTimes.length - 1]
  const p50 = allTimes[Math.floor(allTimes.length * 0.5)]
  const p90 = allTimes[Math.floor(allTimes.length * 0.9)]
  const p95 = allTimes[Math.floor(allTimes.length * 0.95)]
  const p99 = allTimes[Math.floor(allTimes.length * 0.99)]
  console.log(`${allTimes.length} checkpoints across ${numSeeds} games`)
  console.log(`avg ${avg.toFixed(2)}ms, max ${max.toFixed(2)}ms`)
  console.log(`p50=${p50.toFixed(2)}ms p90=${p90.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms`)
}
console.log(`Total wall: ${(performance.now() - t0Global).toFixed(0)}ms`)
