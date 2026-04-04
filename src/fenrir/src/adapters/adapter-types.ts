/**
 * Adapter 共通型定義
 */

import type { SystemRole, ResolvedRules } from '../../../types/index.ts'
import type { Agent, TeamAgent } from '../agents/agent.ts'

/** CapturedObservation: inspect 用 observation キャプチャ */
export type CapturedObservation = {
  seat: number
  role: string
  day: number
  observation: Float32Array
  proposals?: { type: string, target: number }[]
}

/** Strategy-Only Adapter の設定 */
export type StrategyOnlyAdapterConfig = {
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
  /** Retarを有効にする開始Day */
  retarStartDay?: number
  /** enableRetar時に必要 */
  roles?: Map<SystemRole, number>
  /** enableRetar時に必要 */
  rules?: Partial<ResolvedRules>
  /** 全プレイヤーの observation をキャプチャ（inspect 用） */
  captureObservations?: boolean
  /** Mason takeover: ML mason 死亡時に生存パートナーに agent を移す */
  onMasonTakeover?: (deadSeat: number, newSeat: number) => void
}

/** Full Adapter の設定 */
export type FullAdapterConfig = {
  agents?: Map<number, Agent>
  defaultAgent: Agent
  wolfTeamAgent?: TeamAgent
  masonTeamAgent?: TeamAgent
  enableRetar?: boolean
  enableTsumi?: boolean
  retarStartDay?: number
  onRolesAssigned?: (seatRoles: Map<number, SystemRole>) => void
  seed?: number
  roles: Map<SystemRole, number>
  rules?: Partial<ResolvedRules>
}
