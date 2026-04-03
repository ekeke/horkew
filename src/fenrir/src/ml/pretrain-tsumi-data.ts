/**
 * Hati 詰み手順を plan token 教師データとして収集
 *
 * 実ゲーム（ヒューリスティック同士）を回し、詰み検出時に:
 * 1. 詰み局面の observation + tsumiTarget をラベルとして記録
 * 2. 一手前の局面の observation + [前日処刑, NEXT, tsumiTarget] をラベルとして記録
 *
 * adapter が enableTsumi=true で検出した tsumiTarget（depth-1 の最初の処刑席）を使う。
 * 将来: adapter から strategy tree を露出させて multi-step ラベルに拡張。
 */

import type { SystemRole } from '../../../types/index.ts'
import type { StrategyNode } from '../../../hati/types.ts'
import type { Strategy, DecisionContext } from '../strategy.ts'
import type { PlanTokenTrainingSample } from './execution-plan-data.ts'
import { runGame } from '../../../lupa/engine.ts'
import { minimalAdapter } from '../lupaAdapters/minimal-adapter.ts'
import { HeuristicStrategy, WolfTeamHeuristic, MasonTeamHeuristic } from '../heuristic.ts'
import { RandomStrategy, WolfTeamRandom, MasonTeamRandom } from '../../../verify/random-strategy.ts'
import { encodeObservation } from '../observation.ts'
import { PLAN_VOCAB } from '../rule-action.ts'
import { resolveRules } from '../../../howl/ruleset.ts'
import type { TrainingConfig } from '../training.ts'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const NUM_FORWARD_TOKENS = 8
const NUM_ENDGAME_TOKENS = 4

// ============================================================
// Strategy tree → plan token 変換（将来用）
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
    labels[pos] = node.action.execute - 1  // 0-based seat index
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
// ゲーム実行 + 詰み収集
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

/** 一手前の局面ラベル: [前日の処刑席, NEXT, 今日の詰み対象, STOP] */
function makePrevTsumiLabels(
  prevExecuted: number, tsumiTarget: number, numTokens: number,
): { labels: number[], mask: boolean[] } {
  const labels = new Array(numTokens).fill(PLAN_VOCAB.STOP)
  const mask = new Array(numTokens).fill(false)
  let pos = 0
  labels[pos] = prevExecuted - 1; mask[pos++] = true
  if (pos < numTokens - 1) { labels[pos] = PLAN_VOCAB.NEXT; mask[pos++] = true }
  if (pos < numTokens - 1) { labels[pos] = tsumiTarget - 1; mask[pos++] = true }
  if (pos < numTokens) { labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true }
  if (pos < numTokens) { labels[pos] = PLAN_VOCAB.STOP; mask[pos] = true }
  return { labels, mask }
}

type TsumiRecord = {
  observation: Float32Array
  forwardLabels: number[]
  forwardMask: boolean[]
  endgameLabels: number[]
  endgameMask: boolean[]
}

/**
 * 1ゲームを実行し、詰み局面と一手前の局面を収集。
 * adapter の enableTsumi=true が ctx.tsumiTarget を設定する。
 */
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

  // mason は teamStrategy 経由で投票するため decideVote は呼ばれない。
  // decideProposal が adapter の onVote 内で呼ばれるので、そこでキャプチャする。
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

      // observation に tsumi フィールドを含めない（答えの漏洩防止）
      const savedTsumi = ctx.tsumiTarget
      ctx.tsumiTarget = null
      const obs = encodeObservation(ctx)
      ctx.tsumiTarget = savedTsumi

      if (ctx.tsumiTarget !== null) {
        const target = ctx.tsumiTarget
        // 詰み局面そのもの
        records.push({
          observation: obs,
          ...spreadLabels(makeTsumiLabels(target, NUM_FORWARD_TOKENS), makeTsumiLabels(target, NUM_ENDGAME_TOKENS)),
        })
        // 一手前の局面
        if (prevSnapshots.length > 0) {
          const prev = prevSnapshots[prevSnapshots.length - 1]
          if (prev.day === ctx.day - 1 && ctx.lastExecutedSeat !== null) {
            records.push({
              observation: prev.observation,
              ...spreadLabels(
                makePrevTsumiLabels(ctx.lastExecutedSeat, target, NUM_FORWARD_TOKENS),
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
          // mason は常に TsumiStrategy（observation を記録するため）
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
// バッチ収集 + キャッシュ
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
