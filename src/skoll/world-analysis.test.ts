import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeExecutionsByWorld } from './world-analysis.ts'
import { Possibilities, possibilityFromRoles } from '../retar/possibilities.ts'
import type { VillageStatus, SeatStatus, SystemRole } from '../types/index.ts'

const EPSILON = 1e-6

function approx(actual: number, expected: number, message?: string) {
  assert.ok(
    Math.abs(actual - expected) < EPSILON,
    message ?? `expected ${expected}, got ${actual} (diff=${Math.abs(actual - expected)})`,
  )
}

function makeSeat(overrides: Partial<SeatStatus> = {}): SeatStatus {
  return {
    surviving: true,
    causeOfDeath: 'execution' as const,
    survivedDays: 0,
    voted: false,
    claiming: false,
    claimingRole: '',
    deniedRoles: [],
    votedCount: 0,
    votedTarget: 0,
    votedOrder: 0,
    actions: new Map(),
    assertions: new Map(),
    forecasts: new Map(),
    ...overrides,
  }
}

function makeVillage(seats: Map<number, SeatStatus>): VillageStatus {
  return {
    statuses: seats,
    executions: new Map(),
    kills: new Map(),
    roles: new Map(),
    claims: new Map(),
    voteHistory: new Map(),
    revoteTargets: new Set(),
    voteFinalRule: 'revote',
    hasMultiVote: false,
    multiVoteDays: new Set(),
    day: 1,
    finished: false,
    result: undefined,
  }
}

function buildPossibilities(
  setup: Map<SystemRole, number>,
  seatRoles: Map<number, SystemRole[]>,
): Possibilities {
  const p = new Possibilities(setup)
  for (const [seat, roles] of seatRoles) {
    p.possibilities[seat] = possibilityFromRoles(new Set(roles))
  }
  return p
}

describe('analyzeExecutionsByWorld', () => {
  it('最終日 3人 狼1: 狼 seat を吊れば勝率 1.0', () => {
    // seat1=村, seat2=狼, seat3=村 の1ワールドのみ
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['werewolf', 1],
    ])
    const seatRoles = new Map([
      [1, ['villager']],
      [2, ['werewolf']],
      [3, ['villager']],
    ]) as Map<number, SystemRole[]>
    const possibilities = buildPossibilities(setup, seatRoles)
    const vs = makeVillage(new Map([
      [1, makeSeat()], [2, makeSeat()], [3, makeSeat()],
    ]))

    const result = analyzeExecutionsByWorld(possibilities, setup, vs)
    assert.equal(result.totalWorlds, 1)

    // seat2（狼）を吊る → village_win
    const s2 = result.executions.find(e => e.seat === 2)!
    approx(s2.winRate, 1.0, 'executing wolf should win')

    // seat1,3（村人）を吊る → PP (1狼 vs 1村 → wolf_win)
    const s1 = result.executions.find(e => e.seat === 1)!
    approx(s1.winRate, 0.0, 'executing villager should lose')

    assert.equal(result.bestExecution, 2)
  })

  it('最終日 3人 グレー: 狼位置不明 → 各 seat 均等', () => {
    // 3人全員が villager or werewolf
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['werewolf', 1],
    ])
    const seatRoles = new Map([
      [1, ['villager', 'werewolf']],
      [2, ['villager', 'werewolf']],
      [3, ['villager', 'werewolf']],
    ]) as Map<number, SystemRole[]>
    const possibilities = buildPossibilities(setup, seatRoles)
    const vs = makeVillage(new Map([
      [1, makeSeat()], [2, makeSeat()], [3, makeSeat()],
    ]))

    const result = analyzeExecutionsByWorld(possibilities, setup, vs)
    // 3ワールド: 狼が seat1, seat2, seat3 のいずれか
    assert.equal(result.totalWorlds, 3)

    // 各 seat を吊る:
    // 1/3 のワールドで狼命中 → win、2/3 で PP → lose
    for (const ex of result.executions) {
      approx(ex.winRate, 1 / 3, `seat ${ex.seat} should be 1/3`)
    }
  })

  it('wolf vs possessed の区別: wolf 吊りが possessed 吊りより高い', () => {
    // 4人: seat1=[werewolf], seat2=[possessed], seat3,4=[villager]
    // 1ワールドのみ
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['werewolf', 1], ['possessed', 1],
    ])
    const seatRoles = new Map([
      [1, ['werewolf']],
      [2, ['possessed']],
      [3, ['villager']],
      [4, ['villager']],
    ]) as Map<number, SystemRole[]>
    const possibilities = buildPossibilities(setup, seatRoles)
    const vs = makeVillage(new Map([
      [1, makeSeat()], [2, makeSeat()], [3, makeSeat()], [4, makeSeat()],
    ]))

    const result = analyzeExecutionsByWorld(possibilities, setup, vs)
    assert.equal(result.totalWorlds, 1)

    // wolf 吊り → village_win（最後の狼）
    const wolfExec = result.executions.find(e => e.seat === 1)!
    approx(wolfExec.winRate, 1.0)

    // possessed 吊り → ongoing（狼まだいる）
    const possExec = result.executions.find(e => e.seat === 2)!
    // 3人残り、狼1 → 夜で1人死亡 → 2人、PP → 0
    approx(possExec.winRate, 0.0)

    assert.equal(result.bestExecution, 1)
  })

  it('[werewolf, possessed] の混合: wolf/possessed が分かれるケース', () => {
    // seat1=[werewolf,possessed], seat2=[villager,werewolf],
    // seat3=[villager], seat4=[villager,possessed]
    // setup: villager:2, werewolf:1, possessed:1
    //
    // ワールド:
    //   W1: seat1=werewolf, seat2=villager, seat3=villager, seat4=possessed
    //   W2: seat1=possessed, seat2=werewolf, seat3=villager, seat4=villager
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['werewolf', 1], ['possessed', 1],
    ])
    const seatRoles = new Map([
      [1, ['werewolf', 'possessed']],
      [2, ['villager', 'werewolf']],
      [3, ['villager']],
      [4, ['villager', 'possessed']],
    ]) as Map<number, SystemRole[]>
    const possibilities = buildPossibilities(setup, seatRoles)
    const vs = makeVillage(new Map([
      [1, makeSeat()], [2, makeSeat()], [3, makeSeat()], [4, makeSeat()],
    ]))

    const result = analyzeExecutionsByWorld(possibilities, setup, vs)
    assert.equal(result.totalWorlds, 2)

    // seat1 吊り: W1→wolf除去→win, W2→possessed除去→ongoing→PP→0 = 0.5
    // seat2 吊り: W1→villager除去→ongoing→PP→0, W2→wolf除去→win = 0.5
    // seat3 吊り: どちらのワールドでも villager → ongoing → PP → 0
    const s1 = result.executions.find(e => e.seat === 1)!
    const s2 = result.executions.find(e => e.seat === 2)!
    const s3 = result.executions.find(e => e.seat === 3)!

    approx(s1.winRate, 0.5, 'seat1 (wolf/possessed)')
    approx(s2.winRate, 0.5, 'seat2 (villager/wolf)')
    approx(s3.winRate, 0.0, 'seat3 (always villager)')

    // 確定村人 < 狼候補
    assert.ok(s1.winRate > s3.winRate)
  })

  it('打ち切り: maxWorlds で truncated', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['werewolf', 1],
    ])
    const seatRoles = new Map([
      [1, ['villager', 'werewolf']],
      [2, ['villager', 'werewolf']],
      [3, ['villager', 'werewolf']],
    ]) as Map<number, SystemRole[]>
    const possibilities = buildPossibilities(setup, seatRoles)
    const vs = makeVillage(new Map([
      [1, makeSeat()], [2, makeSeat()], [3, makeSeat()],
    ]))

    const result = analyzeExecutionsByWorld(possibilities, setup, vs, 2)
    assert.equal(result.truncated, true)
    assert.equal(result.totalWorlds, 2)
  })
})
