/**
 * HuginnVoteAdapter — skoll-zero の daytime 投票を huginn 経由で決定する adapter。
 *
 * StrategyBaseAdapter を継承し、collectVotes のみ override する。
 * 投票収集フェーズで:
 *   1. 各 alive seat で agent.decideVote(ctx) を呼び MCTS policy を走らせる
 *      (戻り値の seat は使わず getLastMCTSResult() で visits 分布を拾う)
 *   2. DecisionContext + MCTS policy + retarPossibilities → HuginnInput 構築 (per-viewer)
 *   3. huginn.runRounds() で全 seat 一斉に交渉投票
 *   4. Trace.perAgent[i].finalVoteIdx を participants[idx] で seat に戻して Map<seat, target>
 *
 * TeamAgent (wolf/mason) は bypass し、個別 `agents` Map に登録された SkollZeroRoleAgent を呼ぶ (案 R)。
 * executionPlans は参照しない (案 I)。
 */

import type { GameState, PlayerState } from '../../lupa/types.ts'
import type { VoteContext, PhaseContext } from '../../lupa/handlers.ts'
import type { FenrirExt } from '../../fenrir/src/ext.ts'
import type { FenrirExtEvent } from '../../fenrir/src/events.ts'
import type { Proposal } from '../../fenrir/src/leadership.ts'
import type { DecisionContext, Agent } from '../../fenrir/src/agents/agent.ts'
import type { StrategyBaseAdapterConfig } from '../../fenrir/src/adapters/adapter-types.ts'
import { StrategyBaseAdapter } from '../../fenrir/src/adapters/strategy-base-adapter.ts'
import { buildPlayerView } from '../../lupa/player-view.ts'
import { alivePlayers } from '../../lupa/roles.ts'
import type { MCTSResult } from '../mcts/ISMCTS.ts'
import type { HuginnInput, RoleName } from '../../huginn/types.ts'
import { K_ROUNDS } from '../../huginn/types.ts'
import { runRounds } from '../../huginn/protocol.ts'
import type { TrainableNetwork } from '../../huginn/trainable-network.ts'
import { Rng as HuginnRng } from '../../huginn/rng.ts'
import { buildKnowledgeByOther } from './knowledge.ts'
import { buildDesire } from './desire.ts'

export type HuginnVoteAdapterConfig = StrategyBaseAdapterConfig & {
  huginnNetwork: TrainableNetwork
  huginnRounds?: number
  huginnSampling?: 'argmax' | 'stochastic'
  huginnSeed?: number
}

function hasLastMCTSResult(
  agent: Agent,
): agent is Agent & { getLastMCTSResult(): MCTSResult | null } {
  return typeof (agent as unknown as { getLastMCTSResult?: unknown }).getLastMCTSResult === 'function'
}

export class HuginnVoteAdapter extends StrategyBaseAdapter {
  private readonly huginnConfig: HuginnVoteAdapterConfig

  constructor(config: HuginnVoteAdapterConfig) {
    super(config)
    this.huginnConfig = config
  }

  protected override collectVotes(
    vctx: VoteContext<FenrirExtEvent, FenrirExt>,
    state: GameState<FenrirExt>,
    ext: FenrirExt,
    dayProposals: Proposal[],
  ): Map<number, number> {
    const alive = alivePlayers(state)
    if (alive.length === 0) return new Map()

    // participants は全 seat (死亡者含む、sorted)。huginn の vocab は N 固定前提なので、
    // alive 減少で layout ズレないよう死亡者も含める。死亡者は excluded=true で投票対象外。
    // 投票の origin (viewer) は alive のみ。
    const participants = state.players.map(p => p.seat).sort((a, b) => a - b)
    const aliveSet = new Set(alive.map(p => p.seat))
    const candidatesSet = vctx.candidates ? new Set(vctx.candidates) : null

    // 1. 全 alive seat で DecisionContext を構築 + 個別 agent.decideVote で MCTS を走らせる
    const viewerCtxs: { ctx: DecisionContext, player: PlayerState, mcts: MCTSResult | null }[] = []
    for (const player of alive) {
      const view = buildPlayerView(state, player.seat)
      const ctx = this.buildCtx(
        vctx as PhaseContext<FenrirExtEvent, FenrirExt>, player, view, ext, {
          revoteRound: vctx.revoteRound,
          revoteCandidates: vctx.candidates,
          proposals: dayProposals,
        },
      )
      const agent = this.getAgent(player.seat)
      agent.decideVote(ctx)  // MCTS 実行 (戻り値の seat は huginn 経由で上書きするため捨てる)
      const mcts = hasLastMCTSResult(agent) ? agent.getLastMCTSResult() : null
      viewerCtxs.push({ ctx, player, mcts })
    }

    // 2. HuginnInput 構築 (per-viewer)
    const inputs: HuginnInput[] = viewerCtxs.map(({ ctx, player, mcts }) => ({
      self: player.seat,
      viewerRole: player.role as RoleName,
      participants,
      desire: buildDesire(mcts, ctx, participants),
      excluded: participants.map(seat => {
        if (!aliveSet.has(seat)) return true  // 死亡者は投票対象外
        if (seat === player.seat) return true  // self-vote 禁止
        if (candidatesSet && !candidatesSet.has(seat)) return true  // revote 候補外
        return false
      }),
      isDesignationTarget: participants.map(() => false),  // 案 I: plan 無視
      knowledgeByOther: buildKnowledgeByOther(ctx, participants),
    }))

    // 3. huginn runRounds
    const sampling = this.huginnConfig.huginnSampling ?? 'argmax'
    const kRounds = this.huginnConfig.huginnRounds ?? K_ROUNDS
    const rng = sampling === 'stochastic'
      ? new HuginnRng(this.huginnConfig.huginnSeed ?? Date.now())
      : undefined
    const trace = runRounds(
      inputs,
      this.huginnConfig.huginnNetwork,
      new Map(),  // pastCommitViolations: Phase 2 は stateless、毎日新規
      { kRounds, sampling, rng },
    )

    // 4. finalVoteIdx (participants index) → seat に戻して Map<seat, target>
    const votes = new Map<number, number>()
    for (let i = 0; i < viewerCtxs.length; i++) {
      const { player } = viewerCtxs[i]
      const idx = trace.perAgent[i].finalVoteIdx
      votes.set(player.seat, participants[idx])
    }
    return votes
  }
}
