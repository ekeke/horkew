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
import type { GameState, NightAction, PlayerState } from '../../../lupa/types.ts'
import { Rng } from '../../../lupa/random.ts'
import { alivePlayers } from '../../../lupa/roles.ts'
import { resolveRules } from '../../../howl/ruleset.ts'
import { SkollMasterAgent, type SkollMasterOptions } from '../../../skoll/skoll-master-agent.ts'
import type { DecisionContext } from '../agents/agent.ts'
import type { Command, CommandAdapterExt, CoRequestCategory } from '../adapters/command/command-types.ts'
import type { AgentEvents, CommandAgent, DecisionResult } from './command-agent.ts'
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
    events: AgentEvents = [],
  ): Promise<DecisionResult> {
    if (legal.length === 0) {
      throw new Error('SkollCommandAgent: legal commands is empty')
    }

    const phase = state.ext.currentPhase
    if (phase === 'vote') {
      return this.decideVote(state, mySeat, legal, events)
    }
    if (phase === 'night') {
      return this.decideNight(state, mySeat, legal, events)
    }
    if (phase === 'discussion') {
      return this.decideDiscussion(state, mySeat, legal, events)
    }
    if (phase === 'cco') {
      return this.decideCco(state, mySeat, legal, events)
    }
    if (phase === 'commander') {
      return this.decideCommander(state, mySeat, legal, events)
    }
    // 現在 commander/night/vote/discussion/cco を全てカバー済みなのでここに来るはずはない
    const sub = await this.fallback.decide(state, mySeat, legal, events)
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
    events: AgentEvents,
  ): Promise<DecisionResult> {
    const voteLegal = legal.filter(c => c.type === 'vote') as Array<Extract<Command, { type: 'vote' }>>
    if (voteLegal.length === 0) {
      const sub = await this.fallback.decide(state, mySeat, legal, events)
      return { cmd: sub.cmd, log: `(vote)fallback→${this.fallback.name}(no-vote-legal): ${sub.log ?? ''}`.trim() }
    }

    const player = state.players.find(p => p.seat === mySeat)
    if (!player) {
      return this.voteFallback(state, mySeat, voteLegal, 'no-player', events)
    }

    const ctx = this.buildDecisionContext(state, player, events, 'day')
    if (!ctx) {
      return this.voteFallback(state, mySeat, voteLegal, 'no-retar-cache', events)
    }

    const analysis = this.master.analyzeVote(ctx)
    if (!analysis || analysis.bestVote === null) {
      return this.voteFallback(state, mySeat, voteLegal, 'no-analysis', events)
    }

    // bestVote が legal に含まれているかチェック
    const match = voteLegal.find(c => c.target === analysis.bestVote)
    if (!match) {
      return this.voteFallback(
        state, mySeat, voteLegal,
        `bestVote-seat${analysis.bestVote}-not-in-legal`, events,
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
    events: AgentEvents,
  ): Promise<DecisionResult> {
    const sub = await this.fallback.decide(state, mySeat, legal, events)
    return { cmd: sub.cmd, log: `(vote)fallback→${this.fallback.name}(${reason}): ${sub.log ?? ''}`.trim() }
  }

  // ============================================================
  // Night: RuleBasedAgent.decideNightAction を流用
  // ============================================================

  private async decideNight(
    state: Readonly<GameState<CommandAdapterExt>>,
    mySeat: number,
    legal: readonly Command[],
    events: AgentEvents,
  ): Promise<DecisionResult> {
    const player = state.players.find(p => p.seat === mySeat)
    if (!player) {
      return this.nightFallback(state, mySeat, legal, 'no-player', events)
    }

    // 夜行動の主体は seer/bodyguard/werewolf のみ。それ以外は no_action に落とす。
    // （RuleBased は default で {type:'none'} を返すが、わざわざ呼ぶ必要もない）
    const noAction = legal.find(c => c.type === 'no_action')
    if (!['seer', 'bodyguard', 'werewolf'].includes(player.role)) {
      if (noAction) {
        return { cmd: noAction, log: `(night)[${player.role}] no-role-action` }
      }
      return this.nightFallback(state, mySeat, legal, 'no-noaction-legal', events)
    }

    // 狼リーダー以外は attack 権限なし → no_action のみが legal
    if (player.role === 'werewolf' && legal.length === 1 && legal[0].type === 'no_action') {
      return { cmd: legal[0], log: '(night)[werewolf] non-leader → no_action' }
    }

    const ctx = this.buildDecisionContext(state, player, events, 'night')
    if (!ctx) {
      return this.nightFallback(state, mySeat, legal, 'no-retar-cache', events)
    }

    // SkollMasterAgent は RuleBasedAgent を継承しているので decideNightAction をそのまま呼べる
    let action: NightAction
    try {
      action = this.master.decideNightAction(ctx)
    } catch {
      return this.nightFallback(state, mySeat, legal, 'rule-based-throw', events)
    }

    // NightAction → Command 変換
    const cmd = nightActionToCommand(action, legal)
    if (!cmd) {
      return this.nightFallback(
        state, mySeat, legal,
        `action-${action.type}-not-in-legal`, events,
      )
    }

    const actionStr = action.type === 'none'
      ? 'no_action'
      : `${action.type} seat${(action as { target?: number }).target ?? '?'}`
    return { cmd, log: `(night)[${player.role}/rule-based] ${actionStr}` }
  }

  /** night fallback: 現状は RandomCommandAgent に委譲 */
  private async nightFallback(
    state: Readonly<GameState<CommandAdapterExt>>,
    mySeat: number,
    legal: readonly Command[],
    reason: string,
    events: AgentEvents,
  ): Promise<DecisionResult> {
    const sub = await this.fallback.decide(state, mySeat, legal, events)
    return { cmd: sub.cmd, log: `(night)fallback→${this.fallback.name}(${reason}): ${sub.log ?? ''}`.trim() }
  }

  // ============================================================
  // Discussion: 真役職は CO・結果報告、それ以外は潜伏
  // ============================================================

  private async decideDiscussion(
    state: Readonly<GameState<CommandAdapterExt>>,
    mySeat: number,
    legal: readonly Command[],
    events: AgentEvents,
  ): Promise<DecisionResult> {
    const player = state.players.find(p => p.seat === mySeat)
    if (!player) return this.fallbackFor('discussion', state, mySeat, legal, 'no-player', events)

    switch (player.role) {
      case 'seer':     return this.discussionSeer(player, legal, events)
      case 'medium':   return this.discussionMedium(state, player, legal, events)
      case 'bodyguard': return this.discussionOneShotCo(player, legal, 'bodyguard_co')
      case 'nekomata': return this.discussionOneShotCo(player, legal, 'nekomata_co')
      case 'mason':    return this.discussionMason(state, player, legal)
      case 'villager':
      case 'werewolf':
      case 'fanatic':
      case 'werehamster':
      case 'immoralist':
        return this.discussionHide(player, legal)
      default:
        return this.discussionHide(player, legal)
    }
  }

  /** 真 seer: 未 CO → seer_co、CO 済 → 未報告の占い結果を順次 report、全て済みなら skip */
  private discussionSeer(
    player: PlayerState,
    legal: readonly Command[],
    events: AgentEvents,
  ): DecisionResult {
    if (!player.claimedRole) {
      const coCmd = legal.find(c => c.type === 'role_co' && c.claim.type === 'seer_co')
      if (coCmd) return { cmd: coCmd, log: '(discussion)[seer] true-role initial CO' }
    }

    // 既に CO 済: 自分が過去に宣言した seer_claim.results と個別 seer_result を集計
    const reportedTargets = new Set<number>()
    for (const ev of events) {
      if ((ev as { type: string }).type === 'seer_claim') {
        const e = ev as { actor?: number, results?: Array<{ target: number }> }
        if (e.actor === player.seat) {
          for (const r of e.results ?? []) reportedTargets.add(r.target)
        }
      } else if ((ev as { type: string }).type === 'seer_result') {
        const e = ev as { actor?: number, target?: number }
        if (e.actor === player.seat && e.target != null) {
          reportedTargets.add(e.target)
        }
      }
    }

    // divineHistory から未報告を探して report
    for (const [day, entry] of player.divineHistory) {
      if (reportedTargets.has(entry.target)) continue
      const reportCmd = legal.find(c =>
        c.type === 'role_result_report'
        && c.claim.type === 'seer_result'
        && c.claim.target === entry.target
        && c.claim.result === entry.result,
      )
      if (reportCmd) {
        return {
          cmd: reportCmd,
          log: `(discussion)[seer] report D${day} seat${entry.target}=${entry.result}`,
        }
      }
    }

    // 全部報告済み → skip
    return skipOrFirst(legal, '(discussion)[seer] all-reported skip')
  }

  /** 真 medium: 未 CO → medium_co、最新処刑を未報告なら report、済みなら skip */
  private discussionMedium(
    state: Readonly<GameState<CommandAdapterExt>>,
    player: PlayerState,
    legal: readonly Command[],
    events: AgentEvents,
  ): DecisionResult {
    if (!player.claimedRole) {
      const coCmd = legal.find(c => c.type === 'role_co' && c.claim.type === 'medium_co')
      if (coCmd) return { cmd: coCmd, log: '(discussion)[medium] true-role initial CO' }
    }

    // 報告済み回数 = 自分発の medium_result イベント数
    let reportedCount = 0
    for (const ev of events) {
      if ((ev as { type: string }).type !== 'medium_result') continue
      const e = ev as { actor?: number }
      if (e.actor === player.seat) reportedCount++
    }

    // 処刑履歴の件数と比較。未報告があれば最新を report。
    const executedCount = state.executionHistory.size
    if (reportedCount >= executedCount) {
      return skipOrFirst(legal, '(discussion)[medium] up-to-date skip')
    }

    // 未報告の最古処刑（順番通りに出す）
    const sortedExecs = [...state.executionHistory.entries()].sort((a, b) => a[0] - b[0])
    const [day, executedSeat] = sortedExecs[reportedCount]
    const executed = state.players.find(p => p.seat === executedSeat)
    const trueResult = executed?.role === 'werewolf' ? 'wolf' : 'human'

    const reportCmd = legal.find(c =>
      c.type === 'role_result_report'
      && c.claim.type === 'medium_result'
      && c.claim.result === trueResult,
    )
    if (reportCmd) {
      return {
        cmd: reportCmd,
        log: `(discussion)[medium] report D${day} seat${executedSeat}=${trueResult}`,
      }
    }
    return skipOrFirst(legal, '(discussion)[medium] no-matching-report')
  }

  /** 真 bodyguard / nekomata: 初回 CO、以後 skip */
  private discussionOneShotCo(
    player: PlayerState,
    legal: readonly Command[],
    claimType: 'bodyguard_co' | 'nekomata_co',
  ): DecisionResult {
    if (!player.claimedRole) {
      const coCmd = legal.find(c => c.type === 'role_co' && c.claim.type === claimType)
      if (coCmd) return { cmd: coCmd, log: `(discussion)[${player.role}] true-role initial CO` }
    }
    return skipOrFirst(legal, `(discussion)[${player.role}] already-CO skip`)
  }

  /** 真 mason: 未 CO → mason_co (partner = 真相方席)、以後 skip */
  private discussionMason(
    state: Readonly<GameState<CommandAdapterExt>>,
    player: PlayerState,
    legal: readonly Command[],
  ): DecisionResult {
    if (!player.claimedRole) {
      const partner = state.players.find(p => p.role === 'mason' && p.seat !== player.seat)
      if (partner) {
        const coCmd = legal.find(c =>
          c.type === 'role_co'
          && c.claim.type === 'mason_co'
          && c.claim.partner === partner.seat,
        )
        if (coCmd) {
          return {
            cmd: coCmd,
            log: `(discussion)[mason] true-role initial CO partner=seat${partner.seat}`,
          }
        }
      }
    }
    return skipOrFirst(legal, '(discussion)[mason] already-CO skip')
  }

  /** 潜伏（villager/wolf/fanatic/hamster/immoralist）: skip */
  private discussionHide(player: PlayerState, legal: readonly Command[]): DecisionResult {
    return skipOrFirst(legal, `(discussion)[${player.role}] hide skip`)
  }

  // ============================================================
  // CCO: 真役職未 CO なら cco_full、villain/その他は cco_skip
  // ============================================================

  private async decideCco(
    state: Readonly<GameState<CommandAdapterExt>>,
    mySeat: number,
    legal: readonly Command[],
    events: AgentEvents,
  ): Promise<DecisionResult> {
    const player = state.players.find(p => p.seat === mySeat)
    if (!player) return this.fallbackFor('cco', state, mySeat, legal, 'no-player', events)

    // 未 CO の真役職 → cco_full で表明
    if (!player.claimedRole) {
      const targetClaimType = trueCoClaimType(player.role)
      if (targetClaimType) {
        const ccoCmd = legal.find(c =>
          c.type === 'cco_full' && c.claim.type === targetClaimType,
        )
        if (ccoCmd) {
          return {
            cmd: ccoCmd,
            log: `(cco)[${player.role}] true-role last-chance CO`,
          }
        }
      }
    }

    // それ以外は自白しない（CO 済み真役職も結果は既に出している前提）→ cco_skip
    const skipCmd = legal.find(c => c.type === 'cco_skip')
    if (skipCmd) {
      return { cmd: skipCmd, log: `(cco)[${player.role}] stay-silent skip` }
    }
    // 念のため fallback（legal に cco_skip 無い場合）
    return this.fallbackFor('cco', state, mySeat, legal, 'no-skip-legal', events)
  }

  // ============================================================
  // Commander: CO 要求 → 全 CO 揃ったら吊り指定（skoll bestVote）
  // ============================================================

  private async decideCommander(
    state: Readonly<GameState<CommandAdapterExt>>,
    mySeat: number,
    legal: readonly Command[],
    events: AgentEvents,
  ): Promise<DecisionResult> {
    const player = state.players.find(p => p.seat === mySeat)
    if (!player) return this.fallbackFor('commander', state, mySeat, legal, 'no-player', events)

    // Step A: まだ CO が来てない役職カテゴリがあれば request_co
    const unclaimed = findUnclaimedRoleCategory(state, events)
    if (unclaimed) {
      const reqCmd = legal.find(c =>
        c.type === 'request_co' && c.category === unclaimed,
      )
      if (reqCmd) {
        return { cmd: reqCmd, log: `(commander) request-co ${unclaimed}` }
      }
    }

    // Step B: 全 CO 揃った / 要求対象なし → skoll で最も怪しい席を吊り指定
    const ctx = this.buildDecisionContext(state, player, events, 'day')
    if (!ctx) {
      return this.fallbackFor('commander', state, mySeat, legal, 'no-retar-cache', events)
    }

    const analysis = this.master.analyzeVote(ctx)
    if (!analysis || analysis.bestVote === null) {
      return this.fallbackFor('commander', state, mySeat, legal, 'no-analysis', events)
    }

    const designateCmd = legal.find(c =>
      c.type === 'designate_execution' && c.target === analysis.bestVote,
    )
    if (!designateCmd) {
      return this.fallbackFor(
        'commander', state, mySeat, legal,
        `bestVote-seat${analysis.bestVote}-not-in-legal`, events,
      )
    }

    const best = analysis.candidates.find(c => c.seat === analysis.bestVote)
    const bestScore = best?.score ?? 0
    const worldsStr = analysis.totalWorlds != null ? ` worlds=${analysis.totalWorlds}` : ''
    return {
      cmd: designateCmd,
      log: `(commander) designate seat${analysis.bestVote}${worldsStr} score=${bestScore.toFixed(3)}`,
    }
  }

  // ============================================================
  // 汎用 fallback（discussion/cco のエラー系で共通）
  // ============================================================

  private async fallbackFor(
    phase: string,
    state: Readonly<GameState<CommandAdapterExt>>,
    mySeat: number,
    legal: readonly Command[],
    reason: string,
    events: AgentEvents,
  ): Promise<DecisionResult> {
    const sub = await this.fallback.decide(state, mySeat, legal, events)
    return { cmd: sub.cmd, log: `(${phase})fallback→${this.fallback.name}(${reason}): ${sub.log ?? ''}`.trim() }
  }

  // ============================================================
  // DecisionContext shim 構築
  // ============================================================

  /**
   * CommandAdapter 状態から最小 DecisionContext を組み立てる。
   * SkollMasterAgent.analyzeVote / RuleBasedAgent.decideNightAction が
   * 参照する field を埋める（publicEvents は events から流す）。
   */
  private buildDecisionContext(
    state: Readonly<GameState<CommandAdapterExt>>,
    player: PlayerState,
    events: AgentEvents,
    phase: 'night' | 'day',
  ): DecisionContext | null {
    const retarCache = state.ext.retarCache
    // vote では retarCache 必須、night でも rule-based は retarPossibilities を参照するので必要
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
      phase,
      alivePlayers: alive,
      publicEvents: events,
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

/**
 * 未 claim な役職カテゴリを 1 つ返す（seer → medium → bodyguard → nekomata の順）。
 * 判断基準: 初期セットアップに該当役職が存在する & events 中に *_claim が無い。
 * 初期セットアップは state.players から再構築（生死問わず全プレイヤーの role 集計）。
 */
function findUnclaimedRoleCategory(
  state: Readonly<GameState<CommandAdapterExt>>,
  events: AgentEvents,
): CoRequestCategory | null {
  const categories: Array<[CoRequestCategory, SystemRole, string]> = [
    ['seer', 'seer', 'seer_claim'],
    ['medium', 'medium', 'medium_claim'],
    ['bodyguard', 'bodyguard', 'bodyguard_claim'],
    ['nekomata', 'nekomata', 'nekomata_claim'],
  ]
  for (const [cat, role, claimType] of categories) {
    // その役職が setup に存在しないなら要求しない
    const hasRole = state.players.some(p => p.role === role)
    if (!hasRole) continue
    // events 中に該当 CO があれば要求しない
    const hasClaim = events.some(e => (e as { type: string }).type === claimType)
    if (!hasClaim) return cat
  }
  return null
}

/** skip コマンドが legal に無ければ legal[0] で最悪回避する共通ヘルパー */
function skipOrFirst(legal: readonly Command[], log: string): DecisionResult {
  const skip = legal.find(c => c.type === 'skip')
  return { cmd: skip ?? legal[0], log }
}

/** 役職 → cco_full で使う真 CO の claim type（偽 CO 可能性のある役職は null） */
function trueCoClaimType(role: SystemRole): 'seer_co' | 'medium_co' | 'bodyguard_co' | 'nekomata_co' | null {
  switch (role) {
    case 'seer': return 'seer_co'
    case 'medium': return 'medium_co'
    case 'bodyguard': return 'bodyguard_co'
    case 'nekomata': return 'nekomata_co'
    // mason は cco_full に partner が必要で現在 legal 列挙が対応してないため除外
    // villain/villager 系は cco_skip で揃える
    default: return null
  }
}

/** NightAction → legal に一致する Command を返す。不一致なら null。 */
function nightActionToCommand(
  action: NightAction,
  legal: readonly Command[],
): Command | null {
  if (action.type === 'none') {
    return legal.find(c => c.type === 'no_action') ?? null
  }
  const target = action.target
  const match = legal.find(c =>
    c.type === action.type
    && 'target' in c
    && c.target === target,
  )
  return match ?? null
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
