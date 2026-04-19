/**
 * fanatic-analysis の単体テスト
 *
 * wrapper として:
 *   - 自席が vote 候補から除外される
 *   - 自席が PP 計算に含まれる (wolf + fanatic 数で PP 達成判定)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { SystemRole, VillageStatus, SeatStatus } from '../types/index.ts'
import { Possibilities, RoleBitIndex } from '../retar/possibilities.ts'
import { analyzeFanaticVotesByWorld } from './fanatic-analysis.ts'

const SETUP_14D_NEKO: Map<SystemRole, number> = new Map([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])

function makeStatus(surviving: boolean): SeatStatus {
  return {
    surviving,
    causeOfDeath: undefined,
    survivedDays: 0,
    voted: false,
    claiming: false,
    claimingRole: '',
    deniedRoles: [],
    votedCount: 0,
    votedTarget: -1,
    votedOrder: 0,
    actions: {} as any,
    assertions: {} as any,
    forecasts: new Map(),
  } as unknown as SeatStatus
}

function buildVs(aliveSeats: Set<number>, totalSeats: number = 14): VillageStatus {
  const statuses = new Map<number, SeatStatus>()
  for (let s = 1; s <= totalSeats; s++) {
    statuses.set(s, makeStatus(aliveSeats.has(s)))
  }
  return {
    statuses,
    executions: new Map(),
    kills: new Map(),
    roles: new Map(),
  } as VillageStatus
}

function buildPossibilities(setup: Map<SystemRole, number>, perSeat: Map<number, SystemRole[]>): Possibilities {
  const poss = new Possibilities(setup)
  for (const [seat, roles] of perSeat) {
    let mask = 0
    for (const role of roles) {
      mask |= 1 << RoleBitIndex[role]
    }
    poss.possibilities[seat] = mask
  }
  return poss
}

test('fanatic-vote: 自席と knownWolves が vote 候補から除外される', () => {
  // 14 人 alive、knownWolves = {1, 2, 3}、mySeat = 4
  const aliveSeats = new Set<number>()
  for (let i = 1; i <= 14; i++) aliveSeats.add(i)
  const vs = buildVs(aliveSeats)

  const perSeat = new Map<number, SystemRole[]>()
  for (let i = 1; i <= 14; i++) {
    perSeat.set(i, ['villager', 'werewolf', 'werehamster', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'fanatic', 'immoralist'])
  }
  const poss = buildPossibilities(SETUP_14D_NEKO, perSeat)

  const knownWolves = new Set([1, 2, 3])
  const mySeat = 4
  const result = analyzeFanaticVotesByWorld(poss, SETUP_14D_NEKO, vs, knownWolves, mySeat, 50_000)

  // bestVote は knownWolves でも自席でもない
  assert.ok(result.bestVote !== null)
  assert.ok(!knownWolves.has(result.bestVote!), `bestVote ${result.bestVote} が knownWolves`)
  assert.notEqual(result.bestVote, mySeat, `bestVote が自席`)

  // candidates の isTeammate フラグは knownWolves ∪ {mySeat} で true
  for (const c of result.candidates) {
    const expected = knownWolves.has(c.seat) || c.seat === mySeat
    assert.equal(c.isTeammate, expected, `seat ${c.seat} isTeammate`)
  }
})

test('fanatic-vote: 自席を含めて PP 既達判定', () => {
  // 4 人 alive: seat 1=狼, seat 2=狼, seat 3=狂信(自分), seat 4=村
  // wolf 陣営 = {1, 2, 3} (狼2 + 狂信1)、PP は 2*3=6 >= 4 で既達
  // hamster は不可能
  const aliveSeats = new Set([1, 2, 3, 4])
  const vs = buildVs(aliveSeats)

  const perSeat = new Map<number, SystemRole[]>()
  perSeat.set(1, ['werewolf'])
  perSeat.set(2, ['werewolf'])
  perSeat.set(3, ['fanatic'])
  perSeat.set(4, ['villager'])
  const poss = buildPossibilities(SETUP_14D_NEKO, perSeat)

  const knownWolves = new Set([1, 2])
  const mySeat = 3
  const result = analyzeFanaticVotesByWorld(poss, SETUP_14D_NEKO, vs, knownWolves, mySeat, 50_000)

  // 2 * 3 = 6 >= 4 → PP 既達
  assert.equal(result.ppAlreadyAchieved, true)
})

test('fanatic-vote: 自席含めずに wolf-vote すると PP 未達 (差分検証)', () => {
  // 5 人 alive: seat 1=狼, seat 2=狼, seat 3=狂信(自分), seat 4,5=村
  // 狂信なし wolf-vote: 2*2=4 < 5 → PP 未達
  // 狂信あり fanatic-vote: 2*3=6 >= 5 → PP 既達
  const aliveSeats = new Set([1, 2, 3, 4, 5])
  const vs = buildVs(aliveSeats)

  const perSeat = new Map<number, SystemRole[]>()
  perSeat.set(1, ['werewolf'])
  perSeat.set(2, ['werewolf'])
  perSeat.set(3, ['fanatic'])
  perSeat.set(4, ['villager'])
  perSeat.set(5, ['villager'])
  const poss = buildPossibilities(SETUP_14D_NEKO, perSeat)

  const knownWolves = new Set([1, 2])
  const mySeat = 3
  const result = analyzeFanaticVotesByWorld(poss, SETUP_14D_NEKO, vs, knownWolves, mySeat, 50_000)

  // 狂信込みでようやく 2*3=6 >= 5 で PP 既達
  assert.equal(result.ppAlreadyAchieved, true)
})
