import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyDayBonus,
  applyNarrowBonus,
  factionDayBonusSign,
  narrowProgress,
  readDayBonusCoefFromEnv,
  readEndgameBonusCoefFromEnv,
  readNarrowBonusCoefFromEnv,
} from './day-bonus.ts'
import { outcomeToValue, outcomeDistToFactionValue } from '../mcts/ISMCTS.ts'
import { sumAlivePossibilities, viewerFoxAlive } from '../observation/from-sim-state.ts'
import type { SystemRole } from '../../types/index.ts'

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
  it('既存呼び出し (day/coef 省略) は変更なし — 案 A の lose ペナルティ強化込み', () => {
    assert.equal(outcomeToValue('village_win', 'village'), 1.0)
    assert.equal(outcomeToValue('wolf_win', 'village'), -1.3)  // 案 A: -1.0 → -1.3
    assert.equal(outcomeToValue('hamster_win', 'village'), -2.0)
    assert.equal(outcomeToValue('village_win', 'wolf'), -1.3)  // 案 A: -1.0 → -1.3
    assert.equal(outcomeToValue('hamster_win', 'wolf'), -1.5)
    assert.equal(outcomeToValue('village_win', 'hamster'), -1.0)
    assert.equal(outcomeToValue('wolf_win', 'hamster'), -1.0)
    assert.equal(outcomeToValue(null, 'village'), 0)
  })
  it('coef=0 は既存と同じ', () => {
    assert.equal(outcomeToValue('village_win', 'village', 7, 0), 1.0)
    assert.equal(outcomeToValue('hamster_win', 'hamster', 7, 0), 1.0)
  })
  it('day と coef を渡すと bonus が乗る', () => {
    assert.ok(Math.abs(outcomeToValue('village_win', 'village', 7, 0.02) - (1.0 + 0.14)) < 1e-9)
    assert.ok(Math.abs(outcomeToValue('hamster_win', 'hamster', 7, 0.02) - (1.0 - 0.14)) < 1e-9)
    assert.ok(Math.abs(outcomeToValue('village_win', 'wolf', 5, 0.02) - (-1.3 + 0.10)) < 1e-9)
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
  it('day bonus は base に 1 回だけ加算 (二重加算しない、lose=-1.3 込み)', () => {
    // dist = [0.5 village_win, 0.5 wolf_win, 0, 0]
    // village 視点 base = 0.5*1 + 0.5*(-1.3) = -0.15 (案 A の lose ペナルティ強化込み)
    // bonus = +1 * 0.02 * 7 = 0.14 → -0.01
    const dist = new Float32Array([0.5, 0.5, 0, 0])
    assert.ok(Math.abs(outcomeDistToFactionValue(dist, 'village', 7, 0.02) - (-0.01)) < 1e-6)
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

describe('applyDayBonus with foxAliveByViewer + endgameCoef', () => {
  it('village + foxAlive=true は day×coef を加算', () => {
    const v = applyDayBonus(0, 'village', 7, 0.02, { foxAliveByViewer: true, endgameCoef: 0.30 })
    assert.ok(Math.abs(v - 0.14) < 1e-9)
  })
  it('village + foxAlive=false は endgameCoef 固定 (day 不問)', () => {
    const v = applyDayBonus(0, 'village', 7, 0.02, { foxAliveByViewer: false, endgameCoef: 0.30 })
    assert.ok(Math.abs(v - 0.30) < 1e-9)
    // day=15 でも同じ値 (累積しない)
    const v15 = applyDayBonus(0, 'village', 15, 0.02, { foxAliveByViewer: false, endgameCoef: 0.30 })
    assert.ok(Math.abs(v15 - 0.30) < 1e-9)
  })
  it('wolf も同じ条件分岐 (village と同 formula)', () => {
    const alive = applyDayBonus(0, 'wolf', 7, 0.02, { foxAliveByViewer: true, endgameCoef: 0.30 })
    const dead = applyDayBonus(0, 'wolf', 7, 0.02, { foxAliveByViewer: false, endgameCoef: 0.30 })
    assert.ok(Math.abs(alive - 0.14) < 1e-9)
    assert.ok(Math.abs(dead - 0.30) < 1e-9)
  })
  it('hamster は foxAliveByViewer に依らず -coef×day で一貫', () => {
    const a = applyDayBonus(0, 'hamster', 7, 0.02, { foxAliveByViewer: true, endgameCoef: 0.30 })
    const b = applyDayBonus(0, 'hamster', 7, 0.02, { foxAliveByViewer: false, endgameCoef: 0.30 })
    assert.ok(Math.abs(a - (-0.14)) < 1e-9)
    assert.ok(Math.abs(b - (-0.14)) < 1e-9)
  })
  it('coef=0 + endgameCoef=0 で no-op (互換)', () => {
    assert.equal(applyDayBonus(1.0, 'village', 7, 0, { foxAliveByViewer: false, endgameCoef: 0 }), 1.0)
  })
  it('opts 省略時は foxAliveByViewer=true 扱い (互換)', () => {
    assert.ok(Math.abs(applyDayBonus(0, 'village', 7, 0.02) - 0.14) < 1e-9)
  })
})

describe('viewerFoxAlive', () => {
  it('生存席に werehamster 候補があれば true', () => {
    const possibilities = new Map<number, Set<string>>([
      [1, new Set(['villager'])],
      [2, new Set(['werehamster', 'villager'])],
    ])
    const alive = (1 << 1) | (1 << 2)
    // @ts-expect-error: SystemRole のテスト用に string Set を渡す
    assert.equal(viewerFoxAlive(possibilities, alive), true)
  })
  it('生存席で werehamster 候補が消えれば false (= 観測上 fox 死亡確認)', () => {
    const possibilities = new Map<number, Set<string>>([
      [1, new Set(['villager'])],
      [2, new Set(['werewolf'])],
    ])
    const alive = (1 << 1) | (1 << 2)
    // @ts-expect-error: SystemRole のテスト用に string Set を渡す
    assert.equal(viewerFoxAlive(possibilities, alive), false)
  })
  it('werehamster 候補が死亡席にしか居なければ false (生存席のみ判定)', () => {
    const possibilities = new Map<number, Set<string>>([
      [1, new Set(['villager'])],
      [2, new Set(['werehamster'])],  // seat 2 は alive じゃない
    ])
    const alive = (1 << 1)  // seat 1 のみ生存
    // @ts-expect-error: SystemRole のテスト用に string Set を渡す
    assert.equal(viewerFoxAlive(possibilities, alive), false)
  })
  it('possibilities=null は default true (互換、保守側)', () => {
    assert.equal(viewerFoxAlive(null, 0xFFFF), true)
  })
})

describe('readEndgameBonusCoefFromEnv', () => {
  it('未設定なら 0', () => {
    const prev = process.env.SKOLLZ_ENDGAME_BONUS_COEF
    delete process.env.SKOLLZ_ENDGAME_BONUS_COEF
    assert.equal(readEndgameBonusCoefFromEnv(), 0)
    if (prev !== undefined) process.env.SKOLLZ_ENDGAME_BONUS_COEF = prev
  })
  it('正常な数値はそのまま返す', () => {
    const prev = process.env.SKOLLZ_ENDGAME_BONUS_COEF
    process.env.SKOLLZ_ENDGAME_BONUS_COEF = '0.30'
    assert.equal(readEndgameBonusCoefFromEnv(), 0.30)
    if (prev !== undefined) process.env.SKOLLZ_ENDGAME_BONUS_COEF = prev
    else delete process.env.SKOLLZ_ENDGAME_BONUS_COEF
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

describe('narrowProgress', () => {
  it('rootSum=null は 0 (no-op)', () => {
    assert.equal(narrowProgress(null, 50, 14), 0)
    assert.equal(narrowProgress(undefined, 50, 14), 0)
  })
  it('leafSum=null は 0 (no-op)', () => {
    assert.equal(narrowProgress(100, null, 14), 0)
    assert.equal(narrowProgress(100, undefined, 14), 0)
  })
  it('aliveCount=0 は 0', () => {
    assert.equal(narrowProgress(100, 50, 0), 0)
  })
  it('縮小なし (delta<=0) は 0 (拡大は報酬しない)', () => {
    assert.equal(narrowProgress(50, 50, 14), 0)
    assert.equal(narrowProgress(50, 80, 14), 0)
  })
  it('正規化: delta / (alive×11) を返す', () => {
    // alive=14, delta=154 → 154 / (14×11) = 1.0
    assert.equal(narrowProgress(154, 0, 14), 1)
    // alive=14, delta=77 → 77 / 154 = 0.5
    assert.equal(narrowProgress(77 + 50, 50, 14), 0.5)
  })
  it('progress > 1 は 1 に clamp', () => {
    // alive=2, delta=100, denom=22 → 100/22 ≈ 4.5 → 1.0
    assert.equal(narrowProgress(100, 0, 2), 1)
  })
})

describe('applyNarrowBonus', () => {
  it('coef=0 で no-op', () => {
    assert.equal(applyNarrowBonus(1.0, 'village', 0.5, 0), 1.0)
    assert.equal(applyNarrowBonus(-2.0, 'wolf', 0.5, 0), -2.0)
  })
  it('progress=0 で no-op', () => {
    assert.equal(applyNarrowBonus(1.0, 'village', 0, 0.05), 1.0)
  })
  it('village は coef×progress を加算', () => {
    assert.ok(Math.abs(applyNarrowBonus(0.5, 'village', 0.4, 0.05) - (0.5 + 0.02)) < 1e-9)
    assert.ok(Math.abs(applyNarrowBonus(-1.0, 'village', 1.0, 0.10) - (-1.0 + 0.10)) < 1e-9)
  })
  it('wolf は据え置き (非対称設計、handoff 2026-05-05)', () => {
    assert.equal(applyNarrowBonus(0.5, 'wolf', 0.5, 0.05), 0.5)
    assert.equal(applyNarrowBonus(-1.0, 'wolf', 1.0, 0.10), -1.0)
  })
  it('hamster も据え置き', () => {
    assert.equal(applyNarrowBonus(0.5, 'hamster', 0.5, 0.05), 0.5)
  })
})

describe('sumAlivePossibilities', () => {
  it('possibilities=null は null', () => {
    assert.equal(sumAlivePossibilities(null, 0xFFFF), null)
  })
  it('生存席のみ集計 (死亡席は無視)', () => {
    const map = new Map<number, Set<SystemRole>>([
      [1, new Set(['villager', 'seer']) as Set<SystemRole>],            // alive: +2
      [2, new Set(['villager', 'seer', 'medium']) as Set<SystemRole>],  // dead:  +0
      [3, new Set(['villager']) as Set<SystemRole>],                    // alive: +1
    ])
    const alive = (1 << 1) | (1 << 3)  // seat 1, 3 のみ生存
    assert.equal(sumAlivePossibilities(map, alive), 3)
  })
  it('全席生存なら全集計', () => {
    const map = new Map<number, Set<SystemRole>>([
      [1, new Set(['villager']) as Set<SystemRole>],
      [2, new Set(['villager', 'seer']) as Set<SystemRole>],
    ])
    const alive = (1 << 1) | (1 << 2)
    assert.equal(sumAlivePossibilities(map, alive), 3)
  })
  it('空 map は 0', () => {
    assert.equal(sumAlivePossibilities(new Map(), 0xFFFF), 0)
  })
})

describe('readNarrowBonusCoefFromEnv', () => {
  it('未設定なら 0', () => {
    const prev = process.env.SKOLLZ_NARROW_COEF
    delete process.env.SKOLLZ_NARROW_COEF
    assert.equal(readNarrowBonusCoefFromEnv(), 0)
    if (prev !== undefined) process.env.SKOLLZ_NARROW_COEF = prev
  })
  it('正常な数値はそのまま返す', () => {
    const prev = process.env.SKOLLZ_NARROW_COEF
    process.env.SKOLLZ_NARROW_COEF = '0.05'
    assert.equal(readNarrowBonusCoefFromEnv(), 0.05)
    if (prev !== undefined) process.env.SKOLLZ_NARROW_COEF = prev
    else delete process.env.SKOLLZ_NARROW_COEF
  })
  it('不正値は 0 にフォールバック', () => {
    const prev = process.env.SKOLLZ_NARROW_COEF
    process.env.SKOLLZ_NARROW_COEF = 'abc'
    assert.equal(readNarrowBonusCoefFromEnv(), 0)
    if (prev !== undefined) process.env.SKOLLZ_NARROW_COEF = prev
    else delete process.env.SKOLLZ_NARROW_COEF
  })
})
