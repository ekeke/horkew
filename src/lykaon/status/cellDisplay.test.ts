import { describe, test } from 'node:test'
import assert from 'node:assert'
import { parse } from '../../howl/parser.ts'
import { buildVillageStatus } from '../../howl/bridge.ts'
import { extractClaimGroups, buildAssertionTimeline } from './extract.ts'
import type { ClaimRow } from './extract.ts'
import { buildCellDisplay } from './cellDisplay.ts'
import type { VillageStatus } from '../../types/index.ts'

// テスト方針:
//   buildCellDisplay は SummaryTable.svelte:148-154 のセル決定ロジックを純関数として抽出した
//   ビューモデルである。本ファイルは実装に先行して書く TDD スペック。
//   実装は別セッションで行うため、全テストを { todo: true } でマークしている
//   (実装スタブが throw するので todo 扱いとして集計から外れる)。
//   実装ができたら todo フラグを外す。

const TODO = { todo: true }

function setup(howl: string): { vs: VillageStatus, players: Map<number, string> } {
  const { statements, meta } = parse(howl)
  return buildVillageStatus(statements, meta)
}

function findRow(vs: VillageStatus, players: Map<number, string>, role: string, name: string): ClaimRow {
  const group = extractClaimGroups(vs, players).find(g => g.role === role)
  if (!group) throw new Error(`group not found: ${role}`)
  const row = group.rows.find(r => r.name === name)
  if (!row) throw new Error(`row not found: ${role}/${name}`)
  return row
}

// ---- assertion セル ----

describe('buildCellDisplay - assertion content', () => {
  test('identical re-statement: previousAssertions is empty (Task A regression)', TODO, () => {
    // 1d で ボブ白、2d でも ボブ白 を再表明 (+ チャーリー白追加)。
    // 1d セルは スライド扱いせず、prev は空であるべき。
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白

噛み エミリー

アリス: 占いCO ボブ白 チャーリー白`)
    const row = findRow(vs, players, 'seer', 'アリス')
    const timeline = buildAssertionTimeline(row, vs.day, players)

    const cell = buildCellDisplay(row, 1, timeline, players)
    assert.strictEqual(cell.kind, 'assertion')
    if (cell.kind !== 'assertion') return
    assert.strictEqual(cell.target.name, 'ボブ')
    assert.strictEqual(cell.species, 'human')
    assert.deepStrictEqual(cell.previousAssertions, [],
      'identical re-statement must NOT populate previousAssertions')
  })

  test('true slide (target changed): previousAssertions records old', TODO, () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー、フランク

アリス: 占いCO ボブ白

噛み エミリー

アリス: 占いCO チャーリー白 フランク黒`)
    const row = findRow(vs, players, 'seer', 'アリス')
    const timeline = buildAssertionTimeline(row, vs.day, players)

    const cell = buildCellDisplay(row, 1, timeline, players)
    assert.strictEqual(cell.kind, 'assertion')
    if (cell.kind !== 'assertion') return
    assert.strictEqual(cell.target.name, 'チャーリー')
    assert.strictEqual(cell.previousAssertions.length, 1)
    assert.strictEqual(cell.previousAssertions[0].target.name, 'ボブ')
    assert.strictEqual(cell.previousAssertions[0].species, 'human')
  })

  test('true slide (species changed): previousAssertions records old', TODO, () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白

噛み エミリー

アリス: 占いCO ボブ黒 チャーリー白`)
    const row = findRow(vs, players, 'seer', 'アリス')
    const timeline = buildAssertionTimeline(row, vs.day, players)

    const cell = buildCellDisplay(row, 1, timeline, players)
    assert.strictEqual(cell.kind, 'assertion')
    if (cell.kind !== 'assertion') return
    assert.strictEqual(cell.target.name, 'ボブ')
    assert.strictEqual(cell.species, 'wolf')
    assert.strictEqual(cell.previousAssertions.length, 1)
    assert.strictEqual(cell.previousAssertions[0].species, 'human')
  })

  test('consecutive slides: prev list accumulates oldest-first', TODO, () => {
    // 1d ボブ白 → 1d チャーリー白 → 1d デイブ白 と 3 回変わる。
    // 最終的に 1d セルの prev には [ボブ, チャーリー] が並ぶ (push 順 = bridge.ts の挙動)。
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー、フランク、ジョージ

アリス: 占いCO ボブ白

噛み エミリー

アリス: 占いCO チャーリー白 フランク白

噛み ジョージ

アリス: 占いCO デイブ白 フランク白 ジョージ白`)
    const row = findRow(vs, players, 'seer', 'アリス')
    const timeline = buildAssertionTimeline(row, vs.day, players)

    const cell = buildCellDisplay(row, 1, timeline, players)
    assert.strictEqual(cell.kind, 'assertion')
    if (cell.kind !== 'assertion') return
    assert.strictEqual(cell.target.name, 'デイブ')
    assert.strictEqual(cell.previousAssertions.length, 2)
    assert.strictEqual(cell.previousAssertions[0].target.name, 'ボブ')
    assert.strictEqual(cell.previousAssertions[1].target.name, 'チャーリー')
  })

  test('partial restate: identical entries do not stack, only diffs do', TODO, () => {
    // 1d: ボブ → ボブ(同一) → デイブ → prev=[ボブ]
    // 2d: チャーリー → チャーリー(同一) → prev=[]
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー、フランク

アリス: 占いCO ボブ白

噛み エミリー

アリス: 占いCO ボブ白 チャーリー白

噛み フランク

アリス: 占いCO デイブ白 チャーリー白 ボブ白`)
    const row = findRow(vs, players, 'seer', 'アリス')
    const timeline = buildAssertionTimeline(row, vs.day, players)

    const day1 = buildCellDisplay(row, 1, timeline, players)
    assert.strictEqual(day1.kind, 'assertion')
    if (day1.kind !== 'assertion') return
    assert.strictEqual(day1.target.name, 'デイブ')
    assert.deepStrictEqual(day1.previousAssertions.map(p => p.target.name), ['ボブ'])

    const day2 = buildCellDisplay(row, 2, timeline, players)
    assert.strictEqual(day2.kind, 'assertion')
    if (day2.kind !== 'assertion') return
    assert.strictEqual(day2.target.name, 'チャーリー')
    assert.deepStrictEqual(day2.previousAssertions, [])
  })

  test('forecast cell: forecast=true, species=null', TODO, () => {
    // 占いCO + その日の予告 → 翌日 cell に forecast が出る
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白
アリス 予告 チャーリー`)
    const row = findRow(vs, players, 'seer', 'アリス')
    const timeline = buildAssertionTimeline(row, vs.day, players)

    // forecasts は day をキーに保存される。表示は (day + 1) のセル。
    const forecastDay = [...row.forecasts.keys()][0]
    assert.ok(forecastDay !== undefined, 'forecast must be recorded')
    const cell = buildCellDisplay(row, forecastDay + 1, timeline, players)
    assert.strictEqual(cell.kind, 'assertion')
    if (cell.kind !== 'assertion') return
    assert.strictEqual(cell.forecast, true)
    assert.strictEqual(cell.species, null)
    assert.strictEqual(cell.target.name, 'チャーリー')
  })

  test('bodyguard cell: isGuard=true, species=null', TODO, () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

吊り デイブ

噛み エミリー

アリス: 狩人CO ボブ護衛`)
    const row = findRow(vs, players, 'bodyguard', 'アリス')
    const timeline = buildAssertionTimeline(row, vs.day, players)

    // day 2 cell (= night 1) に「ボブ護衛」が出る
    const cell = buildCellDisplay(row, 2, timeline, players)
    assert.strictEqual(cell.kind, 'assertion')
    if (cell.kind !== 'assertion') return
    assert.strictEqual(cell.isGuard, true)
    assert.strictEqual(cell.target.name, 'ボブ')
    assert.strictEqual(cell.species, null)
  })

  test('co-timing: isCoTiming=true on the day the claim was made', TODO, () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白`)
    const row = findRow(vs, players, 'seer', 'アリス')
    const timeline = buildAssertionTimeline(row, vs.day, players)
    assert.strictEqual(row.claimedAt, 1)

    const claimDayCell = buildCellDisplay(row, 1, timeline, players)
    assert.strictEqual(claimDayCell.kind, 'assertion')
    if (claimDayCell.kind !== 'assertion') return
    assert.strictEqual(claimDayCell.isCoTiming, true)
  })

  test('non-guard seer cell: isGuard=false', TODO, () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白`)
    const row = findRow(vs, players, 'seer', 'アリス')
    const timeline = buildAssertionTimeline(row, vs.day, players)

    const cell = buildCellDisplay(row, 1, timeline, players)
    assert.strictEqual(cell.kind, 'assertion')
    if (cell.kind !== 'assertion') return
    assert.strictEqual(cell.isGuard, false)
  })
})

// ---- 非 assertion セル ----

describe('buildCellDisplay - non-assertion cells', () => {
  test('slide-marker: appears on (slidDay + 1) for old-role row', TODO, () => {
    // day 2 で 占い → 霊媒 にスライド → 旧 seer 行が previousClaims に積まれる。
    // 旧 seer 行の slidDay = 2 → day 3 cell が slide-marker。
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白

噛み エミリー

アリス: 霊媒CO`)
    const oldSeer = extractClaimGroups(vs, players)
      .find(g => g.role === 'seer')!
      .rows.find(r => r.slidDay != null)
    assert.ok(oldSeer, 'previousClaims should produce an old seer row')
    const timeline = buildAssertionTimeline(oldSeer!, vs.day, players)

    const cell = buildCellDisplay(oldSeer!, oldSeer!.slidDay! + 1, timeline, players)
    assert.strictEqual(cell.kind, 'slide-marker')
    if (cell.kind !== 'slide-marker') return
    assert.strictEqual(cell.slidToRoleShortName, '霊')
  })

  test('death-marker: appears on (diedDay + 1) for a dead claimant with no assertion that day', TODO, () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白

噛み アリス`)
    const row = findRow(vs, players, 'seer', 'アリス')
    const timeline = buildAssertionTimeline(row, vs.day, players)

    assert.strictEqual(row.surviving, false)
    assert.ok(row.diedDay != null, 'diedDay must be recorded')
    const cell = buildCellDisplay(row, row.diedDay! + 1, timeline, players)
    assert.strictEqual(cell.kind, 'death-marker')
    if (cell.kind !== 'death-marker') return
    assert.strictEqual(cell.causeOfDeathLabel, '襲撃')
  })

  test('empty: alive, no assertion, not slide-marker, not death-marker', TODO, () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白`)
    const row = findRow(vs, players, 'seer', 'アリス')
    const timeline = buildAssertionTimeline(row, vs.day, players)

    // day 2 (= night 1): まだ占い結果なし、生存、スライドなし → empty
    const cell = buildCellDisplay(row, 2, timeline, players)
    assert.strictEqual(cell.kind, 'empty')
  })

  test('assertion takes precedence over death-marker on the same day', TODO, () => {
    // アリスは 1d でCO + ボブ白を主張、その日噛まれる。
    // 1d セルは assertion (kind='assertion') として表示され、death-marker にはならない。
    // (SummaryTable では !assertion 条件で death-marker を判定するため)
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白

噛み アリス`)
    const row = findRow(vs, players, 'seer', 'アリス')
    const timeline = buildAssertionTimeline(row, vs.day, players)

    const cell = buildCellDisplay(row, 1, timeline, players)
    assert.strictEqual(cell.kind, 'assertion')
  })
})
