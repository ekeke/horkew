/**
 * Wolf imitation observation builder の test。
 *
 * 検証項目:
 * - viewerRoleForFakeClaimPhase / viewerRoleForFakeClaimMode の mapping
 * - buildVirtualViewerObs が seer / medium / bodyguard / nekomata 各 viewer で
 *   crash せずに observation (1029 dim) を生成できる (FW3: 多役職 imitation)
 * - viewer role を変えると obs の内容が変わることの sanity check
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { SystemRole } from '../../types/index.ts'
import type { World } from '../../hati/types.ts'
import { RoleBitIndex } from '../../retar/possibilities.ts'
import { ATTR, RoleAttributeBits } from '../../hati/role-attributes.ts'
import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import { buildInitialSimState, buildInvariants } from './from-ctx.ts'
import { OBSERVATION_SIZE } from '../../fenrir/src/observation.ts'
import {
  buildVirtualViewerObs,
  viewerRoleForFakeClaimPhase,
  viewerRoleForFakeClaimMode,
} from './wolf-imitation.ts'

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

function makeCtx(overrides: Partial<DecisionContext> = {}): DecisionContext {
  const base: Partial<DecisionContext> = {
    mySeat: 1,
    myRole: 'werewolf',
    day: 1,
    phase: 'day',
    alivePlayers: [1, 2, 3, 4, 5],
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
      seat: 1, name: 'P1', role: 'werewolf', alive: true,
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

describe('viewerRoleForFakeClaimPhase', () => {
  it('claim_seer_fake → seer', () => {
    assert.equal(viewerRoleForFakeClaimPhase('claim_seer_fake'), 'seer')
  })
  it('claim_medium_fake → medium', () => {
    assert.equal(viewerRoleForFakeClaimPhase('claim_medium_fake'), 'medium')
  })
  it('claim_bg_fake → bodyguard', () => {
    assert.equal(viewerRoleForFakeClaimPhase('claim_bg_fake'), 'bodyguard')
  })
  it('claim_nekomata_fake → nekomata', () => {
    assert.equal(viewerRoleForFakeClaimPhase('claim_nekomata_fake'), 'nekomata')
  })
  it('morning は seer (占い結果のため)', () => {
    assert.equal(viewerRoleForFakeClaimPhase('morning'), 'seer')
  })
  it('non-fake phase は null', () => {
    assert.equal(viewerRoleForFakeClaimPhase('day'), null)
    assert.equal(viewerRoleForFakeClaimPhase('night_attack'), null)
    assert.equal(viewerRoleForFakeClaimPhase('claim_seer_true'), null)
    assert.equal(viewerRoleForFakeClaimPhase('claim_mason'), null)
    assert.equal(viewerRoleForFakeClaimPhase('terminal'), null)
  })
})

describe('viewerRoleForFakeClaimMode', () => {
  it('claim_*_fake / morning → 対応 viewer role', () => {
    assert.equal(viewerRoleForFakeClaimMode('claim_seer_fake'), 'seer')
    assert.equal(viewerRoleForFakeClaimMode('claim_medium_fake'), 'medium')
    assert.equal(viewerRoleForFakeClaimMode('claim_bg_fake'), 'bodyguard')
    assert.equal(viewerRoleForFakeClaimMode('claim_nekomata_fake'), 'nekomata')
    assert.equal(viewerRoleForFakeClaimMode('morning'), 'seer')
  })
  it('execute / attack / divine / guard は null', () => {
    assert.equal(viewerRoleForFakeClaimMode('execute'), null)
    assert.equal(viewerRoleForFakeClaimMode('attack'), null)
    assert.equal(viewerRoleForFakeClaimMode('divine'), null)
    assert.equal(viewerRoleForFakeClaimMode('guard'), null)
  })
})

describe('buildVirtualViewerObs: 各 viewer role で crash しない', () => {
  // 14 人村 (-neko 想定) の最小構成: seer/medium/bg/nekomata/wolf を含む
  const world = makeWorld({
    1: 'werewolf', 2: 'werewolf', 3: 'fanatic',
    4: 'seer', 5: 'medium', 6: 'bodyguard', 7: 'nekomata',
    8: 'mason', 9: 'mason',
    10: 'werehamster', 11: 'immoralist',
    12: 'villager', 13: 'villager', 14: 'villager',
  })
  const ctx = makeCtx({
    mySeat: 1, myRole: 'werewolf',
    alivePlayers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    knownWolves: [2],  // 自席+teammate
  })

  for (const viewerRole of ['seer', 'medium', 'bodyguard', 'nekomata'] as const) {
    it(`viewer='${viewerRole}': obs を ${OBSERVATION_SIZE} dim で生成`, () => {
      const state = buildInitialSimState(ctx, world)
      const invariants = buildInvariants(ctx)
      const obs = buildVirtualViewerObs(state, 1, viewerRole, invariants)
      assert.equal(obs.length, OBSERVATION_SIZE,
        `obs.length should be ${OBSERVATION_SIZE} (got ${obs.length})`)
      // 全部 finite (NaN/Infinity 無し)
      for (let i = 0; i < obs.length; i++) {
        assert.ok(Number.isFinite(obs[i]),
          `obs[${i}] is not finite (viewerRole=${viewerRole}): ${obs[i]}`)
      }
    })
  }

  it('viewer role を変えると obs の内容が変わる (sanity check)', () => {
    const state = buildInitialSimState(ctx, world)
    const invariants = buildInvariants(ctx)
    const seerObs = buildVirtualViewerObs(state, 1, 'seer', invariants)
    const mediumObs = buildVirtualViewerObs(state, 1, 'medium', invariants)
    const bgObs = buildVirtualViewerObs(state, 1, 'bodyguard', invariants)

    // 全 dimension で完全一致することはあり得ない (役職トークンが違う)
    // 少なくとも 1 dim 異なれば OK
    let seerVsMediumDiff = 0, seerVsBgDiff = 0
    for (let i = 0; i < seerObs.length; i++) {
      if (Math.abs(seerObs[i] - mediumObs[i]) > 1e-6) seerVsMediumDiff++
      if (Math.abs(seerObs[i] - bgObs[i]) > 1e-6) seerVsBgDiff++
    }
    assert.ok(seerVsMediumDiff > 0,
      `seer obs と medium obs が完全一致した (差分 0 件)`)
    assert.ok(seerVsBgDiff > 0,
      `seer obs と bodyguard obs が完全一致した (差分 0 件)`)
  })
})
