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
    // 3人残り、狼1 → 夜で1人退場 → 2人、PP → 0
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

  it('狐生存 + 狼1: 狼吊り → 狼全滅だが狐勝ち', () => {
    // seat1=村, seat2=狼, seat3=狐 の1ワールド
    // 狼吊りで aliveWolves=0 になるが hamsterAlive=true → hamster_win
    const setup = new Map<SystemRole, number>([
      ['villager', 1], ['werewolf', 1], ['werehamster', 1],
    ])
    const seatRoles = new Map([
      [1, ['villager']],
      [2, ['werewolf']],
      [3, ['werehamster']],
    ]) as Map<number, SystemRole[]>
    const possibilities = buildPossibilities(setup, seatRoles)
    const vs = makeVillage(new Map([
      [1, makeSeat()], [2, makeSeat()], [3, makeSeat()],
    ]))

    const result = analyzeExecutionsByWorld(possibilities, setup, vs)
    assert.equal(result.totalWorlds, 1)

    // 狼吊り → hamster_win（村負け）
    const s2 = result.executions.find(e => e.seat === 2)!
    approx(s2.winRate, 0.0, '狼吊っても狐生存 → 狐勝ち')

    // 狐吊り → 3人残り、狼1、狐0 → 夜→PP → 0
    const s3 = result.executions.find(e => e.seat === 3)!
    approx(s3.winRate, 0.0, '狐吊っても狼残る → PP')

    // 村吊り → 狼+狐生存 → PP的に 2w+f=3 >= 3 → 0
    const s1 = result.executions.find(e => e.seat === 1)!
    approx(s1.winRate, 0.0, '村吊り → PP相当')
  })

  it('狐生存: 狼吊り vs 狐吊り vs 村吊りで差が出る盤面', () => {
    // 5人: seat1=村, seat2=狼, seat3=狐, seat4=占, seat5=村
    // 狼が1/残り4、狐1いる。設計狼: 狼吊り=0（狐勝ち）、狐吊り=1.0（狼1 → 夜 → 3人で回る）
    // (狐吊り後: 4人、狼1村3、夜で占い生存→翌日勝率)
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['werewolf', 1], ['werehamster', 1], ['seer', 1],
    ])
    const seatRoles = new Map([
      [1, ['villager']],
      [2, ['werewolf']],
      [3, ['werehamster']],
      [4, ['seer']],
      [5, ['villager']],
    ]) as Map<number, SystemRole[]>
    const possibilities = buildPossibilities(setup, seatRoles)
    const vs = makeVillage(new Map([
      [1, makeSeat()], [2, makeSeat()], [3, makeSeat()],
      [4, makeSeat()], [5, makeSeat()],
    ]))

    const result = analyzeExecutionsByWorld(possibilities, setup, vs)
    assert.equal(result.totalWorlds, 1)

    const s2 = result.executions.find(e => e.seat === 2)! // 狼吊り
    const s3 = result.executions.find(e => e.seat === 3)! // 狐吊り
    const s1 = result.executions.find(e => e.seat === 1)! // 村吊り

    // 狼吊り: 狼全滅だが狐生存 → hamster_win (0.0)
    approx(s2.winRate, 0.0, '狼吊り → 狐勝ち')

    // 狐吊り: 狼1残り、4人(狼1村3占1のうち村3＋占1)、夜→ongoing
    //   占い生存 → 呪殺なし（狐もういない）、狼発見なら勝率UP
    assert.ok(s3.winRate > 0, '狐吊り → 村にチャンスあり')

    // 村吊り: 狼+狐生存 → 勝率は狐吊りより低いはず
    assert.ok(s3.winRate > s1.winRate, '狐吊りが村吊りより優位')

    // 最善手は狐吊り
    assert.equal(result.bestExecution, 3)
  })

  it('狐未生存: 既に退場している狐は勝敗に影響しない', () => {
    // 退場した狐（seat3）は hamsterMask に含まれるが alive に含まれない
    // → (hamsterMask & alive) === 0 なので狐なし扱い
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['werewolf', 1], ['werehamster', 1],
    ])
    const seatRoles = new Map([
      [1, ['villager']],
      [2, ['werewolf']],
      [3, ['werehamster']],
      [4, ['villager']],
    ]) as Map<number, SystemRole[]>
    const possibilities = buildPossibilities(setup, seatRoles)
    const vs = makeVillage(new Map([
      [1, makeSeat()], [2, makeSeat()],
      [3, makeSeat({ surviving: false })], // 狐退場
      [4, makeSeat()],
    ]))

    const result = analyzeExecutionsByWorld(possibilities, setup, vs)
    assert.equal(result.totalWorlds, 1)

    // 狼吊り → 村勝ち (狐退場済みなので村勝ち)
    const s2 = result.executions.find(e => e.seat === 2)!
    approx(s2.winRate, 1.0, '狼吊り + 狐退場済み → 村勝ち')
  })

  // ── 霊媒対応 ──

  it('霊媒生存: 霊媒なしより勝率が高い', () => {
    // 霊媒あり (seat5=medium) vs 霊媒なし (seat5=villager) を比較。
    // 同じ世界構造でも霊媒が確定村扱いになるため、ランダム処刑の命中率が上がる。
    // 霊媒あり: seat2(villager)を処刑 → nextAlive=4, wolves=1, medium(seat5)生存
    //   estimateNextDay: grays=2, confirmed=1(medium) → computeWinRate(2,1,0,1,3)=1/2
    // 霊媒なし: seat2(villager)を処刑 → nextAlive=4, wolves=1, medium不在
    //   estimateNextDay: grays=3, confirmed=0 → computeWinRate(3,1,0,0,3)=1/3
    const setupMedium = new Map<SystemRole, number>([
      ['villager', 3], ['werewolf', 1], ['medium', 1],
    ])
    const seatRolesMedium = new Map([
      [1, ['werewolf']],
      [2, ['villager']],
      [3, ['villager']],
      [4, ['villager']],
      [5, ['medium']],
    ]) as Map<number, SystemRole[]>
    const possibilitiesMedium = buildPossibilities(setupMedium, seatRolesMedium)
    const vsMedium = makeVillage(new Map([
      [1, makeSeat()], [2, makeSeat()], [3, makeSeat()],
      [4, makeSeat()], [5, makeSeat()],
    ]))
    const resultMedium = analyzeExecutionsByWorld(possibilitiesMedium, setupMedium, vsMedium)
    const seat2WithMedium = resultMedium.executions.find(e => e.seat === 2)!

    const setupNoMedium = new Map<SystemRole, number>([
      ['villager', 4], ['werewolf', 1],
    ])
    const seatRolesNoMedium = new Map([
      [1, ['werewolf']],
      [2, ['villager']],
      [3, ['villager']],
      [4, ['villager']],
      [5, ['villager']],
    ]) as Map<number, SystemRole[]>
    const possibilitiesNoMedium = buildPossibilities(setupNoMedium, seatRolesNoMedium)
    const vsNoMedium = makeVillage(new Map([
      [1, makeSeat()], [2, makeSeat()], [3, makeSeat()],
      [4, makeSeat()], [5, makeSeat()],
    ]))
    const resultNoMedium = analyzeExecutionsByWorld(possibilitiesNoMedium, setupNoMedium, vsNoMedium)
    const seat2NoMedium = resultNoMedium.executions.find(e => e.seat === 2)!

    // 霊媒あり: 1/2 = 0.5, 霊媒なし: 1/3 ≈ 0.333
    approx(seat2WithMedium.winRate, 0.5, '霊媒あり: 村吊り勝率=1/2')
    approx(seat2NoMedium.winRate, 1 / 3, '霊媒なし: 村吊り勝率=1/3')
    assert.ok(
      seat2WithMedium.winRate > seat2NoMedium.winRate,
      '霊媒生存で勝率向上',
    )
  })

  it('霊媒黒 (狼吊り確認): 霊媒なしより勝率が高い', () => {
    // 2狼のケース: seat1=wolf, seat2=wolf, seat3=medium, seat4-6=villager (6人)
    // 霊媒あり: seat1(wolf)を処刑 → medium=黒 → mediumBlackBonus=1 → confirmed=2
    //   estimateNextDay(4, 1, 0, false, true, 'wolf', cache):
    //     grays=3, confirmed=2 → computeWinRate(3,1,0,2,4) = 1/3
    // 霊媒なし (seat3=villager): seat1(wolf)を処刑
    //   estimateNextDay(4, 1, 0, false, false, null):
    //     grays=4, confirmed=0 → computeWinRate(4,1,0,0,4) = 1/4
    const setupMedium = new Map<SystemRole, number>([
      ['villager', 3], ['werewolf', 2], ['medium', 1],
    ])
    const seatRolesMedium = new Map([
      [1, ['werewolf']], [2, ['werewolf']],
      [3, ['medium']],
      [4, ['villager']], [5, ['villager']], [6, ['villager']],
    ]) as Map<number, SystemRole[]>
    const possibilitiesMedium = buildPossibilities(setupMedium, seatRolesMedium)
    const vsMedium = makeVillage(new Map([
      [1, makeSeat()], [2, makeSeat()], [3, makeSeat()],
      [4, makeSeat()], [5, makeSeat()], [6, makeSeat()],
    ]))
    const resultMedium = analyzeExecutionsByWorld(possibilitiesMedium, setupMedium, vsMedium)
    // seat1(wolf)処刑の勝率: ongoing (wolf=seat2 still alive), medium=黒
    const seat1WithMedium = resultMedium.executions.find(e => e.seat === 1)!

    const setupNoMedium = new Map<SystemRole, number>([
      ['villager', 4], ['werewolf', 2],
    ])
    const seatRolesNoMedium = new Map([
      [1, ['werewolf']], [2, ['werewolf']],
      [3, ['villager']],
      [4, ['villager']], [5, ['villager']], [6, ['villager']],
    ]) as Map<number, SystemRole[]>
    const possibilitiesNoMedium = buildPossibilities(setupNoMedium, seatRolesNoMedium)
    const vsNoMedium = makeVillage(new Map([
      [1, makeSeat()], [2, makeSeat()], [3, makeSeat()],
      [4, makeSeat()], [5, makeSeat()], [6, makeSeat()],
    ]))
    const resultNoMedium = analyzeExecutionsByWorld(possibilitiesNoMedium, setupNoMedium, vsNoMedium)
    const seat1NoMedium = resultNoMedium.executions.find(e => e.seat === 1)!

    // 霊媒あり=黒: 1/3 ≈ 0.333, 霊媒なし: 1/4 = 0.25
    approx(seat1WithMedium.winRate, 1 / 3, '霊媒黒: 狼吊り後勝率=1/3')
    approx(seat1NoMedium.winRate, 1 / 4, '霊媒なし: 狼吊り後勝率=1/4')
    assert.ok(
      seat1WithMedium.winRate > seat1NoMedium.winRate,
      '霊媒黒で勝率向上',
    )
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
