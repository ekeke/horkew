import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from './index.ts'
import type { AnalyzeOptions, AnalyzedPossibilities } from './index.ts'
import { defaultAnalyzeRegulation } from './defaults.ts'
import { resolveRegulation } from '../howl/ruleset.ts'
import type { SystemRole } from '../types/index.ts'
import type { DebugStash } from './finalizer.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scenariosDir = join(__dirname, 'scenarios')

const defaultOptions: AnalyzeOptions = {
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

// 6人2日シナリオ。日付をまたぐ prior チェーンを検証するため、
// 同じゲームの異なる時点で切ったテキストを段階的に作る。
// seat 1=村１、2=猫、3=村２、4=狼、5=占、6=村３
const dayBaseText = `配役 狼1 村3 占1 猫1

++村１、猫、村２、狼、占、村３

村１→村２
猫→村２
村２→占
狼→村２
占→村３
村３→占

村２処刑
`

// Day 1 night: 狼(seat 4) → 占(seat 5)
const day1MorningText = dayBaseText + '\n占 死亡\n'

// Day 2: 猫CO + 投票 + 処刑
const day2EndText = day1MorningText + `
猫 猫CO

村１→狼
猫→村１
狼→村３
村３→村１

村１処刑
`

// Day 2 night: 狼が猫を襲撃 → 道連れで狼確定 → 村勝利
const fullGameText = day2EndText + `
猫 死亡
狼 道連れ

村勝利
`

function build(text: string) {
  const { meta, statements } = parse(text)
  return buildVillageStatus(statements, meta)
}

function freshAnalyze(text: string, extra?: Partial<AnalyzeOptions>) {
  const { vs, setup } = build(text)
  const retar = new VillageRetar(vs, setup, { ...defaultOptions, ...extra })
  const result = retar.analyze()
  return { retar, result }
}

function priorAnalyze(text: string, prior: AnalyzedPossibilities, extra?: Partial<AnalyzeOptions>) {
  const { vs, setup } = build(text)
  const retar = new VillageRetar(vs, setup, { ...defaultOptions, prior, ...extra })
  const result = retar.analyze()
  return { retar, result }
}

function assertSamePossibilities(
  actual: AnalyzedPossibilities,
  expected: AnalyzedPossibilities,
  label: string,
) {
  const actualSeats = [...actual.keys()].sort((a, b) => a - b)
  const expectedSeats = [...expected.keys()].sort((a, b) => a - b)
  assert.deepStrictEqual(actualSeats, expectedSeats, `${label}: seat集合が不一致`)
  for (const seat of expectedSeats) {
    const a = [...actual.get(seat)!].sort()
    const e = [...expected.get(seat)!].sort()
    assert.deepStrictEqual(a, e,
      `${label}: seat ${seat} の possibilities 不一致 expected=[${e.join(',')}] actual=[${a.join(',')}]`)
  }
}

function totalWork(s: DebugStash): number {
  return s.preFinalizeTests
    + Object.values(s.roleTests).reduce((a, b) => a + b, 0)
    + s.finalizerRuns
}

describe('prior across day boundaries', () => {
  test('day1 終了時点の prior を day2 終了時点の retar に渡しても結果が壊れない', () => {
    const { result: priorD1 } = freshAnalyze(dayBaseText)
    const { result: freshD2 } = freshAnalyze(day2EndText)
    const { result: chainedD2 } = priorAnalyze(day2EndText, priorD1.result)
    assertSamePossibilities(chainedD2.result, freshD2.result, 'chained day2 vs fresh day2')
  })

  test('day1 朝（夜襲撃後）の prior を day2 終了時点に渡しても結果が壊れない', () => {
    const { result: priorD1m } = freshAnalyze(day1MorningText)
    const { result: freshD2 } = freshAnalyze(day2EndText)
    const { result: chainedD2 } = priorAnalyze(day2EndText, priorD1m.result)
    assertSamePossibilities(chainedD2.result, freshD2.result, 'chained day2 from day1-morning vs fresh day2')
  })

  test('day2 終了時点の prior を 全ゲーム終了時点に渡しても結果が壊れない', () => {
    const { result: priorD2 } = freshAnalyze(day2EndText)
    const { result: freshFull } = freshAnalyze(fullGameText)
    const { result: chainedFull } = priorAnalyze(fullGameText, priorD2.result)
    assertSamePossibilities(chainedFull.result, freshFull.result, 'chained full vs fresh full')
  })

  test('多段チェーン (day1 → day2 → full) でも fresh full と一致する', () => {
    const { result: priorD1 } = freshAnalyze(dayBaseText)
    const { result: chainedD2 } = priorAnalyze(day2EndText, priorD1.result)
    const { result: chainedFull } = priorAnalyze(fullGameText, chainedD2.result)
    const { result: freshFull } = freshAnalyze(fullGameText)
    assertSamePossibilities(chainedFull.result, freshFull.result, 'multi-step chained full vs fresh full')
  })

  test('prior に含まれる確定席は次の日の retar 結果でも確定したまま保たれる', () => {
    // day2 では seat 2 (猫) が猫又確定。これを prior にして fullGame で再計算 →
    // seat 2 が単一の {nekomata} のままであることを確認する。
    const { result: priorD2 } = freshAnalyze(day2EndText)
    const seat2Prior = priorD2.result.get(2)!
    assert.deepStrictEqual([...seat2Prior].sort(), ['nekomata'], 'day2 で seat 2 が nekomata 確定済みであること')

    const { result: chainedFull } = priorAnalyze(fullGameText, priorD2.result)
    const seat2Chained = chainedFull.result.get(2)!
    assert.deepStrictEqual([...seat2Chained].sort(), ['nekomata'],
      'chained full でも seat 2 が nekomata 確定で維持されていること')
  })

  test('prior 渡しは fresh と比べて探索コストを増やさない（最適化が効いている）', () => {
    // day1 の prior には seat 3 (村２、CO無し処刑) が villager 確定済みなど、
    // day2 の applyFixedPositions 相当の制約が既に焼き込まれている。
    // よって prior 経由の retar は fresh より仕事量が少なくなるべき（少なくとも増えてはいけない）。
    const { result: priorD1 } = freshAnalyze(dayBaseText)
    const { retar: freshRetar } = freshAnalyze(day2EndText)
    const { retar: chainedRetar } = priorAnalyze(day2EndText, priorD1.result)

    const freshWork = totalWork(freshRetar.debugStash)
    const chainedWork = totalWork(chainedRetar.debugStash)

    assert.ok(
      chainedWork <= freshWork,
      `chained work (${chainedWork}) は fresh work (${freshWork}) を超えてはいけない\n`
        + `  fresh:   ${JSON.stringify(freshRetar.debugStash)}\n`
        + `  chained: ${JSON.stringify(chainedRetar.debugStash)}`,
    )
  })

  test('full game の prior（全席確定）を渡すと探索量が大きく削減される', () => {
    // 終局 prior は全席1役職に確定済み → role test は実質スキップされる。
    // 同じ fullGameText に対して fresh と prior 渡しを比較すると、prior 経由は
    // finalizerRuns / role test 回数が劇的に減るはず。
    const { result: priorFull } = freshAnalyze(fullGameText)
    const { retar: freshRetar } = freshAnalyze(fullGameText)
    const { retar: chainedRetar, result: chainedFull } = priorAnalyze(fullGameText, priorFull.result)

    const freshWork = totalWork(freshRetar.debugStash)
    const chainedWork = totalWork(chainedRetar.debugStash)

    assert.ok(
      chainedWork <= freshWork,
      `終局 prior 経由 (${chainedWork}) は fresh (${freshWork}) を超えてはいけない`,
    )
    // 結果も一致（idempotent）
    assertSamePossibilities(chainedFull.result, priorFull.result, 'full prior idempotent')
  })
})

// 役職スライド（CO切替）/ 結果スライド（占い結果の追加・修正）が prior chain に与える影響。
// これらは「過去の時点で正しかった narrowing」が「後の events によって無効化される」ケース。
// prior の possibilities は monotonic narrowing 前提だが、スライドはこの前提を破る可能性がある。
//
// シナリオ: src/retar/scenarios/smabro4.howl
//   - 行 31: むらびと「猫CO」
//   - 行 80: むらびと「占いCO カムイ白 ロックマン黒 ...」← 役職スライド + 結果まとめて後出し
//   - スライド前: @expect solve: false （説明可能な世界線が無い）
//   - スライド後: @expect solve: true、むらびと: [seer]
describe('prior across slides (smabro4)', () => {
  const raw = readFileSync(join(scenariosDir, 'smabro4.howl'), 'utf-8').replace(/\r\n/g, '\n')
  const fmMatch = raw.match(/^(---\n[\s\S]*?\n---\n)/)
  const frontmatter = fmMatch![1]
  const fmLineCount = frontmatter.split('\n').length - 1
  const bodyLines = raw.slice(frontmatter.length).split('\n')

  // file line N (1-indexed) を超えない範囲のテキストを返す
  function sliceBeforeFileLine(fileLine: number): string {
    const bodyEnd = fileLine - fmLineCount - 1
    return frontmatter + bodyLines.slice(0, bodyEnd).join('\n')
  }

  // smabro4 は first ghost ありの大型村
  const smabroOptions: AnalyzeOptions = {
    ...defaultOptions,
    seerClaimingDueDate: 99,
    mediumClaimingDueDate: 99,
    masonClaimingDueDate: 99,
    regulation: resolveRegulation({
      'general.first-victim': 'random',
      'role.seer.first-seek': 'all',
    }),
  }

  function freshSmabro(text: string) {
    const { meta, statements } = parse(text)
    const { vs, setup } = buildVillageStatus(statements, meta)
    const retar = new VillageRetar(vs, setup, smabroOptions)
    return { retar, result: retar.analyze(), vs, setup }
  }

  function priorSmabro(text: string, prior: AnalyzedPossibilities) {
    const { meta, statements } = parse(text)
    const { vs, setup } = buildVillageStatus(statements, meta)
    const retar = new VillageRetar(vs, setup, { ...smabroOptions, prior })
    return { retar, result: retar.analyze(), vs, setup }
  }

  function totalRoles(p: AnalyzedPossibilities): number {
    let n = 0
    for (const roles of p.values()) n += roles.size
    return n
  }

  test('スライド前後で fresh retar の解空間が「空 → 充足」に変わることを確認', () => {
    // この前提が崩れたらシナリオが想定と違うので後段テストの意味も無くなる
    const { result: before } = freshSmabro(sliceBeforeFileLine(80))
    const { result: after } = freshSmabro(sliceBeforeFileLine(81))
    assert.strictEqual(totalRoles(before.result), 0,
      `スライド前は solve:false で possibilities が空のはず (実際: ${totalRoles(before.result)})`)
    assert.ok(totalRoles(after.result) > 0,
      `スライド後は solve:true で possibilities が非空のはず (実際: ${totalRoles(after.result)})`)
  })

  test('スライド前の (空) prior をスライド後に渡しても fresh と一致する', () => {
    // prior=空 を chain に流すと initialPossibilities が空 → role test が全 skip → 結果も空 → fresh と不一致。
    // 役職スライドが起きると prior は「過去前提で棄却された世界線」を持っており、
    // 後続の retar に渡すと正解世界線まで一緒に消える。
    const { result: priorBefore } = freshSmabro(sliceBeforeFileLine(80))
    const { result: freshAfter } = freshSmabro(sliceBeforeFileLine(81))
    const { result: chainedAfter } = priorSmabro(sliceBeforeFileLine(81), priorBefore.result)
    assertSamePossibilities(chainedAfter.result, freshAfter.result,
      'chained after-slide vs fresh after-slide')
  })

  test('スライド前の (空) prior を最終決着まで渡しても fresh と一致する', () => {
    // ゲーム終了 (狼勝利) まで進めても、空 prior をチェーンに通したら正解には到達できない。
    const { result: priorBefore } = freshSmabro(sliceBeforeFileLine(80))
    const finalText = raw // ファイル全体
    const { result: freshFinal } = freshSmabro(finalText)
    const { result: chainedFinal } = priorSmabro(finalText, priorBefore.result)
    assertSamePossibilities(chainedFinal.result, freshFinal.result,
      'chained final vs fresh final')
  })
})
