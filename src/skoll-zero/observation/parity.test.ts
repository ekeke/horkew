/**
 * ctx 経路 (encodeObservation) と SimState 経路 (encodeFromSimState) の
 * obs バイト一致テスト。
 *
 * Stage 3 着手前のレグレッションガード。
 * 既知の発散領域 (KNOWN_DIVERGENT_RANGES) はマスクして比較し、それ以外で
 * バイト完全一致を要求する。マスクが live であることは負例テストで確認する。
 *
 * ## 既知の発散領域 (Stage 2 範囲外)
 *
 * - **D1: revote** — SimState 側はハードコード `round: 0, candidates: []`
 * - **D2: history 全領域 (210 bytes)** — ctx 経路はイベントを「全 3 windows に
 *   smear」（イベント自体に day 情報が無いため）、SimState 経路は deathLog.day で
 *   厳密に振り分ける。両者は構造的に一致しない。さらに vote target / claim /
 *   signal の各列は SimState 経路では未実装。
 * - **D3: 真 seer の publicly visible CO results** — buildInitialSimState が
 *   isFake=false 時に results を divineLog に push しないため、viewer 以外の
 *   真 seer CO による black/white カウントが SimState 側で 0 になる
 *
 * 詳細: tasks/todo.md "skoll-zero obs parity gap" / project_skoll_zero_obs_parity_gap.md
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole, EnumSpecies } from '../../types/index.ts'
import type { World } from '../../hati/types.ts'
import { RoleBitIndex } from '../../retar/possibilities.ts'
import { ATTR, RoleAttributeBits } from '../../hati/role-attributes.ts'
import type { DecisionContext, TeamDecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { PlayerState } from '../../lupa/types.ts'
import type { FenrirEvent } from '../../fenrir/src/events.ts'
import { Rng } from '../../lupa/random.ts'

import {
  encodeObservation,
  encodeCollectiveWolfObservation,
  encodeCollectiveMasonObservation,
  encodeFanaticObservation,
  SEATS,
  HISTORY_START, HISTORY_SIZE,
  REVOTE_START, REVOTE_SIZE,
  PER_SEAT_START, PER_SEAT_SIZE,
  BLACK_OFFSET_IN_SEAT, WHITE_OFFSET_IN_SEAT,
} from '../../fenrir/src/observation.ts'

import { buildInitialSimState, buildInvariants } from './from-ctx.ts'
import {
  encodeIndividualFromSimState,
  encodeMasonCollectiveFromSimState,
  encodeWolfCollectiveFromSimState,
  encodeFanaticFromSimState,
} from './from-sim-state.ts'

// ============================================================
// 既知の発散領域
// ============================================================

/** D1: revote 範囲 (REVOTE_START から REVOTE_SIZE バイト) */
function revoteByteRange(): number[] {
  const out: number[] = []
  for (let i = 0; i < REVOTE_SIZE; i++) out.push(REVOTE_START + i)
  return out
}

/** D2: history 全領域 — ctx 経路の smear 仕様と SimState 経路の day-specific 仕様が
 *  根本的に異なるため、execute/kill 列も含め全 210 bytes が発散しうる */
function historyByteRange(): number[] {
  const out: number[] = []
  for (let i = 0; i < HISTORY_SIZE; i++) out.push(HISTORY_START + i)
  return out
}

/** D3: 真 seer (viewer ≠ actor) の publicly visible CO 由来 black/white カウント */
function trueSeerPublicCOByteRange(
  events: readonly FenrirEvent[], world: World, viewerSeat: number,
): number[] {
  const out: number[] = []
  const seenTargets = new Set<number>()
  const recordTarget = (target: number) => {
    if (target < 1 || target > SEATS) return
    if (seenTargets.has(target)) return
    seenTargets.add(target)
    const base = PER_SEAT_START + (target - 1) * PER_SEAT_SIZE
    out.push(base + BLACK_OFFSET_IN_SEAT, base + WHITE_OFFSET_IN_SEAT)
  }
  for (const ev of events) {
    if (ev.type === 'seer_claim'
      && world.roles[ev.actor] === 'seer'
      && ev.actor !== viewerSeat) {
      for (const r of ev.results) recordTarget(r.target)
    }
    if (ev.type === 'seer_result'
      && world.roles[ev.actor] === 'seer'
      && ev.actor !== viewerSeat) {
      recordTarget(ev.target)
    }
  }
  return out
}

function divergentByteIndices(opts: {
  events: readonly FenrirEvent[]
  world: World
  viewerSeat: number
}): Set<number> {
  const s = new Set<number>()
  for (const i of revoteByteRange()) s.add(i)
  for (const i of historyByteRange()) s.add(i)
  for (const i of trueSeerPublicCOByteRange(opts.events, opts.world, opts.viewerSeat)) s.add(i)
  return s
}

// ============================================================
// 比較ヘルパー
// ============================================================

function assertParity(
  obsCtx: Float32Array, obsSim: Float32Array, divergent: Set<number>, label: string,
): void {
  assert.equal(obsCtx.length, obsSim.length, `${label}: obs lengths differ`)
  const mismatches: Array<{ idx: number, ctx: number, sim: number }> = []
  for (let i = 0; i < obsCtx.length; i++) {
    if (divergent.has(i)) continue
    if (obsCtx[i] !== obsSim[i]) {
      mismatches.push({ idx: i, ctx: obsCtx[i], sim: obsSim[i] })
      if (mismatches.length >= 5) break
    }
  }
  if (mismatches.length > 0) {
    const detail = mismatches.map(m => `byte ${m.idx}: ctx=${m.ctx} sim=${m.sim}`).join('; ')
    assert.fail(`${label}: parity 違反 (発散範囲外で値が違う) — ${detail}`)
  }
}

function assertActuallyDiverges(
  obsCtx: Float32Array, obsSim: Float32Array, candidate: Iterable<number>, label: string,
): void {
  for (const i of candidate) {
    if (obsCtx[i] !== obsSim[i]) return
  }
  assert.fail(`${label}: 発散範囲のどのバイトも一致してしまっている。SimState 側の実装が進んだ可能性 — KNOWN_DIVERGENT_RANGES から外す検討を`)
}

// ============================================================
// World / Player / Scenario builder
// ============================================================

function makeWorld(assignments: Record<number, SystemRole>): World {
  const roles: SystemRole[] = new Array(SEATS + 1).fill('villager')
  const roleIds = new Uint8Array(SEATS + 1)
  for (let s = 1; s <= SEATS; s++) {
    roles[s] = assignments[s] ?? 'villager'
    roleIds[s] = RoleBitIndex[roles[s]]
  }
  let wolfFactionMask = 0
  let foxFactionMask = 0
  let attackCapableMask = 0
  let divineCapableMask = 0
  let guardCapableMask = 0
  let attackImmuneMask = 0
  let dieWhenDivinedMask = 0
  let curseOnExecutedMask = 0
  let curseOnKilledMask = 0
  let followFoxDeathMask = 0
  let mediumshipMask = 0
  for (let s = 1; s <= SEATS; s++) {
    const attr = RoleAttributeBits[roleIds[s]]
    const bit = 1 << s
    if (attr & ATTR.WOLF_FACTION)                wolfFactionMask |= bit
    if (attr & ATTR.FOX_FACTION)                 foxFactionMask |= bit
    if (attr & ATTR.ACTION_ATTACK)               attackCapableMask |= bit
    if (attr & ATTR.ACTION_DIVINE)               divineCapableMask |= bit
    if (attr & ATTR.ACTION_GUARD)                guardCapableMask |= bit
    if (attr & ATTR.PASSIVE_ATTACK_IMMUNE)       attackImmuneMask |= bit
    if (attr & ATTR.PASSIVE_DIE_WHEN_DIVINED)    dieWhenDivinedMask |= bit
    if (attr & ATTR.REACTIVE_CURSE_ON_EXECUTED)  curseOnExecutedMask |= bit
    if (attr & ATTR.REACTIVE_CURSE_ON_KILLED)    curseOnKilledMask |= bit
    if (attr & ATTR.REACTIVE_FOLLOW_FOX_DEATH)   followFoxDeathMask |= bit
    if (attr & ATTR.AUTO_INFO_EXECUTION_SPECIES) mediumshipMask |= bit
  }
  return {
    roles, roleIds,
    wolfFactionMask, foxFactionMask,
    attackCapableMask, divineCapableMask, guardCapableMask,
    attackImmuneMask, dieWhenDivinedMask,
    curseOnExecutedMask, curseOnKilledMask, followFoxDeathMask,
    mediumshipMask,
  }
}

function makePlayer(seat: number, role: SystemRole, opts: {
  divineHistory?: Map<number, { target: number, result: EnumSpecies }>
  guardHistory?: Map<number, number>
  fakeDivineHistory?: Map<number, { target: number, result: EnumSpecies }>
  alive?: boolean
} = {}): PlayerState {
  return {
    seat, name: `P${seat}`, role,
    alive: opts.alive ?? true,
    claimedRole: null, claimedDay: null,
    divineHistory: opts.divineHistory ?? new Map(),
    guardHistory: opts.guardHistory ?? new Map(),
    fakeDivineHistory: opts.fakeDivineHistory ?? new Map(),
    forecastTarget: null,
  }
}

type ScenarioInput = {
  name: string
  assignments: Record<number, SystemRole>
  viewerSeat: number
  alive: number[]
  day: number
  phase?: 'day' | 'night'
  events?: FenrirEvent[]
  commander?: number | null
  retar?: Map<number, Set<SystemRole>> | null
  globalRetar?: Map<number, Set<SystemRole>> | null
  tsumiTarget?: number | null
  maxSurvivingNV?: number | null
  planIndices?: number[] | null
  myDivineHistory?: Map<number, { target: number, result: EnumSpecies }>
  myGuardHistory?: Map<number, number>
  myFakeDivineHistory?: Map<number, { target: number, result: EnumSpecies }>
  /** collective モード時のチームメンバー (mason 2 席 / wolf 全員 等) */
  teamSeats?: number[]
  /** collective モード時の各チームメンバーの fakeDivineHistory */
  teamFakeHistories?: Map<number, Map<number, { target: number, result: EnumSpecies }>>
}

function buildScenario(s: ScenarioInput): {
  ctx: DecisionContext
  teamCtx: TeamDecisionContext
  world: World
  divergent: Set<number>
} {
  const world = makeWorld(s.assignments)
  const viewerRole = world.roles[s.viewerSeat]

  const wolfSeats: number[] = []
  for (let m = world.attackCapableMask; m !== 0; ) {
    const bit = m & (-m)
    wolfSeats.push(31 - Math.clz32(bit))
    m ^= bit
  }
  const wolfTeammates = viewerRole === 'werewolf'
    ? wolfSeats.filter(w => w !== s.viewerSeat) : null
  const knownWolves = viewerRole === 'fanatic' ? wolfSeats : null
  let masonPartner: number | null = null
  if (viewerRole === 'mason') {
    for (let seat = 1; seat <= SEATS; seat++) {
      if (seat !== s.viewerSeat && world.roles[seat] === 'mason') {
        masonPartner = seat
        break
      }
    }
  }
  let knownHamster: number | null = null
  if (viewerRole === 'immoralist' && world.dieWhenDivinedMask !== 0) {
    const bit = world.dieWhenDivinedMask & (-world.dieWhenDivinedMask)
    knownHamster = 31 - Math.clz32(bit)
  }

  const myPlayer = makePlayer(s.viewerSeat, viewerRole, {
    divineHistory: s.myDivineHistory,
    guardHistory: s.myGuardHistory,
    fakeDivineHistory: s.myFakeDivineHistory,
  })

  const events = s.events ?? []

  const ctx: DecisionContext = {
    mySeat: s.viewerSeat,
    myRole: viewerRole,
    myPlayer,
    day: s.day,
    phase: s.phase ?? 'day',
    alivePlayers: s.alive,
    publicEvents: events,
    signals: [],
    commander: s.commander ?? null,
    proposals: [],
    rng: new Rng(1),
    gameState: undefined as unknown as DecisionContext['gameState'],
    lastExecutedSeat: null,
    retarPossibilities: s.retar ?? null,
    maxSurvivingNV: s.maxSurvivingNV ?? null,
    globalRetarPossibilities: s.globalRetar ?? null,
    wolfTeammates, knownWolves, knownHamster, masonPartner,
    revoteRound: null,
    revoteCandidates: null,
    executionPlans: [],
    planIndices: s.planIndices ?? null,
    tsumiTarget: s.tsumiTarget ?? null,
    rules: {} as DecisionContext['rules'],
  }

  const teamSeats = s.teamSeats ?? []
  const teamFakeHistories = s.teamFakeHistories ?? new Map()
  const teamPlayers: PlayerState[] = teamSeats.map(seat => makePlayer(
    seat, world.roles[seat],
    { fakeDivineHistory: teamFakeHistories.get(seat) },
  ))
  const teamCtx: TeamDecisionContext = {
    ...ctx,
    teamSeats, teamPlayers,
    currentActorSeat: s.viewerSeat,
  }

  const divergent = divergentByteIndices({ events, world, viewerSeat: s.viewerSeat })

  return { ctx, teamCtx, world, divergent }
}

// ============================================================
// 共通シナリオ — 14d-neko 構成
// ============================================================

const NEKO_14D: Record<number, SystemRole> = {
  1: 'mason', 2: 'mason', 3: 'seer', 4: 'medium', 5: 'bodyguard', 6: 'nekomata',
  7: 'villager', 8: 'villager', 9: 'villager', 10: 'villager',
  11: 'werewolf', 12: 'werewolf', 13: 'werewolf',
  14: 'werehamster',
}

/** 全シナリオ共通: day 5 (history window=days 3-5)、retar/tsumi/plan 全部入り */
function richExtras(): {
  retar: Map<number, Set<SystemRole>>
  globalRetar: Map<number, Set<SystemRole>>
  tsumiTarget: number
  planIndices: number[]
  maxSurvivingNV: number
} {
  const retar = new Map<number, Set<SystemRole>>()
  retar.set(3, new Set<SystemRole>(['seer', 'villager']))
  retar.set(11, new Set<SystemRole>(['werewolf']))
  const globalRetar = new Map<number, Set<SystemRole>>()
  globalRetar.set(11, new Set<SystemRole>(['werewolf', 'villager']))
  return {
    retar, globalRetar,
    tsumiTarget: 11,
    planIndices: [5, 1, 12, 2, 13, 3, 21, 21, 8, 9, 10, 11],
    maxSurvivingNV: 1,
  }
}

// ============================================================
// シナリオ群
// ============================================================

describe('parity (individual obs)', () => {
  it('mason viewer: 真偽 seer CO + execution + retar/tsumi/plan で発散範囲外がバイト一致', () => {
    const { retar, globalRetar, tsumiTarget, planIndices, maxSurvivingNV } = richExtras()
    const events: FenrirEvent[] = [
      // execution と night_kill は history execute/kill 列に乗る (D2 対象外)
      { type: 'execution', target: 9 },
      { type: 'night_kill', target: 4 },
    ]
    const { ctx, world, divergent } = buildScenario({
      name: 'mason-rich', assignments: NEKO_14D, viewerSeat: 1,
      alive: [1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 14],
      day: 5, events, commander: 3,
      retar, globalRetar, tsumiTarget, planIndices, maxSurvivingNV,
    })
    const state = buildInitialSimState(ctx, world)
    const inv = buildInvariants(ctx)
    const obsCtx = encodeObservation(ctx)
    const obsSim = encodeIndividualFromSimState(state, 1, 'mason', inv)
    assertParity(obsCtx, obsSim, divergent, 'mason-rich')
  })

  it('seer viewer: 自分の divineHistory と CO event がある場合、二重カウントしない', () => {
    const myDivine = new Map<number, { target: number, result: EnumSpecies }>([
      [1, { target: 11, result: 'wolf' }],
      [2, { target: 12, result: 'wolf' }],
    ])
    const events: FenrirEvent[] = [
      // viewer (seat 3) 自身の seer CO — divineHistory 由来と重複しないこと
      { type: 'seer_claim', actor: 3, results: [
        { day: 1, target: 11, result: 'wolf' as EnumSpecies },
        { day: 2, target: 12, result: 'wolf' as EnumSpecies },
      ] },
    ]
    const { ctx, world, divergent } = buildScenario({
      name: 'seer-self-co', assignments: NEKO_14D, viewerSeat: 3,
      alive: [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      day: 3, events, myDivineHistory: myDivine,
    })
    const state = buildInitialSimState(ctx, world)
    const inv = buildInvariants(ctx)
    const obsCtx = encodeObservation(ctx)
    const obsSim = encodeIndividualFromSimState(state, 3, 'seer', inv)
    assertParity(obsCtx, obsSim, divergent, 'seer-self-co')
  })

  it('werewolf viewer: 偽 seer CO 持ち、wolfTeammates と fakeDivine 整合', () => {
    const events: FenrirEvent[] = [
      { type: 'seer_claim', actor: 11, results: [
        { day: 1, target: 7, result: 'wolf' as EnumSpecies },
      ] },
      { type: 'execution', target: 9 },
    ]
    const { ctx, world, divergent } = buildScenario({
      name: 'wolf-fake-seer', assignments: NEKO_14D, viewerSeat: 11,
      alive: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14],
      day: 3, events,
    })
    const state = buildInitialSimState(ctx, world)
    const inv = buildInvariants(ctx)
    const obsCtx = encodeObservation(ctx)
    const obsSim = encodeIndividualFromSimState(state, 11, 'werewolf', inv)
    assertParity(obsCtx, obsSim, divergent, 'wolf-fake-seer')
  })

  it('fanatic viewer: knownWolves 整合', () => {
    const assignments = { ...NEKO_14D, 14: 'fanatic' as SystemRole }
    delete (assignments as Record<number, SystemRole>)[14]
    assignments[14] = 'fanatic'
    const events: FenrirEvent[] = [{ type: 'execution', target: 9 }]
    const { ctx, world, divergent } = buildScenario({
      name: 'fanatic', assignments, viewerSeat: 14,
      alive: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14],
      day: 2, events,
    })
    const state = buildInitialSimState(ctx, world)
    const inv = buildInvariants(ctx)
    const obsCtx = encodeObservation(ctx)
    const obsSim = encodeIndividualFromSimState(state, 14, 'fanatic', inv)
    assertParity(obsCtx, obsSim, divergent, 'fanatic')
  })

  it('immoralist viewer: knownHamster 整合', () => {
    const assignments = { ...NEKO_14D }
    assignments[10] = 'immoralist'
    const events: FenrirEvent[] = []
    const { ctx, world, divergent } = buildScenario({
      name: 'immoralist', assignments, viewerSeat: 10,
      alive: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      day: 1, events,
    })
    const state = buildInitialSimState(ctx, world)
    const inv = buildInvariants(ctx)
    const obsCtx = encodeObservation(ctx)
    const obsSim = encodeIndividualFromSimState(state, 10, 'immoralist', inv)
    assertParity(obsCtx, obsSim, divergent, 'immoralist')
  })

  it('bodyguard viewer: guardHistory が一致', () => {
    const guard = new Map<number, number>([[1, 3], [2, 3]])
    const events: FenrirEvent[] = [{ type: 'execution', target: 11 }]
    const { ctx, world, divergent } = buildScenario({
      name: 'bodyguard', assignments: NEKO_14D, viewerSeat: 5,
      alive: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14],
      day: 3, events, myGuardHistory: guard,
    })
    const state = buildInitialSimState(ctx, world)
    const inv = buildInvariants(ctx)
    const obsCtx = encodeObservation(ctx)
    const obsSim = encodeIndividualFromSimState(state, 5, 'bodyguard', inv)
    assertParity(obsCtx, obsSim, divergent, 'bodyguard')
  })
})

// ============================================================
// collective / fanatic 観測モード
// ============================================================

describe('parity (mason_collective)', () => {
  it('mason viewer + teamSeats=[partner] でバイト一致', () => {
    const events: FenrirEvent[] = [{ type: 'execution', target: 9 }]
    const { teamCtx, world, divergent } = buildScenario({
      name: 'mason-team', assignments: NEKO_14D, viewerSeat: 1,
      alive: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14],
      day: 2, events, teamSeats: [1, 2],
    })
    const state = buildInitialSimState(teamCtx, world)
    const inv = buildInvariants(teamCtx)
    const obsCtx = encodeCollectiveMasonObservation(teamCtx)
    const obsSim = encodeMasonCollectiveFromSimState(state, 1, 'mason', inv)
    assertParity(obsCtx, obsSim, divergent, 'mason-collective')
  })
})

describe('parity (wolf_collective)', () => {
  it('wolf viewer + teamSeats=全狼 + fake_divine 整合', () => {
    const events: FenrirEvent[] = [
      { type: 'seer_claim', actor: 11, results: [
        { day: 1, target: 7, result: 'wolf' as EnumSpecies },
        { day: 2, target: 1, result: 'human' as EnumSpecies },
      ] },
    ]
    const teamFakeHistories = new Map<number, Map<number, { target: number, result: EnumSpecies }>>()
    teamFakeHistories.set(11, new Map([
      [1, { target: 7, result: 'wolf' as EnumSpecies }],
      [2, { target: 1, result: 'human' as EnumSpecies }],
    ]))
    const { teamCtx, world, divergent } = buildScenario({
      name: 'wolf-team', assignments: NEKO_14D, viewerSeat: 11,
      alive: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      day: 3, events, teamSeats: [11, 12, 13],
      teamFakeHistories,
      myFakeDivineHistory: teamFakeHistories.get(11),
    })
    const state = buildInitialSimState(teamCtx, world)
    const inv = buildInvariants(teamCtx)
    const obsCtx = encodeCollectiveWolfObservation(teamCtx)
    const obsSim = encodeWolfCollectiveFromSimState(state, 11, 'werewolf', inv)
    assertParity(obsCtx, obsSim, divergent, 'wolf-collective')
  })
})

describe('parity (fanatic obs)', () => {
  it('fanatic viewer 個人観測 + village_predict/trust 注入なしで一致', () => {
    const assignments = { ...NEKO_14D }
    assignments[14] = 'fanatic'
    const events: FenrirEvent[] = [{ type: 'execution', target: 9 }]
    const { ctx, world, divergent } = buildScenario({
      name: 'fanatic-team', assignments, viewerSeat: 14,
      alive: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14],
      day: 2, events,
    })
    const state = buildInitialSimState(ctx, world)
    const inv = buildInvariants(ctx)
    const obsCtx = encodeFanaticObservation(ctx)
    const obsSim = encodeFanaticFromSimState(state, 14, 'fanatic', inv)
    assertParity(obsCtx, obsSim, divergent, 'fanatic-obs')
  })
})

// ============================================================
// 負例テスト — マスクが live (発散が実在) であることを確認
// ============================================================

describe('parity negative: 発散範囲は実際に発散している (マスクの live 確認)', () => {
  it('D1: revoteRound != null の ctx で revote 範囲がバイト不一致', () => {
    const { ctx, world } = buildScenario({
      name: 'revote', assignments: NEKO_14D, viewerSeat: 1,
      alive: [1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 14],
      day: 3, events: [],
    })
    ctx.revoteRound = 1
    ctx.revoteCandidates = [11, 12]
    const state = buildInitialSimState(ctx, world)
    const inv = buildInvariants(ctx)
    const obsCtx = encodeObservation(ctx)
    const obsSim = encodeIndividualFromSimState(state, 1, 'mason', inv)
    assertActuallyDiverges(obsCtx, obsSim, revoteByteRange(), 'D1 (revote)')
  })

  it('D2: history window 内の vote イベントで history 列 0 が不一致', () => {
    const events: FenrirEvent[] = [
      { type: 'vote', voter: 1, target: 11 },
      { type: 'vote', voter: 2, target: 11 },
    ]
    const { ctx, world } = buildScenario({
      name: 'history-vote', assignments: NEKO_14D, viewerSeat: 1,
      alive: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      day: 1, events,
    })
    const state = buildInitialSimState(ctx, world)
    const inv = buildInvariants(ctx)
    const obsCtx = encodeObservation(ctx)
    const obsSim = encodeIndividualFromSimState(state, 1, 'mason', inv)
    assertActuallyDiverges(obsCtx, obsSim, historyByteRange(), 'D2 (history vote/claim/signal)')
  })

  it('D3: viewer != 真 seer の seer_claim で対象 seat の black/white が不一致', () => {
    const events: FenrirEvent[] = [
      { type: 'seer_claim', actor: 3, results: [
        { day: 1, target: 11, result: 'wolf' as EnumSpecies },
        { day: 2, target: 7, result: 'human' as EnumSpecies },
      ] },
    ]
    const { ctx, world } = buildScenario({
      name: 'true-seer-public-co', assignments: NEKO_14D, viewerSeat: 1,
      alive: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      day: 3, events,
    })
    const state = buildInitialSimState(ctx, world)
    const inv = buildInvariants(ctx)
    const obsCtx = encodeObservation(ctx)
    const obsSim = encodeIndividualFromSimState(state, 1, 'mason', inv)
    assertActuallyDiverges(
      obsCtx, obsSim,
      trueSeerPublicCOByteRange(events, world, 1),
      'D3 (non-viewer true seer CO)',
    )
  })
})
