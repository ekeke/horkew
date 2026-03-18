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

  test('scenario: revoteCandidatesCanVote option allows candidates to vote', () => {
    const text = `---
title: アルティメット人狼 5-3
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
    const result = parse(text, { revoteCandidatesCanVote: true })
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
