/**
 * Retar統合ブリッジ (ブラウザ互換)
 *
 * Lupaエンジンの途中状態からRetarの論理推論を実行する。
 * verify.tsと同じパイプライン: GameEvents → formatHowl → parse → buildVillageStatus → VillageRetar
 */

import type { SystemRole } from '../types/index.ts'
import type { LupaConfig, GameState, GameEvent } from './types.ts'
import { formatHowl } from './format.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { searchTsumi } from '../hati/index.ts'
import type { TsumiResult } from '../hati/index.ts'

export const DEFAULT_RETAR_OPTIONS: AnalyzeOptions = {
  seerClaimingDueDate: 99,
  mediumClaimingDueDate: 99,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 99,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  hasFirstGhost: false,
  assumptions: new Map(),
  wolfPairDenyals: [],
  hocusPocus: new Map(),
  id: 0,
  batches: 1,
  batch: 0,
}

/**
 * 現在のイベント列からRetarの役職可能性を計算 (シングルスレッド)
 */
export function analyzeFromEvents(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
  assumptions?: Map<number, SystemRole>,
): Map<number, Set<SystemRole>> {
  const howl = formatHowl(events, state, config)
  const { meta, statements } = parse(howl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) {
    return new Map()
  }

  const { vs, setup } = buildVillageStatus(statements, meta)

  const baseOptions = config.hasFirstGhost
    ? { ...DEFAULT_RETAR_OPTIONS, hasFirstGhost: true }
    : DEFAULT_RETAR_OPTIONS

  const options = assumptions && assumptions.size > 0
    ? { ...baseOptions, assumptions }
    : baseOptions

  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyzeSafe()

  if (result.error || !result.result) {
    return new Map()
  }

  return result.result
}

/** プレイヤーの初期知識から Retar assumptions を構築 */
export function buildAssumptions(
  state: GameState,
  player: GameState['players'][0],
): Map<number, SystemRole> {
  const assumptions = new Map<number, SystemRole>([[player.seat, player.role]])

  switch (player.role) {
    case 'werewolf':
      for (const p of state.players) {
        if (p.role === 'werewolf' && p.seat !== player.seat) {
          assumptions.set(p.seat, 'werewolf')
        }
      }
      break

    case 'fanatic':
      for (const p of state.players) {
        if (p.role === 'werewolf') {
          assumptions.set(p.seat, 'werewolf')
        }
      }
      break

    case 'immoralist': {
      const hamster = state.players.find(p => p.role === 'werehamster')
      if (hamster) assumptions.set(hamster.seat, 'werehamster')
      break
    }

    case 'mason': {
      const partner = state.players.find(p => p.role === 'mason' && p.seat !== player.seat)
      if (partner) assumptions.set(partner.seat, 'mason')
      break
    }

    case 'seer':
      for (const [, result] of player.divineHistory) {
        if (result.result === 'wolf') {
          assumptions.set(result.target, 'werewolf')
        }
      }
      break

    case 'medium':
      for (const [day, executedSeat] of state.executionHistory) {
        // 霊媒結果は霊媒CO後の medium_result イベントから取得するが、
        // PlayerState には直接アクセスできないため、divineHistory を流用する設計ではない
        // → GameState.players の role 情報から直接取得（情報隔壁に注意）
        // 霊媒師は処刑者の種族を知っているので、実際の role を参照してよい
        const executed = state.players.find(p => p.seat === executedSeat)
        if (executed && executed.role === 'werewolf') {
          assumptions.set(executedSeat, 'werewolf')
        }
      }
      break
  }

  return assumptions
}

/**
 * プレイヤー別 Retar 分析
 * 各プレイヤーの初期知識を assumption として Retar を実行し、プレイヤー別の結果を返す
 */
export function analyzePerPlayer(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
  players: GameState['players'],
): Map<number, Map<number, Set<SystemRole>>> {
  const result = new Map<number, Map<number, Set<SystemRole>>>()

  // Howl → parse → buildVillageStatus は共通（1回だけ）
  const howl = formatHowl(events, state, config)
  const { meta, statements } = parse(howl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) return result

  const { vs, setup } = buildVillageStatus(statements, meta)

  const baseOptions = config.hasFirstGhost
    ? { ...DEFAULT_RETAR_OPTIONS, hasFirstGhost: true }
    : DEFAULT_RETAR_OPTIONS

  for (const player of players) {
    const assumptions = buildAssumptions(state, player)
    const options = { ...baseOptions, assumptions }
    const retar = new VillageRetar(vs, setup, options)
    const r = retar.analyzeSafe()
    result.set(player.seat, r.error || !r.result ? new Map() : r.result)
  }

  return result
}

/**
 * 偽結果を含むイベント列がRetarで矛盾しないか検証。
 * 矛盾（解なし or 可能性が空の席あり）→ false、整合 → true。
 */
export function checkRetarConsistency(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
  assumptions?: Map<number, SystemRole>,
): boolean {
  const howl = formatHowl(events, state, config)
  const { meta, statements } = parse(howl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) return true // パース失敗時は楽観的に通す

  const { vs, setup } = buildVillageStatus(statements, meta)

  const options = assumptions && assumptions.size > 0
    ? { ...DEFAULT_RETAR_OPTIONS, hasFirstGhost: config.hasFirstGhost ?? false, assumptions }
    : config.hasFirstGhost
      ? { ...DEFAULT_RETAR_OPTIONS, hasFirstGhost: true }
      : DEFAULT_RETAR_OPTIONS

  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyzeSafe()

  if (result.error || !result.result) return false

  for (const [, roles] of result.result) {
    if (roles.size === 0) return false
  }
  return true
}

/**
 * Hati詰み探索をイベント列から実行
 *
 * analyzeFromEventsと同じHowl→parse→buildVillageStatusパイプラインを使い、
 * searchTsumiで村側の詰み進行を探索する。
 */
export function searchTsumiFromEvents(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
  maxDepth: number = 4,
): TsumiResult | null {
  const howl = formatHowl(events, state, config)
  const { meta, statements } = parse(howl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) return null

  const { vs, setup } = buildVillageStatus(statements, meta)
  const options: AnalyzeOptions = config.hasFirstGhost
    ? { ...DEFAULT_RETAR_OPTIONS, hasFirstGhost: true }
    : DEFAULT_RETAR_OPTIONS

  try {
    return searchTsumi(vs, setup, options, { maxDepth })
  } catch {
    return null
  }
}
