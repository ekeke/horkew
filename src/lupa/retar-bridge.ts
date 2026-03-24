/**
 * Retar統合ブリッジ
 *
 * Lupaエンジンの途中状態からRetarの論理推論を実行する。
 * verify.tsと同じパイプライン: GameEvents → formatHowl → parse → buildVillageStatus → VillageRetar
 */

import type { SystemRole, EnumSpecies } from '../types/index.ts'
import type { LupaConfig, GameState, GameEvent } from './types.ts'
import { formatHowl } from './format.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'

const DEFAULT_RETAR_OPTIONS: AnalyzeOptions = {
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
 * 現在のイベント列からRetarの役職可能性を計算
 *
 * verify.tsと同じパイプラインを使用:
 * events → formatHowl → parse → buildVillageStatus → VillageRetar.analyze()
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
    // パース失敗時は空の結果を返す
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
 * 人外向け: 仮のCOイベントを追加した上でRetarを実行
 *
 * 「自分が占いCOしたら他プレイヤーの可能性はどう変わるか」をシミュレート。
 * 実際のイベント列を汚さず、コピーに仮イベントを追加して分析する。
 */
export type FakeClaim = {
  type: 'seer_co'
  results: Array<{ target: number, result: EnumSpecies }>
} | {
  type: 'medium_co'
  pastResults?: EnumSpecies[]
}

export function simulateCO(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
  seat: number,
  fakeClaim: FakeClaim,
): Map<number, Set<SystemRole>> {
  // イベント列のコピーに仮COイベントを追加
  const simEvents: GameEvent[] = [...events]

  switch (fakeClaim.type) {
    case 'seer_co':
      simEvents.push({
        type: 'seer_claim',
        actor: seat,
        results: fakeClaim.results,
      })
      break
    case 'medium_co':
      simEvents.push({
        type: 'medium_claim',
        actor: seat,
        pastResults: fakeClaim.pastResults,
      })
      break
  }

  return analyzeFromEvents(simEvents, state, config)
}

/**
 * 人外向け: 現在のCO状況でのRetar分析
 *
 * すでにCOしている場合、その状態での他プレイヤーの可能性を返す。
 * COしていない場合は通常分析と同じ。
 */
export function analyzeCurrentCOImpact(
  events: GameEvent[],
  state: GameState,
  config: LupaConfig,
  seat: number,
): {
  /** 通常分析結果 */
  current: Map<number, Set<SystemRole>>
  /** 占いCOした場合（未COの場合のみ） */
  ifSeerCO: Map<number, Set<SystemRole>> | null
  /** 霊能COした場合（未COの場合のみ） */
  ifMediumCO: Map<number, Set<SystemRole>> | null
} {
  const current = analyzeFromEvents(events, state, config)

  const player = state.players.find(p => p.seat === seat)
  if (!player || player.claimedRole !== null) {
    // すでにCO済み or プレイヤー不明 → What-Ifなし
    return { current, ifSeerCO: null, ifMediumCO: null }
  }

  // 占いCOシミュレーション（ダミー結果: 全員白）
  const alivePlayers = state.players.filter(p => p.alive && p.seat !== seat)
  const dummySeerResults: Array<{ target: number, result: EnumSpecies }> = []
  for (const p of alivePlayers.slice(0, Math.min(state.day, alivePlayers.length))) {
    dummySeerResults.push({ target: p.seat, result: 'human' })
  }

  const ifSeerCO = dummySeerResults.length > 0
    ? simulateCO(events, state, config, seat, {
        type: 'seer_co',
        results: dummySeerResults,
      })
    : null

  // 霊能COシミュレーション
  const ifMediumCO = simulateCO(events, state, config, seat, {
    type: 'medium_co',
  })

  return { current, ifSeerCO, ifMediumCO }
}
