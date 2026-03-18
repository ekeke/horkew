import { describe, test } from 'node:test'
import assert from 'node:assert'
import { parse } from './parser.ts'
import { buildVillageStatus } from './bridge.ts'
import { VillageRetar } from '../retar/index.ts'

describe('bridge: curse statement', () => {
  test('curse after execution sets cursed_by_executed_nekomata', () => {
    const howl = `+アリス、ボブ、チャーリー、デイブ、エミリー

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
    const howl = `+アリス、ボブ、チャーリー、デイブ、エミリー

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
    const howl = `+アリス、ボブ、チャーリー、デイブ、エミリー

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
    const howl = `+アリス、ボブ、チャーリー、デイブ、エミリー

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

describe('bridge: curse/follow in kills map', () => {
  test('curse and follow victims appear in kills map', () => {
    const howl = `+アリス、ボブ、チャーリー、デイブ、エミリー、フランク

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

+エーカゲン２世、ガーグァ、ボムへい、考える人、おわんくん、羽根帚、今川義元、アンゴラウサギ、アネモネ、ちせ、サターニャ、マーマイト、オカリン、闇さとし

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

+エーカゲン２世、ガーグァ、ボムへい、考える人、おわんくん、羽根帚、今川義元、アンゴラウサギ、アネモネ、ちせ、サターニャ、マーマイト、オカリン、闇さとし

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
