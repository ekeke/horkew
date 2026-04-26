import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../types/index.ts'
import type { World } from '../../hati/types.ts'
import { RoleBitIndex } from '../../retar/possibilities.ts'
import { createSimState } from '../simulator/world-state.ts'
import { dispatchForPhase, bucketForRole, type ModuleBundle } from './dispatch.ts'
import { outcomeDistToFactionValue } from './ISMCTS.ts'
import type { SkollZeroModule } from '../module/skoll-zero-module.ts'

function makeWorld(assignments: Record<number, SystemRole>): World {
  const maxSeat = Math.max(...Object.keys(assignments).map(Number))
  const roles: SystemRole[] = new Array(maxSeat + 1)
  const roleIds = new Uint8Array(maxSeat + 1)
  let wolfMask = 0, hamsterMask = 0, immoralistMask = 0
  let seerMask = 0, mediumMask = 0, nekomataMask = 0
  let bodyguardSeat = -1
  for (const [seatStr, role] of Object.entries(assignments)) {
    const seat = Number(seatStr)
    roles[seat] = role
    roleIds[seat] = RoleBitIndex[role]
    switch (role) {
      case 'werewolf': wolfMask |= (1 << seat); break
      case 'werehamster': hamsterMask |= (1 << seat); break
      case 'immoralist': immoralistMask |= (1 << seat); break
      case 'seer': seerMask |= (1 << seat); break
      case 'medium': mediumMask |= (1 << seat); break
      case 'nekomata': nekomataMask |= (1 << seat); break
      case 'bodyguard': bodyguardSeat = seat; break
    }
  }
  return { roles, roleIds, wolfMask, hamsterMask, immoralistMask, seerMask, mediumMask, nekomataMask, bodyguardSeat }
}

function aliveOf(seats: number[]): number {
  let mask = 0
  for (const s of seats) mask |= (1 << s)
  return mask
}

/** mock module — Module class の interface を満たすだけのプレースホルダ */
function makeMock(name: string): SkollZeroModule {
  return { __mock: name } as unknown as SkollZeroModule
}

describe('bucketForRole', () => {
  it('mason → mason', () => assert.equal(bucketForRole('mason'), 'mason'))
  it('werewolf → wolf', () => assert.equal(bucketForRole('werewolf'), 'wolf'))
  it('villager → standard', () => assert.equal(bucketForRole('villager'), 'standard'))
  it('seer → standard', () => assert.equal(bucketForRole('seer'), 'standard'))
  it('bodyguard → standard', () => assert.equal(bucketForRole('bodyguard'), 'standard'))
  it('fanatic → fanatic', () => assert.equal(bucketForRole('fanatic'), 'fanatic'))
  it('werehamster → hamster', () => assert.equal(bucketForRole('werehamster'), 'hamster'))
  it('immoralist → immoralist', () => assert.equal(bucketForRole('immoralist'), 'immoralist'))
})

describe('dispatchForPhase', () => {
  const masonMod = makeMock('mason')
  const wolfMod = makeMock('wolf')
  const stdMod = makeMock('standard')
  const bundle: ModuleBundle = { mason: masonMod, wolf: wolfMod, standard: stdMod }

  it('day: 決定者の役職 Module で execute head', () => {
    const world = makeWorld({ 1: 'mason', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'day')
    const r = dispatchForPhase(state, 1, bundle)
    assert.equal(r?.module, masonMod)
    assert.equal(r?.actorSeat, 1)
    assert.equal(r?.actorRole, 'mason')
    assert.equal(r?.headName, 'execute')
  })

  it('day: 決定者が villager なら standard Module', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'mason' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'day')
    const r = dispatchForPhase(state, 1, bundle)
    assert.equal(r?.module, stdMod)
    assert.equal(r?.actorRole, 'villager')
  })

  it('night_attack: wolf Module の attack head、actor は生存 wolf 最下位', () => {
    const world = makeWorld({
      1: 'villager', 2: 'werewolf', 3: 'werewolf', 4: 'mason',
    })
    const state = createSimState(world, aliveOf([1, 3, 4]), 1, 'night_attack') // seat 2 死亡
    const r = dispatchForPhase(state, 4, bundle) // 決定者 mason だが、actor は wolf
    assert.equal(r?.module, wolfMod)
    assert.equal(r?.actorSeat, 3) // 生存 wolf 最下位
    assert.equal(r?.actorRole, 'werewolf')
    assert.equal(r?.headName, 'attack')
  })

  it('night_divine: standard Module の divine head、actor は真 seer', () => {
    const world = makeWorld({
      1: 'seer', 2: 'werewolf', 3: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'night_divine')
    const r = dispatchForPhase(state, 3, bundle)
    assert.equal(r?.module, stdMod)
    assert.equal(r?.actorSeat, 1)
    assert.equal(r?.actorRole, 'seer')
    assert.equal(r?.headName, 'divine')
  })

  it('night_guard: standard Module の guard head、actor は真 bg', () => {
    const world = makeWorld({
      1: 'bodyguard', 2: 'werewolf', 3: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'night_guard')
    const r = dispatchForPhase(state, 3, bundle)
    assert.equal(r?.module, stdMod)
    assert.equal(r?.actorSeat, 1)
    assert.equal(r?.actorRole, 'bodyguard')
    assert.equal(r?.headName, 'guard')
  })

  it('night_attack: 狼全滅で null', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1]), 1, 'night_attack') // wolf 死亡
    const r = dispatchForPhase(state, 1, bundle)
    assert.equal(r, null)
  })

  it('night_divine: 真 seer 不在で null', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'night_divine')
    const r = dispatchForPhase(state, 1, bundle)
    assert.equal(r, null)
  })

  it('Stage 3: claim_*_true は該当真役職不在で null', () => {
    const world = makeWorld({ 1: 'mason', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'claim_seer_true')
    // 真 seer 不在
    assert.equal(dispatchForPhase(state, 1, bundle), null)
  })

  it('Stage 3: claim_seer_true は真 seer module + claim_true head へ dispatch', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'claim_seer_true')
    const r = dispatchForPhase(state, 1, bundle)
    assert.equal(r?.module, stdMod)
    assert.equal(r?.actorSeat, 1)
    assert.equal(r?.actorRole, 'seer')
    assert.equal(r?.headName, 'claim_true')
  })

  it('Stage 3: claim_mason は mason module + claim_true head へ dispatch', () => {
    const world = makeWorld({ 1: 'mason', 2: 'mason', 3: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'claim_mason')
    const r = dispatchForPhase(state, 1, bundle)
    assert.equal(r?.module, masonMod)
    assert.equal(r?.actorSeat, 1)
    assert.equal(r?.actorRole, 'mason')
    assert.equal(r?.headName, 'claim_true')
  })

  it('Stage 3: claim_seer_fake は wolf module + claim_fake head へ dispatch', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'claim_seer_fake')
    const r = dispatchForPhase(state, 1, bundle)
    assert.equal(r?.module, wolfMod)
    assert.equal(r?.actorSeat, 2) // 最低位 wolf
    assert.equal(r?.actorRole, 'werewolf')
    assert.equal(r?.headName, 'claim_fake')
  })

  it('Stage 3: morning は morningPending[0] + wolf module + morning head', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'morning')
    state.morningPending = [3, 2] // FIFO 先頭は seat 3
    const r = dispatchForPhase(state, 1, bundle)
    assert.equal(r?.module, wolfMod)
    assert.equal(r?.actorSeat, 3)
    assert.equal(r?.headName, 'morning')
  })

  it('Stage 3: morningPending 空で null', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'morning')
    assert.equal(dispatchForPhase(state, 1, bundle), null)
  })

  it('Module 不在で null (mason bundle が無い場合)', () => {
    const partial: ModuleBundle = { wolf: wolfMod, standard: stdMod }
    const world = makeWorld({ 1: 'mason', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'day')
    const r = dispatchForPhase(state, 1, partial)
    assert.equal(r, null)
  })
})

describe('outcomeDistToFactionValue (Stage 4)', () => {
  it('village_win=1 確定なら village 視点 +1, wolf 視点 -1, hamster 視点 -1', () => {
    const dist = new Float32Array([1, 0, 0, 0]) // [village_win, wolf_win, hamster_win, draw]
    assert.equal(outcomeDistToFactionValue(dist, 'village'), 1)
    assert.equal(outcomeDistToFactionValue(dist, 'wolf'), -1)
    assert.equal(outcomeDistToFactionValue(dist, 'hamster'), -1)
  })
  it('hamster_win=1 確定なら 3 陣営とも整合 (village -2.0, wolf -1.5, hamster +1)', () => {
    const dist = new Float32Array([0, 0, 1, 0])
    // Stage 5: village 視点 -2.0 (狐排除を優先)、wolf 視点 -1.5 (狐執着を抑制)
    assert.ok(Math.abs(outcomeDistToFactionValue(dist, 'village') - (-2.0)) < 1e-6)
    assert.ok(Math.abs(outcomeDistToFactionValue(dist, 'wolf') - (-1.5)) < 1e-6)
    assert.ok(Math.abs(outcomeDistToFactionValue(dist, 'hamster') - 1) < 1e-6)
  })
  it('uniform 0.25 では各 faction の期待値は outcomeToValue 平均と一致', () => {
    const dist = new Float32Array([0.25, 0.25, 0.25, 0.25])
    // village 視点: 0.25*(1) + 0.25*(-1) + 0.25*(-2.0) + 0.25*(0) = -0.5
    assert.ok(Math.abs(outcomeDistToFactionValue(dist, 'village') - (-0.5)) < 1e-6)
  })
  it('undefined dist で 0 を返す (fallback)', () => {
    assert.equal(outcomeDistToFactionValue(undefined, 'village'), 0)
  })
})
