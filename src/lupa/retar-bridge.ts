/**
 * Retar統合ブリッジ
 *
 * Lupaエンジンの途中状態からRetarの論理推論を実行する。
 * WASM版が利用可能ならWASM、なければJS版にフォールバック。
 * パイプライン: GameEvents → formatHowl → parse → buildVillageStatus → Retar
 */

import type { SystemRole, Seat } from '../types/index.ts'
import type { LupaConfig, GameState, GameEvent } from './types.ts'
import { formatHowl } from './format.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { searchTsumi } from '../hati/index.ts'
import type { TsumiResult } from '../hati/index.ts'

// ============================================================
// WASM ロード (利用可能ならWASM、なければJS版にフォールバック)
// ============================================================

let wasmAnalyze: ((village: string, setup: string, options: string) => string) | null = null

try {
  // @ts-ignore — WASM pkg は動的ロード
  const wasm = await import('../retar-rs/pkg/retar.js')
  wasmAnalyze = wasm.analyze
} catch {
  // WASM not available, fallback to JS
}

export const useWasm = wasmAnalyze !== null

// ============================================================
// VillageStatus / Options の JSON 直列化 (WASM 用)
// ============================================================

function serializeVillageStatus(vs: any): any {
  const obj: any = { ...vs }
  obj.statuses = Object.fromEntries(
    [...vs.statuses.entries()].map(([k, v]: [any, any]) => [
      String(k),
      {
        ...v,
        actions: Object.fromEntries(v.actions),
        assertions: Object.fromEntries(
          [...v.assertions.entries()].map(([day, a]: [any, any]) => [String(day), a])
        ),
        forecasts: Object.fromEntries(
          [...v.forecasts.entries()].map(([day, s]: [any, any]) => [String(day), s])
        ),
        previousAssertions: v.previousAssertions
          ? Object.fromEntries(
              [...v.previousAssertions.entries()].map(([day, a]: [any, any]) => [String(day), a])
            )
          : undefined,
        previousClaims: v.previousClaims?.map((pc: any) => ({
          ...pc,
          assertions: Object.fromEntries(
            [...pc.assertions.entries()].map(([day, a]: [any, any]) => [String(day), a])
          ),
          actions: Object.fromEntries(pc.actions),
          forecasts: Object.fromEntries(
            [...pc.forecasts.entries()].map(([day, s]: [any, any]) => [String(day), s])
          ),
        })),
      },
    ])
  )
  obj.executions = Object.fromEntries(
    [...vs.executions.entries()].map(([k, v]: [any, any]) => [String(k), v])
  )
  obj.kills = Object.fromEntries(
    [...vs.kills.entries()].map(([k, v]: [any, any]) => [String(k), v])
  )
  obj.voteHistory = Object.fromEntries(
    [...vs.voteHistory.entries()].map(([k, v]: [any, any]) => [String(k), v])
  )
  obj.revoteTargets = [...vs.revoteTargets]
  obj.multiVoteDays = [...vs.multiVoteDays]
  delete obj.roles
  delete obj.claims
  return obj
}

function serializeOptions(options: AnalyzeOptions): any {
  return {
    ...options,
    assumptions: Object.fromEntries(options.assumptions),
    hocusPocus: Object.fromEntries(options.hocusPocus),
  }
}

function parseWasmResult(resultJson: string): Map<Seat, Set<SystemRole>> {
  const parsed = JSON.parse(resultJson)
  if (parsed.error) return new Map()
  const result = new Map<Seat, Set<SystemRole>>()
  for (const [seatStr, roles] of Object.entries(parsed)) {
    result.set(Number(seatStr), new Set(roles as SystemRole[]))
  }
  return result
}

// ============================================================
// Options
// ============================================================

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

// ============================================================
// Core: analyze (WASM or JS)
// ============================================================

function runRetar(
  vs: any,
  setup: Map<SystemRole, number>,
  options: AnalyzeOptions,
): Map<number, Set<SystemRole>> {
  if (wasmAnalyze) {
    const vsJson = JSON.stringify(serializeVillageStatus(vs))
    const setupJson = JSON.stringify(Object.fromEntries(setup))
    const optJson = JSON.stringify(serializeOptions(options))
    return parseWasmResult(wasmAnalyze(vsJson, setupJson, optJson))
  }

  // JS fallback
  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyzeSafe()
  if (result.error || !result.result) return new Map()
  return result.result
}

// ============================================================
// Public API
// ============================================================

/**
 * 現在のイベント列からRetarの役職可能性を計算
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
  if (unknowns.length > 0) return new Map()

  const { vs, setup } = buildVillageStatus(statements, meta)

  const baseOptions = config.hasFirstGhost
    ? { ...DEFAULT_RETAR_OPTIONS, hasFirstGhost: true }
    : DEFAULT_RETAR_OPTIONS

  const options = assumptions && assumptions.size > 0
    ? { ...baseOptions, assumptions }
    : baseOptions

  return runRetar(vs, setup, options)
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
    result.set(player.seat, runRetar(vs, setup, options))
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
  if (unknowns.length > 0) return true

  const { vs, setup } = buildVillageStatus(statements, meta)

  const options = assumptions && assumptions.size > 0
    ? { ...DEFAULT_RETAR_OPTIONS, hasFirstGhost: config.hasFirstGhost ?? false, assumptions }
    : config.hasFirstGhost
      ? { ...DEFAULT_RETAR_OPTIONS, hasFirstGhost: true }
      : DEFAULT_RETAR_OPTIONS

  const retarResult = runRetar(vs, setup, options)
  if (retarResult.size === 0) return false

  for (const [, roles] of retarResult) {
    if (roles.size === 0) return false
  }
  return true
}

/**
 * Hati詰み探索をイベント列から実行
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
