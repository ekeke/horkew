/**
 * CommandAdapter — Command Agent + Command 空間を lupa GameHandlers に接続する本体
 *
 * 設計: tasks/command-adapter-plan.md, tmp/new-command-game-design.txt
 * Phase 3 実装計画: C:/Users/aklas/.claude/plans/moonlit-forging-sunset.md
 *
 * 特徴:
 * - onPreVote を micro-step 方式で実装（`continueDiscussion` による continuation）
 * - Retar で人間陣営確定席から commander を自動選出
 * - designate_execution 時は全員強制投票（R7）
 */

import type { SystemRole, ResolvedRules } from '../../../../types/index.ts'
import type {
  GameState, GameEvent, NightAction, DayClaim, PlayerState,
} from '../../../../lupa/types.ts'
import type {
  GameHandlers, PhaseContext, VoteContext, PreVoteResult,
} from '../../../../lupa/handlers.ts'
import { alivePlayers } from '../../../../lupa/roles.ts'
import { Rng } from '../../../../lupa/random.ts'
import { analyzeFromEventsDetailed } from '../../retar-bridge.ts'
import type { FenrirExtEvent } from '../../events.ts'
import {
  createCommandAdapterExt,
  type CommandAdapterExt,
  type Command,
  type NightCommand,
} from './command-types.ts'
import { legalCommands } from './legal-commands.ts'
import {
  applyCommand,
  resetDiscussionQueue,
  isDiscussionExhausted,
} from './apply-command.ts'
import { selectCommanderFromRetar } from './commander.ts'
import type { CommandAgent } from '../../command-agents/command-agent.ts'

// ============================================================
// コンフィグ
// ============================================================

/**
 * onVote の投票収集ロジックを差し替えるためのフック.
 *
 * designated 強制 / candidate 確定 / voteCandidates セットは CommandAdapter 側で
 * 既存通り行い、「各 agent に decide を問う」部分だけ差し替えたい場合に使う.
 *
 * 戻り値:
 *   - Map<seat, target>: そのまま採用 (applyCommand や emitDecisionLog は collector の責務)
 *   - null: 既存の「各 agent に decide を問う」パスにフォールバック
 */
export type VoteCollector = (
  ctx: VoteContext<FenrirExtEvent, CommandAdapterExt>,
  params: {
    state: GameState<CommandAdapterExt>
    candidates: readonly number[]
    alive: readonly PlayerState[]
  },
) => Promise<Map<number, number> | null>

export type CommandAdapterConfig = {
  /** 席ごとの Agent。未登録席は defaultAgent を使う */
  agents: Map<number, CommandAgent>
  /** agents に無い席用のデフォルト Agent */
  defaultAgent: CommandAgent
  /** 役職分布（Retar 実行に必要） */
  roles: Map<SystemRole, number>
  /** lupa ResolvedRules partial */
  rules?: Partial<ResolvedRules>
  /** シャッフル・ランダム投票・エラーフォールバック用 */
  seed?: number
  /** Retar 呼び出しを無効化（デバッグ用） */
  disableRetar?: boolean
  /**
   * 村確定なら優先的に進行役に割り当てる席の集合。
   * 典型的にはヒューマンプレイ時の human 席。空なら通常通り最小席番。
   */
  preferredCommanderSeats?: ReadonlySet<number>
  /** 役職割当後フック。onSetup 内で呼ばれ、agents Map を席番号で動的に差し込める */
  onRolesAssigned?: (seatRoles: Map<number, SystemRole>) => void
  /** 1 日の onPreVote micro-step 上限（暴走防止、デフォルト 200） */
  maxPreVoteStepsPerDay?: number
  /** 各 GameEvent 発生時のフック（UI ライブ更新用） */
  onEventEmitted?: (event: GameEvent | FenrirExtEvent) => void
  /**
   * onSetup で state の参照を渡すフック。worker ランナーがイベント毎に state を
   * snapshot するために使う。lupa state は in-place 更新されるため、一度捕捉すれば以降参照可能。
   */
  onStateReady?: (state: GameState<CommandAdapterExt>) => void
  /**
   * 投票収集の差し替えフック. 指定時は onVote の「各 agent に decide を問う」部分の
   * 代わりに呼ばれる. null を返すとフォールバックして既存パスが走る.
   * designated 強制投票はこのフックを呼ぶ前に既存ロジックで処理される.
   */
  voteCollector?: VoteCollector
}

const DEFAULT_MAX_PREVOTE_STEPS = 200

// ============================================================
// アダプタ本体
// ============================================================

export class CommandAdapter implements GameHandlers<FenrirExtEvent, CommandAdapterExt> {
  private rng: Rng
  private config: CommandAdapterConfig

  constructor(config: CommandAdapterConfig) {
    this.config = config
    this.rng = new Rng(config.seed)
  }

  // ----------- onSetup -----------

  onSetup(roles: Map<number, SystemRole>, state: GameState<CommandAdapterExt>): void {
    state.ext = createCommandAdapterExt()
    this.config.onStateReady?.(state)
    this.config.onRolesAssigned?.(roles)
  }

  /** lupa engine からの event 通知（GameHandlers.onEvent） */
  onEvent(event: GameEvent | FenrirExtEvent): void {
    this.config.onEventEmitted?.(event)
  }

  // ----------- onNight -----------

  async onNight(
    ctx: PhaseContext<FenrirExtEvent, CommandAdapterExt>,
  ): Promise<Map<number, NightAction>> {
    const state = ctx.state as GameState<CommandAdapterExt>

    // R5 ② 処刑後の Retar 再評価
    this.recomputeCommander(state, ctx.events)

    const ext = state.ext
    ext.currentPhase = 'night'
    // 前日の指定・ステップカウンタをクリア
    ext.designatedTarget = null
    ext.runoffCandidates = null
    ext.preVoteStepCount = 0
    ext.requestedCategoriesThisDay.clear()
    ext.activeCoRequests = []

    const actions = new Map<number, NightAction>()
    for (const p of alivePlayers(state)) {
      const legal = legalCommands(state, p.seat)
      const agent = this.getAgent(p.seat)
      const t0 = performance.now()
      const result = await agent.decide(state, p.seat, legal, ctx.events)
      const elapsed = performance.now() - t0
      // emit を applyCommand の前に: applyCommand が state.ext.currentPhase を遷移させるため
      this.emitDecisionLog(ctx.events, agent, state, p.seat, result.cmd, result.log, elapsed)
      applyCommand(state, p.seat, result.cmd)
      if (result.cmd.type === 'attack') {
        // 襲撃は actor 席の NightAction として記録する（engine は Map key=席 で襲撃者を判定）
        actions.set(result.cmd.actor, { type: 'attack', target: result.cmd.target })
        if (result.cmd.actor !== p.seat && !actions.has(p.seat)) {
          actions.set(p.seat, { type: 'none' })
        }
      } else {
        // リーダーが他狼席に襲撃委任済みの場合、非リーダー狼の no_action で上書きしない
        const existing = actions.get(p.seat)
        if (!existing || existing.type !== 'attack') {
          actions.set(p.seat, toNightAction(result.cmd))
        }
      }
    }
    return actions
  }

  // ----------- onDayClaims -----------

  async onDayClaims(
    _ctx: PhaseContext<FenrirExtEvent, CommandAdapterExt>,
  ): Promise<Map<number, DayClaim>> {
    // 初 CO も含め全ての CO/議論は onPreVote continuation で処理するため空を返す
    // → forceTrueRoleCOPass は claimants 0 で no-op
    return new Map()
  }

  // ----------- onPreVote（micro-step dispatcher） -----------

  async onPreVote(
    ctx: PhaseContext<FenrirExtEvent, CommandAdapterExt>,
  ): Promise<PreVoteResult<FenrirExtEvent>> {
    const state = ctx.state as GameState<CommandAdapterExt>

    // R5 ① CO 反映後 / ③ 朝の襲撃反映後
    // （毎 step 冒頭で走らせる。冪等＆軽量）
    this.recomputeCommander(state, ctx.events)

    const ext = state.ext

    // 暴走防止: 1 日のステップ数上限を超えたら強制的に vote へ
    ext.preVoteStepCount++
    const maxSteps = this.config.maxPreVoteStepsPerDay ?? DEFAULT_MAX_PREVOTE_STEPS
    if (ext.preVoteStepCount > maxSteps) {
      ext.currentPhase = 'vote'
      return { continueDiscussion: false }
    }

    // 新日初回: night フェーズから discussion へ遷移しキューを初期化
    if (ext.currentPhase === 'night') {
      this.enterDiscussion(state)
    }

    switch (ext.currentPhase) {
      case 'discussion':
        return this.stepDiscussion(state, ctx.events)
      case 'commander':
        return this.stepCommander(state, ctx.events)
      case 'cco':
        return this.stepCco(state, ctx.events)
      case 'vote':
      default:
        return { continueDiscussion: false }
    }
  }

  // ----------- onVote -----------

  async onVote(
    ctx: VoteContext<FenrirExtEvent, CommandAdapterExt>,
  ): Promise<Map<number, number>> {
    const state = ctx.state as GameState<CommandAdapterExt>
    const ext = state.ext
    const alive = alivePlayers(state)
    const votes = new Map<number, number>()

    // R7: 吊り指定された場合は全員強制投票（agent 不介入）
    if (ctx.revoteRound === 0 && ext.designatedTarget !== null) {
      for (const p of alive) votes.set(p.seat, ext.designatedTarget)
      return votes
    }

    // 投票候補を確定（lupa の candidates 優先、次に runoff、最後に全生存）
    const candidates = ctx.candidates
      ?? ext.runoffCandidates
      ?? alive.map(p => p.seat)

    // 投票フェーズへ遷移し、候補をセット（legalCommands が参照）
    ext.currentPhase = 'vote'
    ext.voteCandidates = [...candidates]

    // voteCollector フック: 指定されていれば既存の per-agent 投票を飛ばして
    // collector の戻り値 (Map<seat, target>) をそのまま採用. null なら fallback.
    if (this.config.voteCollector) {
      const collected = await this.config.voteCollector(ctx, { state, candidates, alive })
      if (collected !== null) {
        ext.voteCandidates = null
        return collected
      }
    }

    // 各生存席に agent.decide で投票先を問う
    for (const p of alive) {
      const legal = legalCommands(state, p.seat)
      if (legal.length === 0) {
        // 候補が自分だけ等の想定外 → 自席以外の最初の候補
        const fallback = candidates.find(c => c !== p.seat) ?? candidates[0] ?? p.seat
        votes.set(p.seat, fallback)
        continue
      }
      const agent = this.getAgent(p.seat)
      const t0 = performance.now()
      const result = await agent.decide(state, p.seat, legal, ctx.events)
      const elapsed = performance.now() - t0
      this.emitDecisionLog(ctx.events, agent, state, p.seat, result.cmd, result.log, elapsed)
      applyCommand(state, p.seat, result.cmd)
      if (result.cmd.type === 'vote') {
        votes.set(p.seat, result.cmd.target)
      } else {
        // 異常系フォールバック
        const fallback = candidates.find(c => c !== p.seat) ?? candidates[0]
        votes.set(p.seat, fallback)
      }
    }

    // クリア
    ext.voteCandidates = null
    return votes
  }

  // ============================================================
  // 内部ヘルパー
  // ============================================================

  private getAgent(seat: number): CommandAgent {
    return this.config.agents.get(seat) ?? this.config.defaultAgent
  }

  private recomputeCommander(
    state: GameState<CommandAdapterExt>,
    events: readonly (GameEvent | FenrirExtEvent)[],
  ): void {
    if (this.config.disableRetar) {
      state.ext.commander = null
      state.ext.retarCache = null
      return
    }
    try {
      const lupaConfig = {
        roles: this.config.roles,
        rules: this.config.rules,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
      const plainEvents = [...events].filter(isGameEvent)
      const detailed = analyzeFromEventsDetailed(plainEvents, state, lupaConfig)
      const alive = alivePlayers(state).map(p => p.seat)
      state.ext.commander = selectCommanderFromRetar(
        detailed.possibilities, alive, this.config.preferredCommanderSeats,
      )
      state.ext.retarCache = {
        possibilities: detailed.possibilities,
        lastArtifacts: detailed.vs && detailed.setup
          ? { vs: detailed.vs, setup: detailed.setup }
          : null,
        computedAtEventCount: plainEvents.length,
      }
    } catch {
      // Retar 破綻時は commander = null（進行役なし）
      state.ext.commander = null
      state.ext.retarCache = null
    }
  }

  /**
   * Agent の判断を Howl コメントイベントとして emit。
   * ctx.events は lupa engine の内部 events 配列と同参照のため push で OK。
   * onEventEmitted hook も併せて呼ぶことでライブ UI 更新に追随させる。
   */
  private emitDecisionLog(
    events: readonly (GameEvent | FenrirExtEvent)[],
    agent: CommandAgent,
    state: GameState<CommandAdapterExt>,
    seat: number,
    cmd: Command,
    log: string | undefined,
    elapsedMs: number,
  ): void {
    const text = formatDecisionLog(agent, state, seat, cmd, log, elapsedMs)
    const ev: GameEvent = { type: 'comment', text }
    ;(events as (GameEvent | FenrirExtEvent)[]).push(ev)
    this.config.onEventEmitted?.(ev)
  }

  private enterDiscussion(state: GameState<CommandAdapterExt>): void {
    const ext = state.ext
    ext.currentPhase = 'discussion'
    const seats = alivePlayers(state).map(p => p.seat)
    resetDiscussionQueue(ext, this.rng.shuffle(seats))
  }

  private async stepDiscussion(
    state: GameState<CommandAdapterExt>,
    events: readonly (GameEvent | FenrirExtEvent)[],
  ): Promise<PreVoteResult<FenrirExtEvent>> {
    const ext = state.ext

    // キュー先頭を処理
    if (ext.discussionQueue.length > 0) {
      const seat = ext.discussionQueue[0]
      const legal = legalCommands(state, seat)
      const agent = this.getAgent(seat)
      const t0 = performance.now()
      const result = await agent.decide(state, seat, legal, events)
      const elapsed = performance.now() - t0
      this.emitDecisionLog(events, agent, state, seat, result.cmd, result.log, elapsed)
      applyCommand(state, seat, result.cmd)

      const additionalClaims = new Map<number, DayClaim>()
      if (result.cmd.type === 'role_co' || result.cmd.type === 'role_result_report') {
        additionalClaims.set(seat, result.cmd.claim)
        // キュー再構築（行動者を除外）
        const remaining = alivePlayers(state)
          .map(p => p.seat)
          .filter(s => s !== seat)
        resetDiscussionQueue(ext, this.rng.shuffle(remaining))
      }

      return { additionalClaims, continueDiscussion: true }
    }

    // キュー空: 全員連続 skip かどうか
    const aliveSeats = alivePlayers(state).map(p => p.seat)
    if (isDiscussionExhausted(ext, aliveSeats)) {
      // 一巡完了: commander へ戻るか vote へ. この時点で CO 要求 UI バナーは消す.
      ext.activeCoRequests = []
      if (ext.commander !== null) {
        ext.currentPhase = 'commander'
      } else {
        ext.currentPhase = 'vote'
        return { continueDiscussion: false }
      }
    } else {
      // キューは空だが skip 完結してない（行動者除外で空になった直後等）
      // → 残った生存者でキュー再構築
      resetDiscussionQueue(ext, this.rng.shuffle(aliveSeats))
    }
    return { continueDiscussion: true }
  }

  private async stepCommander(
    state: GameState<CommandAdapterExt>,
    events: readonly (GameEvent | FenrirExtEvent)[],
  ): Promise<PreVoteResult<FenrirExtEvent>> {
    const ext = state.ext
    const commanderSeat = ext.commander
    if (commanderSeat === null) {
      // 防御的: commander 消失（途中退場）→ vote へ
      ext.currentPhase = 'vote'
      return { continueDiscussion: false }
    }

    const legal = legalCommands(state, commanderSeat)
    const agent = this.getAgent(commanderSeat)
    const t0 = performance.now()
    const result = await agent.decide(state, commanderSeat, legal, events)
    const elapsed = performance.now() - t0
    this.emitDecisionLog(events, agent, state, commanderSeat, result.cmd, result.log, elapsed)
    applyCommand(state, commanderSeat, result.cmd)

    // applyCommand の中で遷移:
    //   request_co → discussion（consecutiveSkips クリア + queue 空）
    //   designate_execution / designate_runoff → cco（ccoQueue 構築）
    if (ext.currentPhase === 'discussion') {
      // キュー空から discussion 再開なので再構築
      const seats = alivePlayers(state).map(p => p.seat)
      resetDiscussionQueue(ext, this.rng.shuffle(seats))
    }

    return { continueDiscussion: true }
  }

  private async stepCco(
    state: GameState<CommandAdapterExt>,
    events: readonly (GameEvent | FenrirExtEvent)[],
  ): Promise<PreVoteResult<FenrirExtEvent>> {
    const ext = state.ext

    if (ext.ccoQueue.length > 0) {
      const seat = ext.ccoQueue[0]
      const legal = legalCommands(state, seat)
      const agent = this.getAgent(seat)
      const t0 = performance.now()
      const result = await agent.decide(state, seat, legal, events)
      const elapsed = performance.now() - t0
      this.emitDecisionLog(events, agent, state, seat, result.cmd, result.log, elapsed)
      applyCommand(state, seat, result.cmd)

      const additionalClaims = new Map<number, DayClaim>()
      const extraEvents: FenrirExtEvent[] = []

      if (result.cmd.type === 'cco_full') {
        additionalClaims.set(seat, result.cmd.claim)
      } else if (result.cmd.type === 'cco_villain_reveal') {
        // reveal イベントとして emit（lupa の GameEvent type）
        // FenrirExtEvent ではなく GameEvent なので、events 配列経由で渡す
        return {
          additionalClaims: new Map(),
          events: [{ type: 'reveal', seat, role: result.cmd.trueRole } as GameEvent],
          continueDiscussion: true,
        }
      }
      return { additionalClaims, events: extraEvents, continueDiscussion: true }
    }

    // CCO キュー空
    if (ext.ccoAnyReveal) {
      // 議論フェーズ再開
      this.enterDiscussion(state)
    } else {
      ext.currentPhase = 'vote'
      return { continueDiscussion: false }
    }
    return { continueDiscussion: true }
  }
}

// ============================================================
// ヘルパー
// ============================================================

/** Command を lupa NightAction に変換 */
function toNightAction(cmd: Command): NightAction {
  switch (cmd.type) {
    case 'divine':
      return { type: 'divine', target: (cmd as NightCommand & { target: number }).target }
    case 'guard':
      return { type: 'guard', target: (cmd as NightCommand & { target: number }).target }
    case 'attack':
      return { type: 'attack', target: (cmd as NightCommand & { target: number }).target }
    // no_action / その他 → lupa 上は none
    default:
      return { type: 'none' }
  }
}

/** 判断ログのテキスト整形: `D{day} {phase} seat{n}({role}) {agentName} [Nms]: {log} → {cmdSummary}` */
function formatDecisionLog(
  agent: CommandAgent,
  state: GameState<CommandAdapterExt>,
  seat: number,
  cmd: Command,
  log: string | undefined,
  elapsedMs: number,
): string {
  const player = state.players.find(p => p.seat === seat)
  const role = player?.role ?? '?'
  const phase = state.ext.currentPhase
  const summary = summarizeCommand(cmd, state)
  const elapsed = `[${Math.round(elapsedMs)}ms]`
  const head = `D${state.day} ${phase} seat${seat}(${role}) ${agent.name} ${elapsed}`
  return log ? `${head}: ${log} → ${summary}` : `${head} → ${summary}`
}

function summarizeCommand(cmd: Command, state: GameState<CommandAdapterExt>): string {
  const nameOf = (s: number): string => {
    const p = state.players.find(pl => pl.seat === s)
    return p ? `seat${s}` : `seat${s}`
  }
  switch (cmd.type) {
    case 'skip': return 'skip'
    case 'cco_skip': return 'cco_skip'
    case 'no_action': return 'no_action'
    case 'divine': return `divine ${nameOf(cmd.target)}`
    case 'guard': return `guard ${nameOf(cmd.target)}`
    case 'attack': return `attack by seat${cmd.actor} → ${nameOf(cmd.target)}`
    case 'vote': return `vote ${nameOf(cmd.target)}`
    case 'role_co': return `role_co ${cmd.claim.type}`
    case 'role_result_report': return `role_result_report ${cmd.claim.type}`
    case 'cco_full': return `cco_full ${cmd.claim.type}`
    case 'cco_villain_reveal': return `cco_villain_reveal ${cmd.trueRole}`
    case 'request_co': return `request_co ${cmd.category}`
    case 'designate_execution': return `designate_execution ${nameOf(cmd.target)}`
    case 'designate_runoff': return `designate_runoff ${cmd.targets.map(nameOf).join('/')}`
    default: return JSON.stringify(cmd)
  }
}

function isGameEvent(e: GameEvent | FenrirExtEvent): e is GameEvent {
  // GameEvent の type のうち FenrirExtEvent には存在しないもの、で判定できない
  // → すべてを GameEvent として扱う（formatHowl が未対応 type を無視する想定）
  void e
  return true
}
