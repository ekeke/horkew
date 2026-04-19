/**
 * wolf-vote-analysis の単体テスト
 *
 * 主な検証:
 *   - teammates 除外
 *   - PP shortcut (既達 / execution 確定)
 *   - bestVote の選択ロジック (PP 優先 → wolfWinRate 最大)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { SystemRole, VillageStatus, SeatStatus } from '../types/index.ts'
import { Possibilities, RoleBitIndex } from '../retar/possibilities.ts'
import { analyzeWolfVotesByWorld } from './wolf-vote-analysis.ts'

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

test('wolf-vote: teammates が候補から除外される', () => {
  // 14 人全員 alive、knownWolves = {1, 2, 3}
  const aliveSeats = new Set<number>()
  for (let i = 1; i <= 14; i++) aliveSeats.add(i)
  const vs = buildVs(aliveSeats)

  // 適当な possibilities (非自明なら何でも)
  const perSeat = new Map<number, SystemRole[]>()
  for (let i = 1; i <= 14; i++) {
    perSeat.set(i, ['villager', 'werewolf', 'werehamster', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'fanatic', 'immoralist'])
  }
  const poss = buildPossibilities(SETUP_14D_NEKO, perSeat)

  const knownWolves = new Set([1, 2, 3])
  const result = analyzeWolfVotesByWorld(poss, SETUP_14D_NEKO, vs, knownWolves, 50_000)

  // bestVote は teammates 1, 2, 3 ではない
  assert.ok(result.bestVote !== null)
  assert.ok(!knownWolves.has(result.bestVote!), `bestVote ${result.bestVote} should not be teammate`)

  // candidates の isTeammate フラグが正しい
  for (const c of result.candidates) {
    assert.equal(c.isTeammate, knownWolves.has(c.seat))
  }
})

test('wolf-vote: PP 既達ケース (狼半数 + hamster 確実死亡)', () => {
  // 4 人 alive、うち 2 人が knownWolves。hamster 不可能な perSeat 構成
  const aliveSeats = new Set([1, 2, 3, 4])
  const vs = buildVs(aliveSeats)

  // どの alive seat にも hamster bit が立っていない
  const perSeat = new Map<number, SystemRole[]>()
  perSeat.set(1, ['werewolf'])
  perSeat.set(2, ['werewolf'])
  perSeat.set(3, ['villager'])
  perSeat.set(4, ['villager'])
  const poss = buildPossibilities(SETUP_14D_NEKO, perSeat)

  const knownWolves = new Set([1, 2])
  const result = analyzeWolfVotesByWorld(poss, SETUP_14D_NEKO, vs, knownWolves, 50_000)

  // 2 * 2 = 4 = alive count → PP 既達
  assert.equal(result.ppAlreadyAchieved, true)
})

test('wolf-vote: PP 既達でない (hamster 可能性あり)', () => {
  // 4 人 alive、うち 2 人が knownWolves。だが seat 4 は hamster 可能性あり
  const aliveSeats = new Set([1, 2, 3, 4])
  const vs = buildVs(aliveSeats)

  const perSeat = new Map<number, SystemRole[]>()
  perSeat.set(1, ['werewolf'])
  perSeat.set(2, ['werewolf'])
  perSeat.set(3, ['villager'])
  perSeat.set(4, ['werehamster'])  // hamster 可能性
  const poss = buildPossibilities(SETUP_14D_NEKO, perSeat)

  const knownWolves = new Set([1, 2])
  const result = analyzeWolfVotesByWorld(poss, SETUP_14D_NEKO, vs, knownWolves, 50_000)

  // hamster 不確定なので PP 既達にはならない
  assert.equal(result.ppAlreadyAchieved, false)
})

test('wolf-vote: execution で PP 確定する seat を検出', () => {
  // 5 人 alive、knownWolves = {1, 2}, hamster 不可能
  // seat 3 を吊れば 2 wolves vs 4 alive → 2*2=4 >= 4 → PP 確定
  const aliveSeats = new Set([1, 2, 3, 4, 5])
  const vs = buildVs(aliveSeats)

  const perSeat = new Map<number, SystemRole[]>()
  perSeat.set(1, ['werewolf'])
  perSeat.set(2, ['werewolf'])
  perSeat.set(3, ['villager'])
  perSeat.set(4, ['villager'])
  perSeat.set(5, ['villager'])
  const poss = buildPossibilities(SETUP_14D_NEKO, perSeat)

  const knownWolves = new Set([1, 2])
  const result = analyzeWolfVotesByWorld(poss, SETUP_14D_NEKO, vs, knownWolves, 50_000)

  // 全 non-teammate (3,4,5) で PP 確定する
  assert.deepEqual(result.ppByExecution.sort(), [3, 4, 5])
  // bestVote は ppByExecution の中の最小 seat
  assert.equal(result.bestVote, 3)
})
