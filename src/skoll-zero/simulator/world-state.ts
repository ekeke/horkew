import type { SystemRole } from '../../types/index.ts'
import type { World } from '../../hati/types.ts'
import type { GameOutcome } from '../../hati/simulate.ts'

/**
 * SimState.phase の 15 種。1 day-night cycle を細分化:
 *
 *   morning
 *     → claim_seer_true / claim_medium_true / claim_bg_true / claim_nekomata_true / claim_mason
 *     → claim_seer_fake / claim_medium_fake / claim_bg_fake / claim_nekomata_fake
 *     → day
 *     → night_attack / night_divine / night_guard
 *     → (simulateNight + outcome 判定)
 *     → terminal or 翌 morning
 *
 * skip 条件は nextPhase / advancePhase で判定する。
 */
export type Phase =
  | 'morning'
  | 'claim_seer_true'
  | 'claim_medium_true'
  | 'claim_bg_true'
  | 'claim_nekomata_true'
  | 'claim_mason'
  | 'claim_seer_fake'
  | 'claim_medium_fake'
  | 'claim_bg_fake'
  | 'claim_nekomata_fake'
  | 'day'
  | 'night_attack'
  | 'night_divine'
  | 'night_guard'
  | 'terminal'

/** 偽占い結果 (狼/狂が報告する偽報告) */
export type FakeDivineColor = 'human' | 'wolf'

/** 偽占い履歴の 1 件 */
export type FakeDivineEntry = {
  day: number
  target: number
  color: FakeDivineColor
}

/** CO 状態の 1 件 */
export type ClaimEntry = {
  role: SystemRole
  isFake: boolean
}

/**
 * MCTS rollout 用の決定論的 game state。
 *
 * lupa の GameState と異なり、bitmask + 真role world だけで動く軽量版。
 * Stage 1 で 15 phase + claim/fake-divine 履歴 + 夜行動の pending state を保持する。
 *
 * `world` は immutable と仮定 (rollout 中に mutate しない)。enumerateWorlds が
 * 共有バッファを emit する場合は呼び出し側で `cloneWorld` してから渡すこと。
 *
 * pending* / claims / fakeDivineHistory は cloneSimState で deep clone される。
 */
export type SimState = {
  world: World
  alive: number
  day: number
  phase: Phase
  outcome: GameOutcome | null

  /** night_attack で選ばれた噛み先。night_guard 終わりに simulateNight で消費 */
  pendingAttack: number | null
  /** night_guard で選ばれた護衛先 */
  pendingGuard: number | null
  /** night_divine で選ばれた占い先列。複数 seer 対応で配列保持 */
  pendingDivineTargets: number[]

  /** seat → CO 内容 (真/偽の役職表明) */
  claims: Map<number, ClaimEntry>
  /** seerSeat → 偽占い結果の履歴。真 seer は world から導出するため state に持たない */
  fakeDivineHistory: Map<number, FakeDivineEntry[]>
}

/**
 * 新規 SimState を構築。デフォルトで day=1 の morning から開始する。
 *
 * 後方互換: 旧 createSimState(world, alive, day, phase) シグネチャと互換。phase は
 * 旧 'day' / 'night' を受け取れるようにしてあるが、新コードは新 Phase で渡すこと。
 */
export function createSimState(
  world: World,
  alive: number,
  day: number = 1,
  phase: Phase = 'morning',
): SimState {
  return {
    world,
    alive,
    day,
    phase,
    outcome: null,
    pendingAttack: null,
    pendingGuard: null,
    pendingDivineTargets: [],
    claims: new Map(),
    fakeDivineHistory: new Map(),
  }
}

/**
 * state 単位の deep clone。world は共有 (immutable 前提)。
 * Map / 配列フィールドは新規インスタンスを作って独立性を確保する。
 */
export function cloneSimState(state: SimState): SimState {
  const claims = new Map<number, ClaimEntry>()
  for (const [seat, entry] of state.claims) {
    claims.set(seat, { role: entry.role, isFake: entry.isFake })
  }
  const fakeDivineHistory = new Map<number, FakeDivineEntry[]>()
  for (const [seat, entries] of state.fakeDivineHistory) {
    fakeDivineHistory.set(seat, entries.map(e => ({ day: e.day, target: e.target, color: e.color })))
  }
  return {
    world: state.world,
    alive: state.alive,
    day: state.day,
    phase: state.phase,
    outcome: state.outcome,
    pendingAttack: state.pendingAttack,
    pendingGuard: state.pendingGuard,
    pendingDivineTargets: state.pendingDivineTargets.slice(),
    claims,
    fakeDivineHistory,
  }
}

export function isTerminal(state: SimState): boolean {
  return state.phase === 'terminal'
}
