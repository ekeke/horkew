/**
 * Method D: 実ゲームからの事前学習データ収集
 *
 * heuristic vs heuristic でゲームを実行し、各投票時点の
 * observation + heuristic vote + Retar possibilities + game result を収集する。
 */

import type { SystemRole } from '../../../types/index.ts'
import type { Agent, DecisionContext } from '../agents/agent.ts'
import { runGame } from '../../../lupa/engine.ts'
import { MasonTrainingAdapter } from '../adapters/mason-training-adapter.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../agents/rule-based-agent.ts'
import { encodeObservation, SEATS, NUM_ROLES, ROLE_INDEX } from '../observation.ts'
import { PLAN_VOCAB } from '../plan/plan-vocab.ts'
import { terminalReward, DEFAULT_REWARD_CONFIG } from '../reward.ts'
import { resolveRegulation } from '../../../howl/ruleset.ts'
import type { TrainingConfig } from '../training.ts'

export type PretrainSample = {
  observation: Float32Array
  /** plan token labels: [numTokens] vocab indices */
  forwardLabels: number[]
  forwardMask: boolean[]
  /** predict labels: [SEATS * NUM_ROLES] soft one-hot from Retar */
  predictLabel: Float32Array
  /** value label: terminal reward for this player */
  valueLabel: number
  /** player info */
  seat: number
  role: SystemRole
}

const VILLAGE_ROLES: Set<SystemRole> = new Set(['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata'])
const NUM_FORWARD_TOKENS = 8

/** Retar possibilities → predict soft label (1/n per possible role per seat) */
export function retarToPredictLabel(
  possibilities: Map<number, Set<SystemRole>> | null,
): Float32Array {
  const label = new Float32Array(SEATS * NUM_ROLES)
  if (!possibilities) return label
  for (let seat = 1; seat <= SEATS; seat++) {
    const roles = possibilities.get(seat)
    if (!roles || roles.size === 0) continue
    const prob = 1 / roles.size
    for (const role of roles) {
      const rIdx = ROLE_INDEX.get(role)
      if (rIdx !== undefined) {
        label[(seat - 1) * NUM_ROLES + rIdx] = prob
      }
    }
  }
  return label
}

/** heuristic vote seat → plan forward token labels */
export function voteToForwardLabels(
  voteSeat: number,
  numTokens: number = NUM_FORWARD_TOKENS,
): { labels: number[], mask: boolean[] } {
  const labels = new Array(numTokens).fill(PLAN_VOCAB.STOP)
  const mask = new Array(numTokens).fill(false)
  labels[0] = voteSeat - 1  // seat index (0-based)
  mask[0] = true
  labels[1] = PLAN_VOCAB.STOP
  mask[1] = true
  return { labels, mask }
}

/**
 * heuristic vs heuristic でゲームを1回実行し、村陣営の投票時点データを収集
 */
export async function collectGameData(
  config: TrainingConfig,
  seed: number,
): Promise<PretrainSample[]> {
  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])

  // 投票時点の記録バッファ
  const voteRecords: Array<{
    observation: Float32Array
    voteTarget: number
    retarPossibilities: Map<number, Set<SystemRole>> | null
    seat: number
    role: SystemRole
  }> = []

  // minimalAdapter をそのまま使うが、onVote 後に記録を挟むため
  // adapter を直接使わず、custom adapter wrapper でデータを収集する
  // → 実際には minimalAdapter の onVote 内で strategy.decideVote が呼ばれる
  //   ので、記録付きの wrapper strategy を使う

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

      // 村陣営のみ記録
      if (VILLAGE_ROLES.has(ctx.myRole)) {
        voteRecords.push({
          observation: encodeObservation(ctx),
          voteTarget: vote,
          retarPossibilities: ctx.retarPossibilities ? new Map(
            [...ctx.retarPossibilities].map(([k, v]) => [k, new Set(v)])
          ) : null,
          seat: ctx.mySeat,
          role: ctx.myRole,
        })
      }
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
    rules: config.rules ?? resolveRegulation(),
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

  const state = result.state
  const gameResult = state.result ?? 'unknown'

  // ゲーム結果から value label を生成
  const samples: PretrainSample[] = []
  for (const record of voteRecords) {
    const value = terminalReward(record.role, gameResult, DEFAULT_REWARD_CONFIG)
    const { labels, mask } = voteToForwardLabels(record.voteTarget)
    const predictLabel = retarToPredictLabel(record.retarPossibilities)

    samples.push({
      observation: record.observation,
      forwardLabels: labels,
      forwardMask: mask,
      predictLabel,
      valueLabel: value,
      seat: record.seat,
      role: record.role,
    })
  }

  return samples
}

/**
 * 複数ゲームのデータを収集
 */
export async function collectBatchGameData(
  config: TrainingConfig,
  numGames: number,
  baseSeed: number = 50000,
  onGameDone?: () => void,
): Promise<PretrainSample[]> {
  const allSamples: PretrainSample[] = []
  for (let i = 0; i < numGames; i++) {
    const samples = await collectGameData(config, baseSeed + i)
    allSamples.push(...samples)
    onGameDone?.()
  }
  return allSamples
}
