/**
 * SimState → VillageStatus 変換 + Retar 再実行ヘルパ。
 *
 * skoll-zero MCTS rollout 中、確定 world に基づいて Retar を再呼び出しすることで
 * 「rollout 中の推理進行」を NN 観測に反映する。root snapshot の固定 Possibilities
 * では rollout 後半で死亡情報や占い結果が反映されず、判断品質が低下する。
 *
 * パフォーマンス想定: WASM Retar 0.3-1ms/呼び出し、1 game ~4200 expand → 数秒/game。
 */

import type { SystemRole, Seat, VillageStatus, SeatStatus, CauseOfDeath, Assertion } from '../../types/index.ts'
import type { SimState, DeathCause } from '../simulator/world-state.ts'
import { hasSeat } from '../../hati/types.ts'
import { lupaRunRetar, DEFAULT_RETAR_OPTIONS } from '../../fenrir/src/retar-bridge.ts'
import type { AnalyzeOptions } from '../../retar/index.ts'
import { Possibilities } from '../../retar/possibilities.ts'
import { BENCH_ENABLED, benchEnd } from '../bench/profiler.ts'

/** SimState.deathLog の DeathCause → CauseOfDeath (lupa types) */
function mapDeathCause(cause: DeathCause): CauseOfDeath {
  switch (cause) {
    case 'execute': return 'execution'
    case 'night_kill': return 'night_kill'
    case 'follow': return 'follow_killed_hamster'
    case 'curse': return 'cursed_by_executed_nekomata'
    case 'nekomata_revenge': return 'cursed_by_killed_nekomata'
  }
}

/** SimState の outcome → VillageResult */
function outcomeToResult(outcome: SimState['outcome']): VillageStatus['result'] {
  switch (outcome) {
    case 'village_win': return 'villager_won'
    case 'wolf_win': return 'werewolf_won'
    case 'hamster_win': return 'werehamster_won'
    case 'ongoing': return undefined
    case null: return undefined
    default: return undefined
  }
}

/** world.roles から setup (役職別人数) を導出 */
export function setupFromWorld(world: SimState['world']): Map<SystemRole, number> {
  const setup = new Map<SystemRole, number>()
  for (let seat = 1; seat < world.roles.length; seat++) {
    const role = world.roles[seat]
    if (!role) continue
    setup.set(role, (setup.get(role) ?? 0) + 1)
  }
  return setup
}

/**
 * SimState を Retar 入力可能な VillageStatus に変換する。
 *
 * - statuses: alive bitmask + claims + 占い履歴 (divineLog / fakeDivineHistory) から組み立て
 * - claims: claims map を role 別に逆引き
 * - executions / kills: deathLog から day 別に分類
 * - voteHistory: voteLog から day 別に分類 (Stage 5+ 用、現状は空)
 * - roles (真役職): assumption として渡すため空 Map (viewer 視点で別途設定)
 */
export function simStateToVillageStatus(state: SimState): VillageStatus {
  const t0 = BENCH_ENABLED ? performance.now() : 0
  const statuses = new Map<number, SeatStatus>()
  const totalSeats = state.world.roles.length - 1

  // 元から不在の seat は state.world.roles[seat] が undefined。世界に登場する seat のみを対象に。
  for (let seat = 1; seat <= totalSeats; seat++) {
    if (!state.world.roles[seat]) continue

    const surviving = hasSeat(state.alive, seat)
    const claim = state.claims.get(seat)

    let causeOfDeath: CauseOfDeath = 'execution'
    let diedDay: number | undefined
    if (!surviving) {
      const death = state.deathLog.find(e => e.seat === seat)
      if (death) {
        causeOfDeath = mapDeathCause(death.cause)
        diedDay = death.day
      }
    }

    // 占い宣言: claim が seer なら、対応する真/偽 log を assertions に変換
    const assertions = new Map<number, Assertion>()
    if (claim?.role === 'seer') {
      const log = claim.isFake
        ? state.fakeDivineHistory.get(seat)
        : state.divineLog.get(seat)
      if (log) {
        for (const e of log) {
          assertions.set(e.day, { target: e.target, species: e.color })
        }
      }
    }

    statuses.set(seat, {
      surviving,
      causeOfDeath,
      survivedDays: diedDay !== undefined ? diedDay - 1 : state.day,
      diedDay,
      voted: false,
      claiming: !!claim,
      claimingRole: claim?.role ?? '',
      deniedRoles: [],
      votedCount: 0,
      votedTarget: 0,
      votedOrder: 0,
      actions: new Map(),
      assertions,
      forecasts: new Map(),
    })
  }

  const claims = new Map<SystemRole | number, number[]>()
  for (const [seat, claim] of state.claims) {
    const list = claims.get(claim.role) ?? []
    list.push(seat)
    claims.set(claim.role, list)
  }

  const executions = new Map<number, number[]>()
  const kills = new Map<number, number[]>()
  for (const e of state.deathLog) {
    if (e.cause === 'execute') {
      const list = executions.get(e.day) ?? []
      list.push(e.seat)
      executions.set(e.day, list)
    } else {
      const list = kills.get(e.day) ?? []
      list.push(e.seat)
      kills.set(e.day, list)
    }
  }

  const voteHistory = new Map<number, { voter: Seat, target: Seat }[]>()
  for (const e of state.voteLog) {
    const list = voteHistory.get(e.day) ?? []
    list.push({ voter: e.voter, target: e.target })
    voteHistory.set(e.day, list)
  }

  const result: VillageStatus = {
    statuses,
    executions,
    kills,
    roles: new Map(),
    claims,
    voteHistory,
    revoteTargets: new Set(),
    voteFinalRule: 'revote',
    hasMultiVote: false,
    multiVoteDays: new Set(),
    day: state.day,
    finished: state.outcome != null && state.outcome !== 'ongoing',
    result: outcomeToResult(state.outcome),
  }
  if (BENCH_ENABLED) benchEnd('vs_build', t0)
  return result
}

/**
 * 既構築の VillageStatus + setup から Retar を実行する低レベル API。
 * 同じ SimState から global / viewer 両方の Retar を呼ぶときに VS 構築を 1 回化するために使う。
 */
export function runRetarOnVillageStatus(
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
  viewerSeat?: number,
  viewerRole?: SystemRole,
): Map<number, Set<SystemRole>> {
  const assumptions = new Map<number, SystemRole>()
  if (viewerSeat !== undefined && viewerRole !== undefined) {
    assumptions.set(viewerSeat, viewerRole)
  }
  const options: AnalyzeOptions = {
    ...DEFAULT_RETAR_OPTIONS,
    assumptions,
  }
  const t0 = BENCH_ENABLED ? performance.now() : 0
  const possibilities: Possibilities = lupaRunRetar(vs, setup, options)
  if (BENCH_ENABLED) benchEnd('retar_wasm', t0)
  const t1 = BENCH_ENABLED ? performance.now() : 0
  const result = possibilitiesToMap(possibilities)
  if (BENCH_ENABLED) benchEnd('retar_to_map', t1)
  return result
}

/**
 * SimState から Retar を実行し、各 seat の役職可能性を返す (VS 構築を内包)。
 * 単発呼び出し用ラッパ。同 SimState から global+viewer の 2 系統を呼ぶ場合は
 * `simStateToVillageStatus` + `runRetarOnVillageStatus` を直接使って VS 構築を 1 回化すべき。
 *
 * @param state SimState
 * @param setup 配役。省略時は world から導出
 * @param viewerSeat viewer の seat (assumption として viewerRole を渡す場合)
 * @param viewerRole viewer の真役職 (世界由来、assumption に固定)
 * @returns Map<seat, Set<role>> ─ retarPossibilities と互換
 */
export function runRetarOnSimState(
  state: SimState,
  setup?: Map<SystemRole, number>,
  viewerSeat?: number,
  viewerRole?: SystemRole,
): Map<number, Set<SystemRole>> {
  const resolvedSetup = setup ?? setupFromWorld(state.world)
  const vs = simStateToVillageStatus(state)
  return runRetarOnVillageStatus(vs, resolvedSetup, viewerSeat, viewerRole)
}

/** Possibilities インスタンス → Map<seat, Set<role>> 変換 */
function possibilitiesToMap(p: Possibilities): Map<number, Set<SystemRole>> {
  const out = new Map<number, Set<SystemRole>>()
  for (let seat = 1; seat < p.possibilities.length; seat++) {
    const bits = p.possibilities[seat]
    if (bits === 0) continue
    const roles = new Set<SystemRole>()
    // RoleBitIndex 順で各 bit をチェック
    if (bits & (1 << 0)) roles.add('werewolf')
    if (bits & (1 << 1)) roles.add('possessed')
    if (bits & (1 << 2)) roles.add('fanatic')
    if (bits & (1 << 3)) roles.add('werehamster')
    if (bits & (1 << 4)) roles.add('immoralist')
    if (bits & (1 << 5)) roles.add('villager')
    if (bits & (1 << 6)) roles.add('seer')
    if (bits & (1 << 7)) roles.add('medium')
    if (bits & (1 << 8)) roles.add('bodyguard')
    if (bits & (1 << 9)) roles.add('mason')
    if (bits & (1 << 10)) roles.add('nekomata')
    if (roles.size > 0) out.set(seat, roles)
  }
  return out
}

