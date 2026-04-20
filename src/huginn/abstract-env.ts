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

import type { HuginnInput, AgentId } from './types.ts'
import { COMMIT_VIOLATION_PENALTY } from './types.ts'
import type { Rng } from './rng.ts'
import { detectCommitViolation, type Trace } from './protocol.ts'

export type AgentRole =
  | 'learning'                          // policy 学習対象
  | { type: 'fixedVote'; target: AgentId; silent?: boolean }   // 固定投票、silent なら全ラウンド SILENT
  | { type: 'silent' }                  // SILENT 固定、投票はランダム

/** シナリオ作者が投票帰結に対する報酬を明示指定するための override エントリ. */
export type OutcomeReward = {
  reward: number
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
}

const LOW_BASE = 0.05
const MID_BASE = 0.55
const HIGH_BASE = 0.95
const NOISE_AMP = 0.1   // 構造を壊さない程度の小さなノイズ

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

    // 論理で書かれた agentRoles を実 seat 配置に展開. fixedVote target も同じ permutation を通す.
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
        if (this.isLearning(a.agent)) rewards[a.agent] += override.reward
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
