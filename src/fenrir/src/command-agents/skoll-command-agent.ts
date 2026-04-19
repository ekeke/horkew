/**
 * SkollCommandAgent — skoll 評価器を CommandAgent インターフェースで包む
 *
 * 現状の対応フェーズ:
 *   - vote: SkollMasterAgent.analyzeVote() で bestVote を選択
 *   - night / discussion / commander / cco: fallback agent（RandomCommandAgent デフォルト）に委譲
 *
 * 将来、各フェーズごとに skoll 判断ロジックを足す想定。
 *
 * skoll 連携で必要な文脈:
 *   - state.ext.retarCache （CommandAdapter が recomputeCommander で populate）
 *   - 真の役職情報（adapter は state.players[].role を参照可能）
 */

import type { SystemRole } from '../../../types/index.ts'
import type { GameState, PlayerState } from '../../../lupa/types.ts'
import { Rng } from '../../../lupa/random.ts'
import { alivePlayers } from '../../../lupa/roles.ts'
import { resolveRules } from '../../../howl/ruleset.ts'
import { SkollMasterAgent, type SkollMasterOptions } from '../../../skoll/skoll-master-agent.ts'
import type { DecisionContext } from '../agents/agent.ts'
import type { Command, CommandAdapterExt } from '../adapters/command/command-types.ts'
import type { CommandAgent, DecisionResult } from './command-agent.ts'
import { RandomCommandAgent } from './random-command-agent.ts'

export type SkollCommandAgentOptions = {
  /** skoll 判断不能時 / skoll 未対応フェーズ時の fallback エージェント */
  fallback?: CommandAgent
  /** SkollMasterAgent のオプション（NN fallback など） */
  skollOptions?: SkollMasterOptions
  /** 決定性確保用の seed（fallback 生成時と内部 rng に渡す） */
  seed?: number
}

export class SkollCommandAgent implements CommandAgent {
  readonly name = 'skoll'
  private master: SkollMasterAgent
  private fallback: CommandAgent
  private rng: Rng

  constructor(options: SkollCommandAgentOptions = {}) {
    this.master = new SkollMasterAgent(options.skollOptions)
    this.fallback = options.fallback ?? new RandomCommandAgent(options.seed)
    this.rng = new Rng(options.seed)
  }

  async decide(
    state: Readonly<GameState<CommandAdapterExt>>,
    mySeat: number,
    legal: readonly Command[],
  ): Promise<DecisionResult> {
    if (legal.length === 0) {
      throw new Error('SkollCommandAgent: legal commands is empty')
    }

    const phase = state.ext.currentPhase
    if (phase === 'vote') {
      return this.decideVote(state, mySeat, legal)
    }
    // 未対応フェーズは fallback に委譲
    const sub = await this.fallback.decide(state, mySeat, legal)
    const subLog = sub.log ?? ''
    return { cmd: sub.cmd, log: `(${phase})fallback→${this.fallback.name}: ${subLog}`.trim() }
  }

  // ============================================================
  // Vote: SkollMasterAgent.analyzeVote
  // ============================================================

  private async decideVote(
    state: Readonly<GameState<CommandAdapterExt>>,
    mySeat: number,
    legal: readonly Command[],
  ): Promise<DecisionResult> {
    const voteLegal = legal.filter(c => c.type === 'vote') as Array<Extract<Command, { type: 'vote' }>>
    if (voteLegal.length === 0) {
      const sub = await this.fallback.decide(state, mySeat, legal)
      return { cmd: sub.cmd, log: `(vote)fallback→${this.fallback.name}(no-vote-legal): ${sub.log ?? ''}`.trim() }
    }

    const player = state.players.find(p => p.seat === mySeat)
    if (!player) {
      return this.voteFallback(state, mySeat, voteLegal, 'no-player')
    }

    const ctx = this.buildDecisionContext(state, player)
    if (!ctx) {
      return this.voteFallback(state, mySeat, voteLegal, 'no-retar-cache')
    }

    const analysis = this.master.analyzeVote(ctx)
    if (!analysis || analysis.bestVote === null) {
      return this.voteFallback(state, mySeat, voteLegal, 'no-analysis')
    }

    // bestVote が legal に含まれているかチェック
    const match = voteLegal.find(c => c.target === analysis.bestVote)
    if (!match) {
      return this.voteFallback(
        state, mySeat, voteLegal,
        `bestVote-seat${analysis.bestVote}-not-in-legal`,
      )
    }

    const perspective = labelForRole(player.role)
    const best = analysis.candidates.find(c => c.seat === analysis.bestVote)
    const bestScore = best?.score ?? 0
    const worldsStr = analysis.totalWorlds != null ? ` worlds=${analysis.totalWorlds}` : ''
    const ppStr = analysis.ppAlreadyAchieved ? ' PP!' : ''
    const log = `[${perspective}/${analysis.source}]${worldsStr}${ppStr} bestVote=seat${analysis.bestVote} score=${bestScore.toFixed(3)}`
    return { cmd: match, log }
  }

  /** vote fallback: ランダム agent に委譲しつつ理由を log に残す */
  private async voteFallback(
    state: Readonly<GameState<CommandAdapterExt>>,
    mySeat: number,
    legal: readonly Command[],
    reason: string,
  ): Promise<DecisionResult> {
    const sub = await this.fallback.decide(state, mySeat, legal)
    return { cmd: sub.cmd, log: `(vote)fallback→${this.fallback.name}(${reason}): ${sub.log ?? ''}`.trim() }
  }

  // ============================================================
  // DecisionContext shim 構築
  // ============================================================

  /**
   * CommandAdapter 状態から最小 DecisionContext を組み立てる。
   * SkollMasterAgent.analyzeVote が実際に参照する field のみ埋める。
   * 他 field は型整合のためのプレースホルダ（skoll は読まない）。
   */
  private buildDecisionContext(
    state: Readonly<GameState<CommandAdapterExt>>,
    player: PlayerState,
  ): DecisionContext | null {
    const retarCache = state.ext.retarCache
    if (!retarCache || !retarCache.lastArtifacts) return null

    const alive = alivePlayers(state).map(p => p.seat)
    const wolfTeammates = player.role === 'werewolf'
      ? state.players.filter(p => p.role === 'werewolf' && p.seat !== player.seat).map(p => p.seat)
      : null
    const knownWolves = player.role === 'fanatic'
      ? state.players.filter(p => p.role === 'werewolf').map(p => p.seat)
      : null
    const knownHamster = player.role === 'immoralist'
      ? (state.players.find(p => p.role === 'werehamster')?.seat ?? null)
      : null
    const masonPartner = player.role === 'mason'
      ? (state.players.find(p => p.role === 'mason' && p.seat !== player.seat)?.seat ?? null)
      : null

    // ext に retarCache が必要。既に populated なので単純 cast で OK。
    // skoll は ctx.gameState.ext.retarCache.lastArtifacts を直接読む。
    return {
      mySeat: player.seat,
      myRole: player.role,
      myPlayer: player,
      day: state.day,
      phase: 'day',
      alivePlayers: alive,
      publicEvents: [],
      signals: [],
      commander: state.ext.commander,
      proposals: [],
      rng: this.rng,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CommandAdapterExt は skoll の期待形式と互換
      gameState: state as any,
      lastExecutedSeat: lastExecuted(state),
      retarPossibilities: retarCache.possibilities,
      maxSurvivingNV: null,
      globalRetarPossibilities: retarCache.possibilities,
      wolfTeammates,
      knownWolves,
      knownHamster,
      masonPartner,
      revoteRound: null,
      revoteCandidates: null,
      executionPlans: [],
      planIndices: null,
      tsumiTarget: null,
      rules: resolveRules(),
    }
  }
}

/** 最後に処刑された席（executionHistory の最大 day のエントリ） */
function lastExecuted(state: Readonly<GameState<CommandAdapterExt>>): number | null {
  let latest: number | null = null
  let maxDay = -1
  for (const [day, seat] of state.executionHistory) {
    if (day > maxDay) { maxDay = day; latest = seat }
  }
  return latest
}

function labelForRole(role: SystemRole): string {
  switch (role) {
    case 'werewolf': return 'wolf'
    case 'fanatic': return 'fanatic'
    case 'werehamster': return 'hamster'
    case 'immoralist': return 'immoralist'
    case 'mason': return 'mason'
    default: return 'village'
  }
}
