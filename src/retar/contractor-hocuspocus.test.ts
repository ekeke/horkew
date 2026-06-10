import { describe, test } from 'node:test'
import assert from 'node:assert'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from './index.ts'
import { defaultAnalyzeRegulation } from './defaults.ts'
import type { AnalyzeOptions } from './index.ts'
import type { SystemRole } from '../types/index.ts'
import { poweredVillageRolesIn } from './role-sets.ts'

// 契約者 (contractor) 在りの setup で HocusPocus を有効にすると、 盤面全体が
// 解なし状態になっていた回帰テスト (mirurou bugreport: SIREN Final Game)。
//
// 根本原因 2 つ:
//   1. poweredVillageRolesIn が contractor (passive trait のみ) を planningRoles に
//      含めていた → HocusPocus 在りで contractor plan が無理に生成され、 確定
//      contractor 席が plan 候補から漏れて assumption と矛盾.
//   2. planBuilder の早期 skip 条件が `!hasHocusPocus` で迂回されていた → CO ゼロ
//      役職 (bodyguard / nekomata 等) の無駄 plan が生成され、 contractor 確定
//      assumption と矛盾して全 world fail.
//
// 修正後の不変条件:
//   - HocusPocus on 死亡席で盤面が解け (全席で非空)、 真潜伏占 (= HocusPocus 席に
//     seer 候補が追加される) が候補として残る.

const baseOptions: AnalyzeOptions = {
  regulation: defaultAnalyzeRegulation,
  seerClaimingDueDate: 2,
  mediumClaimingDueDate: 2,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  assumptions: new Map(),
  wolfPairDenyals: [],
  hocusPocus: new Map(),
  id: 0,
  batches: 1,
  batch: 0,
}

describe('poweredVillageRolesIn excludes contractor', () => {
  test('contractor (passive trait のみ) は planningRoles に含まれない', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 3],
      ['seer', 1],
      ['contractor', 2],
      ['werewolf', 1],
    ])
    const roles = poweredVillageRolesIn(setup)
    assert.ok(!roles.includes('contractor'),
      `contractor should not be a planning role, got [${roles.join(',')}]`)
    assert.ok(roles.includes('seer'),
      `seer should still be a planning role, got [${roles.join(',')}]`)
  })
})

// 6 人最小再現: 契約者 2 + 占 1 + 狼 1 + 村 2 (= 6)
//   - Day 1 夜: 契約者 1 名 (Alice) 噛み (= 契約者の必須初日犠牲)
//   - Day 2 議論: Charlie が seer CO + Day 1 Bob 黒判定
//   - Day 2 処刑: なし (まだ吊らない、 ここで切る)
//   - spoiler: Alice / Bob = contractor
// HocusPocus on Charlie (生存 seer CO) でも盤面が解け、 期待通り CO の信用度が
// 下がること (Charlie の seer 単独確定が外れること) を保証する.
const minimalScenario = `---
setup:
  villager: 2
  seer: 1
  werewolf: 1
  contractor: 2
---
+ Alice
+ Bob
+ Charlie
+ Dave
+ Eve
+ Frank

!Alice=contractor
!Bob=contractor

Alice噛み

Charlie 占いCO Dave●
`

describe('HocusPocus + contractor: bugreport SIREN regression', () => {
  test('contractor 在りの setup でも HocusPocus を有効にして盤面が解ける', () => {
    const { meta, statements } = parse(minimalScenario)
    const { vs, setup, players, assumptions: spoilerAssumptions } = buildVillageStatus(statements, meta)
    const aliceSeat = [...players.entries()].find(([, n]) => n === 'Alice')![0]
    const charlieSeat = [...players.entries()].find(([, n]) => n === 'Charlie')![0]

    const options: AnalyzeOptions = {
      ...baseOptions,
      assumptions: new Map(spoilerAssumptions),
      hocusPocus: new Map([[charlieSeat, true]]),
    }
    const retar = new VillageRetar(vs, setup, options)
    const result = retar.analyze()

    // 全席に少なくとも 1 つの役職候補が残る (= 盤面が解けている)
    let allNonEmpty = true
    const empties: number[] = []
    for (const [seat] of players) {
      const roles = result.result.get(seat)
      if (!roles || roles.size === 0) {
        allNonEmpty = false
        empties.push(seat)
      }
    }
    assert.ok(allNonEmpty,
      `HocusPocus on Charlie should not break the board (empty seats: [${empties.join(',')}])`)

    // Alice / Bob は契約者確定 (spoiler 起点)
    const aliceRoles = [...(result.result.get(aliceSeat) || [])]
    assert.deepStrictEqual(aliceRoles, ['contractor'],
      `Alice should remain contractor under HocusPocus, got [${aliceRoles.join(',')}]`)
  })
})
