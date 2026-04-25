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

/** 占い結果 (真偽どちらも) — 観測上の色 */
export type DivineColor = 'human' | 'wolf'

/** 偽占い結果 (狼/狂が報告する偽報告) — 既存名は互換のため維持 */
export type FakeDivineColor = DivineColor

/** 偽占い履歴の 1 件 */
export type FakeDivineEntry = {
  day: number
  target: number
  color: FakeDivineColor
}

/** 真占い履歴の 1 件 (世界固定で導出される、actor=seer の私的観測) */
export type DivineEntry = {
  day: number
  target: number
  color: DivineColor
}

/** 死亡原因 (deathLog 用) */
export type DeathCause = 'execute' | 'night_kill' | 'follow' | 'curse' | 'nekomata_revenge'

/** 死亡履歴の 1 件 */
export type DeathEntry = {
  day: number
  seat: number
  cause: DeathCause
}

/** 投票履歴の 1 件 (Stage 2 では voteLog は空配列で OK、Stage 5 で集団意思決定の追加情報) */
export type VoteEntry = {
  day: number
  voter: number
  target: number
}

/** 護衛履歴の 1 件 (bodyguard の私的情報、obs に出る) */
export type GuardEntry = {
  day: number
  target: number
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
  /** seerSeat → 偽占い結果の履歴 (狼/狂の偽報告) */
  fakeDivineHistory: Map<number, FakeDivineEntry[]>

  /** seerSeat → 真占い結果の履歴 (世界固定で導出、actor=seer の私的観測) */
  divineLog: Map<number, DivineEntry[]>
  /** 死亡履歴 (execute / night_kill / follow / curse / nekomata_revenge) */
  deathLog: DeathEntry[]
  /** 投票履歴 (Stage 2 では空、Stage 5 で集団意思決定で活用) */
  voteLog: VoteEntry[]
  /** 護衛履歴 (真 bg の私的情報) */
  guardLog: GuardEntry[]

  /**
   * morning phase で当日まだ偽占い報告をしていない偽 seer の seat キュー (FIFO)。
   * Stage 3 で導入: morning は 1 actor あたり 1 step (28 actions = target × color) で
   * 処理し、queue が空になったら次 phase へ。night_guard 後の翌日遷移時に再 populate される。
   */
  morningPending: number[]
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
    divineLog: new Map(),
    deathLog: [],
    voteLog: [],
    guardLog: [],
    morningPending: [],
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
  const divineLog = new Map<number, DivineEntry[]>()
  for (const [seat, entries] of state.divineLog) {
    divineLog.set(seat, entries.map(e => ({ day: e.day, target: e.target, color: e.color })))
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
    divineLog,
    deathLog: state.deathLog.map(e => ({ day: e.day, seat: e.seat, cause: e.cause })),
    voteLog: state.voteLog.map(e => ({ day: e.day, voter: e.voter, target: e.target })),
    guardLog: state.guardLog.map(e => ({ day: e.day, target: e.target })),
    morningPending: state.morningPending.slice(),
  }
}

export function isTerminal(state: SimState): boolean {
  return state.phase === 'terminal'
}
