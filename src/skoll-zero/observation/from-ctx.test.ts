import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../types/index.ts'
import type { World } from '../../hati/types.ts'
import { RoleBitIndex } from '../../retar/possibilities.ts'
import { ATTR, RoleAttributeBits } from '../../hati/role-attributes.ts'
import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import { buildInitialSimState, buildInvariants } from './from-ctx.ts'

function makeWorld(assignments: Record<number, SystemRole>): World {
  const maxSeat = Math.max(...Object.keys(assignments).map(Number))
  const roles: SystemRole[] = new Array(maxSeat + 1)
  const roleIds = new Uint8Array(maxSeat + 1)
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
  for (const [seatStr, role] of Object.entries(assignments)) {
    const seat = Number(seatStr)
    roles[seat] = role
    const bitIdx = RoleBitIndex[role]
    roleIds[seat] = bitIdx
    const attr = RoleAttributeBits[bitIdx]
    const bit = 1 << seat
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

/** 最小限の DecisionContext mock。テストで必要なフィールドだけ埋める */
function makeCtx(overrides: Partial<DecisionContext> = {}): DecisionContext {
  const base: Partial<DecisionContext> = {
    mySeat: 1,
    myRole: 'villager',
    day: 1,
    phase: 'day',
    alivePlayers: [1, 2, 3],
    publicEvents: [],
    signals: [],
    commander: null,
    proposals: [],
    lastExecutedSeat: null,
    retarPossibilities: null,
    maxSurvivingNV: null,
    globalRetarPossibilities: null,
    wolfTeammates: null,
    knownWolves: null,
    knownHamster: null,
    masonPartner: null,
    revoteRound: null,
    revoteCandidates: null,
    executionPlans: [],
    planIndices: null,
    tsumiTarget: null,
    myPlayer: {
      seat: 1, name: 'P1', role: 'villager', alive: true,
      claimedRole: null, claimedDay: null,
      divineHistory: new Map(),
      guardHistory: new Map(),
      fakeDivineHistory: new Map(),
      forecastTarget: null,
    } as DecisionContext['myPlayer'],
    ...overrides,
  }
  return base as DecisionContext
}

describe('buildInitialSimState: claims', () => {
  it('seer_claim を真 seer (世界一致) として claims に入れる', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager' })
    const ctx = makeCtx({
      mySeat: 1, myRole: 'seer',
      publicEvents: [
        { type: 'seer_claim', actor: 1, results: [] },
      ],
    })
    const state = buildInitialSimState(ctx, world)
    const claim = state.claims.get(1)
    assert.equal(claim?.role, 'seer')
    assert.equal(claim?.isFake, false)
  })

  it('seer_claim を偽 seer (世界不一致) として claims に入れる', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager' })
    const ctx = makeCtx({
      publicEvents: [
        { type: 'seer_claim', actor: 2, results: [{ day: 1, target: 1, result: 'wolf' }] },
      ],
    })
    const state = buildInitialSimState(ctx, world)
    const claim = state.claims.get(2)
    assert.equal(claim?.role, 'seer')
    assert.equal(claim?.isFake, true)
    // fakeDivineHistory にも results が積まれる
    const fake = state.fakeDivineHistory.get(2)
    assert.equal(fake?.length, 1)
    assert.equal(fake?.[0].target, 1)
    assert.equal(fake?.[0].color, 'wolf')
  })

  it('mason_claim を世界の mason mask と照合', () => {
    const world = makeWorld({ 1: 'mason', 2: 'mason', 3: 'villager' })
    const ctx = makeCtx({
      publicEvents: [
        { type: 'mason_claim', actor: 1, partner: 2 },
        { type: 'mason_claim', actor: 3, partner: 1 }, // 世界では mason ではない
      ],
    })
    const state = buildInitialSimState(ctx, world)
    assert.equal(state.claims.get(1)?.isFake, false)
    assert.equal(state.claims.get(3)?.isFake, true)
  })

  it('wolf_claim は常に偽 CO として claims に入れる', () => {
    const world = makeWorld({ 1: 'werewolf', 2: 'villager' })
    const ctx = makeCtx({
      publicEvents: [
        { type: 'wolf_claim', actor: 1, claimedRole: 'seer' },
      ],
    })
    const state = buildInitialSimState(ctx, world)
    const claim = state.claims.get(1)
    assert.equal(claim?.role, 'seer')
    assert.equal(claim?.isFake, true)
  })
})

describe('buildInitialSimState: deathLog', () => {
  it('execution / night_kill / curse_kill / follow_kill を deathLog に変換', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const ctx = makeCtx({
      day: 3,
      publicEvents: [
        { type: 'execution', target: 5 },
        { type: 'night_kill', target: 6 },
        { type: 'curse_kill', target: 7 },
        { type: 'follow_kill', target: 8 },
      ],
    })
    const state = buildInitialSimState(ctx, world)
    assert.equal(state.deathLog.length, 4)
    assert.equal(state.deathLog[0].cause, 'execute')
    assert.equal(state.deathLog[1].cause, 'night_kill')
    assert.equal(state.deathLog[2].cause, 'curse')
    assert.equal(state.deathLog[3].cause, 'follow')
  })
})

describe('buildInitialSimState: viewer 私的情報', () => {
  it('viewer=seer なら myPlayer.divineHistory が divineLog に入る', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf' })
    const ctx = makeCtx({
      mySeat: 1, myRole: 'seer',
      myPlayer: {
        seat: 1, name: 'P1', role: 'seer', alive: true,
        claimedRole: null, claimedDay: null,
        divineHistory: new Map([[1, { target: 2, result: 'wolf' }]]),
        guardHistory: new Map(),
        fakeDivineHistory: new Map(),
        forecastTarget: null,
      } as DecisionContext['myPlayer'],
    })
    const state = buildInitialSimState(ctx, world)
    const log = state.divineLog.get(1)
    assert.deepEqual(log, [{ day: 1, target: 2, color: 'wolf' }])
  })

  it('viewer=bodyguard なら myPlayer.guardHistory が guardLog に入る', () => {
    const world = makeWorld({ 1: 'bodyguard', 2: 'werewolf' })
    const ctx = makeCtx({
      mySeat: 1, myRole: 'bodyguard',
      myPlayer: {
        seat: 1, name: 'P1', role: 'bodyguard', alive: true,
        claimedRole: null, claimedDay: null,
        divineHistory: new Map(),
        guardHistory: new Map([[1, 2]]),
        fakeDivineHistory: new Map(),
        forecastTarget: null,
      } as DecisionContext['myPlayer'],
    })
    const state = buildInitialSimState(ctx, world)
    assert.deepEqual(state.guardLog, [{ day: 1, target: 2 }])
  })
})

describe('buildInvariants', () => {
  it('publicEvents 中の vote イベントが voteReceived に集計される', () => {
    const ctx = makeCtx({
      publicEvents: [
        { type: 'vote', voter: 1, target: 3 },
        { type: 'vote', voter: 2, target: 3 },
      ],
    })
    const inv = buildInvariants(ctx)
    assert.equal(inv.signalCounts[2].voteReceived, 2) // seat 3 (index 2)
  })

  it('signal イベントの suspicion / trust が集計される', () => {
    const ctx = makeCtx({
      publicEvents: [
        { type: 'signal', actor: 1, signal: { type: 'suspicion', target: 2 } },
        { type: 'signal', actor: 2, signal: { type: 'trust', target: 3 } },
      ],
    })
    const inv = buildInvariants(ctx)
    assert.equal(inv.signalCounts[1].suspicion, 1) // seat 2
    assert.equal(inv.signalCounts[2].trust, 1) // seat 3
  })

  it('demand_wolf_co の累積が集計される', () => {
    const ctx = makeCtx({
      publicEvents: [
        { type: 'signal', actor: 1, signal: { type: 'demand_wolf_co' } },
        { type: 'signal', actor: 2, signal: { type: 'demand_wolf_co' } },
      ],
    })
    const inv = buildInvariants(ctx)
    assert.equal(inv.demandWolfCoCount, 2)
  })

  it('retar / tsumi / commander / planIndices は ctx からそのまま', () => {
    const retar = new Map<number, Set<SystemRole>>([[1, new Set(['villager'])]])
    const ctx = makeCtx({
      retarPossibilities: retar,
      tsumiTarget: 5,
      commander: 7,
      planIndices: [1, 2, 3],
    })
    const inv = buildInvariants(ctx)
    assert.equal(inv.retarPossibilities, retar)
    assert.equal(inv.tsumiTarget, 5)
    assert.equal(inv.commander, 7)
    assert.deepEqual(inv.planIndices, [1, 2, 3])
  })

  it('rope margin = (alive-1)/2 - maxSurvivingNV', () => {
    const ctx = makeCtx({
      alivePlayers: [1, 2, 3, 4, 5, 6, 7], // 7 alive
      maxSurvivingNV: 2,
    })
    const inv = buildInvariants(ctx)
    assert.equal(inv.ropeMargin, 3 - 2) // (7-1)/2 - 2 = 1
  })
})
