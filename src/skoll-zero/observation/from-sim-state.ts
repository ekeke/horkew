/**
 * SimState から observation を動的生成する encoder。
 *
 * Stage 2 で実装。各 Module の rollout 中に呼ばれ、世界 + 公開状態 + viewer 視点で
 * Float32Array (CollectedObservation → packObservation) を生成する。
 *
 * ## 設計
 *
 * - **rollout dynamic 部分**: SimState から動的に再構築 (alive / claims /
 *   fakeDivineHistory / divineLog / deathLog / guardLog 等)
 * - **rollout invariant 部分**: root snapshot として `RolloutInvariants` 引数で渡す
 *   - signal カウンター (suspicion / trust / accuse_wolf 等) — comm phase が
 *     rollout 内で発生しないので不変
 *   - retarPossibilities / globalRetarPossibilities — root で計算済 (再計算は重い)
 *   - tsumiTarget / ropeMargin / commander / demandWolfCoCount / planIndices —
 *     全部 root snapshot
 *
 * ## 互換性
 *
 * 既存の `collectObservation(ctx)` と数値的に一致する設計。M3 で `buildInitialSimState(ctx)`
 * + invariants 構築の経路を確立すると、ctx 経路と SimState 経路で同じ obs が出る。
 */

import type { SystemRole } from '../../types/index.ts'
import type { World } from '../../hati/types.ts'
import { hasSeat, popCount32 } from '../../hati/types.ts'
import { RoleBitIndex } from '../../retar/possibilities.ts'
import { runRetarOnVillageStatus, setupFromWorld, simStateToVillageStatus } from './sim-state-to-vs.ts'
import {
  collectObservation, packObservation, encodeCollectiveWolfObservation,
  encodeCollectiveMasonObservation, encodeFanaticObservation,
  overrideForCollective,
  WOLF_COLLECTIVE_OBSERVATION_SIZE, MASON_COLLECTIVE_OBSERVATION_SIZE, FANATIC_OBSERVATION_SIZE,
  COLLECTIVE_TEAM_SIZE_START, WOLF_FAKE_DIVINE_START,
  WOLF_VILLAGE_PREDICT_START, WOLF_VILLAGE_TRUST_START,
  FANATIC_VILLAGE_PREDICT_START, FANATIC_VILLAGE_TRUST_START,
  type CollectedObservation, type SeatPublicData, type ObservationMode,
  SEATS, HISTORY_WINDOW, HISTORY_DAY_SIZE,
} from '../../fenrir/src/observation.ts'
import type { SimState } from '../simulator/world-state.ts'

/**
 * rollout 中に変わらない情報の root snapshot。
 *
 * MCTS root で 1 回 ctx から構築し、rollout 全体で共有する。
 * comm phase が rollout 内で発生しない前提なので、これらは真に不変。
 */
export type RolloutInvariants = {
  /** seat → 各種 signal の累積カウンター (comm phase が rollout 内で発生しないため不変) */
  signalCounts: SignalCountsPerSeat[]
  /** viewer 視点の Retar 可能性 (root で計算済、rollout 中再計算しない) */
  retarPossibilities: Map<number, Set<SystemRole>> | null
  /** 公開情報のみの Retar 可能性 */
  globalRetarPossibilities: Map<number, Set<SystemRole>> | null
  /** 詰み対象 seat (null なら詰み無し) */
  tsumiTarget: number | null
  /** 縄余裕 (Retar 由来、null なら未計算) */
  ropeMargin: number | null
  /** 指揮者 seat (Stage 2 では発生しないため null) */
  commander: number | null
  /** 「狼 CO 要求」の累積回数 */
  demandWolfCoCount: number
  /** 投票プラン (Stage 2 では null) */
  planIndices: number[] | null
  /** frozen 村 NN 出力 (wolf/fanatic 集団観測で使用、未指定時は 0 埋め) */
  villageNNOutput?: VillageNNOutput
  /** 配役 (rollout 中の Retar 再呼び出しに使う、未指定なら world 由来で導出) */
  setup?: Map<SystemRole, number>
  /**
   * true なら observation 生成時に毎回 SimState から Retar を再実行する。
   * false (default) なら invariants.retarPossibilities / globalRetarPossibilities を root snapshot として使う。
   */
  recomputeRetarInRollout?: boolean
  /**
   * Retar 差分計算用の prior cache (mutable)。recomputeRetarInRollout=true のとき、
   * 各 expand の global retar 計算で前回結果を prior として渡し、計算後に最新結果で update。
   *
   * 並列 leaf 間で衝突 (= 直前 leaf の結果が次 leaf の prior になる) する可能性があるが、
   * retar の initFromPrior が cross-day 対応 (eced9fb) で、prior が腐っていれば silent
   * fallback (scratch から計算) するため結果は正しい。prior 効果が落ちる場合があるだけ。
   *
   * Stage 1 簡略化: global retar のみキャッシュ。self retar (viewer-specific assumption)
   * は prior なし (既存挙動維持)。
   */
  retarPriorCache?: { global: Map<number, Set<SystemRole>> | null }
  /**
   * Narrow bonus 用: MCTS root 時点の global retar 可能性総和 (alive 席のみ)。
   *
   * `runMCTS` の冒頭で `globalRetarPossibilities` から 1 度だけ計算してキャッシュする。
   * leaf 評価時に `state.globalRetarSum` と差分を取って narrow bonus を計算する。
   * null なら narrow bonus は no-op (rollout retar OFF または narrow coef=0 時の最適化)。
   */
  globalRetarSumAtRoot?: number | null
}

/** signal の per-seat 累積カウンター (`collectObservation` 由来) */
export type SignalCountsPerSeat = {
  voteReceived: number
  suspicion: number
  trust: number
  executeProposal: number
  isCommander: boolean
  accuseWolf: number
  accuseFox: number
  voteIntent: number
  nominateCommander: number
  planApproved: number
  confirmHuman: number
  confirmWolf: number
  voteFor: number
  voteAgainst: number
}

/** frozen village NN 出力 (集団観測の wolf/fanatic で注入) */
export type VillageNNOutput = {
  /** per-seat × NUM_ROLES (14 × 11 = 154) の予想分布 */
  predict: Float32Array
  /** per-seat (14) の信頼度スカラー */
  trust: Float32Array
}

/** 0 で埋めた signal カウンター (rollout 開始時 / signal 不在時) */
export function zeroSignalCounts(): SignalCountsPerSeat[] {
  const out: SignalCountsPerSeat[] = []
  for (let i = 0; i < SEATS; i++) {
    out.push({
      voteReceived: 0, suspicion: 0, trust: 0, executeProposal: 0, isCommander: false,
      accuseWolf: 0, accuseFox: 0, voteIntent: 0, nominateCommander: 0, planApproved: 0,
      confirmHuman: 0, confirmWolf: 0, voteFor: 0, voteAgainst: 0,
    })
  }
  return out
}

/** signal 全 0、retar/tsumi/plan も全部 null/0 で埋めた invariants (テスト用 / fallback) */
export function emptyInvariants(): RolloutInvariants {
  return {
    signalCounts: zeroSignalCounts(),
    retarPossibilities: null,
    globalRetarPossibilities: null,
    tsumiTarget: null,
    ropeMargin: null,
    commander: null,
    demandWolfCoCount: 0,
    planIndices: null,
  }
}

/**
 * world + viewerSeat から viewer の SystemRole を導出。
 * MCTS rollout 内では viewer 役職は決定者の役職か、phase dispatch で他役職に切替わる。
 */
export function viewerRoleOf(world: World, viewerSeat: number): SystemRole {
  return world.roles[viewerSeat]
}

/**
 * SimState + viewer 情報 + invariants から CollectedObservation を組み立てる。
 *
 * `collectObservation(ctx)` と同じ結果を返すよう、ctx の各フィールドを SimState 経路で導出する。
 *
 * @param state rollout 中の動的 state
 * @param viewerSeat 観測の主体 (actor)
 * @param viewerRole 観測者の役職 (世界由来、actor の真 role)
 * @param invariants rollout 不変情報 (root snapshot)
 */
export function collectFromSimState(
  state: SimState,
  viewerSeat: number,
  viewerRole: SystemRole,
  invariants: RolloutInvariants,
): CollectedObservation {
  const world = state.world
  const aliveCount = popCount32(state.alive)

  // ========== per-seat ==========
  const seats: SeatPublicData[] = []

  // claim 履歴から black/white カウントを集計 (真 seer + 偽 seer)
  // - 真 seer: state.divineLog から(claims に真 seer CO が登録されている seer の seat の log)
  // - 偽 seer: state.fakeDivineHistory から (claims に偽 seer CO 登録された seat の log)
  const blackCounts = new Map<number, number>()
  const whiteCounts = new Map<number, number>()
  for (const [seerSeat, entries] of state.divineLog) {
    // 真 seer の log を集計するのは「真 seer が CO 済」の場合のみ
    const claim = state.claims.get(seerSeat)
    if (!claim || claim.role !== 'seer' || claim.isFake) continue
    for (const e of entries) {
      if (e.color === 'wolf') blackCounts.set(e.target, (blackCounts.get(e.target) ?? 0) + 1)
      else whiteCounts.set(e.target, (whiteCounts.get(e.target) ?? 0) + 1)
    }
  }
  for (const [seerSeat, entries] of state.fakeDivineHistory) {
    const claim = state.claims.get(seerSeat)
    if (!claim || claim.role !== 'seer' || !claim.isFake) continue
    for (const e of entries) {
      if (e.color === 'wolf') blackCounts.set(e.target, (blackCounts.get(e.target) ?? 0) + 1)
      else whiteCounts.set(e.target, (whiteCounts.get(e.target) ?? 0) + 1)
    }
  }

  for (let seat = 1; seat <= SEATS; seat++) {
    const claim = state.claims.get(seat)
    const sig = invariants.signalCounts[seat - 1]
    seats.push({
      alive: hasSeat(state.alive, seat),
      claimedRole: claim?.role,
      isMe: seat === viewerSeat,
      blackCount: blackCounts.get(seat) ?? 0,
      whiteCount: whiteCounts.get(seat) ?? 0,
      voteReceived: sig.voteReceived,
      suspicion: sig.suspicion,
      trust: sig.trust,
      executeProposal: sig.executeProposal,
      isCommander: invariants.commander === seat,
      accuseWolf: sig.accuseWolf,
      accuseFox: sig.accuseFox,
      voteIntent: sig.voteIntent,
      nominateCommander: sig.nominateCommander,
      planApproved: sig.planApproved,
      confirmHuman: sig.confirmHuman,
      confirmWolf: sig.confirmWolf,
      voteFor: sig.voteFor,
      voteAgainst: sig.voteAgainst,
    })
  }

  // ========== private 情報 ==========
  const divineResults: Array<[number, 'human' | 'wolf']> = []
  if (viewerRole === 'seer') {
    const log = state.divineLog.get(viewerSeat)
    if (log) {
      for (const e of log) divineResults.push([e.target, e.color])
    }
  }

  const guardedSeats: number[] = []
  if (viewerRole === 'bodyguard') {
    const seen = new Set<number>()
    for (const e of state.guardLog) {
      if (e.target >= 1 && e.target <= SEATS && !seen.has(e.target)) {
        seen.add(e.target)
        guardedSeats.push(e.target)
      }
    }
  }

  // wolf チームの仲間情報
  const wolfTeamSeats: number[] = []
  if (viewerRole === 'werewolf' || viewerRole === 'fanatic') {
    let mask = world.wolfMask
    while (mask !== 0) {
      const bit = mask & (-mask)
      const s = 31 - Math.clz32(bit)
      mask ^= bit
      if (s !== viewerSeat) wolfTeamSeats.push(s)
    }
  }

  // mason partner: 他の mason seat
  let masonPartner: number | null = null
  if (viewerRole === 'mason') {
    for (let s = 1; s < world.roleIds.length; s++) {
      if (s !== viewerSeat && world.roleIds[s] === RoleBitIndex.mason) {
        masonPartner = s
        break
      }
    }
  }

  // 妖狐の知識: immoralist は werehamster 席を知る
  let knownHamster: number | null = null
  if (viewerRole === 'immoralist') {
    let mask = world.hamsterMask
    if (mask !== 0) {
      const bit = mask & (-mask)
      knownHamster = 31 - Math.clz32(bit)
    }
  }

  // ========== history (直近 3 日分) ==========
  // TODO(stage-3+): ctx 経路 (collectObservation) は各イベントを「全 3 windows に
  // smear」する仕様 (イベントに day 情報が無いため)。SimState 経路は deathLog.day で
  // 厳密に振り分けるため、両者は構造的に一致しない。さらに claim/vote/signal の各
  // 列は day 情報が claims・signalCounts に乗っていないため未実装。
  // 詳細: src/skoll-zero/observation/parity.test.ts の D2 / tasks/todo.md
  const history = new Float32Array(HISTORY_WINDOW * HISTORY_DAY_SIZE)
  const currentDay = state.day
  for (const e of state.deathLog) {
    for (let w = 0; w < HISTORY_WINDOW; w++) {
      const histDay = currentDay - HISTORY_WINDOW + w + 1
      if (e.day !== histDay) continue
      const slot = e.seat - 1
      if (slot < 0 || slot >= SEATS) continue
      const dayBase = w * HISTORY_DAY_SIZE
      if (e.cause === 'execute') history[dayBase + slot * 5 + 1] = 1
      else history[dayBase + slot * 5 + 2] = 1
    }
  }

  // ========== rope margin ==========
  let ropeMargin = invariants.ropeMargin
  if (ropeMargin === null && invariants.retarPossibilities !== null) {
    // 暫定: ropeMargin の再計算は invariants で済んでいる前提。null のままなら 0 扱い
  }

  return {
    global: {
      day: state.day,
      phase: phaseToCtxPhase(state.phase),
      aliveCount,
      myRole: viewerRole,
      commander: invariants.commander,
      demandWolfCoCount: invariants.demandWolfCoCount,
      ropeMargin,
      aliveParity: aliveCount % 2,
    },
    seats,
    private: {
      divineResults,
      wolfTeamSeats,
      masonPartner,
      guardedSeats,
      knownHamster,
    },
    // TODO(stage-3+): SimState に revote 状態 (round/candidates) を持たせる。
    // 現状ハードコード 0/[] のため、ctx.revoteRound != null の場面で発散する。
    // 詳細: src/skoll-zero/observation/parity.test.ts の D1 / tasks/todo.md
    revote: {
      round: 0,
      candidates: [],
    },
    history: Array.from(history),
    retar: (() => {
      const r = resolveRetarBoth(state, viewerSeat, viewerRole, invariants)
      return {
        self: mapOfSetsToRecord(r.self),
        global: mapOfSetsToRecord(r.global),
      }
    })(),
    plan: {
      indices: invariants.planIndices,
    },
    tsumiTarget: invariants.tsumiTarget,
  }
}

/** Map<number, Set<SystemRole>> → Record<string, SystemRole[]> (CollectedObservation 互換) */
function mapOfSetsToRecord(
  map: Map<number, Set<SystemRole>> | null,
): Record<string, SystemRole[]> | null {
  if (!map) return null
  const rec: Record<string, SystemRole[]> = {}
  for (const [seat, roles] of map) rec[String(seat)] = [...roles]
  return rec
}

/**
 * 初回だけエラーログを出すため。WASM Retar が panic した場合の fallback を発動した
 * ことを開発者に通知する (rollout 中は数千回呼ばれるため、毎回 stderr に出すと膨大に
 * なる)。学習継続のため fallback で root snapshot を返す。
 */
let warnedRetarFallback = false
let debugDumpDone = false

/**
 * panic 時の SimState / VillageStatus を JSON で stderr に書き出す debug helper。
 * 環境変数 RETAR_DEBUG_DUMP=1 で有効化。1 回だけ実行して止まる (大量 dump 回避)。
 */
function debugDumpOnPanic(
  state: SimState,
  viewerSeat: number | null,
  viewerRole: SystemRole | null,
  setup: Map<SystemRole, number>,
  e: unknown,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- node process global
  const env = (globalThis as any).process?.env ?? {}
  if (env.RETAR_DEBUG_DUMP !== '1' || debugDumpDone) return
  debugDumpDone = true
  const lines: string[] = ['=== Retar panic input dump ===']
  lines.push(`error: ${e instanceof Error ? e.message : String(e)}`)
  lines.push(`viewer: seat=${viewerSeat} role=${viewerRole}`)
  lines.push(`day: ${state.day} phase: ${state.phase} alive: 0x${state.alive.toString(16)}`)
  lines.push(`setup: ${JSON.stringify([...setup.entries()])}`)
  lines.push(`claims: ${JSON.stringify([...state.claims.entries()])}`)
  lines.push(`divineLog: ${JSON.stringify([...state.divineLog.entries()])}`)
  lines.push(`fakeDivineHistory: ${JSON.stringify([...state.fakeDivineHistory.entries()])}`)
  lines.push(`deathLog: ${JSON.stringify(state.deathLog)}`)
  lines.push(`voteLog: ${JSON.stringify(state.voteLog)}`)
  lines.push(`guardLog: ${JSON.stringify(state.guardLog)}`)
  lines.push(`morningPending: ${JSON.stringify(state.morningPending)}`)
  lines.push(`world.roles: ${JSON.stringify(state.world.roles)}`)
  lines.push(`world.wolfMask: 0x${state.world.wolfMask.toString(16)}`)
  lines.push(`world.hamsterMask: 0x${state.world.hamsterMask.toString(16)}`)
  try {
    const vs = simStateToVillageStatus(state)
    lines.push(`vs.statuses: ${JSON.stringify([...vs.statuses.entries()].map(([k, v]) => [k, {
      ...v,
      actions: [...v.actions.entries()],
      assertions: [...v.assertions.entries()],
      forecasts: [...v.forecasts.entries()],
    }]))}`)
    lines.push(`vs.executions: ${JSON.stringify([...vs.executions.entries()])}`)
    lines.push(`vs.kills: ${JSON.stringify([...vs.kills.entries()])}`)
    lines.push(`vs.voteHistory: ${JSON.stringify([...vs.voteHistory.entries()])}`)
    lines.push(`vs.claims: ${JSON.stringify([...vs.claims.entries()])}`)
  } catch (vsErr) {
    lines.push(`vs build failed: ${vsErr instanceof Error ? vsErr.message : String(vsErr)}`)
  }
  lines.push('=== end dump ===')
  console.error(lines.join('\n'))
}

/**
 * viewer 視点 retar から「観測上 fox (werehamster) 候補が生存席に残っているか」を判定。
 * 全生存席で fox を持ち得る席が消えれば観測上 fox 死亡確認、それ以外は生存可能性ありで true。
 * day bonus / endgame bonus の faction 切替信号として `state.foxAliveByViewer` に書き戻す。
 */
export function viewerFoxAlive(
  possibilities: Map<number, Set<SystemRole>> | null,
  alive: number,
): boolean {
  if (!possibilities) return true  // 不明時は生存扱い (互換、保守側)
  for (const [seat, roles] of possibilities) {
    if (!hasSeat(alive, seat)) continue
    if (roles.has('werehamster')) return true
  }
  return false
}

/**
 * Retar の生存席可能性総和 = Σ_{seat ∈ alive} |possibilities[seat]|。
 *
 * narrow bonus の root/leaf 比較に使う。possibilities が null なら null を返す
 * (= 計算できない、bonus 側で no-op になる)。
 *
 * possibilities に死亡席のエントリが入っていても無視する (alive bitmask で filter)。
 */
export function sumAlivePossibilities(
  possibilities: Map<number, Set<SystemRole>> | null,
  alive: number,
): number | null {
  if (!possibilities) return null
  let sum = 0
  for (const [seat, roles] of possibilities) {
    if (!hasSeat(alive, seat)) continue
    sum += roles.size
  }
  return sum
}

/**
 * viewer 視点 + global 視点の retarPossibilities を 1 度の VS 構築でまとめて解決する。
 * `invariants.recomputeRetarInRollout` が true なら SimState から Retar 再実行、
 * false なら invariants の root snapshot を使う。
 *
 * 最適化: 同 SimState から 2 系統 (assumption 違い) を呼ぶ場合、VillageStatus と
 * setup は共有できる。`simStateToVillageStatus` を 1 回だけ呼んで使い回す。
 *
 * Retar 呼び出しが失敗した場合 (WASM panic 等) は root snapshot にフォールバック。
 *
 * 副作用: self retar 結果から `state.foxAliveByViewer` を更新する (rollout 内の day 進行で
 * 占い呪殺等が観測上確認できた瞬間に false に切り替わる)。
 */
function resolveRetarBoth(
  state: SimState,
  viewerSeat: number,
  viewerRole: SystemRole,
  invariants: RolloutInvariants,
): {
  self: Map<number, Set<SystemRole>> | null,
  global: Map<number, Set<SystemRole>> | null,
} {
  if (!invariants.recomputeRetarInRollout) {
    state.foxAliveByViewer = viewerFoxAlive(invariants.retarPossibilities, state.alive)
    state.globalRetarSum = sumAlivePossibilities(invariants.globalRetarPossibilities, state.alive)
    return {
      self: invariants.retarPossibilities,
      global: invariants.globalRetarPossibilities,
    }
  }
  const setup = invariants.setup ?? setupFromWorld(state.world)
  try {
    const vs = simStateToVillageStatus(state)
    // 差分計算: 前回 global retar 結果を prior として渡す。retar 内部で initFromPrior
    // 経路で枝刈り。prior が腐っていれば silent fallback (scratch から計算) する。
    const priorGlobal = invariants.retarPriorCache?.global ?? undefined
    const global = runRetarOnVillageStatus(vs, setup, undefined, undefined, priorGlobal)
    // self retar は viewer-specific assumption が異なるため Stage 1 では prior なし
    const self = runRetarOnVillageStatus(vs, setup, viewerSeat, viewerRole)
    // 次回 prior 用に cache を update (並列 leaf で衝突しても retar 側 fallback で正しく動く)
    if (invariants.retarPriorCache) invariants.retarPriorCache.global = global
    state.foxAliveByViewer = viewerFoxAlive(self, state.alive)
    state.globalRetarSum = sumAlivePossibilities(global, state.alive)
    return { self, global }
  } catch (e) {
    debugDumpOnPanic(state, viewerSeat, viewerRole, setup, e)
    if (!warnedRetarFallback) {
      console.error(`[from-sim-state] Retar rollout failed, falling back to root snapshot: ${e instanceof Error ? e.message : String(e)}`)
      warnedRetarFallback = true
    }
    state.foxAliveByViewer = viewerFoxAlive(invariants.retarPossibilities, state.alive)
    state.globalRetarSum = sumAlivePossibilities(invariants.globalRetarPossibilities, state.alive)
    return {
      self: invariants.retarPossibilities,
      global: invariants.globalRetarPossibilities,
    }
  }
}

/** Phase (15 種) → CollectedObservation の phase ('day' | 'night') */
function phaseToCtxPhase(phase: SimState['phase']): 'day' | 'night' {
  switch (phase) {
    case 'night_attack':
    case 'night_divine':
    case 'night_guard':
      return 'night'
    default:
      return 'day' // morning / claim_* / day / terminal は day 扱い
  }
}

/**
 * SimState から個人観測 (1029 dims) を encode。
 *
 * @param state rollout dynamic state
 * @param viewerSeat 観測者の seat
 * @param viewerRole 観測者の役職 (世界由来)
 * @param invariants rollout 不変情報
 */
export function encodeIndividualFromSimState(
  state: SimState,
  viewerSeat: number,
  viewerRole: SystemRole,
  invariants: RolloutInvariants,
): Float32Array {
  return packObservation(collectFromSimState(state, viewerSeat, viewerRole, invariants))
}

/**
 * SimState + viewer + invariants から mason_collective 観測 (1030 dims) を encode。
 * 個人観測ベース + collective override + team_size。
 */
export function encodeMasonCollectiveFromSimState(
  state: SimState,
  viewerSeat: number,
  viewerRole: SystemRole,
  invariants: RolloutInvariants,
): Float32Array {
  const obs = new Float32Array(MASON_COLLECTIVE_OBSERVATION_SIZE)
  const base = encodeIndividualFromSimState(state, viewerSeat, viewerRole, invariants)
  obs.set(base)
  const teamSeats = masonSeatsFromWorld(state.world)
  overrideForCollective(obs, teamSeats)
  obs[COLLECTIVE_TEAM_SIZE_START] = teamSeats.length / SEATS
  return obs
}

/**
 * SimState + viewer + invariants から wolf_collective 観測 (1212 dims) を encode。
 * 個人観測ベース + collective override + team_size + fake_divine + village_predict/trust。
 */
export function encodeWolfCollectiveFromSimState(
  state: SimState,
  viewerSeat: number,
  viewerRole: SystemRole,
  invariants: RolloutInvariants,
): Float32Array {
  const obs = new Float32Array(WOLF_COLLECTIVE_OBSERVATION_SIZE)
  const base = encodeIndividualFromSimState(state, viewerSeat, viewerRole, invariants)
  obs.set(base)
  const teamSeats = seatsFromMask(state.world.wolfMask)
  overrideForCollective(obs, teamSeats)
  obs[COLLECTIVE_TEAM_SIZE_START] = teamSeats.length / SEATS

  // fake_divine: wolf チームの誰かが偽 seer CO してたら、fakeDivineHistory から target ごとに集計
  for (let seat = 1; seat <= SEATS; seat++) {
    let fakeResult = 0
    for (const wolfSeat of teamSeats) {
      const fake = state.fakeDivineHistory.get(wolfSeat)
      if (!fake) continue
      const claim = state.claims.get(wolfSeat)
      if (!claim || claim.role !== 'seer' || !claim.isFake) continue
      for (const e of fake) {
        if (e.target === seat) fakeResult = e.color === 'human' ? 0.5 : 1.0
      }
    }
    obs[WOLF_FAKE_DIVINE_START + seat - 1] = fakeResult
  }

  // village_predict / village_trust の注入
  if (invariants.villageNNOutput) {
    obs.set(invariants.villageNNOutput.predict, WOLF_VILLAGE_PREDICT_START)
    obs.set(invariants.villageNNOutput.trust, WOLF_VILLAGE_TRUST_START)
  }
  return obs
}

/**
 * SimState + viewer + invariants から fanatic 観測 (1197 dims) を encode。
 * 個人観測ベース + village_predict/trust。collective override なし (fanatic は個人 NN)。
 */
export function encodeFanaticFromSimState(
  state: SimState,
  viewerSeat: number,
  viewerRole: SystemRole,
  invariants: RolloutInvariants,
): Float32Array {
  const obs = new Float32Array(FANATIC_OBSERVATION_SIZE)
  const base = encodeIndividualFromSimState(state, viewerSeat, viewerRole, invariants)
  obs.set(base)
  if (invariants.villageNNOutput) {
    obs.set(invariants.villageNNOutput.predict, FANATIC_VILLAGE_PREDICT_START)
    obs.set(invariants.villageNNOutput.trust, FANATIC_VILLAGE_TRUST_START)
  }
  return obs
}

/**
 * SimState から観測モード別に encode する dispatcher。
 */
export function encodeFromSimState(
  state: SimState,
  viewerSeat: number,
  viewerRole: SystemRole,
  encoderType: ObservationMode,
  invariants: RolloutInvariants,
): Float32Array {
  switch (encoderType) {
    case 'individual':
      return encodeIndividualFromSimState(state, viewerSeat, viewerRole, invariants)
    case 'mason_collective':
      return encodeMasonCollectiveFromSimState(state, viewerSeat, viewerRole, invariants)
    case 'wolf_collective':
      return encodeWolfCollectiveFromSimState(state, viewerSeat, viewerRole, invariants)
    case 'fanatic':
      return encodeFanaticFromSimState(state, viewerSeat, viewerRole, invariants)
    case 'team':
      // team obs は人狼ゲーム以外の汎用。Stage 2 範囲ではサポートしない。
      throw new Error('encodeFromSimState: encoderType "team" is not supported in skoll-zero')
  }
}

/** ビットマスクから seat 配列 (低ビットから昇順) */
function seatsFromMask(mask: number): number[] {
  const out: number[] = []
  while (mask !== 0) {
    const bit = mask & (-mask)
    out.push(31 - Math.clz32(bit))
    mask ^= bit
  }
  return out
}

/** world.roles から mason の seat 配列 */
function masonSeatsFromWorld(world: World): number[] {
  const out: number[] = []
  for (let s = 1; s < world.roleIds.length; s++) {
    if (world.roleIds[s] === RoleBitIndex.mason) out.push(s)
  }
  return out
}

// 関数の re-export
export {
  encodeCollectiveWolfObservation,
  encodeCollectiveMasonObservation,
  encodeFanaticObservation,
  collectObservation,
}
