/**
 * Win-Rate Estimator 教師データ収集
 *
 * RuleBasedAgent 同士の対戦から、全陣営・全投票時点の
 * observation + game result を収集する。
 */

import type { SystemRole, ResolvedRules } from '../../../types/index.ts'
import type { Agent, DecisionContext } from '../agents/agent.ts'
import { runGame } from '../../../lupa/engine.ts'
import type { RevoteConfig } from '../../../lupa/types.ts'
import { MasonTrainingAdapter } from '../adapters/mason-training-adapter.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../agents/rule-based-agent.ts'
import { encodeObservation } from '../observation.ts'
import { resolveRules } from '../../../howl/ruleset.ts'

// ============================================================
// Types
// ============================================================

export type WinrateSample = {
  observation: Float32Array
  seat: number
  role: SystemRole
  day: number
  /** one-hot: [village_win, wolf_win, fox_win] */
  gameResult: Float32Array
}

export type WinrateDataConfig = {
  roles: Record<string, number>
  hasFirstGhost: boolean
  revoteConfig?: RevoteConfig
  rules?: Partial<ResolvedRules>
}

// 結果 → one-hot ラベル変換
function gameResultToLabel(result: string): Float32Array {
  const label = new Float32Array(3)
  if (result === 'villager_won') label[0] = 1
  else if (result === 'werewolf_won') label[1] = 1
  else if (result === 'werehamster_won') label[2] = 1
  // draw は [0,0,0] — 学習から除外する方が安全
  return label
}

// ============================================================
// Single game collection
// ============================================================

/**
 * heuristic vs heuristic でゲームを1回実行し、全陣営の投票時点データを収集
 */
export async function collectWinrateGameData(
  config: WinrateDataConfig,
  seed: number,
): Promise<WinrateSample[]> {
  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])

  // 全座席の投票時点を記録
  const voteRecords: Array<{
    observation: Float32Array
    seat: number
    role: SystemRole
    day: number
  }> = []

  class RecordingStrategy implements Agent {
    private inner = new RuleBasedAgent()

    decideNightAction(ctx: DecisionContext) { return this.inner.decideNightAction(ctx) }
    decideDayClaim(ctx: DecisionContext) { return this.inner.decideDayClaim(ctx) }
    decideForecast(ctx: DecisionContext) { return this.inner.decideForecast(ctx) }
    decideCommunication(ctx: DecisionContext) { return this.inner.decideCommunication(ctx) }
    decideProposal(ctx: DecisionContext) { return this.inner.decideProposal(ctx) }
    decideLeadershipResponse(ctx: DecisionContext, proposal: any) { return this.inner.decideLeadershipResponse(ctx, proposal) }
    decideDefensiveClaim(ctx: DecisionContext) { return this.inner.decideDefensiveClaim(ctx) }

    decideVote(ctx: DecisionContext): number {
      const vote = this.inner.decideVote(ctx)

      // 全陣営を記録（死者は除外 — decideVote は生存者のみ呼ばれる）
      voteRecords.push({
        observation: encodeObservation(ctx),
        seat: ctx.mySeat,
        role: ctx.myRole,
        day: ctx.day,
      })

      return vote
    }
  }

  const recordingStrategy = new RecordingStrategy()

  const handlers = new MasonTrainingAdapter({
    agents: new Map<number, Agent>(),
    defaultAgent: recordingStrategy,
    wolfTeamAgent: new WolfTeamRuleAgent(),
    masonTeamAgent: new MasonTeamRuleAgent(),
    onRolesAssigned: () => {},
    seed,
    enableRetar: true,
    roles,
    rules: config.rules ?? resolveRules(),
  })

  const result = await runGame(
    {
      roles,
      seed,
      hasFirstGhost: config.hasFirstGhost,
      revoteConfig: config.revoteConfig,
      rules: config.rules,
    },
    handlers,
  )

  const gameResult = result.state.result
  if (!gameResult || gameResult === 'draw') return []  // draw は除外

  const label = gameResultToLabel(gameResult)

  return voteRecords.map(record => ({
    observation: record.observation,
    seat: record.seat,
    role: record.role,
    day: record.day,
    gameResult: label,
  }))
}

// ============================================================
// Batch collection
// ============================================================

/**
 * 複数ゲームのデータを収集
 */
export async function collectWinrateBatchData(
  config: WinrateDataConfig,
  numGames: number,
  baseSeed: number = 100000,
  onGameDone?: (gameIdx: number) => void,
): Promise<{ samples: WinrateSample[], stats: { villageWins: number, wolfWins: number, foxWins: number } }> {
  const allSamples: WinrateSample[] = []
  let villageWins = 0, wolfWins = 0, foxWins = 0

  for (let i = 0; i < numGames; i++) {
    const samples = await collectWinrateGameData(config, baseSeed + i)
    if (samples.length > 0) {
      allSamples.push(...samples)
      // 同じゲームの全サンプルは同じ結果
      if (samples[0].gameResult[0] === 1) villageWins++
      else if (samples[0].gameResult[1] === 1) wolfWins++
      else foxWins++
    }
    onGameDone?.(i)
  }

  return {
    samples: allSamples,
    stats: { villageWins, wolfWins, foxWins },
  }
}

// ============================================================
// Default 14D猫 config
// ============================================================

export const DEFAULT_14D_NEKO_CONFIG: WinrateDataConfig = {
  roles: {
    villager: 4,
    seer: 1,
    medium: 1,
    bodyguard: 1,
    mason: 2,
    nekomata: 1,
    werewolf: 3,
    possessed: 0,
    fanatic: 1,
    werehamster: 1,
    immoralist: 0,
  },
  hasFirstGhost: true,
}

// ============================================================
// PPO game results → WRE training samples
// ============================================================

/**
 * SerializedGameResult[] からWRE学習サンプルを抽出
 * PPOのゲーム生成結果をそのまま流用し、追加のゲーム生成なしで再学習データを得る
 */
export function extractWreSamplesFromGameResults(
  games: Array<{ individualSteps: Array<{ role: string, steps: Array<{ observation: number[] }> }>, result: string }>,
): { observations: Float32Array[], labels: Float32Array[] } {
  const observations: Float32Array[] = []
  const labels: Float32Array[] = []

  for (const game of games) {
    const result = game.result
    if (result === 'draw' || result === 'unknown') continue

    const label = new Float32Array(3)
    if (result === 'villager_won') label[0] = 1
    else if (result === 'werewolf_won') label[1] = 1
    else if (result === 'werehamster_won') label[2] = 1
    else continue

    for (const entry of game.individualSteps) {
      for (const step of entry.steps) {
        observations.push(new Float32Array(step.observation))
        labels.push(label)
      }
    }
  }

  return { observations, labels }
}
