import { describe, it } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'
import { explain, findReason } from './index.ts'
import { runAnalysis, analyzeSeer } from './analysis.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scenariosDir = join(__dirname, '..', 'retar', 'scenarios')

const defaultOptions: AnalyzeOptions = {
  seerClaimingDueDate: 2,
  mediumClaimingDueDate: 2,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  hasFirstGhost: false,
  assumptions: new Map(),
  hocusPocus: new Map(),
  id: 0,
  batches: 1,
  batch: 0,
}

function loadScenario(file: string) {
  const content = readFileSync(join(scenariosDir, file), 'utf-8').replace(/\r\n/g, '\n')
  const { meta, statements } = parse(content)
  const { vs, setup, players } = buildVillageStatus(statements, meta)
  const options = { ...defaultOptions, ...(meta.options || {}) }
  const retar = new VillageRetar(vs, setup, options)
  const result = retar.analyze()
  const possibilities = result.result

  const seatOf = (name: string) => {
    for (const [seat, n] of players) {
      if (n === name || n.includes(name)) return seat
    }
    throw new Error(`player "${name}" not found`)
  }

  return { vs, setup, players, possibilities, seatOf }
}

describe('gmork integration: mada4', () => {
  const { vs, setup, possibilities, seatOf } = loadScenario('mada4.howl')
  const analysis = runAnalysis(vs, setup, possibilities)

  describe('占い師真贋分析', () => {
    it('占いCO者は4人', () => {
      assert.strictEqual(analysis.seer.candidates.length, 4)
    })

    it('さとし(闇さとし)は破綻', () => {
      const seat = seatOf('闇さとし')
      assert.ok(analysis.seer.busted.has(seat), 'さとしは破綻しているべき')
    })

    it('サターニャは破綻', () => {
      const seat = seatOf('サターニャ')
      assert.ok(analysis.seer.busted.has(seat), 'サターニャは破綻しているべき')
    })

    it('ちせは破綻', () => {
      const seat = seatOf('ちせ')
      assert.ok(analysis.seer.busted.has(seat), 'ちせは破綻しているべき')
    })

    it('考える人は破綻していない → 真占い師確定', () => {
      const seat = seatOf('考える人')
      assert.ok(!analysis.seer.busted.has(seat))
      assert.strictEqual(analysis.seer.confirmed, seat)
    })
  })

  describe('霊媒師真贋分析', () => {
    it('霊媒CO者は1人(羽根帚) → 真霊媒師確定', () => {
      assert.strictEqual(analysis.medium.candidates.length, 1)
      assert.strictEqual(analysis.medium.confirmed, seatOf('羽根帚'))
    })
  })

  describe('真占い師の判定による否定', () => {
    it('羽根帚は人狼ではない (真占い師の白判定)', () => {
      const reason = findReason(vs, setup, seatOf('羽根帚'), 'werewolf', possibilities)
      assert.ok(reason)
      assert.strictEqual(reason.type, 'confirmed_seer_white')
    })

    it('explain出力に真占い師が含まれる', () => {
      const result = explain(vs, setup, seatOf('羽根帚'), 'werewolf', possibilities)
      assert.match(result, /真占い師/)
    })
  })
})

describe('gmork integration: ultimate.5.3', () => {
  const { vs, setup, possibilities, seatOf } = loadScenario('ultimate.5.3.howl')
  const analysis = runAnalysis(vs, setup, possibilities)

  describe('占い師真贋分析', () => {
    it('占いCO者は2人(ダンカン, 中田)', () => {
      assert.strictEqual(analysis.seer.candidates.length, 2)
    })

    it('ダンカンは破綻: 対抗(中田)が襲撃死かつ人外枠不足', () => {
      const seat = seatOf('ダンカン')
      const bust = analysis.seer.busted.get(seat)
      assert.ok(bust)
      assert.strictEqual(bust.type, 'rival_not_wolf_no_evil_slot')
    })

    it('中田が真占い師確定', () => {
      assert.strictEqual(analysis.seer.confirmed, seatOf('中田'))
    })
  })

  describe('占い師真贋分析 (Retar確定なし・Gmork独自推論)', () => {
    // Retar確定を使わず、Gmorkだけで破綻を検出できるか
    const emptyConfirmed = new Map()
    const seerIndependent = analyzeSeer(vs, setup, emptyConfirmed)

    it('ダンカンは破綻: 対抗(中田)が襲撃死かつ人外枠不足', () => {
      const seat = seatOf('ダンカン')
      const bust = seerIndependent.busted.get(seat)
      assert.ok(bust, 'ダンカンはRetar無しでも破綻すべき')
      assert.strictEqual(bust.type, 'rival_not_wolf_no_evil_slot')
    })

    it('Retar無しでも中田が真占い師確定', () => {
      assert.strictEqual(seerIndependent.confirmed, seatOf('中田'))
    })
  })

  describe('霊媒師真贋分析', () => {
    it('霊媒CO者は3人(香川, 児玉, マドック)', () => {
      assert.strictEqual(analysis.medium.candidates.length, 3)
    })

    it('香川は破綻: 視点人外数が超過 (霊媒対抗2+占い1+藤澤黒1+狩人1=5 > 人外4)', () => {
      const bust = analysis.medium.busted.get(seatOf('香川'))
      assert.ok(bust)
      assert.strictEqual(bust.type, 'perspective_liar_budget')
      if (bust.type === 'perspective_liar_budget') {
        assert.strictEqual(bust.needed, 5)
        assert.strictEqual(bust.budget, 4)
        assert.strictEqual(bust.breakdown.length, 4) // 霊媒対抗, 占い偽, 黒判定, 狩人偽
      }
    })

    it('霊媒師は未確定 (児玉・マドックが残り2人で枠1)', () => {
      assert.strictEqual(analysis.medium.confirmed, null)
    })
  })

  describe('真占い師(中田)の判定による否定', () => {
    it('森本は人狼ではない (中田の1d白判定)', () => {
      const reason = findReason(vs, setup, seatOf('森本'), 'werewolf', possibilities)
      assert.ok(reason)
      assert.strictEqual(reason.type, 'confirmed_seer_white')
    })

    it('大野は人狼ではない (中田の4d白判定)', () => {
      const reason = findReason(vs, setup, seatOf('大野'), 'werewolf', possibilities)
      assert.ok(reason)
      assert.strictEqual(reason.type, 'confirmed_seer_white')
    })

    it('結は人狼ではない (中田の3d白判定)', () => {
      const reason = findReason(vs, setup, seatOf('結'), 'werewolf', possibilities)
      assert.ok(reason)
      assert.strictEqual(reason.type, 'confirmed_seer_white')
    })
  })

  describe('偽占い師の結果を信用しない', () => {
    it('香川/werewolf: ダンカン(確定人狼)の白判定を使わない', () => {
      const reason = findReason(vs, setup, seatOf('香川'), 'werewolf', possibilities)
      // ダンカンは確定人狼なので、ダンカンの白判定は無視されるべき
      if (reason && reason.type === 'seer_white') {
        assert.notStrictEqual((reason as any).seerSeat, seatOf('ダンカン'),
          'ダンカン(確定人狼)の占い結果を信用してはいけない')
      }
    })
  })

  describe('偽霊媒師の結果を信用しない', () => {
    it('藤澤/werewolf: 香川(確定狂人)の黒判定を使わない', () => {
      const reason = findReason(vs, setup, seatOf('藤澤'), 'werewolf', possibilities)
      // 香川は確定狂人なので霊媒結果は信用できない
      if (reason && (reason.type === 'medium_black' || reason.type === 'medium_white')) {
        assert.notStrictEqual((reason as any).mediumSeat, seatOf('香川'),
          '香川(確定狂人)の霊媒結果を信用してはいけない')
      }
    })
  })
})
