import { describe, test } from 'node:test'
import assert from 'node:assert'
import { parse } from './parser.ts'
import { buildVillageStatus } from './bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import { defaultAnalyzeRegulation } from '../retar/defaults.ts'
import type { SystemRole } from '../types/index.ts'

describe('bridge: curse statement', () => {
  test('curse after execution sets cursed_by_executed_nekomata', () => {
    const howl = `++アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス
道連れ ボブ`

    const { statements, meta } = parse(howl)
    const { vs, players } = buildVillageStatus(statements, meta)

    const bobSeat = [...players.entries()].find(([, n]) => n === 'ボブ')![0]
    const bobStatus = vs.statuses.get(bobSeat)!

    assert.strictEqual(bobStatus.surviving, false)
    assert.strictEqual(bobStatus.causeOfDeath, 'cursed_by_executed_nekomata')
    assert.strictEqual(bobStatus.diedDay, 1)
  })

  test('curse after night kill sets cursed_by_killed_nekomata', () => {
    const howl = `++アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス

噛み ボブ
道連れ チャーリー`

    const { statements, meta } = parse(howl)
    const { vs, players } = buildVillageStatus(statements, meta)

    const charSeat = [...players.entries()].find(([, n]) => n === 'チャーリー')![0]
    const charStatus = vs.statuses.get(charSeat)!

    assert.strictEqual(charStatus.surviving, false)
    assert.strictEqual(charStatus.causeOfDeath, 'cursed_by_killed_nekomata')
    assert.strictEqual(charStatus.diedDay, 1)
  })
})

describe('bridge: follow statement', () => {
  test('follow after execution sets follow_executed_hamster', () => {
    const howl = `++アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス
後追い ボブ`

    const { statements, meta } = parse(howl)
    const { vs, players } = buildVillageStatus(statements, meta)

    const bobSeat = [...players.entries()].find(([, n]) => n === 'ボブ')![0]
    const bobStatus = vs.statuses.get(bobSeat)!

    assert.strictEqual(bobStatus.surviving, false)
    assert.strictEqual(bobStatus.causeOfDeath, 'follow_executed_hamster')
    assert.strictEqual(bobStatus.diedDay, 1)
  })

  test('follow after night kill sets follow_killed_hamster', () => {
    const howl = `++アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス

噛み ボブ
後追い チャーリー`

    const { statements, meta } = parse(howl)
    const { vs, players } = buildVillageStatus(statements, meta)

    const charSeat = [...players.entries()].find(([, n]) => n === 'チャーリー')![0]
    const charStatus = vs.statuses.get(charSeat)!

    assert.strictEqual(charStatus.surviving, false)
    assert.strictEqual(charStatus.causeOfDeath, 'follow_killed_hamster')
    assert.strictEqual(charStatus.diedDay, 1)
  })
})

describe('bridge: nonVillage CO (人外系)', () => {
  const variants = [
    { label: '人外CO',   howl: 'ボブ　人外CO' },
    { label: '人狼CO',   howl: 'ボブ　人狼CO' },
    { label: '狂人CO',   howl: 'ボブ　狂人CO' },
    { label: '妖狐CO',   howl: 'ボブ　妖狐CO' },
    { label: '狂信者CO', howl: 'ボブ　狂信者CO' },
    { label: '背徳者CO', howl: 'ボブ　背徳者CO' },
  ]

  for (const { label, howl } of variants) {
    test(`${label} denies all 6 village roles via deniedRoles`, () => {
      const text = `++アリス、ボブ、チャーリー\n噛み アリス\n${howl}`
      const { statements, meta } = parse(text)
      const { vs, players } = buildVillageStatus(statements, meta)
      const bobSeat = [...players.entries()].find(([, n]) => n === 'ボブ')![0]
      const bobStatus = vs.statuses.get(bobSeat)!
      assert.strictEqual(bobStatus.claiming, false, `${label} should not set claiming`)
      assert.deepStrictEqual(
        [...bobStatus.deniedRoles].sort(),
        ['bodyguard', 'mason', 'medium', 'nekomata', 'seer', 'villager'],
        `${label} should deny all 6 village roles`,
      )
    })
  }
})

describe('bridge: suddenDeath statement', () => {
  test('suddenDeath at execution timing goes to executions with diedDay=day', () => {
    const howl = `++アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス
ボブ突然死（回線落ち）`

    const { statements, meta } = parse(howl)
    const { vs, players } = buildVillageStatus(statements, meta)

    const bobSeat = [...players.entries()].find(([, n]) => n === 'ボブ')![0]
    const bobStatus = vs.statuses.get(bobSeat)!

    assert.strictEqual(bobStatus.surviving, false)
    assert.strictEqual(bobStatus.causeOfDeath, 'sudden_death')
    assert.strictEqual(bobStatus.diedDay, 1)
    assert.ok((vs.executions.get(1) ?? []).includes(bobSeat))
  })

  test('suddenDeath at night kill timing goes to kills with diedDay=day-1', () => {
    const howl = `++アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス

噛み ボブ
チャーリー突然死`

    const { statements, meta } = parse(howl)
    const { vs, players } = buildVillageStatus(statements, meta)

    const charSeat = [...players.entries()].find(([, n]) => n === 'チャーリー')![0]
    const charStatus = vs.statuses.get(charSeat)!

    assert.strictEqual(charStatus.surviving, false)
    assert.strictEqual(charStatus.causeOfDeath, 'sudden_death')
    assert.strictEqual(charStatus.diedDay, 1)
    assert.ok((vs.kills.get(1) ?? []).includes(charSeat))
  })

  test('suddenDeath at game start (no prior death) treated as execution timing', () => {
    const howl = `++アリス、ボブ、チャーリー、デイブ、エミリー

アリス突然死`

    const { statements, meta } = parse(howl)
    const { vs, players } = buildVillageStatus(statements, meta)

    const aliceSeat = [...players.entries()].find(([, n]) => n === 'アリス')![0]
    const aliceStatus = vs.statuses.get(aliceSeat)!

    assert.strictEqual(aliceStatus.surviving, false)
    assert.strictEqual(aliceStatus.causeOfDeath, 'sudden_death')
    assert.strictEqual(aliceStatus.diedDay, 1)
    assert.ok((vs.executions.get(1) ?? []).includes(aliceSeat))
  })
})

describe('bridge: curse/follow in kills map', () => {
  test('curse and follow victims appear in kills map', () => {
    const howl = `++アリス、ボブ、チャーリー、デイブ、エミリー、フランク

吊り アリス
道連れ ボブ
後追い チャーリー`

    const { statements, meta } = parse(howl)
    const { vs, players } = buildVillageStatus(statements, meta)

    const bobSeat = [...players.entries()].find(([, n]) => n === 'ボブ')![0]
    const charSeat = [...players.entries()].find(([, n]) => n === 'チャーリー')![0]

    // Both should be in kills map for day 1 (same day as execution)
    const day1Kills = vs.kills.get(1) || []
    assert.ok(day1Kills.includes(bobSeat), 'curse victim in kills map')
    assert.ok(day1Kills.includes(charSeat), 'follow victim in kills map')
  })
})

describe('bridge-retar integration: follow confirms immoralist', () => {
  test('follow_killed_hamster confirms immoralist role in retar', () => {
    const howl = `---
setup:
  nekomata: 1
  villager: 2
  seer: 1
  medium: 1
  bodyguard: 1
  possessed: 1
  werewolf: 3
  mason: 2
  werehamster: 1
  immoralist: 1
---

++エーカゲン２世、ガーグァ、ボムへい、考える人、おわんくん、羽根帚、今川義元、アンゴラウサギ、アネモネ、ちせ、サターニャ、マーマイト、オカリン、闇さとし

エーカゲン死亡

さとし　占いCOガーグァ●
羽根　霊能CO
サタ　占いCO　オカリン●
考える人　占いCO　羽根○
ちせ　予言CO　さとし〇

オカリン　共有CO　ガーグァ白
ガーグァ　共有CO　おか〇

サターニャ←
ガーグァ←さとし
おか←さた

サターニャ処刑

マーマイト　死亡
ボム　死亡
さとし　後追い`

    const { statements, meta } = parse(howl)
    const { vs, setup, players } = buildVillageStatus(statements, meta)

    const satoshiSeat = [...players.entries()].find(([, n]) => n === '闇さとし')![0]
    assert.strictEqual(vs.statuses.get(satoshiSeat)!.causeOfDeath, 'follow_killed_hamster')

    const options = {
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

    const retar = new VillageRetar(vs, setup, options)
    const result = retar.analyze()

    assert.ok(result, 'retar should return a result')
    assert.ok(retar.debugStash.finalizerPasses > 0, 'at least one valid world found')

    const satoshiRoles = result.result.get(satoshiSeat)
    assert.ok(satoshiRoles, '闇さとし should have role possibilities')
    assert.deepStrictEqual([...satoshiRoles], ['immoralist'])
  })

  test('seer divination results exclude werehamster candidates', () => {
    const howl = `---
setup:
  nekomata: 1
  villager: 2
  seer: 1
  medium: 1
  bodyguard: 1
  possessed: 1
  werewolf: 3
  mason: 2
  werehamster: 1
  immoralist: 1
---

++エーカゲン２世、ガーグァ、ボムへい、考える人、おわんくん、羽根帚、今川義元、アンゴラウサギ、アネモネ、ちせ、サターニャ、マーマイト、オカリン、闇さとし

エーカゲン死亡

さとし　占いCOガーグァ●
羽根　霊能CO
サタ　占いCO　オカリン●
考える人　占いCO　羽根○
ちせ　予言CO　さとし〇

オカリン　共有CO　ガーグァ白
ガーグァ　共有CO　おか〇

サターニャ←
ガーグァ←さとし
おか←さた

サターニャ処刑

マーマイト　死亡
ボム　死亡
さとし　後追い

ちせ　ボム○
考える　ボム白`

    const { statements, meta } = parse(howl)
    const { vs, setup, players } = buildVillageStatus(statements, meta)

    const options = {
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

    const retar = new VillageRetar(vs, setup, options)
    const result = retar.analyze()

    assert.ok(result, 'retar should return a result')
    assert.ok(retar.debugStash.finalizerPasses > 0, 'at least one valid world found')

    const marmiteSeat = [...players.entries()].find(([, n]) => n === 'マーマイト')![0]
    const marmiteRoles = result.result.get(marmiteSeat)
    assert.ok(marmiteRoles, 'マーマイト should have role possibilities')
    assert.ok(!marmiteRoles.has('werehamster'), 'マーマイト should not be werehamster candidate (both seers divined ボム, not マーマイト)')

    const satoshiSeat = [...players.entries()].find(([, n]) => n === '闇さとし')![0]
    const satoshiRoles = result.result.get(satoshiSeat)
    assert.deepStrictEqual([...satoshiRoles!], ['immoralist'])
  })
})

describe('bridge: assertion right-alignment', () => {
  function setup(howl: string) {
    const { statements, meta } = parse(howl)
    return buildVillageStatus(statements, meta)
  }

  function seat(players: Map<number, string>, name: string): number {
    return [...players.entries()].find(([, n]) => n === name)![0]
  }

  test('single result on day 1 maps to night 0', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白`)
    const aliceSeat = seat(players, 'アリス')
    const bobSeat = seat(players, 'ボブ')
    const assertions = vs.statuses.get(aliceSeat)!.assertions
    assert.strictEqual(assertions.size, 1)
    const night0 = assertions.get(0)
    assert.ok(night0)
    assert.strictEqual(night0!.target, bobSeat)
    assert.strictEqual(night0!.species, 'human')
  })

  test('two results on day 3 right-align to nights 1 and 2', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

吊り デイブ

噛み エミリー

アリス: 占いCO ボブ白 チャーリー黒`)
    const aliceSeat = seat(players, 'アリス')
    const bobSeat = seat(players, 'ボブ')
    const charSeat = seat(players, 'チャーリー')
    const assertions = vs.statuses.get(aliceSeat)!.assertions

    assert.strictEqual(assertions.size, 2)
    // Night 0 (お告げ) = ボブ白
    assert.deepStrictEqual(assertions.get(0), { target: bobSeat, species: 'human' })
    // Night 1 = チャーリー黒
    assert.deepStrictEqual(assertions.get(1), { target: charSeat, species: 'wolf' })
  })

  test('slide: second assert on same day overwrites first (結果スライド)', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白
アリス: チャーリー黒`)
    const aliceSeat = seat(players, 'アリス')
    const charSeat = seat(players, 'チャーリー')
    const assertions = vs.statuses.get(aliceSeat)!.assertions

    // Only 1 result: the slide replaced ボブ白 with チャーリー黒 for night 0
    assert.strictEqual(assertions.size, 1)
    const night0 = assertions.get(0)
    assert.ok(night0)
    assert.strictEqual(night0!.target, charSeat)
    assert.strictEqual(night0!.species, 'wolf')
  })

  test('late CO on day 3 with 3 results: nights 0, 1, 2', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー、フランク

吊り デイブ

噛み エミリー

吊り フランク

噛み ボブ

アリス: 占いCO デイブ白 エミリー白 チャーリー黒`)
    const aliceSeat = seat(players, 'アリス')
    const daveSeat = seat(players, 'デイブ')
    const emilySeat = seat(players, 'エミリー')
    const charSeat = seat(players, 'チャーリー')
    const assertions = vs.statuses.get(aliceSeat)!.assertions

    assert.strictEqual(assertions.size, 3)
    // Right-aligned from day 3: nights 0, 1, 2
    assert.deepStrictEqual(assertions.get(0), { target: daveSeat, species: 'human' })
    assert.deepStrictEqual(assertions.get(1), { target: emilySeat, species: 'human' })
    assert.deepStrictEqual(assertions.get(2), { target: charSeat, species: 'wolf' })
  })

  test('incremental results across days accumulate correctly', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白

吊り デイブ

噛み エミリー

アリス: チャーリー黒`)
    const aliceSeat = seat(players, 'アリス')
    const bobSeat = seat(players, 'ボブ')
    const charSeat = seat(players, 'チャーリー')
    const assertions = vs.statuses.get(aliceSeat)!.assertions

    // Day 1: ボブ白 → night 0
    // Day 2: チャーリー黒 → night 1
    assert.strictEqual(assertions.size, 2)
    assert.deepStrictEqual(assertions.get(0), { target: bobSeat, species: 'human' })
    assert.deepStrictEqual(assertions.get(1), { target: charSeat, species: 'wolf' })
  })

  test('restate identical result: no previousAssertions slide on night 0', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白

吊り デイブ

噛み エミリー

アリス: 占いCO ボブ白 チャーリー黒`)
    const aliceSeat = seat(players, 'アリス')
    const bobSeat = seat(players, 'ボブ')
    const charSeat = seat(players, 'チャーリー')
    const status = vs.statuses.get(aliceSeat)!

    // Final assertions: night 0 = ボブ白, night 1 = チャーリー黒
    assert.strictEqual(status.assertions.size, 2)
    assert.deepStrictEqual(status.assertions.get(0), { target: bobSeat, species: 'human' })
    assert.deepStrictEqual(status.assertions.get(1), { target: charSeat, species: 'wolf' })

    // Identical restate must NOT create a previousAssertions entry for night 0
    if (status.previousAssertions) {
      assert.ok(!status.previousAssertions.has(0), 'night 0 must not appear in previousAssertions for identical restate')
    }
  })

  test('restate with different target: previousAssertions records the slide', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー、フランク

アリス: 占いCO ボブ白

吊り デイブ

噛み エミリー

アリス: 占いCO チャーリー白 フランク黒`)
    const aliceSeat = seat(players, 'アリス')
    const bobSeat = seat(players, 'ボブ')
    const charSeat = seat(players, 'チャーリー')
    const frankSeat = seat(players, 'フランク')
    const status = vs.statuses.get(aliceSeat)!

    assert.deepStrictEqual(status.assertions.get(0), { target: charSeat, species: 'human' })
    assert.deepStrictEqual(status.assertions.get(1), { target: frankSeat, species: 'wolf' })

    // Genuine slide on night 0: previous target ボブ白 → new target チャーリー白
    assert.ok(status.previousAssertions, 'previousAssertions should be set')
    const prev = status.previousAssertions!.get(0)
    assert.ok(prev && prev.length === 1)
    assert.deepStrictEqual(prev[0], { target: bobSeat, species: 'human' })
  })

  test('restate with different species: previousAssertions records the slide', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白

吊り デイブ

噛み エミリー

アリス: 占いCO ボブ黒 チャーリー黒`)
    const aliceSeat = seat(players, 'アリス')
    const bobSeat = seat(players, 'ボブ')
    const charSeat = seat(players, 'チャーリー')
    const status = vs.statuses.get(aliceSeat)!

    assert.deepStrictEqual(status.assertions.get(0), { target: bobSeat, species: 'wolf' })
    assert.deepStrictEqual(status.assertions.get(1), { target: charSeat, species: 'wolf' })

    // Genuine slide on night 0: same target, species flipped 白 → 黒
    assert.ok(status.previousAssertions, 'previousAssertions should be set')
    const prev = status.previousAssertions!.get(0)
    assert.ok(prev && prev.length === 1)
    assert.deepStrictEqual(prev[0], { target: bobSeat, species: 'human' })
  })

  test('multiple consecutive identical restates accumulate no previousAssertions', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー、フランク、ジョージ

アリス: 占いCO ボブ白

吊り デイブ

噛み エミリー

アリス: 占いCO ボブ白 チャーリー黒

吊り フランク

噛み ジョージ

アリス: 占いCO ボブ白 チャーリー黒 アリス白`)
    const aliceSeat = seat(players, 'アリス')
    const status = vs.statuses.get(aliceSeat)!

    // Three identical restatements across three days: night 0 and night 1 must remain slide-free
    assert.strictEqual(status.assertions.size, 3)
    if (status.previousAssertions) {
      assert.ok(!status.previousAssertions.has(0), 'night 0 must not slide on identical restate')
      assert.ok(!status.previousAssertions.has(1), 'night 1 must not slide on identical restate')
    }
  })

  test('mason assertions use negative day keys', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

共有 アリス ボブ`)
    const aliceSeat = seat(players, 'アリス')
    const bobSeat = seat(players, 'ボブ')
    const assertions = vs.statuses.get(aliceSeat)!.assertions

    assert.strictEqual(assertions.size, 1)
    const entry = assertions.get(-1)
    assert.ok(entry)
    assert.strictEqual(entry!.target, bobSeat)
    assert.strictEqual(entry!.species, 'human')
  })
})

describe('bridge: spoiler assumptions', () => {
  test('collects spoilers into assumptions map', () => {
    const howl = `++アリス、ボブ、チャーリー、デイブ、エミリー
!アリス=seer
!ボブ=werewolf
!チャーリー=狼`

    const { statements, meta } = parse(howl)
    const { assumptions, players } = buildVillageStatus(statements, meta)

    const seatOf = (n: string) => [...players.entries()].find(([, x]) => x === n)![0]

    assert.strictEqual(assumptions.get(seatOf('アリス')), 'seer')
    assert.strictEqual(assumptions.get(seatOf('ボブ')), 'werewolf')
    assert.strictEqual(assumptions.get(seatOf('チャーリー')), 'werewolf')
    assert.strictEqual(assumptions.size, 3)
  })

  test('spoiler can appear before the + join line (hoisting)', () => {
    const howl = `!マドック=霊媒
+マドック
+ダンカン`

    const { statements, meta } = parse(howl)
    const { assumptions, players } = buildVillageStatus(statements, meta)

    const madocSeat = [...players.entries()].find(([, n]) => n === 'マドック')![0]
    assert.strictEqual(assumptions.get(madocSeat), 'medium')
  })

  test('full-width ！ and ＝ are accepted', () => {
    const howl = `+アリス
+ボブ
！アリス＝占い師`

    const { statements, meta } = parse(howl)
    const { assumptions, players } = buildVillageStatus(statements, meta)

    const aliceSeat = [...players.entries()].find(([, n]) => n === 'アリス')![0]
    assert.strictEqual(assumptions.get(aliceSeat), 'seer')
  })

  test('duplicate spoiler with same role is allowed', () => {
    const howl = `+アリス
+ボブ
!アリス=seer
!アリス=占い`

    const { statements, meta } = parse(howl)
    const { assumptions, players } = buildVillageStatus(statements, meta)

    const aliceSeat = [...players.entries()].find(([, n]) => n === 'アリス')![0]
    assert.strictEqual(assumptions.get(aliceSeat), 'seer')
    assert.strictEqual(assumptions.size, 1)
  })

  test('conflicting spoilers throw an error', () => {
    const howl = `+アリス
+ボブ
!アリス=seer
!アリス=werewolf`

    const { statements, meta } = parse(howl)
    assert.throws(() => buildVillageStatus(statements, meta), /矛盾する仮定/)
  })

  test('paparazzi spoiler is resolved (both カタカナ and ASCII)', () => {
    const howl = `+アリス
+ボブ
!アリス=パパラッチ
!ボブ=paparazzi`

    const { statements, meta } = parse(howl)
    const { assumptions, players } = buildVillageStatus(statements, meta)

    const seatOf = (n: string) => [...players.entries()].find(([, x]) => x === n)![0]
    assert.strictEqual(assumptions.get(seatOf('アリス')), 'paparazzi')
    assert.strictEqual(assumptions.get(seatOf('ボブ')), 'paparazzi')
  })

  test('frontmatter spoilers.roles is resolved', () => {
    const howl = `---
spoilers:
  roles:
    アリス: パパラッチ
    ボブ: paparazzi
    チャーリー: 占い師
---
+アリス
+ボブ
+チャーリー`

    const { statements, meta } = parse(howl)
    const { assumptions, players } = buildVillageStatus(statements, meta)

    const seatOf = (n: string) => [...players.entries()].find(([, x]) => x === n)![0]
    assert.strictEqual(assumptions.get(seatOf('アリス')), 'paparazzi')
    assert.strictEqual(assumptions.get(seatOf('ボブ')), 'paparazzi')
    assert.strictEqual(assumptions.get(seatOf('チャーリー')), 'seer')
  })

  test('frontmatter spoilers + ! spoiler with same role is OK', () => {
    const howl = `---
spoilers:
  roles:
    アリス: 占い師
---
+アリス
+ボブ
!アリス=占い師`

    const { statements, meta } = parse(howl)
    const { assumptions, players } = buildVillageStatus(statements, meta)
    const seatOf = (n: string) => [...players.entries()].find(([, x]) => x === n)![0]
    assert.strictEqual(assumptions.get(seatOf('アリス')), 'seer')
  })

  test('frontmatter spoilers + ! spoiler with different role throws', () => {
    const howl = `---
spoilers:
  roles:
    アリス: 占い師
---
+アリス
+ボブ
!アリス=パパラッチ`

    const { statements, meta } = parse(howl)
    assert.throws(() => buildVillageStatus(statements, meta), /矛盾する仮定/)
  })

  test('frontmatter spoilers with unknown player throws', () => {
    const howl = `---
spoilers:
  roles:
    キャロル: 占い師
---
+アリス
+ボブ`

    const { statements, meta } = parse(howl)
    assert.throws(() => buildVillageStatus(statements, meta), /未知のプレイヤー/)
  })

  test('frontmatter spoilers with bad role name throws', () => {
    const howl = `---
spoilers:
  roles:
    アリス: ぱぱらっち
---
+アリス`

    const { statements, meta } = parse(howl)
    assert.throws(() => buildVillageStatus(statements, meta), /役職名を解決できません/)
  })

  test('spoiler action (divine) is recorded in spoilerActions', () => {
    const howl = `+アリス
+ボブ
!アリス=占い師
!アリス 1夜 占い ボブ`

    const { statements, meta } = parse(howl)
    const { spoilerActions, players } = buildVillageStatus(statements, meta)
    const seatOf = (n: string) => [...players.entries()].find(([, x]) => x === n)![0]
    assert.strictEqual(spoilerActions.length, 1)
    assert.deepStrictEqual(spoilerActions[0], {
      day: 1, by: seatOf('アリス'), action: 'divine', target: seatOf('ボブ'),
    })
  })

  test('spoiler actions (guard, attack) work', () => {
    const howl = `+アリス
+ボブ
+キャロル
!ボブ 1夜 護衛 アリス
!キャロル 1夜 襲撃 アリス`

    const { statements, meta } = parse(howl)
    const { spoilerActions, players } = buildVillageStatus(statements, meta)
    const seatOf = (n: string) => [...players.entries()].find(([, x]) => x === n)![0]
    assert.strictEqual(spoilerActions.length, 2)
    assert.deepStrictEqual(spoilerActions[0], {
      day: 1, by: seatOf('ボブ'), action: 'guard', target: seatOf('アリス'),
    })
    assert.deepStrictEqual(spoilerActions[1], {
      day: 1, by: seatOf('キャロル'), action: 'attack', target: seatOf('アリス'),
    })
  })

  test('spoiler action with ASCII verbs (divine/guard/attack) works', () => {
    const howl = `+アリス
+ボブ
!アリス 2夜 divine ボブ`

    const { statements, meta } = parse(howl)
    const { spoilerActions, players } = buildVillageStatus(statements, meta)
    const seatOf = (n: string) => [...players.entries()].find(([, x]) => x === n)![0]
    assert.strictEqual(spoilerActions.length, 1)
    assert.deepStrictEqual(spoilerActions[0], {
      day: 2, by: seatOf('アリス'), action: 'divine', target: seatOf('ボブ'),
    })
  })

  test('spoiler action with unknown target throws', () => {
    const howl = `+アリス
!アリス 1夜 占い キャロル`

    const { statements, meta } = parse(howl)
    assert.throws(() => buildVillageStatus(statements, meta), /未知のターゲット/)
  })

  test('role pin and spoiler action coexist for same player', () => {
    const howl = `+アリス
+ボブ
!アリス=占い師
!アリス 1夜 占い ボブ`

    const { statements, meta } = parse(howl)
    const { assumptions, spoilerActions, players } = buildVillageStatus(statements, meta)
    const seatOf = (n: string) => [...players.entries()].find(([, x]) => x === n)![0]
    assert.strictEqual(assumptions.get(seatOf('アリス')), 'seer')
    assert.strictEqual(spoilerActions.length, 1)
    assert.strictEqual(spoilerActions[0].action, 'divine')
  })

  test('spoiler for unknown player throws', () => {
    const howl = `+アリス
+ボブ
!キャロル=seer`

    const { statements, meta } = parse(howl)
    assert.throws(() => buildVillageStatus(statements, meta), /未知のプレイヤー/)
  })

  test('assumptions are consumed by VillageRetar', () => {
    // 5人規模 simple: 占1 狼1 村3、アリスを占い仮定にすると他席の占い可能性が消える
    const howl = `---
setup: { seer: 1, werewolf: 1, villager: 3 }
---
+アリス
+ボブ
+チャーリー
+デイブ
+エミリー
!アリス=seer`

    const { statements, meta } = parse(howl)
    const { vs, setup, assumptions } = buildVillageStatus(statements, meta)
    const retar = new VillageRetar(vs, setup, {
      regulation: defaultAnalyzeRegulation,
      seerClaimingDueDate: 99, mediumClaimingDueDate: 99,
      bodyguardClaimingDueDate: 99, masonClaimingDueDate: 99,
      nekomataClaimingDueDate: 99,
      dayCountFrom: 1,
      assumptions, wolfPairDenyals: [], hocusPocus: new Map(),
      id: 0, batches: 1, batch: 0,
    })
    const result = retar.analyze()
    assert.strictEqual(result.error, undefined)

    // seat1 (アリス) は seer 確定
    const alicePos = result.result.get(1)!
    assert.ok(alicePos.has('seer'))
    assert.strictEqual(alicePos.size, 1)
    // 他席は seer を持たない
    for (let seat = 2; seat <= 5; seat++) {
      const pos = result.result.get(seat)!
      assert.ok(!pos.has('seer'), `seat ${seat} should not have seer possibility`)
    }
  })
})

describe('bridge: spoiler faction alias', () => {
  // systemRoles の faction 分布 (テスト時点で固定):
  //   village: villager, seer, medium, bodyguard, mason, nekomata
  //   wolf:    werewolf, possessed, fanatic, paparazzi
  //   fox:     werehamster, immoralist, kogitsune
  const VILLAGE_ROLES = new Set(['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata'])
  const WOLF_ROLES    = new Set(['werewolf', 'possessed', 'fanatic', 'paparazzi'])
  const FOX_ROLES     = new Set(['werehamster', 'immoralist', 'kogitsune'])

  const seatOf = (players: Map<number, string>, name: string): number =>
    [...players.entries()].find(([, x]) => x === name)![0]

  test('!Alice=人外 → 村陣営の全役職を spoilerDeniedRoles に積む', () => {
    const howl = `+アリス
+ボブ
!アリス=人外`
    const { statements, meta } = parse(howl)
    const { spoilerDeniedRoles, vs, players, assumptions } = buildVillageStatus(statements, meta)
    const aliceSeat = seatOf(players, 'アリス')

    assert.strictEqual(assumptions.has(aliceSeat), false, 'alias は assumption pin に入らない')
    const denied = spoilerDeniedRoles.get(aliceSeat)!
    assert.ok(denied, 'spoilerDeniedRoles にエントリが作られる')
    for (const role of VILLAGE_ROLES) {
      assert.ok(denied.has(role as SystemRole), `${role} は人外 alias で deny される`)
    }
    for (const role of [...WOLF_ROLES, ...FOX_ROLES]) {
      assert.ok(!denied.has(role as SystemRole), `${role} は人外 alias では deny されない`)
    }
    // seat.deniedRoles にも反映 (retar が消化する経路)
    const aliceStatus = vs.statuses.get(aliceSeat)!
    for (const role of VILLAGE_ROLES) {
      assert.ok(aliceStatus.deniedRoles.includes(role as SystemRole), `seat.deniedRoles に ${role} が含まれる`)
    }
  })

  test('!Alice=狼陣営 → village + fox faction を deny', () => {
    const howl = `+アリス
+ボブ
!アリス=狼陣営`
    const { statements, meta } = parse(howl)
    const { spoilerDeniedRoles, players } = buildVillageStatus(statements, meta)
    const aliceSeat = seatOf(players, 'アリス')
    const denied = spoilerDeniedRoles.get(aliceSeat)!
    for (const role of [...VILLAGE_ROLES, ...FOX_ROLES]) {
      assert.ok(denied.has(role as SystemRole), `${role} は狼陣営 alias で deny`)
    }
    for (const role of WOLF_ROLES) {
      assert.ok(!denied.has(role as SystemRole), `${role} は狼陣営では deny されない`)
    }
  })

  test('!Alice=狐陣営 → village + wolf faction を deny', () => {
    const howl = `+アリス
+ボブ
!アリス=狐陣営`
    const { statements, meta } = parse(howl)
    const { spoilerDeniedRoles, players } = buildVillageStatus(statements, meta)
    const aliceSeat = seatOf(players, 'アリス')
    const denied = spoilerDeniedRoles.get(aliceSeat)!
    for (const role of [...VILLAGE_ROLES, ...WOLF_ROLES]) {
      assert.ok(denied.has(role as SystemRole), `${role} は狐陣営 alias で deny`)
    }
    for (const role of FOX_ROLES) {
      assert.ok(!denied.has(role as SystemRole), `${role} は狐陣営では deny されない`)
    }
  })

  test('!Alice=村陣営 → wolf + fox faction を deny', () => {
    const howl = `+アリス
+ボブ
!アリス=村陣営`
    const { statements, meta } = parse(howl)
    const { spoilerDeniedRoles, players } = buildVillageStatus(statements, meta)
    const aliceSeat = seatOf(players, 'アリス')
    const denied = spoilerDeniedRoles.get(aliceSeat)!
    for (const role of [...WOLF_ROLES, ...FOX_ROLES]) {
      assert.ok(denied.has(role as SystemRole), `${role} は村陣営 alias で deny`)
    }
    for (const role of VILLAGE_ROLES) {
      assert.ok(!denied.has(role as SystemRole), `${role} は村陣営では deny されない`)
    }
  })

  test('英語キーワード (wolf / fox / village / hostile) も受け付ける', () => {
    const howl = `+アリス
+ボブ
+キャロル
+デイブ
!アリス=wolf
!ボブ=fox
!キャロル=village
!デイブ=hostile`
    const { statements, meta } = parse(howl)
    const { spoilerDeniedRoles, players } = buildVillageStatus(statements, meta)
    assert.ok(spoilerDeniedRoles.get(seatOf(players, 'アリス'))!.has('werehamster' as SystemRole), 'wolf alias で werehamster は許容')
    // ↑ wolf alias は fox を deny するので werehamster (fox) は denied に含まれる
    assert.ok(spoilerDeniedRoles.get(seatOf(players, 'ボブ'))!.has('werewolf' as SystemRole), 'fox alias で werewolf は denied')
    assert.ok(spoilerDeniedRoles.get(seatOf(players, 'キャロル'))!.has('werewolf' as SystemRole), 'village alias で werewolf は denied')
    assert.ok(spoilerDeniedRoles.get(seatOf(players, 'デイブ'))!.has('seer' as SystemRole), 'hostile alias で seer は denied')
  })

  test('alias 重複 (人外 + 狼陣営) は冗長扱いで OK (狭い方の制約が効く)', () => {
    const howl = `+アリス
+ボブ
!アリス=人外
!アリス=狼陣営`
    const { statements, meta } = parse(howl)
    const { spoilerDeniedRoles, players } = buildVillageStatus(statements, meta)
    const denied = spoilerDeniedRoles.get(seatOf(players, 'アリス'))!
    // 人外 = village deny、 狼陣営 = village + fox deny。 union = village + fox deny。
    // 残るのは wolf faction のみ。
    for (const role of [...VILLAGE_ROLES, ...FOX_ROLES]) {
      assert.ok(denied.has(role as SystemRole), `${role} は重複 alias で deny`)
    }
    for (const role of WOLF_ROLES) {
      assert.ok(!denied.has(role as SystemRole), `${role} は両 alias で許容`)
    }
  })

  test('pin role + alias の混在は throw する', () => {
    const howl = `+アリス
+ボブ
!アリス=seer
!アリス=人外`
    const { statements, meta } = parse(howl)
    assert.throws(() => buildVillageStatus(statements, meta), /矛盾する仮定/)
  })

  test('alias + pin role の混在 (逆順) も throw する', () => {
    const howl = `+アリス
+ボブ
!アリス=人外
!アリス=seer`
    const { statements, meta } = parse(howl)
    assert.throws(() => buildVillageStatus(statements, meta), /矛盾する仮定/)
  })

  test('!Alice=人外 → !Alice=人狼 は refinement として許容 (alias の denied に含まれない pin)', () => {
    // hostile alias は village 役職のみ deny、 werewolf は denied set に含まれないため
    // 後続の `!Alice=人狼` は矛盾せず assumptions に werewolf を追加する。
    const howl = `+アリス
+ボブ
!アリス=人外
!アリス=人狼`
    const { statements, meta } = parse(howl)
    const { assumptions, spoilerDeniedRoles, players } = buildVillageStatus(statements, meta)
    const aliceSeat = seatOf(players, 'アリス')
    assert.strictEqual(assumptions.get(aliceSeat), 'werewolf')
    assert.ok(spoilerDeniedRoles.get(aliceSeat)!.has('seer' as SystemRole), 'hostile alias の deny は残る')
    assert.ok(!spoilerDeniedRoles.get(aliceSeat)!.has('werewolf' as SystemRole), 'werewolf は denied set に入らない')
  })

  test('frontmatter spoilers.roles でも alias が使える', () => {
    const howl = `---
spoilers:
  roles:
    アリス: 人外
---
+アリス
+ボブ`
    const { statements, meta } = parse(howl)
    const { spoilerDeniedRoles, players } = buildVillageStatus(statements, meta)
    const denied = spoilerDeniedRoles.get(seatOf(players, 'アリス'))!
    assert.ok(denied.has('seer' as SystemRole), 'frontmatter alias でも village role が deny される')
  })
})

describe('bridge: announce assumptions', () => {
  test('announce rolePin populates both assumptions and announceAssumptions', () => {
    const howl = `++アリス、ボブ、チャーリー、デイブ、エミリー
※ アリス、ボブ 契約者`

    const { statements, meta } = parse(howl)
    const { assumptions, announceAssumptions, players } = buildVillageStatus(statements, meta)
    const seatOf = (n: string) => [...players.entries()].find(([, x]) => x === n)![0]

    assert.strictEqual(assumptions.get(seatOf('アリス')), 'contractor')
    assert.strictEqual(assumptions.get(seatOf('ボブ')), 'contractor')
    assert.strictEqual(announceAssumptions.get(seatOf('アリス')), 'contractor')
    assert.strictEqual(announceAssumptions.get(seatOf('ボブ')), 'contractor')
    assert.strictEqual(announceAssumptions.size, 2)
  })

  test('spoiler-only pins do not appear in announceAssumptions', () => {
    const howl = `++アリス、ボブ、チャーリー、デイブ、エミリー
!アリス=seer
※ ボブ 契約者`

    const { statements, meta } = parse(howl)
    const { assumptions, announceAssumptions, players } = buildVillageStatus(statements, meta)
    const seatOf = (n: string) => [...players.entries()].find(([, x]) => x === n)![0]

    assert.strictEqual(assumptions.size, 2)
    assert.strictEqual(announceAssumptions.size, 1)
    assert.strictEqual(announceAssumptions.get(seatOf('ボブ')), 'contractor')
    assert.strictEqual(announceAssumptions.has(seatOf('アリス')), false)
  })

  test('announce same role as existing spoiler is allowed and recorded as announce', () => {
    const howl = `++アリス、ボブ、チャーリー、デイブ、エミリー
!アリス=契約者
※ アリス 契約者`

    const { statements, meta } = parse(howl)
    const { assumptions, announceAssumptions, players } = buildVillageStatus(statements, meta)
    const seatOf = (n: string) => [...players.entries()].find(([, x]) => x === n)![0]

    assert.strictEqual(assumptions.get(seatOf('アリス')), 'contractor')
    assert.strictEqual(announceAssumptions.get(seatOf('アリス')), 'contractor')
  })

  test('announce conflicting with spoiler throws', () => {
    const howl = `++アリス、ボブ、チャーリー、デイブ、エミリー
!アリス=seer
※ アリス 契約者`

    const { statements, meta } = parse(howl)
    assert.throws(() => buildVillageStatus(statements, meta), /矛盾する仮定/)
  })
})

describe('bridge: seat number references', () => {
  test('seat number resolves alongside player name in vote', () => {
    const howl = `++Alice,Bob,Charlie
1→2`
    const { statements, meta } = parse(howl)
    const { vs, players } = buildVillageStatus(statements, meta)
    const aliceSeat = [...players.entries()].find(([, n]) => n === 'Alice')![0]
    const bobSeat = [...players.entries()].find(([, n]) => n === 'Bob')![0]
    const alice = vs.statuses.get(aliceSeat)!
    assert.strictEqual(alice.voted, true)
    assert.strictEqual(alice.votedTarget, bobSeat)
  })

  test('seat number resolves with synthesized players when JOIN omitted', () => {
    const howl = `---
setup:
  villager: 1
  seer: 1
  werewolf: 1
---
1→3
3→1
吊り 1`
    const { statements, meta } = parse(howl)
    const { vs, players } = buildVillageStatus(statements, meta)
    assert.strictEqual(players.get(1), 'プレイヤー1')
    assert.strictEqual(players.get(3), 'プレイヤー3')
    const seat1 = vs.statuses.get(1)!
    assert.strictEqual(seat1.surviving, false)
    assert.strictEqual(seat1.causeOfDeath, 'execution')
  })
})

describe('bridge labeled mode (day ラベル付き assertion)', () => {
  function setup(howl: string) {
    const { statements, meta } = parse(howl)
    return buildVillageStatus(statements, meta)
  }

  function seat(players: Map<number, string>, name: string): number {
    return [...players.entries()].find(([, n]) => n === name)![0]
  }

  test('全 day ラベル付き: assertion.day を直接 key として投入 (= 0日目 + 1日目)', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO 0日目 ボブ白 1日目 チャーリー黒`)
    const aliceSeat = seat(players, 'アリス')
    const bobSeat = seat(players, 'ボブ')
    const charSeat = seat(players, 'チャーリー')
    const assertions = vs.statuses.get(aliceSeat)!.assertions

    assert.strictEqual(assertions.size, 2)
    assert.deepStrictEqual(assertions.get(0), { target: bobSeat, species: 'human' })
    assert.deepStrictEqual(assertions.get(1), { target: charSeat, species: 'wolf' })
  })

  test('順序逆転 day ラベル: 並び順無視、 assertion.day で投入', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO 2日目 ボブ白 1日目 チャーリー黒`)
    const aliceSeat = seat(players, 'アリス')
    const bobSeat = seat(players, 'ボブ')
    const charSeat = seat(players, 'チャーリー')
    const assertions = vs.statuses.get(aliceSeat)!.assertions

    // 並び順とは無関係に day で配置: 1日目 = チャーリー黒、 2日目 = ボブ白
    assert.deepStrictEqual(assertions.get(1), { target: charSeat, species: 'wolf' })
    assert.deepStrictEqual(assertions.get(2), { target: bobSeat, species: 'human' })
  })

  test('混在 (一部だけ day ラベル): silent right-align fallback', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

吊り デイブ

噛み エミリー

アリス: 占いCO 1日目 ボブ白 チャーリー黒`)
    const aliceSeat = seat(players, 'アリス')
    const bobSeat = seat(players, 'ボブ')
    const charSeat = seat(players, 'チャーリー')
    const assertions = vs.statuses.get(aliceSeat)!.assertions

    // mixed → right-align fallback (= day=2, lastActionDay=1, 2 結果 → 行動日 0, 1)
    assert.deepStrictEqual(assertions.get(0), { target: bobSeat, species: 'human' })
    assert.deepStrictEqual(assertions.get(1), { target: charSeat, species: 'wolf' })
  })

  test('重複 day: 後勝ち (= Map.set 上書き、 previousAssertions にスライド記録)', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO 1日目 ボブ白 1日目 チャーリー黒`)
    const aliceSeat = seat(players, 'アリス')
    const charSeat = seat(players, 'チャーリー')
    const status = vs.statuses.get(aliceSeat)!

    // 後勝ち: 行動日 1 = チャーリー黒
    assert.deepStrictEqual(status.assertions.get(1), { target: charSeat, species: 'wolf' })
    // ボブ白 → チャーリー黒 のスライドが previousAssertions に記録される
    assert.ok(status.previousAssertions?.has(1))
  })

  test('0日目 単独 CO: first-seek 由来の先制占い結果として行動日 0 に投入', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO 0日目 ボブ白`)
    const aliceSeat = seat(players, 'アリス')
    const bobSeat = seat(players, 'ボブ')
    const assertions = vs.statuses.get(aliceSeat)!.assertions

    assert.strictEqual(assertions.size, 1)
    assert.deepStrictEqual(assertions.get(0), { target: bobSeat, species: 'human' })
  })
})
