/**
 * Adapter 共通型定義
 */

import type { SystemRole, ResolvedRules } from '../../../types/index.ts'
import type { Agent, TeamAgent } from '../agents/agent.ts'
import type { CollectedObservation } from '../observation.ts'

/** CapturedObservation: inspect 用 observation キャプチャ */
export type CapturedObservation = {
  seat: number
  role: string
  day: number
  observation: CollectedObservation
  proposals?: { type: string, target: number }[]
}

/** Strategy Base Adapter の設定（plan ライフサイクル共通） */
export type StrategyBaseAdapterConfig = {
  agents: Map<number, Agent>
  defaultAgent?: Agent
  wolfTeamAgent?: TeamAgent
  masonTeamAgent?: TeamAgent
  /** 役職割当後にagent差し替え用コールバック */
  onRolesAssigned?: (seatRoles: Map<number, SystemRole>) => void
  seed?: number
  /** Retar有効化（デフォルト: false） */
  enableRetar?: boolean
  /** 詰み探索を有効化（デフォルトfalse） */
  enableTsumi?: boolean
  /** enableRetar時に必要 */
  roles?: Map<SystemRole, number>
  /** enableRetar時に必要 */
  rules?: Partial<ResolvedRules>
  /** 全プレイヤーの observation をキャプチャ（inspect 用） */
  captureObservations?: boolean
}

/** Mason Training Adapter の設定（mason 固有オプション追加） */
export type MasonTrainingAdapterConfig = StrategyBaseAdapterConfig & {
  /** Mason takeover: ML mason 死亡時に生存パートナーに agent を移す */
  onMasonTakeover?: (deadSeat: number, newSeat: number) => void
  /** Phase 2 自己対戦モード: 村エージェントの trajectory 記録 + mason は teamAgent で投票 */
  selfPlayMode?: boolean
}

/** 後方互換エイリアス */
export type StrategyOnlyAdapterConfig = MasonTrainingAdapterConfig

/** Full Adapter の設定 */
export type FullAdapterConfig = {
  agents?: Map<number, Agent>
  defaultAgent: Agent
  wolfTeamAgent?: TeamAgent
  masonTeamAgent?: TeamAgent
  enableRetar?: boolean
  enableTsumi?: boolean
  onRolesAssigned?: (seatRoles: Map<number, SystemRole>) => void
  seed?: number
  roles: Map<SystemRole, number>
  rules?: Partial<ResolvedRules>
}
