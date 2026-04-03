/**
 * Hati 詰み手順を plan token 教師データとして収集
 *
 * データソース:
 * 1. DB (data/tsumi-db/) — howl + manifest から strategy tree を再構築、multi-depth ラベル
 * 2. Runtime (フォールバック) — ゲーム実行 + adapter の tsumiTarget、depth-1 ラベル
 */

import type { SystemRole } from '../../../types/index.ts'
import type { StrategyNode } from '../../../hati/types.ts'
import { searchTsumi, searchTsumiStrategy } from '../../../hati/index.ts'
import type { Strategy, DecisionContext } from '../strategy.ts'
import type { PlanTokenTrainingSample } from './execution-plan-data.ts'
import { runGame } from '../../../lupa/engine.ts'
import { minimalAdapter } from '../lupaAdapters/minimal-adapter.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from '../heuristic.ts'
import { RandomStrategy, WolfTeamRandom, MasonTeamRandom } from '../../../verify/random-strategy.ts'
import { encodeObservation } from '../observation.ts'
import { PLAN_VOCAB } from '../rule-action.ts'
import { lupaRunRetar } from '../retar-bridge.ts'
import { parse } from '../../../howl/parser.ts'
import { buildVillageStatus } from '../../../howl/bridge.ts'
import { rolesFromPossibility } from '../../../retar/possibilities.ts'
import { resolveRules } from '../../../howl/ruleset.ts'
import type { TrainingConfig } from '../training.ts'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AnalyzeOptions } from '../../../retar/index.ts'

const NUM_FORWARD_TOKENS = 8
const NUM_ENDGAME_TOKENS = 4

const DB_ANALYZE_OPTIONS: AnalyzeOptions = {
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

// ============================================================
// Strategy tree → plan token 変換
// ============================================================

/**
 * StrategyNode tree を greedy-first path で plan token 列にフラット化。
 * depth 1 の action.execute は常に正しい（OR-node の選択）。
 * depth 2+ は最初の branch を辿る。
 */
export function flattenStrategyToLabels(
  strategy: StrategyNode,
  numTokens: number,
): { labels: number[], mask: boolean[] } | null {
  const labels = new Array(numTokens).fill(PLAN_VOCAB.STOP)
  const mask = new Array(numTokens).fill(false)
  let pos = 0
  let node: StrategyNode = strategy

  while (node.type === 'action' && pos < numTokens - 1) {
    if (node.action.execute === -1) {
      // Night ノード: ラベルに含めず branch を辿って次の Day ノードへ
      const keys = Object.keys(node.branches)
      if (keys.length === 0) break
      const next = node.branches[keys[0]]
      if (next.type === 'win') break
      node = next
      continue
    }

    const seatIdx = node.action.execute - 1  // 0-based seat index
    if (seatIdx < 0 || seatIdx >= 14) break  // safety guard
    labels[pos] = seatIdx
    mask[pos++] = true

    const keys = Object.keys(node.branches)
    if (keys.length === 0) break
    const next = node.branches[keys[0]]
    if (next.type === 'win') break

    if (pos < numTokens - 1) {
      labels[pos] = PLAN_VOCAB.NEXT
      mask[pos++] = true
    }
    node = next
  }

  if (pos < numTokens) { labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true }
  if (pos < numTokens) { labels[pos] = PLAN_VOCAB.STOP; mask[pos] = true }

  return mask[0] ? { labels, mask } : null
}

// ============================================================
// DB から詰みデータを読み込み
// ============================================================

type ManifestEntry = {
  seed: number
  players: number
  file: string
  tsumi: Array<{
    day: number
    target: number
    alive: number
    strategyDepth: number
  }>
  result: string
}

function findExecutionCheckpoints(howl: string): { lineIndex: number, day: number }[] {
  const lines = howl.split('\n')
  const result: { lineIndex: number, day: number }[] = []
  let day = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/処刑$/)) {
      day++
      result.push({ lineIndex: i + 1, day })
    }
  }
  return result
}

/** howl の配役表から mason の seat を取得 */
function findMasonSeat(howl: string): number | null {
  const lines = howl.split('\n')
  for (const line of lines) {
    const m = line.match(/^(.+)＝共有$/)
    if (m) {
      // 座席名（プレイヤー名）→ 座席番号を howl の冒頭から探す
      // ++player1, player2, ... の並び順で seat が決まる
      const setupLine = lines.find(l => l.startsWith('++'))
      if (!setupLine) continue
      const players = setupLine.slice(2).split(/[、,]/).map(s => s.trim())
      const idx = players.indexOf(m[1])
      if (idx >= 0) return idx + 1
    }
  }
  return null
}

/** VillageStatus から生存席リストを取得 */
function getAliveSeats(vs: any): number[] {
  const alive: number[] = []
  if (vs.statuses) {
    for (const [seat, status] of vs.statuses) {
      if (status.alive) alive.push(seat)
    }
  }
  return alive
}

/**
 * DB の manifest + howl から pretrain サンプルを生成。
 * howl → parse → VillageStatus → Retar → observation (tsumi masked) + strategy labels。
 */
export function loadTsumiFromDB(
  dbDir: string,
  log?: (msg: string) => void,
): PlanTokenTrainingSample[] {
  const manifestPath = join(dbDir, 'manifest.ndjson')
  if (!existsSync(manifestPath)) return []

  const text = readFileSync(manifestPath, 'utf-8')
  const entries: ManifestEntry[] = text.split('\n').filter(Boolean).map(l => JSON.parse(l))

  const samples: PlanTokenTrainingSample[] = []
  let errors = 0

  for (const entry of entries) {
    const howlPath = join(dbDir, entry.file)
    if (!existsSync(howlPath)) continue

    const howl = readFileSync(howlPath, 'utf-8')
    const checkpoints = findExecutionCheckpoints(howl)
    const masonSeat = findMasonSeat(howl)
    if (masonSeat === null) continue

    // 一手前用: 前日の observation を記録
    let prevObs: Float32Array | null = null
    let prevDay = -1

    for (const tsumiInfo of entry.tsumi) {
      const cp = checkpoints.find(c => c.day === tsumiInfo.day)
      if (!cp) continue

      try {
        // 処刑直前の状態を再構築
        const truncated = howl.split('\n').slice(0, cp.lineIndex - 1).join('\n')
        const { meta, statements } = parse(truncated)
        const { vs, setup } = buildVillageStatus(statements, meta)

        // Retar → 可能性マップ
        const tsumiResult = searchTsumi(vs, setup, DB_ANALYZE_OPTIONS, lupaRunRetar)
        if (!tsumiResult.isTsumi) continue

        // Strategy tree を取得（DB 時は maxDepth を広げる）
        const sr = searchTsumiStrategy(tsumiResult, { maxDepth: 6 })
        if (!sr.strategy || sr.strategy.type !== 'action') continue

        // Retar possibilities を DecisionContext 用に変換
        // tsumiResult.conclusions は Possibilities (bitmask) 型
        const conclusions = tsumiResult.conclusions as any
        const retarPossibilities = new Map<number, Set<SystemRole>>()
        if (conclusions?.possibilities) {
          const aliveSeats = getAliveSeats(vs)
          for (const seat of aliveSeats) {
            const bits = conclusions.possibilities[seat]
            if (bits) {
              retarPossibilities.set(seat, new Set(rolesFromPossibility(bits)))
            }
          }
        }

        // mason 視点の簡易 DecisionContext を構築
        const aliveSeats = getAliveSeats(vs)
        const ctx: DecisionContext = {
          mySeat: masonSeat,
          myRole: 'mason',
          myPlayer: { seat: masonSeat, role: 'mason', alive: aliveSeats.includes(masonSeat), divineHistory: new Map(), guardHistory: new Map(), claimed: null, fakeDivineHistory: null } as any,
          day: tsumiInfo.day,
          phase: 'day',
          alivePlayers: aliveSeats,
          publicEvents: [],
          signals: [],
          commander: null,
          proposals: [],
          rng: { next: () => 0 } as any,
          gameState: { day: tsumiInfo.day, phase: 'day', players: [], commander: null } as any,
          lastExecutedSeat: tsumiInfo.day > 1 ? (checkpoints.find(c => c.day === tsumiInfo.day - 1) ? null : null) : null,
          retarPossibilities,
          maxSurvivingNV: null,
          globalRetarPossibilities: retarPossibilities,
          wolfTeammates: null,
          knownWolves: null,
          knownHamster: null,
          masonPartner: null,
          revoteRound: null,
          revoteCandidates: null,
          executionPlans: [],
          tsumiTarget: null,  // tsumi masked
          rules: resolveRules(),
        }

        const obs = encodeObservation(ctx)

        // Strategy tree → labels (multi-depth)
        const fwd = flattenStrategyToLabels(sr.strategy, NUM_FORWARD_TOKENS)
        const eg = flattenStrategyToLabels(sr.strategy, NUM_ENDGAME_TOKENS)
        if (!fwd || !eg) continue

        samples.push({
          observation: obs,
          forwardLabels: fwd.labels, forwardMask: fwd.mask,
          endgameLabels: eg.labels, endgameMask: eg.mask,
        })

        // 一手前の局面
        if (prevObs && prevDay === tsumiInfo.day - 1) {
          // 前日の処刑席を取得
          const prevCp = checkpoints.find(c => c.day === tsumiInfo.day - 1)
          if (prevCp) {
            const prevTruncated = howl.split('\n').slice(0, prevCp.lineIndex).join('\n')
            const execMatch = prevTruncated.match(/^(.+)処刑$/m)
            // 一手前のラベル: [前日target, NEXT, 今日のstrategy...]
            // 簡易版: 前日は strategy の最初のアクション、今日は次のアクション
            // → そのまま depth+1 の strategy として表現
          }
          // 一手前は prevObs + 今回の strategy の first action をラベルに
          const target = sr.strategy.action.execute
          const prevFwd = makePrevTsumiLabels(target, NUM_FORWARD_TOKENS)
          samples.push({
            observation: prevObs,
            forwardLabels: prevFwd.labels, forwardMask: prevFwd.mask,
            endgameLabels: eg.labels, endgameMask: eg.mask,
          })
        }

        // 今日の observation を一手前用に保存
        prevObs = obs
        prevDay = tsumiInfo.day
      } catch {
        errors++
      }
    }
  }

  if (log) {
    log(`  DB loaded: ${samples.length} samples from ${entries.length} games (${errors} errors)`)
  }
  return samples
}

/** 一手前の局面ラベル: [今日の詰み対象, STOP] (前日の observation に対して) */
function makePrevTsumiLabels(tsumiTarget: number, numTokens: number): { labels: number[], mask: boolean[] } {
  const labels = new Array(numTokens).fill(PLAN_VOCAB.STOP)
  const mask = new Array(numTokens).fill(false)
  labels[0] = tsumiTarget - 1
  mask[0] = true
  labels[1] = PLAN_VOCAB.STOP
  mask[1] = true
  if (numTokens > 2) { labels[2] = PLAN_VOCAB.STOP; mask[2] = true }
  return { labels, mask }
}

function spreadLabels(
  fwd: { labels: number[], mask: boolean[] },
  eg: { labels: number[], mask: boolean[] },
) {
  return {
    forwardLabels: fwd.labels, forwardMask: fwd.mask,
    endgameLabels: eg.labels, endgameMask: eg.mask,
  }
}

// ============================================================
// Runtime 収集 (フォールバック、DB がない場合)
// ============================================================

/** 詰み対象を1席だけ指定する plan token */
function makeTsumiLabels(target: number, numTokens: number): { labels: number[], mask: boolean[] } {
  const labels = new Array(numTokens).fill(PLAN_VOCAB.STOP)
  const mask = new Array(numTokens).fill(false)
  labels[0] = target - 1
  mask[0] = true
  labels[1] = PLAN_VOCAB.STOP
  mask[1] = true
  if (numTokens > 2) { labels[2] = PLAN_VOCAB.STOP; mask[2] = true }
  return { labels, mask }
}

type TsumiRecord = {
  observation: Float32Array
  forwardLabels: number[]
  forwardMask: boolean[]
  endgameLabels: number[]
  endgameMask: boolean[]
}

async function collectTsumiFromGame(
  config: TrainingConfig,
  seed: number,
  useRandom: boolean = true,
): Promise<TsumiRecord[]> {
  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])
  const records: TsumiRecord[] = []
  let masonSeat: number | null = null

  type DaySnapshot = { observation: Float32Array, day: number }
  const prevSnapshots: DaySnapshot[] = []

  class TsumiStrategy implements Strategy {
    private inner = new HeuristicStrategy()
    decideNightAction(ctx: DecisionContext) { return this.inner.decideNightAction(ctx) }
    decideDayClaim(ctx: DecisionContext) { return this.inner.decideDayClaim(ctx) }
    decideForecast(ctx: DecisionContext) { return this.inner.decideForecast(ctx) }
    decideCommunication(ctx: DecisionContext) { return this.inner.decideCommunication(ctx) }
    decideLeadershipResponse(ctx: DecisionContext, proposal: any) { return this.inner.decideLeadershipResponse(ctx, proposal) }
    decideDefensiveClaim(ctx: DecisionContext) { return this.inner.decideDefensiveClaim(ctx) }
    decideVote(ctx: DecisionContext) { return this.inner.decideVote(ctx) }

    decideProposal(ctx: DecisionContext) {
      const result = this.inner.decideProposal(ctx)

      if (masonSeat === null) masonSeat = ctx.mySeat
      if (ctx.mySeat !== masonSeat) return result

      const savedTsumi = ctx.tsumiTarget
      ctx.tsumiTarget = null
      const obs = encodeObservation(ctx)
      ctx.tsumiTarget = savedTsumi

      if (ctx.tsumiTarget !== null) {
        const target = ctx.tsumiTarget
        records.push({
          observation: obs,
          ...spreadLabels(makeTsumiLabels(target, NUM_FORWARD_TOKENS), makeTsumiLabels(target, NUM_ENDGAME_TOKENS)),
        })
        if (prevSnapshots.length > 0) {
          const prev = prevSnapshots[prevSnapshots.length - 1]
          if (prev.day === ctx.day - 1 && ctx.lastExecutedSeat !== null) {
            records.push({
              observation: prev.observation,
              ...spreadLabels(
                makeTsumiLabels(target, NUM_FORWARD_TOKENS),
                makeTsumiLabels(target, NUM_ENDGAME_TOKENS),
              ),
            })
          }
        }
      }

      prevSnapshots.push({ observation: obs, day: ctx.day })
      return result
    }
  }

  const tsumiStrategy = new TsumiStrategy()
  const strategies = new Map<number, Strategy>()

  const handlers = minimalAdapter({
    strategies,
    defaultStrategy: useRandom ? new RandomStrategy() : new HeuristicStrategy(),
    wolfTeamStrategy: useRandom ? new WolfTeamRandom() : new WolfTeamHeuristic(),
    masonTeamStrategy: useRandom ? new MasonTeamRandom() : new MasonTeamHeuristic(),
    onRolesAssigned: (seatRoles) => {
      for (const [seat, role] of seatRoles) {
        if (role === 'mason') {
          if (masonSeat === null) masonSeat = seat
          strategies.set(seat, tsumiStrategy)
        }
      }
    },
    seed,
    enableRetar: true,
    enableTsumi: true,
    roles,
    rules: config.rules ?? resolveRules(),
  })

  await runGame(
    { roles, seed, hasFirstGhost: config.hasFirstGhost, revoteConfig: config.revoteConfig, rules: config.rules },
    handlers,
  )

  return records
}

// ============================================================
// 公開 API
// ============================================================

export async function collectTsumiBatch(
  config: TrainingConfig,
  numGames: number,
  baseSeed: number = 80000,
  log?: (msg: string) => void,
): Promise<PlanTokenTrainingSample[]> {
  const all: PlanTokenTrainingSample[] = []
  for (let i = 0; i < numGames; i++) {
    try {
      const records = await collectTsumiFromGame(config, baseSeed + i)
      for (const r of records) all.push(r)
    } catch {
      // ゲーム実行エラーはスキップ
    }
    if (log && (i + 1) % 100 === 0) {
      log(`  tsumi collection: ${i + 1}/${numGames} games, ${all.length} samples`)
    }
  }
  return all
}

/** キャッシュ保存 (NDJSON) */
export function saveTsumiCache(samples: PlanTokenTrainingSample[], path: string): void {
  const lines = samples.map(s => JSON.stringify({
    obs: Buffer.from(s.observation.buffer).toString('base64'),
    fl: s.forwardLabels,
    fm: s.forwardMask,
    el: s.endgameLabels,
    em: s.endgameMask,
  }))
  writeFileSync(path, lines.join('\n'))
}

/** キャッシュ読み込み */
export function loadTsumiCache(path: string): PlanTokenTrainingSample[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf-8')
  return text.split('\n').filter(Boolean).map(line => {
    const obj = JSON.parse(line)
    const buf = Buffer.from(obj.obs, 'base64')
    return {
      observation: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
      forwardLabels: obj.fl,
      forwardMask: obj.fm,
      endgameLabels: obj.el,
      endgameMask: obj.em,
    }
  })
}
