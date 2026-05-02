import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyDayBonus,
  factionDayBonusSign,
  readDayBonusCoefFromEnv,
} from './day-bonus.ts'
import { outcomeToValue, outcomeDistToFactionValue } from '../mcts/ISMCTS.ts'

describe('factionDayBonusSign', () => {
  it('village は +1 (長期化希望)', () => {
    assert.equal(factionDayBonusSign('village'), +1)
  })
  it('wolf は +1 (狐入り村で長期化希望)', () => {
    assert.equal(factionDayBonusSign('wolf'), +1)
  })
  it('hamster は -1 (短期決着希望)', () => {
    assert.equal(factionDayBonusSign('hamster'), -1)
  })
})

describe('applyDayBonus', () => {
  it('coef=0 で no-op (基本的に既存挙動維持)', () => {
    assert.equal(applyDayBonus(1.0, 'village', 7, 0), 1.0)
    assert.equal(applyDayBonus(-2.0, 'hamster', 7, 0), -2.0)
  })
  it('day=0 でも no-op', () => {
    assert.equal(applyDayBonus(1.0, 'village', 0, 0.02), 1.0)
    assert.equal(applyDayBonus(1.0, 'hamster', 0, 0.02), 1.0)
  })
  it('village は day×coef だけ加算', () => {
    assert.ok(Math.abs(applyDayBonus(1.0, 'village', 7, 0.02) - (1.0 + 0.14)) < 1e-9)
  })
  it('wolf も day×coef だけ加算 (狐入りで長期化希望)', () => {
    assert.ok(Math.abs(applyDayBonus(1.0, 'wolf', 7, 0.02) - (1.0 + 0.14)) < 1e-9)
  })
  it('hamster は day×coef だけ減算', () => {
    assert.ok(Math.abs(applyDayBonus(1.0, 'hamster', 7, 0.02) - (1.0 - 0.14)) < 1e-9)
  })
  it('負の base value にも正しく加算', () => {
    assert.ok(Math.abs(applyDayBonus(-1.0, 'village', 5, 0.02) - (-1.0 + 0.10)) < 1e-9)
  })
})

describe('outcomeToValue with day bonus (互換性)', () => {
  it('既存呼び出し (day/coef 省略) は変更なし', () => {
    assert.equal(outcomeToValue('village_win', 'village'), 1.0)
    assert.equal(outcomeToValue('hamster_win', 'village'), -2.0)
    assert.equal(outcomeToValue('hamster_win', 'wolf'), -1.5)
    assert.equal(outcomeToValue('village_win', 'hamster'), -1.0)
    assert.equal(outcomeToValue(null, 'village'), 0)
  })
  it('coef=0 は既存と同じ', () => {
    assert.equal(outcomeToValue('village_win', 'village', 7, 0), 1.0)
    assert.equal(outcomeToValue('hamster_win', 'hamster', 7, 0), 1.0)
  })
  it('day と coef を渡すと bonus が乗る', () => {
    assert.ok(Math.abs(outcomeToValue('village_win', 'village', 7, 0.02) - (1.0 + 0.14)) < 1e-9)
    assert.ok(Math.abs(outcomeToValue('hamster_win', 'hamster', 7, 0.02) - (1.0 - 0.14)) < 1e-9)
    assert.ok(Math.abs(outcomeToValue('village_win', 'wolf', 5, 0.02) - (-1.0 + 0.10)) < 1e-9)
  })
  it('null outcome は day bonus に関わらず 0', () => {
    assert.equal(outcomeToValue(null, 'village', 7, 0.02), 0)
  })
})

describe('outcomeDistToFactionValue with day bonus (互換性)', () => {
  it('既存呼び出し (day/coef 省略) は変更なし', () => {
    const dist = new Float32Array([1, 0, 0, 0])  // village_win 確定
    assert.equal(outcomeDistToFactionValue(dist, 'village'), 1.0)
  })
  it('day bonus は base に 1 回だけ加算 (二重加算しない)', () => {
    // dist = [0.5 village_win, 0.5 wolf_win, 0, 0]
    // village 視点 base = 0.5*1 + 0.5*(-1) = 0
    // bonus = +1 * 0.02 * 7 = 0.14
    const dist = new Float32Array([0.5, 0.5, 0, 0])
    assert.ok(Math.abs(outcomeDistToFactionValue(dist, 'village', 7, 0.02) - 0.14) < 1e-6)
  })
  it('hamster faction では bonus が負', () => {
    const dist = new Float32Array([0, 0, 1, 0])  // hamster_win 確定
    // base = 1.0、bonus = -0.02*7 = -0.14
    assert.ok(Math.abs(outcomeDistToFactionValue(dist, 'hamster', 7, 0.02) - (1.0 - 0.14)) < 1e-6)
  })
  it('undefined dist は 0 (bonus も乗らない)', () => {
    assert.equal(outcomeDistToFactionValue(undefined, 'village', 7, 0.02), 0)
  })
})

describe('readDayBonusCoefFromEnv', () => {
  it('未設定なら 0', () => {
    const prev = process.env.SKOLLZ_DAY_BONUS_COEF
    delete process.env.SKOLLZ_DAY_BONUS_COEF
    assert.equal(readDayBonusCoefFromEnv(), 0)
    if (prev !== undefined) process.env.SKOLLZ_DAY_BONUS_COEF = prev
  })
  it('正常な数値はそのまま返す', () => {
    const prev = process.env.SKOLLZ_DAY_BONUS_COEF
    process.env.SKOLLZ_DAY_BONUS_COEF = '0.02'
    assert.equal(readDayBonusCoefFromEnv(), 0.02)
    if (prev !== undefined) process.env.SKOLLZ_DAY_BONUS_COEF = prev
    else delete process.env.SKOLLZ_DAY_BONUS_COEF
  })
  it('不正値は 0 にフォールバック', () => {
    const prev = process.env.SKOLLZ_DAY_BONUS_COEF
    process.env.SKOLLZ_DAY_BONUS_COEF = 'abc'
    assert.equal(readDayBonusCoefFromEnv(), 0)
    if (prev !== undefined) process.env.SKOLLZ_DAY_BONUS_COEF = prev
    else delete process.env.SKOLLZ_DAY_BONUS_COEF
  })
})
