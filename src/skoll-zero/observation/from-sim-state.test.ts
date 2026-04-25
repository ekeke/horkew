import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../types/index.ts'
import type { World } from '../../hati/types.ts'
import { RoleBitIndex } from '../../retar/possibilities.ts'
import { createSimState } from '../simulator/world-state.ts'
import {
  collectFromSimState, emptyInvariants,
  encodeIndividualFromSimState,
  encodeWolfCollectiveFromSimState,
  encodeMasonCollectiveFromSimState,
  encodeFanaticFromSimState,
} from './from-sim-state.ts'
import {
  SEATS, WOLF_COLLECTIVE_OBSERVATION_SIZE, MASON_COLLECTIVE_OBSERVATION_SIZE, FANATIC_OBSERVATION_SIZE,
  OBSERVATION_SIZE,
  COLLECTIVE_TEAM_SIZE_START, WOLF_FAKE_DIVINE_START,
} from '../../fenrir/src/observation.ts'

function makeWorld(assignments: Record<number, SystemRole>): World {
  const maxSeat = Math.max(...Object.keys(assignments).map(Number))
  const roles: SystemRole[] = new Array(maxSeat + 1)
  const roleIds = new Uint8Array(maxSeat + 1)
  let wolfMask = 0
  let hamsterMask = 0
  let immoralistMask = 0
  let seerMask = 0
  let mediumMask = 0
  let nekomataMask = 0
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

  return {
    roles, roleIds, wolfMask, hamsterMask, immoralistMask,
    seerMask, mediumMask, nekomataMask, bodyguardSeat,
  }
}

function aliveOf(seats: number[]): number {
  let mask = 0
  for (const s of seats) mask |= (1 << s)
  return mask
}

describe('collectFromSimState: global', () => {
  it('day / phase / aliveCount / myRole / aliveParity が SimState から正しく取れる', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'seer' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 5, 'day')
    const data = collectFromSimState(state, 1, 'villager', emptyInvariants())
    assert.equal(data.global.day, 5)
    assert.equal(data.global.phase, 'day')
    assert.equal(data.global.aliveCount, 3)
    assert.equal(data.global.myRole, 'villager')
    assert.equal(data.global.aliveParity, 1)
  })

  it('night_attack phase は ctx phase=night として表現される', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'night_attack')
    const data = collectFromSimState(state, 1, 'villager', emptyInvariants())
    assert.equal(data.global.phase, 'night')
  })
})

describe('collectFromSimState: per-seat', () => {
  it('alive bitmask が seats[].alive に反映される', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'seer' })
    const state = createSimState(world, aliveOf([1, 3]), 1, 'day') // seat 2 死亡
    const data = collectFromSimState(state, 1, 'villager', emptyInvariants())
    assert.equal(data.seats[0].alive, true) // seat 1
    assert.equal(data.seats[1].alive, false) // seat 2
    assert.equal(data.seats[2].alive, true) // seat 3
  })

  it('claims が seats[].claimedRole に反映される', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'day')
    state.claims.set(1, { role: 'seer', isFake: false })
    state.claims.set(2, { role: 'medium', isFake: true })
    const data = collectFromSimState(state, 1, 'seer', emptyInvariants())
    assert.equal(data.seats[0].claimedRole, 'seer')
    assert.equal(data.seats[1].claimedRole, 'medium')
  })

  it('isMe フラグが viewerSeat に対応する', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'day')
    const data = collectFromSimState(state, 2, 'werewolf', emptyInvariants())
    assert.equal(data.seats[0].isMe, false)
    assert.equal(data.seats[1].isMe, true)
  })

  it('真 seer の divineLog が CO 済の場合に black/white カウントへ集計される', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 2, 'day')
    state.claims.set(1, { role: 'seer', isFake: false })
    state.divineLog.set(1, [
      { day: 1, target: 2, color: 'wolf' },
      { day: 1, target: 3, color: 'human' },
    ])
    const data = collectFromSimState(state, 1, 'seer', emptyInvariants())
    assert.equal(data.seats[1].blackCount, 1) // seat 2 が wolf として 1 回出た
    assert.equal(data.seats[2].whiteCount, 1) // seat 3 が human として 1 回出た
  })

  it('真 seer の divineLog は CO 未だと観測に出ない (潜伏中の seer)', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 2, 'day')
    state.divineLog.set(1, [{ day: 1, target: 2, color: 'wolf' }])
    // CO していない
    const data = collectFromSimState(state, 1, 'seer', emptyInvariants())
    assert.equal(data.seats[1].blackCount, 0)
  })

  it('偽 seer の fakeDivineHistory が claims に乗っていれば集計される', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 2, 'day')
    state.claims.set(2, { role: 'seer', isFake: true })
    state.fakeDivineHistory.set(2, [{ day: 1, target: 1, color: 'wolf' }])
    const data = collectFromSimState(state, 1, 'seer', emptyInvariants())
    assert.equal(data.seats[0].blackCount, 1)
  })
})

describe('collectFromSimState: private', () => {
  it('viewer=seer の divineResults が divineLog から取れる (自分の log)', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 2, 'day')
    state.divineLog.set(1, [{ day: 1, target: 2, color: 'wolf' }])
    const data = collectFromSimState(state, 1, 'seer', emptyInvariants())
    assert.deepEqual(data.private.divineResults, [[2, 'wolf']])
  })

  it('viewer=villager は divineResults 空', () => {
    const world = makeWorld({ 1: 'seer', 2: 'villager' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'day')
    state.divineLog.set(1, [{ day: 1, target: 2, color: 'human' }])
    const data = collectFromSimState(state, 2, 'villager', emptyInvariants())
    assert.deepEqual(data.private.divineResults, [])
  })

  it('viewer=werewolf の wolfTeamSeats に他の wolf が入る (自分は除外)', () => {
    const world = makeWorld({
      1: 'villager', 2: 'werewolf', 3: 'werewolf', 4: 'werewolf',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4]), 1, 'day')
    const data = collectFromSimState(state, 2, 'werewolf', emptyInvariants())
    assert.deepEqual(data.private.wolfTeamSeats.sort((a, b) => a - b), [3, 4])
  })

  it('viewer=mason の masonPartner に別 mason の seat', () => {
    const world = makeWorld({ 1: 'mason', 2: 'mason', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'day')
    const data = collectFromSimState(state, 1, 'mason', emptyInvariants())
    assert.equal(data.private.masonPartner, 2)
  })

  it('viewer=immoralist の knownHamster に hamster seat', () => {
    const world = makeWorld({ 1: 'immoralist', 2: 'werehamster', 3: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'day')
    const data = collectFromSimState(state, 1, 'immoralist', emptyInvariants())
    assert.equal(data.private.knownHamster, 2)
  })

  it('viewer=bodyguard の guardedSeats に guardLog の target が入る', () => {
    const world = makeWorld({ 1: 'bodyguard', 2: 'villager', 3: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 2, 'day')
    state.guardLog.push({ day: 1, target: 2 })
    const data = collectFromSimState(state, 1, 'bodyguard', emptyInvariants())
    assert.deepEqual(data.private.guardedSeats, [2])
  })
})

describe('collectFromSimState: history', () => {
  it('deathLog の execute / night_kill が history に反映される', () => {
    const world = makeWorld({
      1: 'villager', 2: 'werewolf', 3: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 3]), 2, 'day')
    state.deathLog.push({ day: 1, seat: 2, cause: 'execute' })
    const data = collectFromSimState(state, 1, 'villager', emptyInvariants())
    // history は直近 3 日分 (currentDay-2..currentDay)、各 day で per-seat 5 features
    // window 0 = day-2、window 1 = day-1、window 2 = day
    // currentDay=2 → window 0 = day 0 (前)、window 1 = day 1、window 2 = day 2
    // day 1 の seat 2 (slot 1) で executed (offset 1) フラグが立つ
    const window1Base = 1 * SEATS * 5 // window=1 (day=1) の base
    assert.equal(data.history[window1Base + 1 * 5 + 1], 1) // seat 2 execute
  })
})

describe('encodeIndividualFromSimState', () => {
  it('OBSERVATION_SIZE 長の Float32Array を返す', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'day')
    const obs = encodeIndividualFromSimState(state, 1, 'villager', emptyInvariants())
    assert.equal(obs.length, OBSERVATION_SIZE)
  })
})

describe('encodeMasonCollectiveFromSimState', () => {
  it('MASON_COLLECTIVE_OBSERVATION_SIZE 長 + team_size セット', () => {
    const world = makeWorld({ 1: 'mason', 2: 'mason', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'day')
    const obs = encodeMasonCollectiveFromSimState(state, 1, 'mason', emptyInvariants())
    assert.equal(obs.length, MASON_COLLECTIVE_OBSERVATION_SIZE)
    assert.equal(obs[COLLECTIVE_TEAM_SIZE_START], Math.fround(2 / SEATS))
  })
})

describe('encodeWolfCollectiveFromSimState', () => {
  it('WOLF_COLLECTIVE_OBSERVATION_SIZE 長 + team_size セット', () => {
    const world = makeWorld({
      1: 'villager', 2: 'werewolf', 3: 'werewolf',
    })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'day')
    const obs = encodeWolfCollectiveFromSimState(state, 2, 'werewolf', emptyInvariants())
    assert.equal(obs.length, WOLF_COLLECTIVE_OBSERVATION_SIZE)
    assert.equal(obs[COLLECTIVE_TEAM_SIZE_START], Math.fround(2 / SEATS))
  })

  it('wolf チームの偽占い結果が fake_divine セクションに集計される', () => {
    const world = makeWorld({
      1: 'villager', 2: 'werewolf', 3: 'werewolf', 4: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4]), 2, 'day')
    state.claims.set(2, { role: 'seer', isFake: true })
    state.fakeDivineHistory.set(2, [{ day: 1, target: 1, color: 'wolf' }])
    const obs = encodeWolfCollectiveFromSimState(state, 2, 'werewolf', emptyInvariants())
    // seat 1 (slot 0) に偽 wolf 結果 → 1.0
    assert.equal(obs[WOLF_FAKE_DIVINE_START + 0], 1.0)
    // seat 4 は何も無い
    assert.equal(obs[WOLF_FAKE_DIVINE_START + 3], 0)
  })
})

describe('encodeFanaticFromSimState', () => {
  it('FANATIC_OBSERVATION_SIZE 長 (個人観測 + village_predict/trust)', () => {
    const world = makeWorld({ 1: 'fanatic', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'day')
    const obs = encodeFanaticFromSimState(state, 1, 'fanatic', emptyInvariants())
    assert.equal(obs.length, FANATIC_OBSERVATION_SIZE)
  })
})
