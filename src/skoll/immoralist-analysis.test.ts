/**
 * immoralist-analysis の単体テスト
 *
 * 検証:
 *   - 狐席が bestVote から除外される
 *   - hamster-analysis と同等の結果（mySeat = 狐席のとき）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { SystemRole, VillageStatus, SeatStatus } from '../types/index.ts'
import { Possibilities, RoleBitIndex } from '../retar/possibilities.ts'
import { analyzeImmoralistVotesByWorld } from './immoralist-analysis.ts'
import { analyzeHamsterVotesByWorld } from './hamster-analysis.ts'

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

test('immoralist-vote: 狐席が bestVote から除外される', () => {
  const aliveSeats = new Set([1, 2, 3, 4, 5])
  const vs = buildVs(aliveSeats)

  const perSeat = new Map<number, SystemRole[]>()
  perSeat.set(1, ['werewolf'])
  perSeat.set(2, ['werewolf'])
  perSeat.set(3, ['werehamster'])
  perSeat.set(4, ['villager'])
  perSeat.set(5, ['immoralist'])  // 自席（背徳者）
  const setup = new Map<SystemRole, number>([
    ['werewolf', 2], ['werehamster', 1], ['villager', 1], ['immoralist', 1],
  ])
  const poss = buildPossibilities(setup, perSeat)

  // 背徳者は seat 5。狐は seat 3。
  const knownHamster = 3
  const result = analyzeImmoralistVotesByWorld(poss, setup, vs, knownHamster, 50_000)

  assert.notEqual(result.bestVote, knownHamster, '狐席が bestVote になっている')

  // 狐席は candidates にあって isSelf=true (= 狐視点での「自席」)
  const foxCandidate = result.candidates.find(c => c.seat === knownHamster)!
  assert.equal(foxCandidate.isSelf, true)
})

test('immoralist-vote: hamster-analysis と同じ結果', () => {
  const aliveSeats = new Set([1, 2, 3, 4, 5])
  const vs = buildVs(aliveSeats)

  const perSeat = new Map<number, SystemRole[]>()
  perSeat.set(1, ['werewolf'])
  perSeat.set(2, ['werewolf'])
  perSeat.set(3, ['werehamster'])
  perSeat.set(4, ['villager'])
  perSeat.set(5, ['villager'])
  const setup = new Map<SystemRole, number>([
    ['werewolf', 2], ['werehamster', 1], ['villager', 2],
  ])
  const poss = buildPossibilities(setup, perSeat)

  const hamsterResult = analyzeHamsterVotesByWorld(poss, setup, vs, 3, 50_000)
  const immoralistResult = analyzeImmoralistVotesByWorld(poss, setup, vs, 3, 50_000)

  assert.equal(immoralistResult.bestVote, hamsterResult.bestVote)
  assert.equal(immoralistResult.totalWorlds, hamsterResult.totalWorlds)

  // 各 candidate の hamsterWinRate も一致
  for (let i = 0; i < hamsterResult.candidates.length; i++) {
    assert.equal(immoralistResult.candidates[i].hamsterWinRate, hamsterResult.candidates[i].hamsterWinRate)
  }
})
