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
import type {
  Command, CommandAdapterExt, CoRequestCategory,
  VillainClaimAssignment,
} from '../adapters/command/command-types.ts'
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

/** commander で top-1 と top-2 の score 差がこれ未満なら designate_runoff を検討 */
const RUNOFF_THRESHOLD = 0.05
/** top-2 も含めて runoff 候補となる最低スコア（どちらもノイズ級は無視） */
const MIN_RUNOFF_SCORE = 0.1

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
        return this.discussionHide(player, legal)
      case 'werewolf':
      case 'fanatic':
      case 'werehamster':
      case 'immoralist':
        return this.discussionVillain(state, player, legal, events)
      default:
        return this.discussionHide(player, legal)
    }
  }

  /**
   * 人外の議論ルーター: villainClaimPlan を lazy 初期化し、割当に応じてルーティング。
   * 'seer' → fake seer、'medium' → fake medium、'hide' → 潜伏。
   */
  private discussionVillain(
    state: Readonly<GameState<CommandAdapterExt>>,
    player: PlayerState,
    legal: readonly Command[],
    events: AgentEvents,
  ): DecisionResult {
    // 初回: plan を populate（1 ゲーム内 1 回のみ）
    if (state.ext.villainClaimPlan.size === 0) {
      const plan = electVillainClaims(state)
      // Readonly cast を回避: ext は mutable（command-adapter 側で常に mutation）
      const mutablePlan = (state.ext as CommandAdapterExt).villainClaimPlan
      for (const [seat, role] of plan) mutablePlan.set(seat, role)
    }
    const assignment = state.ext.villainClaimPlan.get(player.seat) ?? 'hide'
    switch (assignment) {
      case 'seer':      return this.discussionFakeSeer(state, player, legal, events)
      case 'medium':    return this.discussionFakeMedium(state, player, legal, events)
      case 'bodyguard': return this.discussionOneShotCo(player, legal, 'bodyguard_co')
      case 'nekomata':  return this.discussionOneShotCo(player, legal, 'nekomata_co')
      case 'hide':
      default:          return this.discussionHide(player, legal)
    }
  }

  /**
   * 騙り占い: 未 CO → seer_co 空、CO 済 → fakeDivineHistory を日数分に満たしつつ未報告分を report。
   * target は非狼席からランダム（skoll は未活用、将来的に wolf-perspective で優先席選択を強化）。
   */
  private discussionFakeSeer(
    state: Readonly<GameState<CommandAdapterExt>>,
    player: PlayerState,
    legal: readonly Command[],
    events: AgentEvents,
  ): DecisionResult {
    if (!player.claimedRole) {
      // 空 results 版を選ぶ（fake 付き single-result 版は legal に存在しないため）
      const coCmd = legal.find(c =>
        c.type === 'role_co'
        && c.claim.type === 'seer_co'
        && c.claim.results.length === 0,
      )
      if (coCmd) return { cmd: coCmd, log: '(discussion)[fake-seer] initial CO (empty results)' }
    }

    // fakeDivineHistory を state.day に合わせて populate（不足分を生成）
    // D1 discussion では 1 件（D0 夜分）、D2 では 2 件…となる。
    // Skoll の wolf-perspective で「狼が最も吊りたい村役職」を smear 対象として優先。
    this.populateFakeDivineEntries(state, player, events)

    // 既に報告済みの対象を event 走査で確認
    const reportedTargets = collectReportedTargets(player.seat, events)
    // 最古未報告の fake を順番に出す
    const sortedFakes = [...player.fakeDivineHistory.entries()].sort(([a], [b]) => a - b)
    for (const [day, fake] of sortedFakes) {
      if (reportedTargets.has(fake.target)) continue
      const result = fake.result === 'wolf' ? 'wolf' : 'human'
      const reportCmd = legal.find(c =>
        c.type === 'role_result_report'
        && c.claim.type === 'seer_result'
        && c.claim.target === fake.target
        && c.claim.result === result,
      )
      if (reportCmd) {
        return {
          cmd: reportCmd,
          log: `(discussion)[fake-seer] fake-report D${day} seat${fake.target}=${result}`,
        }
      }
    }
    return skipOrFirst(legal, '(discussion)[fake-seer] all-reported skip')
  }

  /**
   * 騙り占いの fakeDivineHistory を day 分 populate する（不足分を生成）。
   *
   * 戦略:
   *   - 最初の 1 件 (D0 相当): 安全優先で非狼かつ未 fake の席を random pick、結果 'human'
   *   - 2 件目以降: Skoll の wolf-perspective 分析で「狼陣営が最も吊りたい席 = 村の有力情報役」
   *     を取得し、その席を 'wolf' で smear（= 村役職候補を偽黒で潰しにいく）。
   *     分析不能なら random non-wolf に 'human' fallback。
   */
  private populateFakeDivineEntries(
    state: Readonly<GameState<CommandAdapterExt>>,
    player: PlayerState,
    events: AgentEvents,
  ): void {
    const expected = state.day
    while (player.fakeDivineHistory.size < expected) {
      const nextDay = player.fakeDivineHistory.size
      const alreadyFaked = new Set<number>()
      for (const [, e] of player.fakeDivineHistory) alreadyFaked.add(e.target)

      // 除外対象: 自席 + 狼仲間 + 過去 fake 済み
      const excluded = new Set<number>([player.seat])
      for (const p of state.players) if (p.role === 'werewolf') excluded.add(p.seat)
      for (const s of alreadyFaked) excluded.add(s)

      // 1 件目は smear しない（まだ情報が少なく逆効果）。2 件目以降で Skoll 経由で smear 対象を探す
      if (nextDay >= 1) {
        const smearSeat = this.pickFakeSmearSeat(state, player, events, excluded)
        if (smearSeat !== null) {
          player.fakeDivineHistory.set(nextDay, { target: smearSeat, result: 'wolf' })
          continue
        }
      }

      // Fallback: 非狼・未 fake の席を random pick、結果 'human'（安全寄り）
      const candidates = state.players.filter(p => !excluded.has(p.seat))
      if (candidates.length === 0) break
      const picked = candidates[this.rng.nextInt(candidates.length)]
      player.fakeDivineHistory.set(nextDay, { target: picked.seat, result: 'human' })
    }
  }

  /**
   * Skoll wolf-perspective で「狼にとって最も吊りたい席」= 村側の情報役候補を返す。
   * retarCache 未構築や分析失敗時は null。
   */
  private pickFakeSmearSeat(
    state: Readonly<GameState<CommandAdapterExt>>,
    player: PlayerState,
    events: AgentEvents,
    excluded: Set<number>,
  ): number | null {
    const ctx = this.buildDecisionContext(state, player, events, 'day')
    if (!ctx) return null
    let analysis
    try {
      analysis = this.master.analyzeVote(ctx)
    } catch {
      return null
    }
    if (!analysis || analysis.candidates.length === 0) return null
    // wolf perspective: score 高い = 狼にとって吊りたい席 = 村の有力情報役
    const sorted = [...analysis.candidates]
      .filter(c => !c.excluded && !excluded.has(c.seat))
      .sort((a, b) => b.score - a.score)
    return sorted[0]?.seat ?? null
  }

  /**
   * 騙り霊能: 未 CO → medium_co 空、CO 済 → 処刑履歴に追従して報告。
   *
   * 戦略: 常に '○' と報告する
   *   - 非狼処刑時: 真霊能も '○' と言うので一致（自然に見える）
   *   - 狼処刑時: 真霊能が '●' と言う中で自分は '○' → divergence 発生
   *     真霊能が既に死亡している場合は village から見分け不能になり大きな攪乱
   *     真霊能生存時でも「どちらが真か」を判断材料にさせる（ログ/retar 勝負）
   */
  private discussionFakeMedium(
    state: Readonly<GameState<CommandAdapterExt>>,
    player: PlayerState,
    legal: readonly Command[],
    events: AgentEvents,
  ): DecisionResult {
    if (!player.claimedRole) {
      const coCmd = legal.find(c =>
        c.type === 'role_co'
        && c.claim.type === 'medium_co'
        && (c.claim.pastResults == null || c.claim.pastResults.length === 0),
      )
      if (coCmd) return { cmd: coCmd, log: '(discussion)[fake-medium] initial CO (empty past)' }
    }

    // 自席の medium_result event 数 = 報告済み数
    let reportedCount = 0
    for (const ev of events) {
      if ((ev as { type: string }).type !== 'medium_result') continue
      const e = ev as { actor?: number }
      if (e.actor === player.seat) reportedCount++
    }
    const executedCount = state.executionHistory.size
    if (reportedCount >= executedCount) {
      return skipOrFirst(legal, '(discussion)[fake-medium] up-to-date skip')
    }

    // 未報告の最古処刑 → 常に '○' (human) と報告（狼処刑隠し戦略）
    const sortedExecs = [...state.executionHistory.entries()].sort(([a], [b]) => a - b)
    const [day, executedSeat] = sortedExecs[reportedCount]
    const executed = state.players.find(p => p.seat === executedSeat)
    const fakeResult: 'human' | 'wolf' = 'human'
    const trueRole = executed?.role ?? '?'

    const reportCmd = legal.find(c =>
      c.type === 'role_result_report'
      && c.claim.type === 'medium_result'
      && c.claim.result === fakeResult,
    )
    if (reportCmd) {
      const tag = trueRole === 'werewolf' ? 'lie-hide-wolf' : 'truthful-non-wolf'
      return {
        cmd: reportCmd,
        log: `(discussion)[fake-medium] D${day} seat${executedSeat}=${fakeResult} (${tag})`,
      }
    }
    return skipOrFirst(legal, '(discussion)[fake-medium] no-matching-report')
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
        let ccoCmd: Command | undefined
        if (player.role === 'mason') {
          // 真相方席の mason_co を選ぶ
          const partner = state.players.find(p =>
            p.role === 'mason' && p.seat !== player.seat,
          )
          if (partner) {
            ccoCmd = legal.find(c =>
              c.type === 'cco_full'
              && c.claim.type === 'mason_co'
              && c.claim.partner === partner.seat,
            )
          }
          if (ccoCmd) {
            return {
              cmd: ccoCmd,
              log: `(cco)[mason] true-role last-chance CO partner=seat${partner!.seat}`,
            }
          }
        } else {
          ccoCmd = legal.find(c =>
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
    if (!player) return this.commanderSkipOrFallback(state, mySeat, legal, 'no-player', events)

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

    // Step B: 全 CO 揃った / 要求対象なし → skoll で最も怪しい席を判断
    const ctx = this.buildDecisionContext(state, player, events, 'day')
    if (!ctx) {
      return this.commanderSkipOrFallback(state, mySeat, legal, 'no-retar-cache', events)
    }

    const analysis = this.master.analyzeVote(ctx)
    if (!analysis || analysis.bestVote === null) {
      return this.commanderSkipOrFallback(state, mySeat, legal, 'no-analysis', events)
    }

    // top-2 candidate を score 降順で抽出（excluded 除外）
    const ranked = [...analysis.candidates]
      .filter(c => !c.excluded)
      .sort((a, b) => b.score - a.score)
    const top1 = ranked[0]
    const top2 = ranked[1]

    const worldsStr = analysis.totalWorlds != null ? ` worlds=${analysis.totalWorlds}` : ''

    // top-1 と top-2 が拮抗 (score 差 < RUNOFF_THRESHOLD) かつ両席とも有意 (>0.1) なら designate_runoff
    if (top1 && top2) {
      const diff = top1.score - top2.score
      if (diff < RUNOFF_THRESHOLD && top2.score > MIN_RUNOFF_SCORE) {
        const runoffCmd = legal.find(c =>
          c.type === 'designate_runoff'
          && c.targets.length === 2
          && c.targets.includes(top1.seat)
          && c.targets.includes(top2.seat),
        )
        if (runoffCmd) {
          return {
            cmd: runoffCmd,
            log: `(commander) runoff seat${top1.seat}/seat${top2.seat}${worldsStr} diff=${diff.toFixed(3)}`,
          }
        }
      }
    }

    // 通常: bestVote を designate_execution
    const designateCmd = legal.find(c =>
      c.type === 'designate_execution' && c.target === analysis.bestVote,
    )
    if (!designateCmd) {
      return this.commanderSkipOrFallback(
        state, mySeat, legal,
        `bestVote-seat${analysis.bestVote}-not-in-legal`, events,
      )
    }

    const bestScore = top1?.score ?? 0
    return {
      cmd: designateCmd,
      log: `(commander) designate seat${analysis.bestVote}${worldsStr} score=${bestScore.toFixed(3)}`,
    }
  }

  /**
   * commander の安全な撤退: skip が legal にあればそれを選び、
   * 無ければ fallback (random) へ。random designate を避ける。
   */
  private async commanderSkipOrFallback(
    state: Readonly<GameState<CommandAdapterExt>>,
    mySeat: number,
    legal: readonly Command[],
    reason: string,
    events: AgentEvents,
  ): Promise<DecisionResult> {
    const skipCmd = legal.find(c => c.type === 'skip')
    if (skipCmd) {
      return { cmd: skipCmd, log: `(commander) skip (${reason})` }
    }
    return this.fallbackFor('commander', state, mySeat, legal, reason, events)
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

/** 役職 → cco_full で使う真 CO の claim type（村騙り可能性のある役職は null） */
function trueCoClaimType(role: SystemRole): 'seer_co' | 'medium_co' | 'bodyguard_co' | 'nekomata_co' | 'mason_co' | null {
  switch (role) {
    case 'seer': return 'seer_co'
    case 'medium': return 'medium_co'
    case 'bodyguard': return 'bodyguard_co'
    case 'nekomata': return 'nekomata_co'
    case 'mason': return 'mason_co'
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

/**
 * 人外チームの騙り割当を決定。
 * 戦略（デフォルト）:
 *   - 狼 seat 昇順で 占い騙り → 霊能騙り、残り狼は潜伏
 *   - 狂信者: setup に bodyguard が存在するなら狩人騙り、いなければ潜伏
 *   - 妖狐・背徳者: 潜伏（積極騙りはリスクが高いため）
 *
 * 決定論的（seat 昇順）— 同一盤面なら常に同じ割当。
 */
function electVillainClaims(
  state: Readonly<GameState<CommandAdapterExt>>,
): Map<number, VillainClaimAssignment> {
  const result = new Map<number, VillainClaimAssignment>()
  const villains = state.players
    .filter(p => {
      return p.role === 'werewolf'
        || p.role === 'fanatic'
        || p.role === 'werehamster'
        || p.role === 'immoralist'
    })
    .sort((a, b) => a.seat - b.seat)

  // 狼: seat 昇順で 占い→霊能、残りは潜伏
  const wolves = villains.filter(p => p.role === 'werewolf')
  if (wolves.length >= 1) result.set(wolves[0].seat, 'seer')
  if (wolves.length >= 2) result.set(wolves[1].seat, 'medium')

  // 狂信者: setup に bodyguard がいれば狩人騙り、いなければ潜伏
  //   bodyguard がいない setup で狩人騙りを出すと retar で即バレしやすい
  const hasBodyguard = state.players.some(p => p.role === 'bodyguard')
  const fanatic = villains.find(p => p.role === 'fanatic')
  if (fanatic && hasBodyguard) {
    result.set(fanatic.seat, 'bodyguard')
  }

  // 残り（未割当の狼、fanatic が狩人騙りしなかった場合、狐、背徳）→ 潜伏
  for (const v of villains) {
    if (!result.has(v.seat)) result.set(v.seat, 'hide')
  }
  return result
}


/** event 列から指定 actor の seer_claim / seer_result に出た target 集合を収集 */
function collectReportedTargets(
  actorSeat: number, events: AgentEvents,
): Set<number> {
  const reported = new Set<number>()
  for (const ev of events) {
    const t = (ev as { type: string }).type
    if (t === 'seer_claim') {
      const e = ev as { actor?: number, results?: Array<{ target: number }> }
      if (e.actor === actorSeat) {
        for (const r of e.results ?? []) reported.add(r.target)
      }
    } else if (t === 'seer_result') {
      const e = ev as { actor?: number, target?: number }
      if (e.actor === actorSeat && e.target != null) reported.add(e.target)
    }
  }
  return reported
}
