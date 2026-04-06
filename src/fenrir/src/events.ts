/**
 * Fenrir 拡張イベント — 議論・指揮者・予測など戦略層のイベント
 *
 * エンジンの GameEvent をジェネリクスで拡張:
 *   runGame<FenrirExtEvent>(config, handlers)
 *
 * 全イベント型:
 *   type FenrirEvent = GameEvent | FenrirExtEvent
 */

import type { SystemRole } from '../../types/index.ts'
import type { Signal, RolePrediction } from './communication.ts'
import type { Proposal, LeadershipResponse } from './leadership.ts'
import type { GameEvent } from '../../lupa/types.ts'

export type FenrirExtEvent =
  | { type: 'signal', actor: number, signal: Signal }
  | { type: 'wolf_claim', actor: number, claimedRole: SystemRole }
  | { type: 'execute_proposals', actor: number, targets: number[] }
  | { type: 'prediction', actor: number, predictions: RolePrediction }
  | { type: 'commander_appointed', seat: number }
  | { type: 'proposal', actor: number, proposal: Proposal }
  | { type: 'leadership_response', actor: number, response: LeadershipResponse }
  | { type: 'plan_commit', actor: number, plan: string }
  | { type: 'vote_decisions', decisions: Array<{ seat: number, reason: 'plan' | 'heuristic' | 'wolf' | 'agent' }> }

export type FenrirEvent = GameEvent | FenrirExtEvent
