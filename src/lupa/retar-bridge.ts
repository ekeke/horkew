/**
 * Retar統合ブリッジ
 *
 * Lupaエンジンの途中状態からRetarの論理推論を実行する。
 * WASM版が利用可能ならWASM、なければJS版にフォールバック。
 * パイプライン: GameEvents → formatHowl → parse → buildVillageStatus → Retar
 */

import type { SystemRole } from '../types/index.ts'
import type { LupaConfig, GameState, GameEvent } from './types.ts'
import { formatHowl } from './format.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { serializeVillageStatus, serializeOptions, parseWasmResult, resultToPossibilities } from '../retar/wasm-helpers.ts'
import { searchTsumi } from '../hati/index.ts'
import type { RunRetar } from '../hati/index.ts'
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

export type RetarResult = {
  possibilities: Map<number, Set<SystemRole>>
  maxSurvivingNV: number
}

function runRetar(
  vs: any,
  setup: Map<SystemRole, number>,
  options: AnalyzeOptions,
): RetarResult {
  if (wasmAnalyze) {
    const vsJson = JSON.stringify(serializeVillageStatus(vs))
    const setupJson = JSON.stringify(Object.fromEntries(setup))
    const optJson = JSON.stringify(serializeOptions(options, setup))
    const wasmResult = parseWasmResult(wasmAnalyze(vsJson, setupJson, optJson))
    return { possibilities: wasmResult.result, maxSurvivingNV: wasmResult.maxSurvivingNV }
  }

  // JS fallback
  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyzeSafe()
  if (result.error || !result.result) return { possibilities: new Map(), maxSurvivingNV: 0 }
  return { possibilities: result.result, maxSurvivingNV: result.maxSurvivingNV }
}

// ============================================================
// RunRetar (Possibilities を返す版 — hati DI 用)
// ============================================================

const lupaRunRetar: RunRetar = (vs, setup, options) => {
  if (wasmAnalyze) {
    const vsJson = JSON.stringify(serializeVillageStatus(vs))
    const setupJson = JSON.stringify(Object.fromEntries(setup))
    const optJson = JSON.stringify(serializeOptions(options, setup))
    return resultToPossibilities(parseWasmResult(wasmAnalyze(vsJson, setupJson, optJson)))
  }
  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyzeSafe()
  if (result.error || !result.result) return resultToPossibilities({ possibilities: new Map(), maxSurvivingNV: 0 })
  return resultToPossibilities({ possibilities: result.result, maxSurvivingNV: result.maxSurvivingNV })
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
): RetarResult {
  const howl = formatHowl(events, state, config)
  const { meta, statements } = parse(howl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) return { possibilities: new Map(), maxSurvivingNV: 0 }

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
  prior?: Map<number, Set<SystemRole>>,
): Map<number, SystemRole> {
  const assumptions = new Map<number, SystemRole>()

  const trySet = (seat: number, role: SystemRole) => {
    if (prior) {
      const possible = prior.get(seat)
      if (!possible || !possible.has(role)) return
    }
    assumptions.set(seat, role)
  }

  trySet(player.seat, player.role)

  switch (player.role) {
    case 'werewolf':
      for (const p of state.players) {
        if (p.role === 'werewolf' && p.seat !== player.seat) {
          trySet(p.seat, 'werewolf')
        }
      }
      break

    case 'fanatic':
      for (const p of state.players) {
        if (p.role === 'werewolf') {
          trySet(p.seat, 'werewolf')
        }
      }
      break

    case 'immoralist': {
      const hamster = state.players.find(p => p.role === 'werehamster')
      if (hamster) trySet(hamster.seat, 'werehamster')
      break
    }

    case 'mason': {
      const partner = state.players.find(p => p.role === 'mason' && p.seat !== player.seat)
      if (partner) trySet(partner.seat, 'mason')
      break
    }

    case 'seer':
      for (const [, result] of player.divineHistory) {
        if (result.result === 'wolf') {
          trySet(result.target, 'werewolf')
        }
      }
      break

    case 'medium':
      for (const [day, executedSeat] of state.executionHistory) {
        const executed = state.players.find(p => p.seat === executedSeat)
        if (executed && executed.role === 'werewolf') {
          trySet(executedSeat, 'werewolf')
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
): Map<number, RetarResult> {
  const result = new Map<number, RetarResult>()

  const howl = formatHowl(events, state, config)
  const { meta, statements } = parse(howl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) return result

  const { vs, setup } = buildVillageStatus(statements, meta)

  const baseOptions = config.hasFirstGhost
    ? { ...DEFAULT_RETAR_OPTIONS, hasFirstGhost: true }
    : DEFAULT_RETAR_OPTIONS

  // 共通 Retar を1回走らせ、結果を prior として再利用
  const common = runRetar(vs, setup, baseOptions)
  const prior = common.possibilities

  // 共通 Retar が破綻していたら per-player もスキップ
  if (common.possibilities.size === 0) return result

  for (const player of players) {
    const assumptions = buildAssumptions(state, player, prior)
    if (assumptions.size === 0) {
      result.set(player.seat, common)
    } else {
      const options = { ...baseOptions, assumptions, prior }
      result.set(player.seat, runRetar(vs, setup, options))
    }
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

  const { possibilities } = runRetar(vs, setup, options)
  if (possibilities.size === 0) return false

  for (const [, roles] of possibilities) {
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
    return searchTsumi(vs, setup, options, { maxDepth }, lupaRunRetar)
  } catch {
    return null
  }
}
