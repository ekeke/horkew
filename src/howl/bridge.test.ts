import { describe, test } from 'node:test'
import assert from 'node:assert'
import { parse } from './parser.ts'
import { buildVillageStatus } from './bridge.ts'
import { VillageRetar } from '../retar/index.ts'

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
      seerClaimingDueDate: 99, mediumClaimingDueDate: 99,
      bodyguardClaimingDueDate: 99, masonClaimingDueDate: 99,
      nekomataClaimingDueDate: 99,
      dayCountFrom: 1, hasFirstGhost: false,
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
