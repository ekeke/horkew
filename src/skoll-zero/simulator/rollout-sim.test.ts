import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../types/index.ts'
import type { World } from '../../hati/types.ts'
import { RoleBitIndex } from '../../retar/possibilities.ts'
import { createSimState } from './world-state.ts'
import { stepDayNightCycle } from './rollout-sim.ts'
import type { NightDecision } from './rollout-sim.ts'

/** テスト用 world 構築ヘルパー */
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

const EMPTY_NIGHT: NightDecision = { attackTarget: null, guardTarget: null, seerTargets: [] }

describe('stepDayNightCycle: day phase', () => {
  it('executedSeat で指定 seat が処刑される', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]))
    stepDayNightCycle(state, { executedSeat: 2 }, EMPTY_NIGHT)
    // wolf を処刑 → village_win で terminal
    assert.equal(state.phase, 'terminal')
    assert.equal(state.outcome, 'village_win')
  })

  it('executedSeat=-1 で処刑スキップ', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]))
    stepDayNightCycle(state, { executedSeat: -1 }, { attackTarget: 1, guardTarget: null, seerTargets: [] })
    // 処刑なし、夜に seat1 襲撃 → wolf1 vs villager1 → 2*1 >= 2 で wolf_win
    assert.equal(state.phase, 'terminal')
    assert.equal(state.outcome, 'wolf_win')
  })

  it('非 terminal なら day → night → day に進み day が +1', () => {
    const world = makeWorld({
      1: 'villager', 2: 'seer', 3: 'werewolf', 4: 'werewolf', 5: 'villager', 6: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4, 5, 6]))
    // day: wolf 1 匹処刑、night: seat1 襲撃
    stepDayNightCycle(state, { executedSeat: 3 }, { attackTarget: 1, guardTarget: null, seerTargets: [] })
    assert.equal(state.phase, 'day')
    assert.equal(state.day, 2)
    assert.equal(state.alive, aliveOf([2, 4, 5, 6]))
  })
})

describe('stepDayNightCycle: night phase', () => {
  it('attackTarget で指定 seat が襲撃される', () => {
    const world = makeWorld({ 1: 'seer', 2: 'villager', 3: 'werewolf', 4: 'villager' })
    // state を night から開始（root night action 用途を想定）
    const state = createSimState(world, aliveOf([1, 2, 3, 4]), 1, 'night')
    stepDayNightCycle(state, { executedSeat: -1 }, { attackTarget: 1, guardTarget: null, seerTargets: [] })
    // seer (seat1) 襲撃 → alive [2, 3, 4]、wolf1 vs villager2 → 2 < 3 で ongoing
    assert.equal(state.phase, 'day')
    assert.equal(state.alive, aliveOf([2, 3, 4]))
  })

  it('guardTarget で attack がブロックされる', () => {
    const world = makeWorld({
      1: 'bodyguard', 2: 'seer', 3: 'werewolf', 4: 'villager', 5: 'werewolf',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4, 5]), 1, 'night')
    stepDayNightCycle(state, { executedSeat: -1 }, { attackTarget: 2, guardTarget: 2, seerTargets: [] })
    // seat2 (seer) に attack、bodyguard が同 seat を護衛 → 攻撃 ブロック
    assert.ok(state.alive & (1 << 2), 'seer が護衛で生存')
  })

  it('seerTargets で狐を呪殺できる', () => {
    const world = makeWorld({
      1: 'seer', 2: 'werehamster', 3: 'werewolf', 4: 'werewolf', 5: 'villager', 6: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4, 5, 6]), 1, 'night')
    // seer が狐 seat2 を占う → 呪殺で狐退場
    stepDayNightCycle(state, { executedSeat: -1 }, { attackTarget: 5, guardTarget: null, seerTargets: [2] })
    // 狐呪殺 + seat5 襲撃 → alive [1, 3, 4, 6]
    assert.ok(!(state.alive & (1 << 2)), '狐呪殺で seat2 退場')
    assert.ok(!(state.alive & (1 << 5)), 'seat5 襲撃で退場')
  })
})

describe('stepDayNightCycle: terminal', () => {
  it('terminal state は mutate されない', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]))
    state.phase = 'terminal'
    state.outcome = 'village_win'
    const beforeAlive = state.alive
    stepDayNightCycle(state, { executedSeat: 1 }, EMPTY_NIGHT)
    assert.equal(state.phase, 'terminal')
    assert.equal(state.alive, beforeAlive)
  })
})
