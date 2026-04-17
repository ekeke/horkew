import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeWinRate } from './winrate.ts'
import { buildBranches } from './branches.ts'
import { analyzeExecutions } from './analysis.ts'
import type { VillageStatus, SeatStatus, SystemRole } from '../types/index.ts'

// ── ヘルパー ──

const EPSILON = 1e-10

function approx(actual: number, expected: number, message?: string) {
  assert.ok(
    Math.abs(actual - expected) < EPSILON,
    message ?? `expected ${expected}, got ${actual}`,
  )
}

/** 最小限の SeatStatus を作る */
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

/** 最小限の VillageStatus を作る */
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

// ══════════════════════════════════════════════
// winrate.ts 単体テスト
// ══════════════════════════════════════════════

describe('computeWinRate', () => {
  it('最終日 グレー3 狼1 → 1/3', () => {
    // 4人生存: 確定村1 + グレー3（うち狼1）
    // rope = floor(3/2) = 1
    approx(computeWinRate(3, 1, 0, 1, 4), 1 / 3)
  })

  it('狼0 → 勝率1.0', () => {
    approx(computeWinRate(3, 0, 0, 1, 4), 1.0)
  })

  it('PP → 勝率0.0', () => {
    // 4人生存、グレー2、狼2 → PP (2*2 >= 4)
    approx(computeWinRate(2, 2, 0, 0, 4), 0.0)
  })

  it('6人 グレー4 狼2 確定村0 → 勝率計算', () => {
    // 6人、rope = 2
    // 吊りで狼引く確率 2/4 = 1/2
    //   命中: 5人、グレー3、狼1、夜で confirmed=0 → グレー噛み → 4人グレー2狼1
    //         → rope=1, pHit=1/2, 命中で勝ち、ハズレで3人グレー1狼1 → PP
    //         → 1/2
    //   ハズレ: 5人、グレー3、狼2、夜でグレー噛み → 4人グレー2狼2 → PP → 0
    // 勝率 = 1/2 * 1/2 + 1/2 * 0 = 1/4
    approx(computeWinRate(4, 2, 0, 0, 6), 1 / 4)
  })

  it('6人 グレー4 狼2 確定村2 → confirmed 噛みモデル', () => {
    // 6人生存: 確定村2 + グレー4（うち狼2）
    // rope = floor(5/2) = 2
    // 命中(2/4): 夜→confirmed噛み → grays=3, wolves=1, confirmed=1, alive=4
    //   rope=1, pHit=1/3, 命中→最後の狼→1.0
    //   ハズレ→ grays=2,wolves=1,confirmed=0,alive=2 → PP → 0
    //   → 1/3
    // ハズレ(2/4): 夜→confirmed噛み → grays=3, wolves=2, confirmed=1, alive=4
    //   PP判定: 2*2=4 >= 4 → PP → 0.0
    // 勝率 = 1/2 * 1/3 + 1/2 * 0 = 1/6
    approx(computeWinRate(4, 2, 0, 2, 6), 1 / 6)
  })

  it('rope=0 → 0.0', () => {
    // alive=1, rope=0
    approx(computeWinRate(1, 1, 0, 0, 1), 0.0)
  })

  it('grays=1 wolves=1 最終日', () => {
    // 2人: グレー1（狼）+ 確定村0? alive=2
    // PP: 1*2 >= 2 → true → 0.0
    approx(computeWinRate(1, 1, 0, 0, 2), 0.0)
    // 3人: グレー1（狼）+ 確定村1, alive=3
    // rope=1, pHit=1/1=1.0, 最後の狼→1.0
    approx(computeWinRate(1, 1, 0, 1, 3), 1.0)
  })

  // ── 狐対応 ──

  it('狼0 + 狐1 → 狐勝ち (0.0)', () => {
    approx(computeWinRate(1, 0, 1, 0, 2), 0.0)
  })

  it('PP + 狐生存 → 0.0（狐勝ち）', () => {
    // 3人: 狼1+狐1+村1, 2w+f=3 >= 3 → PP(狐勝ち)
    approx(computeWinRate(3, 1, 1, 0, 3), 0.0)
  })

  it('最終日 グレー3 狼1 狐1 → 狐がいるので勝率低下', () => {
    // 4人、グレー3（狼1狐1村1）、確定村1、rope=1
    // 処刑:
    //   狼命中 (1/3): 最後の狼だが狐生存 → 0
    //   狐命中 (1/3): grays=2 (狼1村1), foxes=0, 夜→confirmed噛み → grays=2,wolves=1,conf=0,alive=2 → PP → 0
    //   ハズレ (1/3): grays=2 (狼1狐1), foxes=1, 夜→confirmed噛み → grays=2,wolves=1,foxes=1,conf=0,alive=2 → 2w+f=3>=2 PP → 0
    // 勝率 = 0
    approx(computeWinRate(3, 1, 1, 1, 4), 0.0)
  })

  it('6人 グレー5 狼1 狐1 確定村1 → 狐処刑で勝ち筋', () => {
    // 6人、グレー5（狼1狐1村3）、確定村1、rope=2
    // 狐命中 (1/5): grays=4(狼1村3), foxes=0, conf=1, alive=5
    //   夜 confirmed 噛み → grays=4,wolves=1,foxes=0,conf=0,alive=4 → rope=1
    //   pHit=1/4, 命中=最後狼→1.0, ハズレ=grays=3,wolves=1,alive=3 PP=0
    //   = 1/4
    // 狼命中 (1/5): 最後の狼だが狐生存 → 0
    // ハズレ (3/5): grays=4(狼1狐1村2), foxes=1, conf=1, alive=5
    //   夜 confirmed 噛み → grays=4,wolves=1,foxes=1,conf=0,alive=4 → 2w+f=3<4 ok, rope=1
    //   pHit_wolf=1/4→最後狼だが狐生存=0, pHit_fox=1/4→grays=3(狼1村2),foxes=0,alive=3 夜? wolves=1
    //     applyNightBite(grays=3,w=1,f=0,conf=0,alive=3): gnwnf=2>0 → grays=2,w=1,alive=2 PP=0
    //     = 0
    //   pMiss=2/4 → grays=3(狼1狐1村1),foxes=1,alive=3 → 2w+f=3>=3 PP=0
    //   すべて0
    // 合計 = 1/5 * 1/4 = 1/20 = 0.05
    approx(computeWinRate(5, 1, 1, 1, 6), 0.05)
  })
})

// ══════════════════════════════════════════════
// branches.ts テスト
// ══════════════════════════════════════════════

describe('buildBranches', () => {
  it('CO なし → 全員グレーの単一分岐', () => {
    const seats = new Map([
      [1, makeSeat()],
      [2, makeSeat()],
      [3, makeSeat()],
    ])
    const vs = makeVillage(seats)
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['werewolf', 1],
    ])

    const branches = buildBranches(vs, setup)
    assert.equal(branches.length, 1)
    assert.equal(branches[0].trueSeer, null)
    assert.equal(branches[0].classification.grayCount, 3)
    assert.equal(branches[0].classification.wolvesInGray, 1)
  })

  it('占い2CO → 2分岐', () => {
    // A(seat1): 占いCO、seat3に黒
    // B(seat2): 占いCO、seat4に黒
    // seat3-6: 一般市民
    // seat7,8: 共有CO
    const seats = new Map([
      [1, makeSeat({
        claiming: true, claimingRole: 'seer',
        assertions: new Map([[1, { target: 3, species: 'wolf' as const }]]),
      })],
      [2, makeSeat({
        claiming: true, claimingRole: 'seer',
        assertions: new Map([[1, { target: 4, species: 'wolf' as const }]]),
      })],
      [3, makeSeat()],
      [4, makeSeat()],
      [5, makeSeat()],
      [6, makeSeat()],
      [7, makeSeat({ claiming: true, claimingRole: 'mason' })],
      [8, makeSeat({ claiming: true, claimingRole: 'mason' })],
    ])
    const vs = makeVillage(seats)
    const setup = new Map<SystemRole, number>([
      ['villager', 3], ['seer', 1], ['mason', 2], ['werewolf', 2],
    ])

    const branches = buildBranches(vs, setup)
    assert.equal(branches.length, 2)

    // 分岐0: seat1 が真占い
    const b0 = branches[0]
    assert.equal(b0.trueSeer, 1)
    assert.deepEqual(b0.fakeSeats, [2])
    assert.equal(b0.classification.categories.get(1), 'confirmed_village') // 真占い
    assert.equal(b0.classification.categories.get(3), 'confirmed_wolf')   // A の黒先
    assert.equal(b0.classification.categories.get(2), 'gray')             // 偽占い
    assert.equal(b0.classification.categories.get(7), 'confirmed_village') // 共有
    assert.equal(b0.classification.categories.get(8), 'confirmed_village') // 共有

    // 分岐1: seat2 が真占い
    const b1 = branches[1]
    assert.equal(b1.trueSeer, 2)
    assert.equal(b1.classification.categories.get(4), 'confirmed_wolf')   // B の黒先
    assert.equal(b1.classification.categories.get(1), 'gray')             // 偽占い
  })

  it('単独占いCO → 単一分岐で結果適用', () => {
    const seats = new Map([
      [1, makeSeat({
        claiming: true, claimingRole: 'seer',
        assertions: new Map([
          [1, { target: 3, species: 'wolf' as const }],
          [2, { target: 4, species: 'human' as const }],
        ]),
      })],
      [2, makeSeat()],
      [3, makeSeat()],
      [4, makeSeat()],
      [5, makeSeat()],
    ])
    const vs = makeVillage(seats)
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['seer', 1], ['werewolf', 2],
    ])

    const branches = buildBranches(vs, setup)
    assert.equal(branches.length, 1)
    assert.equal(branches[0].classification.categories.get(3), 'confirmed_wolf')
    assert.equal(branches[0].classification.categories.get(4), 'confirmed_village')
    assert.equal(branches[0].classification.categories.get(1), 'confirmed_village') // 真占い自身
    assert.equal(branches[0].classification.categories.get(2), 'gray')
    assert.equal(branches[0].classification.categories.get(5), 'gray')
    assert.equal(branches[0].classification.wolvesInGray, 1) // 2狼 - 1確定狼
  })
})

// ══════════════════════════════════════════════
// analyzeExecutions 統合テスト
// ══════════════════════════════════════════════

describe('analyzeExecutions', () => {
  it('最終日 共有+グレー3: グレー吊り勝率 1/3, 共有吊り勝率 0', () => {
    // 4人生存: 共有(1), グレー(2,3,4), 狼1
    const seats = new Map([
      [1, makeSeat({ claiming: true, claimingRole: 'mason' })],
      [2, makeSeat()],
      [3, makeSeat()],
      [4, makeSeat()],
    ])
    const vs = makeVillage(seats)
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['mason', 1], ['werewolf', 1],
    ])

    const result = analyzeExecutions(vs, setup)

    // 共有を吊る → 勝率 0（PP になる）
    const masonExec = result.executions.find(e => e.seat === 1)!
    approx(masonExec.winRate, 0.0, 'mason execution should be 0')

    // グレーを吊る → 勝率 1/3
    for (const seat of [2, 3, 4]) {
      const ex = result.executions.find(e => e.seat === seat)!
      approx(ex.winRate, 1 / 3, `gray seat ${seat} should be 1/3`)
    }

    // 最善手はグレーのどれか
    assert.ok([2, 3, 4].includes(result.bestExecution))
  })

  it('確定狼がいる場合 → 確定狼吊りが最善', () => {
    // 5人: 占い(1), 確定狼(2, 占いが黒), グレー(3,4,5), 狼2
    const seats = new Map([
      [1, makeSeat({
        claiming: true, claimingRole: 'seer',
        assertions: new Map([[1, { target: 2, species: 'wolf' as const }]]),
      })],
      [2, makeSeat()],
      [3, makeSeat()],
      [4, makeSeat()],
      [5, makeSeat()],
    ])
    const vs = makeVillage(seats)
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['seer', 1], ['werewolf', 2],
    ])

    const result = analyzeExecutions(vs, setup)

    // 確定狼吊りの勝率が最も高いはず
    const wolfExec = result.executions.find(e => e.seat === 2)!
    for (const ex of result.executions) {
      if (ex.seat !== 2) {
        assert.ok(
          wolfExec.winRate >= ex.winRate,
          `wolf execution (${wolfExec.winRate}) should be >= seat ${ex.seat} (${ex.winRate})`,
        )
      }
    }
    assert.equal(result.bestExecution, 2)
  })

  it('占いA/B 矛盾: C,D を吊る勝率が最高', () => {
    // 会話の例:
    // A(1): 占いCO、C(3)に黒、D(4)に白
    // B(2): 占いCO、D(4)に黒、C(3)に白
    // C(3), D(4), E(5): 一般
    // 共(6), 共(7): 共有
    const seats = new Map([
      [1, makeSeat({
        claiming: true, claimingRole: 'seer',
        assertions: new Map([
          [1, { target: 3, species: 'wolf' as const }],
          [2, { target: 4, species: 'human' as const }],
        ]),
      })],
      [2, makeSeat({
        claiming: true, claimingRole: 'seer',
        assertions: new Map([
          [1, { target: 4, species: 'wolf' as const }],
          [2, { target: 3, species: 'human' as const }],
        ]),
      })],
      [3, makeSeat()],
      [4, makeSeat()],
      [5, makeSeat()],
      [6, makeSeat({ claiming: true, claimingRole: 'mason' })],
      [7, makeSeat({ claiming: true, claimingRole: 'mason' })],
    ])
    const vs = makeVillage(seats)
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['seer', 1], ['mason', 2], ['werewolf', 2],
    ])

    const result = analyzeExecutions(vs, setup)

    // C(3) と D(4) の吊り勝率は等しく、他より高いはず
    const cExec = result.executions.find(e => e.seat === 3)!
    const dExec = result.executions.find(e => e.seat === 4)!
    approx(cExec.winRate, dExec.winRate, 'C and D should have equal win rates')

    // E(5) や 占い(1,2) よりも C,D が良い
    for (const seat of [1, 2, 5]) {
      const ex = result.executions.find(e => e.seat === seat)!
      assert.ok(
        cExec.winRate >= ex.winRate,
        `C/D execution (${cExec.winRate}) should be >= seat ${seat} (${ex.winRate})`,
      )
    }
  })

  it('CO なし → fallback=true, 全員均等', () => {
    const seats = new Map([
      [1, makeSeat()],
      [2, makeSeat()],
      [3, makeSeat()],
    ])
    const vs = makeVillage(seats)
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['werewolf', 1],
    ])

    const result = analyzeExecutions(vs, setup)
    assert.equal(result.fallback, true)

    // 全員グレーなので全員同じ勝率
    const rates = result.executions.map(e => e.winRate)
    for (let i = 1; i < rates.length; i++) {
      approx(rates[i], rates[0], `all seats should have same win rate`)
    }
  })
})
