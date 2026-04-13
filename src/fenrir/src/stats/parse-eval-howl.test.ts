import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvalHowl } from './parse-eval-howl.ts'

/** test28 形式: プレイヤー名が役職ラベル、開示行が名前＝ラベル */
const TEST28_HOWL = `配役 狼3 村2 占1 霊1 狩1 共2 猫1 信1 狐1 背1

# seed: 10000
++狩、占、背、狼１、共１、猫、信、狼２、共２、狼３、村１、狐、村２、霊

占 死亡

背 占いCO 狐○
狼１ 狩りCO
共１ 共有CO 共２白
信 霊能CO
狼２ 狩りCO
共２ 共有CO 共１白
狼３ 狩りCO
霊 霊能CO
狩 狩りCO 狼２護衛

狩→背
背→狼３
狼１→狐
共１→背
猫→背
信→背
狼２→狐
共２→背
狼３→狐
村１→背
狐→背
村２→背
霊→背

背処刑

# 霊能: 背 = ○

狐勝利

狩＝狩り
占＝占い
背＝背徳
狼１＝人狼
共１＝共有
猫＝猫
信＝狂信
狼２＝人狼
共２＝共有
狼３＝人狼
村１＝村
狐＝狐
村２＝村
霊＝霊
`

describe('parseEvalHowl', () => {
  it('parses test28 format: reveal, day0 death, day1 claims', () => {
    const game = parseEvalHowl(TEST28_HOWL)

    assert.equal(game.result, 'werehamster_won')
    assert.equal(game.day0Deaths, 1) // 占 死亡

    // 14 seats - 1 day0 death = 13 entries
    assert.equal(game.entries.length, 13)

    // 占 (seer) died day 0 → not in entries
    const seerEntries = game.entries.filter(e => e.role === 'seer')
    assert.equal(seerEntries.length, 0)

    // 背 (immoralist) claimed seer
    const immoralist = game.entries.find(e => e.role === 'immoralist')
    assert.equal(immoralist?.claim, 'seer')

    // 狼１/狼２/狼３ all claimed bodyguard
    const wolves = game.entries.filter(e => e.role === 'werewolf')
    assert.equal(wolves.length, 3)
    assert.ok(wolves.every(w => w.claim === 'bodyguard'))

    // 共１/共２ claimed mason
    const masons = game.entries.filter(e => e.role === 'mason')
    assert.equal(masons.length, 2)
    assert.ok(masons.every(m => m.claim === 'mason'))

    // 信 (fanatic) claimed medium
    const fanatic = game.entries.find(e => e.role === 'fanatic')
    assert.equal(fanatic?.claim, 'medium')

    // 狩 (bodyguard) claimed bodyguard
    const bg = game.entries.find(e => e.role === 'bodyguard')
    assert.equal(bg?.claim, 'bodyguard')

    // 霊 (medium) claimed medium
    const medium = game.entries.find(e => e.role === 'medium')
    assert.equal(medium?.claim, 'medium')

    // 狐 (werehamster) did NOT CO on day 1 → none (CO came on day 2)
    const fox = game.entries.find(e => e.role === 'werehamster')
    assert.equal(fox?.claim, 'none')

    // 村１/村２ did not CO
    const villagers = game.entries.filter(e => e.role === 'villager')
    assert.equal(villagers.length, 2)
    assert.ok(villagers.every(v => v.claim === 'none'))

    // 猫 did not CO (nekomata claim came later)
    const neko = game.entries.find(e => e.role === 'nekomata')
    assert.equal(neko?.claim, 'none')
  })

  it('returns unknown result when no reveal block', () => {
    const game = parseEvalHowl('# bogus\n背 占いCO 狐○\n')
    assert.equal(game.result, 'unknown')
    assert.equal(game.entries.length, 0)
  })
})
