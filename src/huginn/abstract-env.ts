/**
 * Abstract negotiation-and-voting game (Huginn が遊ぶゲーム本体).
 *
 * シナリオ構造:
 *   - 各ゲームで、チームごとに「最優先ターゲット (primary)」をランダム選出
 *   - 同チームメンバは primary を共有、他敵に対する desire も同じ
 *   - これによりチーム内の集票協調と、チーム間の票交渉に意味が生まれる
 *
 * Desire 値:
 *   self        : 0
 *   teammate    : LOW_BASE (≈0.05)
 *   own primary : HIGH_BASE (≈0.95)
 *   other enemy : MID_BASE (≈0.55)
 *   noise       : ±NOISE_AMP * (1 - desireCorrelation)
 *
 * - K ラウンド交渉 → 同時投票 → 最多得票者を 1 名 eliminate
 * - 報酬 = desire[eliminated] + 食言ペナルティ
 */

import type { HuginnInput, AgentId, Message } from './types.ts'
import { COMMIT_VIOLATION_PENALTY, DESIRE_HIGH_BASE } from './types.ts'
import type { Rng } from './rng.ts'
import { detectCommitViolation, type Trace } from './protocol.ts'

export type AgentRole =
  | 'learning'                          // policy 学習対象
  | { type: 'fixedVote'; target: AgentId; silent?: boolean }   // 固定投票、silent なら全ラウンド SILENT
  | { type: 'silent' }                  // SILENT 固定、投票はランダム
  /** 実演ボット: 毎 round offer を出す. 投票は primary.
   *  mode='split' (default): offer(iVote=primary, youVote=(acceptable\{primary}) の round サイクル) — 2-way 分割提案
   *  mode='unanimous': offer(iVote=primary, youVote=primary) — 「primary に全員で合意しよう」broadcast
   *  primary/acceptable はシナリオ定義では論理 seat. reset() で実 seat に変換される.
   *  startRound: 指定 round 未満は silent (途中参加シミュレーション).
   *  gameParticipationProb: 各ゲーム reset 時にサイコロ、unreach なら全 round silent (ランダム参加). */
  | { type: 'offerer'; primary: AgentId; acceptable: AgentId[]; mode?: 'split' | 'unanimous'; startRound?: number; gameParticipationProb?: number }
  /** 実演ボット: 既出 offer のうち youVote ∈ acceptable を見つけたら即 commit(youVote) を出す.
   *  自分の過去 commit があればその target に投票、無ければ primary.
   *  startRound, gameParticipationProb: offerer と同じ挙動. */
  | { type: 'eagerCommitter'; primary: AgentId; acceptable: AgentId[]; startRound?: number; gameParticipationProb?: number }

/** シナリオ作者が投票帰結に対する報酬を明示指定するための override エントリ.
 *
 *  - reward: 全 learner に同じ reward (タイプ A: 同チーム協調シナリオ).
 *  - rewardByTeam: teamId → reward の辞書. 指定がある team の learner はこの値を、
 *    無い team の learner は reward (fallback) を受ける. タイプ B: hidden role / 混在チームで
 *    「村勝は狼の負け」のようにチームで符号が逆転するケースに使う. teams config が必須.
 */
export type OutcomeReward = {
  reward?: number
  rewardByTeam?: Record<number, number>
  label: string
}

export type EnvConfig = {
  numAgents: number
  /** 各 agent の役割。省略時は全員 'learning' */
  agentRoles?: AgentRole[]
  /** bot シナリオ用: 学習 agent の primary を bot 集団からランダムに独立選出する場合 true */
  primaryFromBots?: boolean
  /** 毎ゲーム agent の role を seat にランダム再割当 (bot と learner の数は agentRoles で指定された比を維持)。
   * fixedVote の target は再割当後の最若 learner seat に置き換える。 */
  randomizeRolesPerGame?: boolean
  teams?: number[][]              // partition of [0..N-1]; 省略時は全員 1 チーム
  desireCorrelation: number       // [0,1]、高いほどノイズ小
  kRounds: number
  /** 報酬モード:
   *   'eliminated'  : reward = desire[eliminated]  (集団行動・credit assignment 困難)
   *   'voteDirect'  : reward = desire[my_vote]      (個別決定、学習容易、交渉価値なし)
   */
  rewardMode?: 'eliminated' | 'voteDirect'
  /** 合意ボーナス: 学習 agent 間の投票一致度に応じて [0, consensusBonus] を全学習 agent の reward に加算 */
  consensusBonus?: number
  /** 投票帰結 (top 票 seats) の key → 学習 agent 全員に与える報酬を直接指定する.
   *  key = 最多得票 seats を昇順ソートしてカンマ連結. 単独吊り "2", 2-way tie "2,3", 4-way tie "0,1,2,3".
   *  override あり: desire/consensusBonus はスキップし、この reward を使う (commit violation は従来通り加算).
   *  override なし: 従来通り random pick + desire[eliminated] + consensusBonus. */
  outcomeRewards?: Record<string, OutcomeReward>
  /** 学習 agent の primary を明示指定する (seat → primary seat). 既存の primaryFromBots / teams 由来 primary を上書きする.
   *  「村は狼の seat を知っている」のような前知識を表現するのに使う. */
  fixedPrimaries?: Record<AgentId, AgentId>
  /** 学習 agent の primary 候補セット (論理 seat). 指定時は各 learner が独立にランダム選出する.
   *  primaryFromBots / teams 由来の primary を override する (fixedPrimaries は更に上書き可能).
   *  bot プールに混ぜたくない agent (例: 村メンターボット) がいる場合に使う. */
  primaryCandidates?: AgentId[]
}

// desire は「ちょっとしたヒント」程度の shaping signal として使う. outcomeRewards override の
// reward (0.0〜1.0) に対して全域で微小であるべき — そうでないと desire-based reward モードで
// 単独 primary 吊り (HIGH) が引き分け成功 (override) を超えてしまい学習目標が歪む.
// 自分の primary への加点は 0.1 以下に抑える. LOW/MID/HIGH のギャップは 0.05 ずつ.
// HIGH_BASE は types.ts の DESIRE_HIGH_BASE で定義 (observation 側の正規化と共有するため).
const LOW_BASE = 0.00
const MID_BASE = 0.05
const HIGH_BASE = DESIRE_HIGH_BASE
const NOISE_AMP = 0.04   // noiseScale = 0.04 * (1 - desireCorr). desireCorr=0.7 なら ±0.006 (ギャップ 0.05 の 12%)

export type StepResult = {
  eliminated: AgentId
  voteCounts: number[]
  rewards: number[]
  done: boolean
  commitViolations: boolean[]
  /** outcomeRewards override が適用された場合の key. なければ undefined. */
  outcomeKey?: string
  /** outcomeRewards override が適用された場合の label. なければ undefined. */
  outcomeLabel?: string
}

export class AbstractGame {
  readonly config: EnvConfig
  readonly rng: Rng
  private inputs: HuginnInput[] = []
  private teamMembership: number[] = []
  private primaryByTeam: Map<number, AgentId> = new Map()
  /** primaryFromBots モード時、各学習 agent の個別 primary */
  private primaryByAgent: Map<AgentId, AgentId> = new Map()
  /** 論理 seat (シナリオ定義順) → 実 seat (今回のゲームでの座席位置) */
  private _actualOfLogical: number[] = []
  /** 実 seat → 論理 seat */
  private _logicalOfActual: number[] = []
  /** 今回のゲームでの、実 seat → AgentRole (fixedVote target は既に実 seat に変換済み). agentRoles 未指定の場合は null. */
  private currentRoles: AgentRole[] | null = null

  constructor(config: EnvConfig, rng: Rng) {
    this.config = config
    this.rng = rng
  }

  getAgentRole(agent: AgentId): AgentRole {
    if (this.currentRoles) return this.currentRoles[agent]
    return this.config.agentRoles?.[agent] ?? 'learning'
  }

  isLearning(agent: AgentId): boolean {
    return this.getAgentRole(agent) === 'learning'
  }

  getPrimaryByAgent(): Map<AgentId, AgentId> {
    return new Map(this.primaryByAgent)
  }

  /** 実 seat から論理 seat (シナリオ定義順) を得る. */
  getLogicalSeat(actual: AgentId): AgentId {
    return this._logicalOfActual[actual]
  }

  /** 論理 seat (シナリオ定義順) から実 seat を得る. */
  getActualSeat(logical: AgentId): AgentId {
    return this._actualOfLogical[logical]
  }

  reset(): HuginnInput[] {
    const N = this.config.numAgents
    const participants = Array.from({ length: N }, (_, i) => i)

    // 論理 seat → 実 seat の permutation を毎ゲーム生成.
    // randomize 無効時は identity で、シナリオ定義どおりの配置.
    const actualOfLogical = Array.from({ length: N }, (_, i) => i)
    if (this.config.randomizeRolesPerGame) {
      for (let i = N - 1; i > 0; i--) {
        const j = Math.floor(this.rng.next() * (i + 1))
        ;[actualOfLogical[i], actualOfLogical[j]] = [actualOfLogical[j], actualOfLogical[i]]
      }
    }
    this._actualOfLogical = actualOfLogical
    this._logicalOfActual = new Array<number>(N)
    for (let logical = 0; logical < N; logical++) {
      this._logicalOfActual[actualOfLogical[logical]] = logical
    }

    // 論理で書かれた agentRoles を実 seat 配置に展開. fixedVote/offerer/eagerCommitter の target/primary/acceptable も permutation で変換.
    if (this.config.agentRoles) {
      const newRoles = new Array<AgentRole>(N)
      for (let logical = 0; logical < N; logical++) {
        const actual = actualOfLogical[logical]
        const baseRole = this.config.agentRoles[logical]
        if (typeof baseRole === 'object' && baseRole.type === 'fixedVote') {
          newRoles[actual] = {
            type: 'fixedVote',
            target: actualOfLogical[baseRole.target],
            ...(baseRole.silent !== undefined ? { silent: baseRole.silent } : {}),
          }
        } else if (typeof baseRole === 'object' && baseRole.type === 'offerer') {
          // gameParticipationProb でサイコロ: 不参加なら silent で置換
          if (baseRole.gameParticipationProb !== undefined && this.rng.next() > baseRole.gameParticipationProb) {
            newRoles[actual] = { type: 'silent' }
          } else {
            newRoles[actual] = {
              type: 'offerer',
              primary: actualOfLogical[baseRole.primary],
              acceptable: baseRole.acceptable.map(l => actualOfLogical[l]),
              ...(baseRole.mode !== undefined ? { mode: baseRole.mode } : {}),
              ...(baseRole.startRound !== undefined ? { startRound: baseRole.startRound } : {}),
            }
          }
        } else if (typeof baseRole === 'object' && baseRole.type === 'eagerCommitter') {
          if (baseRole.gameParticipationProb !== undefined && this.rng.next() > baseRole.gameParticipationProb) {
            newRoles[actual] = { type: 'silent' }
          } else {
            newRoles[actual] = {
              type: 'eagerCommitter',
              primary: actualOfLogical[baseRole.primary],
              acceptable: baseRole.acceptable.map(l => actualOfLogical[l]),
              ...(baseRole.startRound !== undefined ? { startRound: baseRole.startRound } : {}),
            }
          }
        } else {
          newRoles[actual] = baseRole
        }
      }
      this.currentRoles = newRoles
    } else {
      this.currentRoles = null
    }

    this.teamMembership = this.assignTeams()
    const numTeams = Math.max(...this.teamMembership) + 1

    this.primaryByTeam = new Map()
    this.primaryByAgent = new Map()

    if (this.config.primaryFromBots) {
      const bots: AgentId[] = []
      for (let i = 0; i < N; i++) if (!this.isLearning(i)) bots.push(i)
      if (bots.length === 0) throw new Error('primaryFromBots requires at least one bot agent')
      for (let i = 0; i < N; i++) {
        if (this.isLearning(i)) {
          this.primaryByAgent.set(i, bots[Math.floor(this.rng.next() * bots.length)])
        }
      }
    } else {
      for (let t = 0; t < numTeams; t++) {
        const enemies: AgentId[] = []
        for (let i = 0; i < N; i++) {
          if (this.teamMembership[i] !== t) enemies.push(i)
        }
        if (enemies.length === 0) continue
        this.primaryByTeam.set(t, enemies[Math.floor(this.rng.next() * enemies.length)])
      }
      for (let self = 0; self < N; self++) {
        const p = this.primaryByTeam.get(this.teamMembership[self])
        if (p !== undefined) this.primaryByAgent.set(self, p)
      }
    }

    // primaryCandidates: 明示された論理 seat から各 learner が独立にランダム選出. primaryFromBots/teams の結果を上書き.
    if (this.config.primaryCandidates && this.config.primaryCandidates.length > 0) {
      const cands = this.config.primaryCandidates.map(l => actualOfLogical[l])
      for (let i = 0; i < N; i++) {
        if (this.isLearning(i)) {
          this.primaryByAgent.set(i, cands[Math.floor(this.rng.next() * cands.length)])
        }
      }
    }

    // fixedPrimaries は論理 seat で記述される. key/value ともに permutation で実 seat に変換する.
    if (this.config.fixedPrimaries) {
      for (const [logicalSelfStr, logicalPrimary] of Object.entries(this.config.fixedPrimaries)) {
        const actualSelf = actualOfLogical[Number(logicalSelfStr)]
        const actualPrimary = actualOfLogical[logicalPrimary]
        this.primaryByAgent.set(actualSelf, actualPrimary)
      }
    }

    const noiseScale = NOISE_AMP * (1 - this.config.desireCorrelation)
    const inputs: HuginnInput[] = []
    for (let self = 0; self < N; self++) {
      const myTeam = this.teamMembership[self]
      const myPrimary = this.primaryByAgent.get(self)
      const desire = new Float64Array(N)
      const excluded = new Array<boolean>(N).fill(false)
      excluded[self] = true
      for (let i = 0; i < N; i++) {
        if (i === self) {
          desire[i] = 0
          continue
        }
        let base: number
        if (this.config.primaryFromBots) {
          // ABCD 学習グループ: 同じ学習 agent は LOW、bot のうち myPrimary は HIGH、他 bot は MID
          if (this.isLearning(i)) {
            base = LOW_BASE
          } else if (i === myPrimary) {
            base = HIGH_BASE
          } else {
            base = MID_BASE
          }
        } else {
          if (this.teamMembership[i] === myTeam) {
            base = LOW_BASE
          } else if (i === myPrimary) {
            base = HIGH_BASE
          } else {
            base = MID_BASE
          }
        }
        const noise = (this.rng.next() - 0.5) * noiseScale
        desire[i] = clamp01(base + noise)
      }
      inputs.push({ self, participants, desire, excluded })
    }
    this.inputs = inputs
    return inputs
  }

  getPrimaryByTeam(): Map<number, AgentId> {
    return new Map(this.primaryByTeam)
  }

  private assignTeams(): number[] {
    const N = this.config.numAgents
    const result = new Array<number>(N).fill(0)
    if (!this.config.teams || this.config.teams.length === 0) return result
    for (let t = 0; t < this.config.teams.length; t++) {
      for (const logicalMember of this.config.teams[t]) {
        if (logicalMember < 0 || logicalMember >= N) throw new Error(`team member ${logicalMember} out of range`)
        result[this._actualOfLogical[logicalMember]] = t
      }
    }
    return result
  }

  step(trace: Trace): StepResult {
    const N = this.config.numAgents
    const voteCounts = new Array<number>(N).fill(0)
    for (const a of trace.perAgent) {
      const votedAgent = this.inputs[a.agent].participants[a.finalVoteIdx]
      voteCounts[votedAgent] += 1
    }

    let max = -1
    let topAgents: AgentId[] = []
    for (let i = 0; i < N; i++) {
      if (voteCounts[i] > max) {
        max = voteCounts[i]
        topAgents = [i]
      } else if (voteCounts[i] === max) {
        topAgents.push(i)
      }
    }
    const eliminated = topAgents[Math.floor(this.rng.next() * topAgents.length)]

    const rewards = new Array<number>(N).fill(0)
    const commitViolations = new Array<boolean>(N).fill(false)

    // outcomeRewards はシナリオ作者が論理 seat で記述する. 実 seat の topAgents を論理 seat に戻してから key を作る.
    const outcomeKey = topAgents
      .map(a => this._logicalOfActual[a])
      .sort((a, b) => a - b)
      .join(',')
    const override = this.config.outcomeRewards?.[outcomeKey]

    if (override !== undefined) {
      for (const a of trace.perAgent) {
        if (this.isLearning(a.agent)) {
          // rewardByTeam があれば learner の team の値を優先、無ければ reward (fallback) を使う.
          const teamId = this.teamMembership[a.agent]
          const teamReward = override.rewardByTeam?.[teamId]
          const base = teamReward !== undefined ? teamReward : (override.reward ?? 0)
          rewards[a.agent] += base
        }
        const violated = detectCommitViolation(a, this.inputs[a.agent].participants)
        commitViolations[a.agent] = violated
        if (violated) rewards[a.agent] += COMMIT_VIOLATION_PENALTY
      }
      return {
        eliminated,
        voteCounts,
        rewards,
        done: true,
        commitViolations,
        outcomeKey,
        outcomeLabel: override.label,
      }
    }

    const mode = this.config.rewardMode ?? 'eliminated'
    for (const a of trace.perAgent) {
      if (mode === 'voteDirect') {
        const myVotedSeat = this.inputs[a.agent].participants[a.finalVoteIdx]
        rewards[a.agent] += this.inputs[a.agent].desire[myVotedSeat]
      } else {
        rewards[a.agent] += this.inputs[a.agent].desire[eliminated]
      }
      const violated = detectCommitViolation(a, this.inputs[a.agent].participants)
      commitViolations[a.agent] = violated
      if (violated) rewards[a.agent] += COMMIT_VIOLATION_PENALTY
    }

    // Consensus bonus: 学習 agent 間で同じ seat に投票した最大数 / 学習 agent 数 を全学習 agent に加算
    const consensusBonus = this.config.consensusBonus ?? 0
    if (consensusBonus > 0) {
      const learnerVotes = new Map<AgentId, number>()
      let numLearners = 0
      for (const a of trace.perAgent) {
        if (!this.isLearning(a.agent)) continue
        numLearners++
        const seat = this.inputs[a.agent].participants[a.finalVoteIdx]
        learnerVotes.set(seat, (learnerVotes.get(seat) ?? 0) + 1)
      }
      if (numLearners > 1) {
        const maxAgree = Math.max(...learnerVotes.values())
        const consensusFrac = (maxAgree - 1) / (numLearners - 1)  // 1人だけ: 0、全員一致: 1
        const bonus = consensusBonus * consensusFrac
        for (const a of trace.perAgent) {
          if (this.isLearning(a.agent)) rewards[a.agent] += bonus
        }
      }
    }

    return { eliminated, voteCounts, rewards, done: true, commitViolations }
  }

  getTeams(): number[] {
    return [...this.teamMembership]
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

export type MessageHistoryEntry = { round: number; sender: AgentId; message: Message }

/**
 * 非 learning ボットの各 round の発話を決める. learning は呼び出し側で扱う.
 * role は reset() で permutation 変換済みの、実 seat ベースのもの.
 */
export function scriptedBotMessage(
  role: AgentRole,
  self: AgentId,
  round: number,
  messageHistory: MessageHistoryEntry[],
): Message {
  if (role === 'learning') throw new Error('scriptedBotMessage called for learning role')
  if (typeof role !== 'object') return { type: 'silent' }
  switch (role.type) {
    case 'fixedVote':
    case 'silent':
      return { type: 'silent' }
    case 'offerer': {
      if (role.startRound !== undefined && round < role.startRound) return { type: 'silent' }
      if (role.primary === self) return { type: 'silent' }
      const mode = role.mode ?? 'split'
      if (mode === 'unanimous') {
        return { type: 'offer', iVote: role.primary, youVote: role.primary }
      }
      const others = role.acceptable.filter(x => x !== role.primary && x !== self)
      if (others.length === 0) return { type: 'silent' }
      const youVote = others[round % others.length]
      return { type: 'offer', iVote: role.primary, youVote }
    }
    case 'eagerCommitter': {
      if (role.startRound !== undefined && round < role.startRound) return { type: 'silent' }
      const acceptable = new Set(role.acceptable)
      for (let i = messageHistory.length - 1; i >= 0; i--) {
        const entry = messageHistory[i]
        if (entry.sender === self) continue
        const m = entry.message
        if (m.type === 'offer' && acceptable.has(m.youVote) && m.youVote !== self) {
          return { type: 'commit', target: m.youVote }
        }
      }
      return { type: 'silent' }
    }
  }
}

/**
 * 非 learning ボットの最終投票 (participants インデックス) を決める. learning は呼び出し側で扱う.
 */
export function scriptedBotVoteIdx(
  role: AgentRole,
  self: AgentId,
  input: HuginnInput,
  messageHistory: MessageHistoryEntry[],
  rng: Rng,
): number {
  const randomNonExcluded = (): number => {
    const cand: number[] = []
    for (let i = 0; i < input.participants.length; i++) if (!input.excluded[i]) cand.push(i)
    return cand[Math.floor(rng.next() * cand.length)]
  }
  const tryIdxOf = (target: AgentId): number | null => {
    const idx = input.participants.indexOf(target)
    if (idx < 0 || input.excluded[idx]) return null
    return idx
  }
  if (typeof role !== 'object') return randomNonExcluded()
  switch (role.type) {
    case 'fixedVote': {
      return tryIdxOf(role.target) ?? randomNonExcluded()
    }
    case 'silent':
      return randomNonExcluded()
    case 'offerer': {
      return tryIdxOf(role.primary) ?? randomNonExcluded()
    }
    case 'eagerCommitter': {
      let lastCommitTarget: AgentId | null = null
      for (const entry of messageHistory) {
        if (entry.sender !== self) continue
        if (entry.message.type === 'commit') lastCommitTarget = entry.message.target
      }
      if (lastCommitTarget !== null) {
        const idx = tryIdxOf(lastCommitTarget)
        if (idx !== null) return idx
      }
      return tryIdxOf(role.primary) ?? randomNonExcluded()
    }
  }
}
