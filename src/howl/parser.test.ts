import { describe, test } from 'node:test'
import assert from 'node:assert'
import { parse } from './parser.ts'

describe('parser', () => {
  const howl = `---
title: Example Howl File
description: Demonstrates various statement types in the Howl format
author: aklas
date: 2023-10-01
---

+便ールガンカ、花京院、小梅ちゃん、ワンワン、ウルガー、ペガサス盛り、星刻、百面ダイス、ブルファンゴ、泣く女、ビスマス結晶、スレッタ、裁縫龍、グロ中尉

噛み　ルガ

百面ダイス　占いCO　グロ白
グロ　占いCO　小梅ちゃん白
泣く女　占いco　スレッタ○

星　霊CO

共有　ペガサス　裁縫龍

百面ダイス　スレッタ黒

吊り　ダイス

噛み　グロ

泣く　花京院白

星　白

吊り　泣く女


噛み　ペガサス

星　黒

ウルガー　猫狩CO
スレ　猫狩CO
ビス　猫狩CO

吊り　ブル

噛み　裁縫龍

星　白

ビスマス　猫CO
ウル　猫CO

スレ　狩りCO　泣く女護衛　星護衛　星護衛

吊り　ワン

平和

星　黒

スレ　小梅護衛

吊り　花京院

噛み　小梅

星　白

スレ　星護衛

ビスマス　妖狐CO

吊り　ビスマス

星噛

人狼勝利

ダイス＝背徳
グロ＝占い
泣く＝人狼
ペが＝共有
ぶる＝村
裁縫＝共有
ワン＝人狼
花京院＝狂信
小梅＝村
ビス＝狐
星＝霊
ウル＝猫
スレ＝人狼
初日＝狩り

  `
  test('valid parser function with howl file', () => {
    const parsed = parse(howl)

    assert.ok(parsed.meta)
    assert.ok(parsed.statements)
  })

  test('assigns day numbers to statements', () => {
    const parsed = parse(howl)
    const stmts = parsed.statements

    // All statements should have a day
    for (const s of stmts) {
      assert.ok(s.day !== undefined, `statement ${s.type} at line ${s.line} should have day`)
    }

    // join is day 1
    assert.strictEqual(stmts[0].day, 1)

    // First attack (噛み ルガ) advances to day 2
    const firstAttack = stmts.find(s => s.type === 'attack')!
    assert.strictEqual(firstAttack.day, 2)

    // Statements after first attack but before next attack/peace are day 2
    const firstAttackIdx = stmts.indexOf(firstAttack)
    const nextBoundary = stmts.findIndex((s, i) => i > firstAttackIdx && (s.type === 'attack' || s.type === 'peace'))
    for (let i = firstAttackIdx + 1; i < nextBoundary; i++) {
      assert.strictEqual(stmts[i].day, 2, `statement ${stmts[i].type} at line ${stmts[i].line} should be day 2`)
    }
  })

  test('multiple attacks in one night share the same day', () => {
    const text = `+Alice,Bob,Charlie,Dave,Eve
吊り Alice
噛み Bob
噛み Charlie
Dave→Eve
吊り Eve`
    const stmts = parse(text).statements
    // join, lynch = day 1
    assert.strictEqual(stmts[0].day, 1) // join
    assert.strictEqual(stmts[1].day, 1) // lynch Alice
    // Both attacks = day 2 (single increment)
    assert.strictEqual(stmts[2].day, 2) // attack Bob
    assert.strictEqual(stmts[3].day, 2) // attack Charlie
    // Next daytime statements = day 2
    assert.strictEqual(stmts[4].day, 2) // vote
    assert.strictEqual(stmts[5].day, 2) // lynch Eve
  })

  test('peace and attack do not double-increment', () => {
    const text = `+Alice,Bob,Charlie
吊り Alice
平和
Bob→Charlie
吊り Charlie`
    const stmts = parse(text).statements
    assert.strictEqual(stmts[0].day, 1) // join
    assert.strictEqual(stmts[1].day, 1) // lynch
    assert.strictEqual(stmts[2].day, 2) // peace
    assert.strictEqual(stmts[3].day, 2) // vote
    assert.strictEqual(stmts[4].day, 2) // lynch
  })
})

describe('fillMultiVoteVoters', () => {
  function findMultiVotes(text: string) {
    return parse(text).statements
      .filter((s: any) => s.type === 'multiVote')
      .map((s: any) => ({ target: s.target, voters: s.voters }))
  }

  test('empty multiVote excludes later explicit voters in same round', () => {
    const text = `+Alice,Bob,Charlie,Dave,Eve
噛み Alice
Charlie←
Dave→Bob
吊り Bob`
    const mvs = findMultiVotes(text)
    assert.strictEqual(mvs.length, 1)
    // "Charlie←" means target=Charlie, voters=empty
    // Explicit voters in round: Dave
    // Alive after attack on Alice: Bob, Charlie, Dave, Eve
    // remaining = alive - explicit - target = Bob, Eve
    assert.deepStrictEqual(mvs[0].target, 'Charlie')
    assert.deepStrictEqual(mvs[0].voters.sort(), ['Bob', 'Eve'].sort())
  })

  test('empty multiVote with no later votes gets all alive', () => {
    const text = `+Alice,Bob,Charlie
噛み Alice
Charlie←
吊り Charlie`
    const mvs = findMultiVotes(text)
    assert.strictEqual(mvs.length, 1)
    assert.deepStrictEqual(mvs[0].voters.sort(), ['Bob'].sort())
  })

  test('revote resets round — voters from previous round do not affect new round', () => {
    const text = `+Alice,Bob,Charlie,Dave
噛み Alice
Bob→Charlie
再投票
Charlie←
吊り Charlie`
    const mvs = findMultiVotes(text)
    assert.strictEqual(mvs.length, 1)
    // After revote, new round: no explicit voters
    // Alive: Bob, Charlie, Dave. Target=Charlie excluded.
    assert.deepStrictEqual(mvs[0].voters.sort(), ['Bob', 'Dave'].sort())
  })

  test('lynch resets for next day — dead player excluded', () => {
    const text = `+Alice,Bob,Charlie,Dave,Eve
噛み Alice
Bob→Charlie
吊り Charlie
噛み Dave
Eve←
吊り Eve`
    const mvs = findMultiVotes(text)
    assert.strictEqual(mvs.length, 1)
    // After lynch Charlie + attack Dave: alive = Bob, Eve
    // No explicit voters, target=Eve excluded
    assert.deepStrictEqual(mvs[0].voters.sort(), ['Bob'].sort())
  })

  test('attack removes dead from alive set', () => {
    const text = `+Alice,Bob,Charlie,Dave
噛み Alice
Dave←
吊り Dave
噛み Bob
Charlie←
吊り Charlie`
    const mvs = findMultiVotes(text)
    assert.strictEqual(mvs.length, 2)
    // Round 1: alive after attack Alice = Bob,Charlie,Dave. No explicit voters. Target=Dave excluded.
    assert.deepStrictEqual(mvs[0].voters.sort(), ['Bob', 'Charlie'].sort())
    // Round 2: alive after lynch Dave + attack Bob = Charlie. No explicit voters. Target=Charlie excluded.
    assert.deepStrictEqual(mvs[1].voters.sort(), [].sort())
  })

  test('multiple empty multiVotes in same round share same voters', () => {
    const text = `+Alice,Bob,Charlie,Dave,Eve
噛み Alice
Bob←
Charlie←
Dave→Eve
吊り Eve`
    const mvs = findMultiVotes(text)
    assert.strictEqual(mvs.length, 2)
    // Explicit voter: Dave
    // Alive: Bob, Charlie, Dave, Eve
    // remaining = alive - explicit = Bob, Charlie, Eve
    // Bob←: target=Bob excluded → Charlie, Eve
    // Charlie←: target=Charlie excluded → Bob, Eve
    assert.deepStrictEqual(mvs[0].voters.sort(), ['Charlie', 'Eve'].sort())
    assert.deepStrictEqual(mvs[1].voters.sort(), ['Bob', 'Eve'].sort())
  })

  test('all alive voted explicitly — empty multiVote gets empty voters', () => {
    const text = `+Alice,Bob,Charlie
噛み Alice
Bob→Charlie
Charlie←
吊り Charlie`
    const mvs = findMultiVotes(text)
    assert.strictEqual(mvs.length, 1)
    // Explicit: Bob. Alive: Bob, Charlie. Target=Charlie excluded. remaining = []
    assert.deepStrictEqual(mvs[0].voters.sort(), [].sort())
  })

  test('scenario: アルティメット人狼 5-3 — abbreviated names resolved for multiVote fill', () => {
    const text = `---
title: アルティメット人狼 5-3
author: 俺
setup:
  werewolf: 3
  possessed: 1
  seer: 1
  medium: 1
  bodyguard: 1
  villager: 6
---

+ マドック、ダンカン、デイジー、メイソン、結、藤澤 仁、児玉　健、森本　茂樹、大野　聡、　伊藤　真吾、香川　愛生、村中　秀史、中田　功

村中→伊藤
大野→中田
中田→藤澤
ダンカン→村中
まど→香川
香川→ダンカン
藤澤→ダンカン
森本→まど
メイソン→大野
伊藤→中田
児玉→藤澤
でじ→村中
結→でじ
ーーーーーー
ダンカン　予言CO　香川○
中田　予言CO　森本白

ダンカン←児玉
藤澤←メイソン、結、森本、大野、香川
村中←まど、伊藤、デイジー
中田←`
    const result = parse(text)
    const mvs = result.statements
      .filter((s: any) => s.type === 'multiVote')
      .map((s: any) => ({ target: s.target, voters: s.voters }))

    assert.strictEqual(mvs.length, 4)

    // ダンカン←児玉 (explicit, not empty)
    assert.deepStrictEqual(mvs[0].target, 'ダンカン')
    assert.deepStrictEqual(mvs[0].voters, ['児玉'])

    // 藤澤←メイソン、結、森本、大野、香川 (explicit)
    assert.deepStrictEqual(mvs[1].target, '藤澤')
    assert.deepStrictEqual(mvs[1].voters, ['メイソン', '結', '森本', '大野', '香川'])

    // 村中←まど、伊藤、デイジー (explicit)
    assert.deepStrictEqual(mvs[2].target, '村中')
    assert.deepStrictEqual(mvs[2].voters, ['まど', '伊藤', 'デイジー'])

    // 中田← (empty multiVote, revote round)
    // Candidates (targets): ダンカン, 藤澤, 村中, 中田 — all excluded from voters
    // Explicit voters cover the rest → empty
    assert.deepStrictEqual(mvs[3].target, '中田')
    assert.deepStrictEqual(mvs[3].voters, [])
  })

  test('scenario: vote.final=revote allows candidates to vote', () => {
    const text = `---
title: アルティメット人狼 5-3
rules:
  vote.final: revote
---

+ マドック、ダンカン、デイジー、メイソン、結、藤澤 仁、児玉　健、森本　茂樹、大野　聡、　伊藤　真吾、香川　愛生、村中　秀史、中田　功

村中→伊藤
大野→中田
中田→藤澤
ダンカン→村中
まど→香川
香川→ダンカン
藤澤→ダンカン
森本→まど
メイソン→大野
伊藤→中田
児玉→藤澤
でじ→村中
結→でじ
ーーーーーー

ダンカン←児玉
藤澤←メイソン、結、森本、大野、香川
村中←まど、伊藤、デイジー
中田←`
    const result = parse(text)
    const mvs = result.statements
      .filter((s: any) => s.type === 'multiVote')
      .map((s: any) => ({ target: s.target, voters: s.voters }))

    // With option: candidates CAN vote, so only explicit voters + target excluded
    // 13 alive - 9 explicit - target(中田　功) = ダンカン, 藤澤 仁, 村中　秀史
    assert.deepStrictEqual(mvs[3].target, '中田')
    assert.deepStrictEqual(mvs[3].voters.sort(), ['ダンカン', '村中　秀史', '藤澤 仁'].sort())
  })

  test('non-empty multiVote voters counted as explicit', () => {
    const text = `+Alice,Bob,Charlie,Dave,Eve
噛み Alice
Charlie←Bob,Dave
Eve←
吊り Eve`
    const mvs = findMultiVotes(text)
    assert.strictEqual(mvs.length, 2)
    // First multiVote has explicit voters Bob, Dave
    assert.deepStrictEqual(mvs[0].voters.sort(), ['Bob', 'Dave'].sort())
    // Second multiVote: explicit = Bob, Dave. Alive = Bob,Charlie,Dave,Eve. Target=Eve excluded. remaining = Charlie
    assert.deepStrictEqual(mvs[1].voters.sort(), ['Charlie'].sort())
  })
})

describe('fillMediumTargets', () => {
  function findAsserts(text: string) {
    return parse(text).statements
      .filter((s: any) => s.type === 'assert')
      .map((s: any) => ({ actor: s.actor, assertions: s.assertions }))
  }

  test('medium result without target is filled from lynch history', () => {
    const text = `+Alice,Bob,Charlie,Dave
噛み Alice
Bob　霊CO　白
吊り Charlie
噛み Dave
Bob　黒`
    const asserts = findAsserts(text)
    // Bob claims medium; first result (白) → Charlie (1st lynch)
    assert.strictEqual(asserts[0].assertions[1].target, 'Charlie')
    // Second statement: 黒 → no second lynch yet, but Charlie is 1st
    // Wait: there's only one lynch (Charlie). Bob's 1st result is from CO statement.
    // "Bob　霊CO　白" has role claim + one history entry (白, no target) → target = Charlie
    assert.strictEqual(asserts[0].assertions.length, 2)
    assert.strictEqual(asserts[0].assertions[1].target, 'Charlie')
    assert.strictEqual(asserts[0].assertions[1].result, 'isHuman')
  })

  test('incremental medium reports match sequential lynches', () => {
    const text = `+Alice,Bob,Charlie,Dave,Eve,Frank
噛み Alice
Bob　霊CO
吊り Charlie
噛み Dave
Bob　白
吊り Eve
Bob　黒`
    const asserts = findAsserts(text)
    // Bob's 1st result (白) → Charlie (1st lynch)
    assert.strictEqual(asserts[1].assertions[0].target, 'Charlie')
    assert.strictEqual(asserts[1].assertions[0].result, 'isHuman')
    // Bob's 2nd result (黒) → Eve (2nd lynch)
    assert.strictEqual(asserts[2].assertions[0].target, 'Eve')
    assert.strictEqual(asserts[2].assertions[0].result, 'isWolf')
  })

  test('medium claim after results — retroactive fill', () => {
    const text = `+Alice,Bob,Charlie,Dave,Eve
噛み Alice
Bob　白
吊り Charlie
噛み Dave
Bob　霊CO　黒`
    const asserts = findAsserts(text)
    // "Bob　白" before CO → still filled since Bob eventually claims medium
    assert.strictEqual(asserts[0].assertions[0].target, 'Charlie')
    assert.strictEqual(asserts[0].assertions[0].result, 'isHuman')
    // "Bob　霊CO　黒" → 2nd result (黒), but only 1 lynch (Charlie) so far
    // Wait: the CO has a role claim + history entry. The history entry is the 2nd result.
    // But there's only 1 lynch. So target stays undefined.
    assert.strictEqual(asserts[1].assertions[1].target, undefined)
  })

  test('non-medium assert is not affected', () => {
    const text = `+Alice,Bob,Charlie,Dave
噛み Alice
Bob　占いCO　Charlie白
吊り Dave`
    const asserts = findAsserts(text)
    // Bob is seer, not medium — target already specified as Charlie
    assert.strictEqual(asserts[0].assertions[1].target, 'Charlie')
    assert.strictEqual(asserts[0].assertions[1].result, 'isHuman')
  })

  test('medium with explicit target is not overwritten', () => {
    const text = `+Alice,Bob,Charlie,Dave
噛み Alice
Bob　霊CO　Charlie白
吊り Dave`
    const asserts = findAsserts(text)
    // Explicit target Charlie — should not be overwritten to Dave
    assert.strictEqual(asserts[0].assertions[1].target, 'Charlie')
  })

  test('scenario: medium incremental reports in full game', () => {
    const text = `+便ールガンカ、花京院、小梅ちゃん、ワンワン、ウルガー、ペガサス盛り、星刻、百面ダイス、ブルファンゴ、泣く女、ビスマス結晶、スレッタ、裁縫龍、グロ中尉

噛み　ルガ

百面ダイス　占いCO　グロ白
グロ　占いCO　小梅ちゃん白
泣く女　占いco　スレッタ○

星　霊CO

共有　ペガサス　裁縫龍

百面ダイス　スレッタ黒

吊り　ダイス

噛み　グロ

泣く　花京院白

星　白

吊り　泣く女

噛み　ペガサス

星　黒

吊り　ブル

噛み　裁縫龍

星　白

吊り　ワン

平和

星　黒

吊り　花京院

噛み　小梅

星　白

吊り　ビスマス

星噛

人狼勝利`
    const result = parse(text)
    const starAsserts = result.statements
      .filter((s: any) => s.type === 'assert' && s.actor === '星')
      .map((s: any) => s.assertions.filter((a: any) => !a.roles))
      .flat()

    // 星 claims medium. Lynch order: ダイス, 泣く女, ブル, ワン, 花京院, ビスマス
    // 星 reports 5 results (attacked before reporting 6th)
    const expectedTargets = ['百面ダイス', '泣く女', 'ブルファンゴ', 'ワンワン', '花京院']
    const expectedResults = ['isHuman', 'isWolf', 'isHuman', 'isWolf', 'isHuman']

    assert.strictEqual(starAsserts.length, 5)
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(starAsserts[i].target, expectedTargets[i], `target at index ${i}`)
      assert.strictEqual(starAsserts[i].result, expectedResults[i], `result at index ${i}`)
    }
  })
})

describe('curse and follow statements in parser', () => {
  test('curse removes target from alive set', () => {
    const howl = `+アリス、ボブ、チャーリー、デイブ

吊り アリス
道連れ ボブ

チャーリー←
吊り チャーリー`

    const result = parse(howl)
    const lynch1 = result.statements.find((s: any) => s.type === 'lynch' && s.target === 'アリス')
    assert.ok(lynch1, 'first lynch exists')

    const curse = result.statements.find((s: any) => s.type === 'curse')
    assert.deepEqual(curse?.type, 'curse')
    assert.deepEqual((curse as any).target, 'ボブ')

    // After curse, multiVote should not include ボブ as voter
    const multiVote = result.statements.find((s: any) => s.type === 'multiVote') as any
    assert.ok(multiVote, 'multiVote exists')
    assert.ok(!multiVote.voters.includes('ボブ'), 'curse victim excluded from voters')
    assert.ok(!multiVote.voters.includes('アリス'), 'lynch victim excluded from voters')
  })

  test('follow removes target from alive set', () => {
    const howl = `+アリス、ボブ、チャーリー、デイブ

吊り アリス
後追い ボブ

チャーリー←
吊り チャーリー`

    const result = parse(howl)
    const follow = result.statements.find((s: any) => s.type === 'follow')
    assert.deepEqual(follow?.type, 'follow')
    assert.deepEqual((follow as any).target, 'ボブ')

    const multiVote = result.statements.find((s: any) => s.type === 'multiVote') as any
    assert.ok(multiVote, 'multiVote exists')
    assert.ok(!multiVote.voters.includes('ボブ'), 'follow victim excluded from voters')
  })

  test('curse and follow get correct day assignment', () => {
    const howl = `+アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス
道連れ ボブ
後追い チャーリー

噛み デイブ`

    const result = parse(howl)
    const lynch = result.statements.find((s: any) => s.type === 'lynch') as any
    const curse = result.statements.find((s: any) => s.type === 'curse') as any
    const follow = result.statements.find((s: any) => s.type === 'follow') as any
    const attack = result.statements.find((s: any) => s.type === 'attack') as any

    assert.strictEqual(lynch.day, 1)
    assert.strictEqual(curse.day, 1)
    assert.strictEqual(follow.day, 1)
    assert.strictEqual(attack.day, 2)
  })
})
