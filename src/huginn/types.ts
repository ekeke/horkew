/**
 * Huginn — standalone negotiation-and-voting game agent.
 * 人狼ゲームとは無関係。N agent が desire ranking を持って交渉投票する別ゲーム。
 */

export type AgentId = number

export type HeatName = 'low' | 'mid' | 'high'
export const HEAT_NAMES: readonly HeatName[] = ['low', 'mid', 'high']

export type Message =
  | { type: 'silent' }
  | { type: 'propose'; target: AgentId; priority: 1 | 2 | 3; heat: HeatName }
  | { type: 'offer'; iVote: AgentId; youVote: AgentId }
  | { type: 'accept'; offerRef: number }
  | { type: 'reject'; offerRef: number }
  | { type: 'commit'; target: AgentId }

export type HuginnInput = {
  self: AgentId
  participants: AgentId[]   // ソート済み (昇順)
  desire: Float64Array      // length === participants.length, ∈ [0,1]
  excluded: boolean[]       // length === participants.length
  /** 指定進行の指定対象集合. length === participants.length. この集合外への投票は DESIGNATION_VIOLATION_PENALTY.
   *  集合全体が空なら指定なし（どこに投票してもペナルティなし）. 全 agent で同じ内容（共有観測）. */
  isDesignationTarget: boolean[]
}

export type HuginnOutput = {
  messages: Message[]
  finalVote: AgentId
}

export type Observation = {
  input: HuginnInput
  roundNumber: number
  messageHistory: { round: number; sender: AgentId; message: Message }[]
  pastCommitViolations: Map<AgentId, number>
}

export const K_ROUNDS = 4
export const MAX_AGENTS = 15
export const OFFER_REF_WINDOW = 3
export const PRIORITY_LEVELS = 3
export const HEAT_LEVELS = 3

export const COMMIT_VIOLATION_PENALTY = -0.1
export const SILENT_ENTROPY_BONUS = 0.0

/** 指定進行違反ペナルティ. final vote が designatedTargets 集合のいずれにも一致しない learner に加算.
 *  DESIRE_HIGH_BASE (=0.10, 自分の primary 吊り報酬) より大きく、陣営勝利 (=1.0) より充分小さい中間値. */
export const DESIGNATION_VIOLATION_PENALTY = -0.2

/** desire の primary (HIGH) 値. observation 側の正規化にも使うため types.ts で共有.
 *  reward として desire を使う場合に outcomeRewards override (0〜1) より充分小さくしておく. */
export const DESIRE_HIGH_BASE = 0.10
