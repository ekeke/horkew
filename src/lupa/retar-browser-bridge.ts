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
): Map<number, Set<SystemRole>> {
  const howl = formatHowl(events, state, config)
  const { meta, statements } = parse(howl)
  const unknowns = statements.filter(s => s.type === 'unknown')
  if (unknowns.length > 0) {
    return new Map()
  }

  const { vs, setup } = buildVillageStatus(statements, meta)

  const options = config.hasFirstGhost
    ? { ...DEFAULT_RETAR_OPTIONS, hasFirstGhost: true }
    : DEFAULT_RETAR_OPTIONS

  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyzeSafe()

  if (result.error || !result.result) {
    return new Map()
  }

  return result.result
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
