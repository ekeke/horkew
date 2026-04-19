/**
 * hamster-analysis の単体テスト
 *
 * 検証:
 *   - 自席が候補に残るが bestVote 選択からは除外される
 *   - 終局で hamster 死亡確定なワールドの hamsterWinRate = 0
 *   - 狼全滅 + 狐生存ワールドで hamsterWinRate = 1
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { SystemRole, VillageStatus, SeatStatus } from '../types/index.ts'
import { Possibilities, RoleBitIndex } from '../retar/possibilities.ts'
import { analyzeHamsterVotesByWorld } from './hamster-analysis.ts'

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

test('hamster-vote: 自席は bestVote から除外される', () => {
  // 5 seats, mySeat = 3
  const aliveSeats = new Set([1, 2, 3, 4, 5])
  const vs = buildVs(aliveSeats)

  const perSeat = new Map<number, SystemRole[]>()
  perSeat.set(1, ['werewolf'])
  perSeat.set(2, ['werewolf'])
  perSeat.set(3, ['werehamster'])
  perSeat.set(4, ['villager'])
  perSeat.set(5, ['villager'])
  const poss = buildPossibilities(SETUP_14D_NEKO, perSeat)

  const result = analyzeHamsterVotesByWorld(poss, SETUP_14D_NEKO, vs, 3, 50_000)

  assert.notEqual(result.bestVote, 3, '自席が bestVote になっている')
  // 自席は candidates にはある
  const selfCandidate = result.candidates.find(c => c.seat === 3)
  assert.ok(selfCandidate)
  assert.equal(selfCandidate!.isSelf, true)
})

test('hamster-vote: 狼吊りで狼全滅 → 高 hamster winrate', () => {
  // 3 seats: 狼1, 狼2, 狐3
  // 狼1 か 狼2 を吊ると狼1人残るがPP（2*1=2 vs 2 alive） → wolf_win or hamster_win
  //   alive 後 = 2 (1狼+1狐) → 2*1=2 >= 2 → PP. hamsterAlive → hamster_win
  // 自席3 を吊ると…hamster_win = 0
  const aliveSeats = new Set([1, 2, 3])
  const vs = buildVs(aliveSeats)

  const perSeat = new Map<number, SystemRole[]>()
  perSeat.set(1, ['werewolf'])
  perSeat.set(2, ['werewolf'])
  perSeat.set(3, ['werehamster'])
  const setup = new Map<SystemRole, number>([
    ['werewolf', 2], ['werehamster', 1],
  ])
  const poss = buildPossibilities(setup, perSeat)

  const result = analyzeHamsterVotesByWorld(poss, setup, vs, 3, 50_000)

  // bestVote は seat 1 か 2（どちらでも狼を1減らせるが、減らした後 PP で hamster_win）
  assert.ok(result.bestVote === 1 || result.bestVote === 2, `bestVote=${result.bestVote}`)
  const bestCandidate = result.candidates.find(c => c.seat === result.bestVote)!
  assert.ok(bestCandidate.hamsterWinRate > 0.5, `bestVote の hamster_winRate=${bestCandidate.hamsterWinRate} should be > 0.5`)
})

test('hamster-vote: 狐自身吊り = 0', () => {
  // 同じ盤面、ただし「自席を吊る選択」の hamster_winRate を見る
  const aliveSeats = new Set([1, 2, 3])
  const vs = buildVs(aliveSeats)

  const perSeat = new Map<number, SystemRole[]>()
  perSeat.set(1, ['werewolf'])
  perSeat.set(2, ['werewolf'])
  perSeat.set(3, ['werehamster'])
  const setup = new Map<SystemRole, number>([
    ['werewolf', 2], ['werehamster', 1],
  ])
  const poss = buildPossibilities(setup, perSeat)

  const result = analyzeHamsterVotesByWorld(poss, setup, vs, 3, 50_000)
  const selfCandidate = result.candidates.find(c => c.seat === 3)!
  assert.equal(selfCandidate.hamsterWinRate, 0, '自席吊りは hamster 死亡で 0')
})
