/**
 * Retar統合ブリッジ
 *
 * Lupaエンジンの途中状態からRetarの論理推論を実行する。
 * WASM版が利用可能ならWASM、なければJS版にフォールバック。
 * パイプライン: GameEvents → formatHowl → parse → buildVillageStatus → Retar
 */

import type { SystemRole } from '../../types/index.ts'
import { resolveRules } from '../../howl/ruleset.ts'
import type { LupaConfig, GameState, GameEvent } from '../../lupa/types.ts'
import { formatHowl } from '../../lupa/format.ts'
import { parse } from '../../howl/parser.ts'
import { buildVillageStatus } from '../../howl/bridge.ts'
import { VillageRetar } from '../../retar/index.ts'
import type { AnalyzeOptions } from '../../retar/index.ts'
import { serializeVillageStatus, serializeOptions, parseWasmResult, resultToPossibilities } from '../../retar/wasm-helpers.ts'
import { Possibilities, RoleBitIndex, possibilityFromRoles } from '../../retar/possibilities.ts'
import { searchTsumi, searchTsumiStrategy } from '../../hati/index.ts'
import type { RunRetar } from '../../hati/index.ts'
import type { TsumiResult, StrategyNode } from '../../hati/index.ts'

// ============================================================
// WASM ロード (利用可能ならWASM、なければJS版にフォールバック)
// ============================================================

let wasmAnalyze: ((village: string, setup: string, options: string) => string) | null = null

try {
  // @ts-ignore — WASM pkg は動的ロード
  const wasm = await import('../../retar-rs/pkg/retar.js')
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

/** LupaConfig のルールから Retar AnalyzeOptions を構築 */
function buildRetarOptions(config: LupaConfig): AnalyzeOptions {
  const rules = resolveRules(config.rules)
  const hasFirstGhost = config.hasFirstGhost ?? rules['first-victim'] !== 'none'
  const seerFirstSeek = rules['role.seer.first-seek']
  // dayCountFrom は Retar 内部の占い行動開始夜。countFirstDay は表示問題であり Retar に影響しない。
  // hasFirstGhost が true なら night 0 から行動するので dayCountFrom=1 は正しいまま。
  return {
    ...DEFAULT_RETAR_OPTIONS,
    hasFirstGhost,
    seerFirstSeek,
  }
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

export const lupaRunRetar: RunRetar = (vs, setup, options) => {
  if (wasmAnalyze) {
    const vsJson = JSON.stringify(serializeVillageStatus(vs))
    const setupJson = JSON.stringify(Object.fromEntries(setup))
    const optJson = JSON.stringify(serializeOptions(options, setup))
    return resultToPossibilities(parseWasmResult(wasmAnalyze(vsJson, setupJson, optJson)))
  }
  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyzeSafe()
  if (result.error || !result.result) return resultToPossibilities({ result: new Map(), maxSurvivingNV: 0 })
  return resultToPossibilities({ result: result.result, maxSurvivingNV: result.maxSurvivingNV })
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

  const baseOptions = buildRetarOptions(config)

  const options = assumptions && assumptions.size > 0
    ? { ...baseOptions, assumptions }
    : baseOptions

  return runRetar(vs, setup, options)
}

/** analyzeFromEventsDetailed の戻り値: Retar 結果 + vs/setup (skoll 連携用) */
export type DetailedRetarResult = RetarResult & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- VillageStatus: howl ブリッジの型に依存
  vs: any | null
  setup: Map<SystemRole, number> | null
}

/**
 * analyzeFromEvents の詳細版: Retar 結果に加え、skoll が必要とする vs/setup も返す。
 * VillageStatus の構築に失敗（unknown 文含む）した場合は vs/setup が null になる。
 */
export function analyzeFromEventsDetailed(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
  assumptions?: Map<number, SystemRole>,
): DetailedRetarResult {
  const empty: DetailedRetarResult = { possibilities: new Map(), maxSurvivingNV: 0, vs: null, setup: null }
  const howl = formatHowl(events, state, config)
  const { meta, statements } = parse(howl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) return empty

  const { vs, setup } = buildVillageStatus(statements, meta)
  const baseOptions = buildRetarOptions(config)
  const options = assumptions && assumptions.size > 0
    ? { ...baseOptions, assumptions }
    : baseOptions

  const result = runRetar(vs, setup, options)
  return { ...result, vs, setup }
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
      for (const [_day, executedSeat] of state.executionHistory) {
        const executed = state.players.find(p => p.seat === executedSeat)
        if (executed && executed.role === 'werewolf') {
          trySet(executedSeat, 'werewolf')
        }
      }
      break
  }

  return assumptions
}

/** global prior に refix を適用し、Rust側と同等の effective prior を Possibilities で返す */
function buildRefixedPrior(
  prior: Map<number, Set<SystemRole>>,
  setup: Map<SystemRole, number>,
): Possibilities | null {
  let maxSeat = 0
  for (const seat of prior.keys()) {
    if (seat > maxSeat) maxSeat = seat
  }
  if (maxSeat === 0) return null
  const p = new Possibilities(maxSeat)
  for (const [role, count] of setup) {
    p.setup[RoleBitIndex[role]] = count
  }
  p.setupOriginal = new Uint8Array(p.setup)
  for (const [seat, roles] of prior) {
    p.possibilities[seat] = possibilityFromRoles(roles)
  }
  p.refix()
  return p
}

/**
 * assumptions を effective prior 上で逐次 fix_role し、
 * 矛盾なく適用できるもののみ返す（Rust側の init_from_prior と同じ順序制約を模倣）
 */
function validateAssumptions(
  assumptions: Map<number, SystemRole>,
  refixed: Possibilities,
): Map<number, SystemRole> {
  const p = refixed.cloneInstance()
  const valid = new Map<number, SystemRole>()
  for (const [seat, role] of assumptions) {
    if (!p.hasRole(seat, role)) continue
    if (!p.fixRole(seat, role)) continue
    valid.set(seat, role)
  }
  return valid
}

/** analyzePerPlayer の戻り値: グローバル結果 + プレイヤー別結果 + Hati再利用用中間成果物 */
export type PerPlayerRetarResult = {
  /** 仮定なし（公開情報のみ）のRetar結果 */
  global: RetarResult
  /** プレイヤー別Retar結果 (seat → RetarResult) */
  perPlayer: Map<number, RetarResult>
  /** VillageStatus (Hati再利用用、構築失敗時は null) */
  vs: any | null
  /** 役職配置 (Hati再利用用) */
  setup: Map<SystemRole, number> | null
  /** Retar解析オプション (Hati再利用用) */
  analyzeOptions: AnalyzeOptions | null
}

/**
 * プレイヤー別 Retar 分析
 * 各プレイヤーの初期知識を assumption として Retar を実行し、プレイヤー別の結果を返す
 * グローバル（仮定なし）の結果も同時に返す
 */
export function analyzePerPlayer(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
  players: GameState['players'],
): PerPlayerRetarResult {
  const emptyGlobal: RetarResult = { possibilities: new Map(), maxSurvivingNV: 0 }
  const perPlayer = new Map<number, RetarResult>()

  const howl = formatHowl(events, state, config)
  const { meta, statements } = parse(howl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) return { global: emptyGlobal, perPlayer, vs: null, setup: null, analyzeOptions: null }

  const { vs, setup } = buildVillageStatus(statements, meta)

  const baseOptions = buildRetarOptions(config)

  // 共通 Retar を1回走らせ、結果を prior として再利用
  const global = runRetar(vs, setup, baseOptions)
  const prior = global.possibilities

  // 共通 Retar が破綻していたら per-player もスキップ
  if (global.possibilities.size === 0) return { global, perPlayer, vs, setup, analyzeOptions: baseOptions }

  // Rust側の init_from_prior は prior に refix() → assumptions を逐次 fix_role する。
  // 各ステップで連鎖伝播が発生し可能性が絞り込まれるため、
  // TS側でも同等のシミュレートで矛盾する assumption を事前に除外する。
  const refixed = buildRefixedPrior(prior, setup)

  for (const player of players) {
    const raw = buildAssumptions(state, player, prior)
    const assumptions = refixed && raw.size > 0
      ? validateAssumptions(raw, refixed)
      : raw
    if (assumptions.size === 0) {
      perPlayer.set(player.seat, global)
    } else {
      const options = { ...baseOptions, assumptions, prior }
      perPlayer.set(player.seat, runRetar(vs, setup, options))
    }
  }

  return { global, perPlayer, vs, setup, analyzeOptions: baseOptions }
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

  const baseOpts = buildRetarOptions(config)
  const options = assumptions && assumptions.size > 0
    ? { ...baseOpts, assumptions }
    : baseOpts

  const { possibilities } = runRetar(vs, setup, options)
  if (possibilities.size === 0) return false

  for (const [, roles] of possibilities) {
    if (roles.size === 0) return false
  }
  return true
}

/** searchTsumiFromEvents の戻り値（判定 + 手順構築） */
export type TsumiFromEventsResult = TsumiResult & { strategy: StrategyNode | null }

/**
 * Hati詰み探索をイベント列から実行（判定 + 手順構築）
 */
export function searchTsumiFromEvents(
  events: readonly any[],
  state: GameState,
  config: LupaConfig,
  maxDepth: number = 4,
): TsumiFromEventsResult | null {
  const howl = formatHowl(events, state, config)
  const { meta, statements } = parse(howl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) return null

  const { vs, setup } = buildVillageStatus(statements, meta)
  const options: AnalyzeOptions = buildRetarOptions(config)

  try {
    const result = searchTsumi(vs, setup, options, lupaRunRetar)
    let strategy: StrategyNode | null = null
    if (result.isTsumi) {
      const sr = searchTsumiStrategy(result, { maxDepth })
      strategy = sr.strategy
    }
    return { ...result, strategy }
  } catch {
    return null
  }
}

/**
 * RetarResult (Map<seat, Set<role>>) → Possibilities 変換
 * Hati の retarConclusions に渡すための変換ヘルパー
 */
export function retarResultToPossibilities(
  result: RetarResult,
  setup: Map<SystemRole, number>,
): Possibilities {
  let maxSeat = 0
  for (const seat of result.possibilities.keys()) {
    if (seat > maxSeat) maxSeat = seat
  }
  const p = new Possibilities(maxSeat)
  for (const [role, count] of setup) {
    p.setup[RoleBitIndex[role]] = count
  }
  p.setupOriginal = new Uint8Array(p.setup)
  for (const [seat, roles] of result.possibilities) {
    p.possibilities[seat] = possibilityFromRoles(roles)
  }
  p.refix()
  return p
}
