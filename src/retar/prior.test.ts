import { describe, test } from 'node:test'
import assert from 'node:assert'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from './index.ts'
import type { AnalyzeOptions } from './index.ts'
import type { SystemRole } from '../types/index.ts'

const defaultOptions: AnalyzeOptions = {
  seerClaimingDueDate: 2,
  mediumClaimingDueDate: 2,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  hasFirstGhost: false,
  assumptions: new Map(),
  wolfPairDenyals: [],
  hocusPocus: new Map(),
  id: 0,
  batches: 1,
  batch: 0,
}

// 猫又道連れシナリオ（6人村、全席確定）
const scenario = `配役 狼1 村3 占1 猫1

++村１、狼、村２、占、猫、村３

村１→猫
狼→村１
村２→占
占→村１
猫→狼
村３→狼

村１処刑

猫 死亡
狼 道連れ

村勝利
`

function buildScenario() {
  const { meta, statements } = parse(scenario)
  return buildVillageStatus(statements, meta)
}

describe('prior-based re-analysis', () => {
  test('prior + assumption で通常モードと同じ結果になる', () => {
    const { vs, setup } = buildScenario()

    // 通常モード: seat 2 = werewolf を仮定
    const assumptions = new Map<number, SystemRole>([[2, 'werewolf']])
    const normalRetar = new VillageRetar(vs, setup, { ...defaultOptions, assumptions })
    const normalResult = normalRetar.analyze()

    // priorモード: ベースのanalyze結果を取得し、同じassumptionで再計算
    const baseResult = new VillageRetar(vs, setup, defaultOptions).analyze()
    const priorRetar = new VillageRetar(vs, setup, { ...defaultOptions, assumptions, prior: baseResult.result })
    const priorResult = priorRetar.analyze()

    // 結果が一致すること
    for (const [seat, roles] of normalResult.result) {
      const priorRoles = priorResult.result.get(seat)
      assert.ok(priorRoles, `seat ${seat} missing in prior result`)
      assert.deepStrictEqual(
        [...roles].sort(),
        [...priorRoles].sort(),
        `seat ${seat} mismatch`,
      )
    }
  })

  test('prior + assumption なしでベースと同じ結果になる', () => {
    const { vs, setup } = buildScenario()

    const baseResult = new VillageRetar(vs, setup, defaultOptions).analyze()

    const priorRetar = new VillageRetar(vs, setup, { ...defaultOptions, prior: baseResult.result })
    const priorResult = priorRetar.analyze()

    for (const [seat, roles] of baseResult.result) {
      const priorRoles = priorResult.result.get(seat)
      assert.ok(priorRoles, `seat ${seat} missing in prior result`)
      assert.deepStrictEqual(
        [...roles].sort(),
        [...priorRoles].sort(),
        `seat ${seat} mismatch`,
      )
    }
  })

  test('priorに含まれない役職のassumptionでエラー', () => {
    const { vs, setup } = buildScenario()

    const baseResult = new VillageRetar(vs, setup, defaultOptions).analyze()

    // seat 2(狼) は道連れにより werewolf に確定済み → seer を仮定するとエラー
    const assumptions = new Map<number, SystemRole>([[2, 'seer']])
    assert.throws(
      () => new VillageRetar(vs, setup, { ...defaultOptions, assumptions, prior: baseResult.result }),
      /Prior-based re-analysis/,
    )
  })

  test('矛盾するassumptionでエラー', () => {
    const { vs, setup } = buildScenario()

    const baseResult = new VillageRetar(vs, setup, defaultOptions).analyze()

    // 狼は1人だけの配役で、2席をwerewolfに仮定 → fixRoleで矛盾
    const assumptions = new Map<number, SystemRole>([[1, 'werewolf'], [3, 'werewolf']])
    assert.throws(
      () => new VillageRetar(vs, setup, { ...defaultOptions, assumptions, prior: baseResult.result }),
      /Prior-based re-analysis/,
    )
  })
})
