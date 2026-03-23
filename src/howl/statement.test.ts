import { describe, test } from 'node:test'
import assert from 'node:assert'
import * as S from './statement.ts'



describe('join statement (single player)', () => {
  test('name only', () => {
    const result = S.parseJoinStatement('+Alice', 1)
    assert.deepEqual(result, {
      type: 'join',
      line: 1,
      name: 'Alice',
      aliases: [],
    })
  })

  test('name with short name', () => {
    const result = S.parseJoinStatement('+Alice(Al)', 1)
    assert.deepEqual(result, {
      type: 'join',
      line: 1,
      name: 'Alice',
      shortName: 'Al',
      aliases: [],
    })
  })

  test('name with short name and aliases', () => {
    const result = S.parseJoinStatement('+Alice(Al), アリス', 1)
    assert.deepEqual(result, {
      type: 'join',
      line: 1,
      name: 'Alice',
      shortName: 'Al',
      aliases: ['アリス'],
    })
  })

  test('full-width brackets for short name', () => {
    const result = S.parseJoinStatement('＋ボブ（ボ）、Bob', 1)
    assert.deepEqual(result, {
      type: 'join',
      line: 1,
      name: 'ボブ',
      shortName: 'ボ',
      aliases: ['Bob'],
    })
  })

  test('name with multiple aliases', () => {
    const result = S.parseJoinStatement('+Alice(Al), アリス, ally', 1)
    assert.deepEqual(result, {
      type: 'join',
      line: 1,
      name: 'Alice',
      shortName: 'Al',
      aliases: ['アリス', 'ally'],
    })
  })

  test('does not match double plus', () => {
    const result = S.parseJoinStatement('++Alice, Bob', 1)
    assert.equal(result, null)
  })

  test('invalid join statement', () => {
    const result = S.parseJoinStatement('', 1)
    assert.equal(result, null)
  })

  test('returns null for plus with no name', () => {
    const result = S.parseJoinStatement('+', 1)
    assert.equal(result, null)
  })

  test('space-delimited aliases', () => {
    const result = S.parseJoinStatement('+Alice Bob', 1)
    assert.deepEqual(result, {
      type: 'join',
      line: 1,
      name: 'Alice',
      aliases: ['Bob'],
    })
  })

  test('quoted name with space', () => {
    const result = S.parseJoinStatement('+"Alice Smith"(Al) アリス', 1)
    assert.deepEqual(result, {
      type: 'join',
      line: 1,
      name: 'Alice Smith',
      shortName: 'Al',
      aliases: ['アリス'],
    })
  })

  test('smart quotes', () => {
    const result = S.parseJoinStatement('+\u201CAlice Smith\u201D', 1)
    assert.deepEqual(result, {
      type: 'join',
      line: 1,
      name: 'Alice Smith',
      aliases: [],
    })
  })

  test('fullwidth quotes with shortName and aliases', () => {
    const result = S.parseJoinStatement('＋\uFF02村中　秀史\uFF02（村中）　むらなか　しょあく', 1)
    assert.deepEqual(result, {
      type: 'join',
      line: 1,
      name: '村中　秀史',
      shortName: '村中',
      aliases: ['むらなか', 'しょあく'],
    })
  })
})

describe('joinMulti statement', () => {
  test('valid joinMulti statement', () => {
    const result = S.parseJoinMultiStatement('++John, Curt', 1)
    assert.deepEqual(result, {
      type: 'joinMulti',
      line: 1,
      players: ['John', 'Curt'],
    })
  })

  test('Accepts roughly inputted players on Japanese IME', () => {
    const result = S.parseJoinMultiStatement('　　＋＋ボブ　,　マックス、John', 1)
    assert.deepEqual(result, {
      type: 'joinMulti',
      line: 1,
      players: ['ボブ', 'マックス', 'John'],
    })
  })

  test('mixed plus signs', () => {
    const result = S.parseJoinMultiStatement('+＋Alice, Bob', 1)
    assert.deepEqual(result, {
      type: 'joinMulti',
      line: 1,
      players: ['Alice', 'Bob'],
    })
  })

  test('does not match single plus', () => {
    const result = S.parseJoinMultiStatement('+Alice', 1)
    assert.equal(result, null)
  })

  test('space-delimited players', () => {
    const result = S.parseJoinMultiStatement('++ Alice Bob Charlie', 1)
    assert.deepEqual(result, {
      type: 'joinMulti',
      line: 1,
      players: ['Alice', 'Bob', 'Charlie'],
    })
  })

  test('quoted player name with space', () => {
    const result = S.parseJoinMultiStatement('++ "Alice Smith" Bob', 1)
    assert.deepEqual(result, {
      type: 'joinMulti',
      line: 1,
      players: ['Alice Smith', 'Bob'],
    })
  })

  test('single-quoted player name', () => {
    const result = S.parseJoinMultiStatement("++ 'Alice Smith' Bob", 1)
    assert.deepEqual(result, {
      type: 'joinMulti',
      line: 1,
      players: ['Alice Smith', 'Bob'],
    })
  })

  test('smart quotes', () => {
    const result = S.parseJoinMultiStatement('++ \u201C太郎\u201D \u2018次郎\u2019', 1)
    assert.deepEqual(result, {
      type: 'joinMulti',
      line: 1,
      players: ['太郎', '次郎'],
    })
  })
})

describe('vote statement', () => {
  test('valid vote statement', () => {
    const result = S.parseVoteStatement('John→Curt', 1)
    assert.deepEqual(result, {
      type: 'vote',
      line: 1,
      voter: 'John',
      target: 'Curt',
    })
  })

  test('Accepts roughly inputted players on Japanese IME', () => {
    const result = S.parseVoteStatement('　　John　ー＞　Curt　', 1)
    assert.deepEqual(result, {
      type: 'vote',
      line: 1,
      voter: 'John',
      target: 'Curt',
    })
  })

  test('invalid vote statement', () => {
    const result = S.parseVoteStatement('', 1)
    assert.equal(result, null)
  })
})

describe('multiVote statement', () => {
  test('valid multiVote statement', () => {
    const result = S.parseMultiVoteStatement('John←Alice, Bob, Charlie', 1)
    assert.deepEqual(result, {
      type: 'multiVote',
      line: 1,
      voters: ['Alice', 'Bob', 'Charlie'],
      target: 'John',
    })
  })

  test('Accepts roughly inputted players on Japanese IME', () => {
    const result = S.parseMultiVoteStatement('　　ポール　＜ー　マイク　,　サラ、田中　', 1)
    assert.deepEqual(result, {
      type: 'multiVote',
      line: 1,
      voters: ['マイク', 'サラ', '田中'],
      target: 'ポール',
    })
  })

  test('empty voters', () => {
    const result = S.parseMultiVoteStatement('John←', 1)
    assert.deepEqual(result, {
      type: 'multiVote',
      line: 1,
      voters: [],
      target: 'John',
    })
  })

  test('empty voters with spaces', () => {
    const result = S.parseMultiVoteStatement('　ポール　＜ー　', 1)
    assert.deepEqual(result, {
      type: 'multiVote',
      line: 1,
      voters: [],
      target: 'ポール',
    })
  })

  test('invalid multiVote statement', () => {
    const result = S.parseMultiVoteStatement('', 1)
    assert.equal(result, null)
  })

})

describe('attack statement', () => {
  test('valid attack statement', () => {
    const result = S.parseAttackStatement('襲撃　　John, Bob, Charlie', 1)
    assert.deepEqual(result, {
      type: 'attack',
      line: 1,
      target: ['John', 'Bob', 'Charlie'],
    })
  })

  test('Accepts roughly inputted players on Japanese IME', () => {
    const result = S.parseAttackStatement('　　噛み：　　ポール、マイク　サラ　', 1)
    assert.deepEqual(result, {
      type: 'attack',
      line: 1,
      target: ['ポール', 'マイク', 'サラ'],
    })
  })

  test('死亡 as attack alias', () => {
    const result = S.parseAttackStatement('死亡　Alice', 1)
    assert.deepEqual(result, {
      type: 'attack',
      line: 1,
      target: ['Alice'],
    })
  })

  test('reverse pattern with delimiter/space', () => {
    assert.deepEqual(S.parseAttackStatement('bob　死亡', 1), {
      type: 'attack', line: 1, target: ['bob'],
    })
    assert.deepEqual(S.parseAttackStatement('Alice 噛み', 1), {
      type: 'attack', line: 1, target: ['Alice'],
    })
  })

  test('invalid attack statement', () => {
    const result = S.parseAttackStatement('', 1)
    assert.equal(result, null)
  })
})

describe('lynch statement', () => {
  test('valid lynch statement', () => {
    const result = S.parseLynchStatement('吊り　　John', 1)
    assert.deepEqual(result, {
      type: 'lynch',
      line: 1,
      target: 'John',
    })
  })

  test('Accepts roughly inputted players on Japanese IME', () => {
    const result = S.parseLynchStatement('　　処刑：　　ポール　', 1)
    assert.deepEqual(result, {
      type: 'lynch',
      line: 1,
      target: 'ポール',
    })
  })

  test('no execution: 処刑者なし', () => {
    const result = S.parseLynchStatement('処刑者なし', 1)
    assert.deepEqual(result, {
      type: 'lynch',
      line: 1,
      target: null,
    })
  })

  test('no execution: 吊りなし', () => {
    const result = S.parseLynchStatement('吊りなし', 1)
    assert.deepEqual(result, {
      type: 'lynch',
      line: 1,
      target: null,
    })
  })

  test('no execution: 処刑無し', () => {
    const result = S.parseLynchStatement('処刑無し', 1)
    assert.deepEqual(result, {
      type: 'lynch',
      line: 1,
      target: null,
    })
  })

  test('no execution: 吊ナシ with spaces', () => {
    const result = S.parseLynchStatement('　　吊ナシ　', 1)
    assert.deepEqual(result, {
      type: 'lynch',
      line: 1,
      target: null,
    })
  })

  test('invalid lynch statement', () => {
    const result = S.parseLynchStatement('', 1)
    assert.equal(result, null)
  })
})

describe('revote statement', () => {
  test('valid revote statement', () => {
    const result = S.parseRevoteStatement('再投票　　John, Bob, Charlie', 1)
    assert.deepEqual(result, {
      type: 'revote',
      line: 1,
      targets: ['John', 'Bob', 'Charlie'],
    })
  })

  test('Accepts roughly inputted players on Japanese IME', () => {
    const result = S.parseRevoteStatement('　　再投票：　　ポール、マイク　サラ　', 1)
    assert.deepEqual(result, {
      type: 'revote',
      line: 1,
      targets: ['ポール', 'マイク', 'サラ'],
    })
  })

  test('Accepts no final vote candidates version', () => {
    const result = S.parseRevoteStatement('---', 1)
    assert.deepEqual(result, {
      type: 'revote',
      line: 1,
      targets: [],
    })
  })

  test('Accepts full-width long dash', () => {
    const result = S.parseRevoteStatement('ーーー', 1)
    assert.deepEqual(result, {
      type: 'revote',
      line: 1,
      targets: [],
    })
  })

  test('Accepts full-width equals', () => {
    const result = S.parseRevoteStatement('＝＝＝', 1)
    assert.deepEqual(result, {
      type: 'revote',
      line: 1,
      targets: [],
    })
  })

  test('invalid revote statement', () => {
    const result = S.parseRevoteStatement('', 1)
    assert.equal(result, null)
  })
})

describe('over statement', () => {
  test('valid over statement', () => {
    const result = S.parseOverStatement('村勝ち', 1)
    assert.deepEqual(result, {
      type: 'over',
      line: 1,
      result: 'villageWin',
    })
  })

  test('Accepts roughly inputted players on Japanese IME', () => {
    const result = S.parseOverStatement('　　勝ち：　　村人陣営　', 1)
    assert.deepEqual(result, {
      type: 'over',
      line: 1,
      result: 'villageWin',
    })
  })

  test('Accepts wolf win version', () => {
    const result = S.parseOverStatement('人狼陣営勝利', 1)
    assert.deepEqual(result, {
      type: 'over',
      line: 1,
      result: 'wolfWin',
    })
  })

  test('Accepts draw version', () => {
    const result = S.parseOverStatement('引き分け', 1)
    assert.deepEqual(result, {
      type: 'over',
      line: 1,
      result: 'draw',
    })
  })

  test('invalid over statement', () => {
    const result = S.parseOverStatement('', 1)
    assert.equal(result, null)
  })
})

describe('assert statement', () => {
  test('valid assert statement', () => {
    const result = S.parseAssertStatement('間宮:　占いCO　辺古山白　西園寺●', 1)
    assert.deepEqual(result, {
      actor: '間宮',
      type: 'assert',
      line: 1,
      assertions: [
        {
          player: '間宮',
          roles: ['seer'],
        },
        {
          player: '間宮',
          target: '辺古山',
          result: 'isHuman',
        },
        {
          player: '間宮',
          target: '西園寺',
          result: 'isWolf',
        },
      ]
    })
  })
})


describe('the parser function', () => {
  test('valid parser function with join', () => {
    const result = S.parseStatement('　　＋John, Curt　', 1)
    assert.deepEqual(result, {
      type: 'join',
      line: 1,
      name: 'John',
      aliases: ['Curt'],
    })
  })

  test('valid parser function with joinMulti', () => {
    const result = S.parseStatement('　　＋＋John, Curt　', 1)
    assert.deepEqual(result, {
      type: 'joinMulti',
      line: 1,
      players: ['John', 'Curt'],
    })
  })

  test('valid parser function with vote statement', () => {
    const result = S.parseStatement('John→Curt', 1)
    assert.deepEqual(result, {
      type: 'vote',
      line: 1,
      voter: 'John',
      target: 'Curt',
    })
  })

  test('valid parser function with multiVote statement', () => {
    const result = S.parseStatement('John←Alice, Bob, Charlie', 1)
    assert.deepEqual(result, {
      type: 'multiVote',
      line: 1,
      voters: ['Alice', 'Bob', 'Charlie'],
      target: 'John',
    })
  })

  test('valid parser function with attack statement', () => {
    const result = S.parseStatement('襲撃　　John, Bob, Charlie', 1)
    assert.deepEqual(result, {
      type: 'attack',
      line: 1,
      target: ['John', 'Bob', 'Charlie'],
    })
  })

  test('valid parser function with lynch statement', () => {
    const result = S.parseStatement('吊り　　John', 1)
    assert.deepEqual(result, {
      type: 'lynch',
      line: 1,
      target: 'John',
    })
  })

  test('valid parser function with revote statement', () => {
    const result = S.parseStatement('再投票　　John, Bob, Charlie', 1)
    assert.deepEqual(result, {
      type: 'revote',
      line: 1,
      targets: ['John', 'Bob', 'Charlie'],
    })
  })

  test('valid parser function with over statement', () => {
    const result = S.parseStatement('村勝ち', 1)
    assert.deepEqual(result, {
      type: 'over',
      line: 1,
      result: 'villageWin',
    })
  })

  test('valid parser function with assert statement', () => {
    const result = S.parseStatement('間宮:　占いCO　辺古山白　西園寺●', 1)
    assert.deepEqual(result, {
      actor: '間宮',
      type: 'assert',
      line: 1,
      assertions: [
        {
          player: '間宮',
          roles: ['seer'],
        },
        {
          player: '間宮',
          target: '辺古山',
          result: 'isHuman',
        },
        {
          player: '間宮',
          target: '西園寺',
          result: 'isWolf',
        },
      ]
    })
  })

  test('negative assertion (非CO)', () => {
    const result = S.parseAssertStatement('ボブ　非占いCO', 1)
    assert.deepEqual(result, {
      actor: 'ボブ',
      type: 'assert',
      line: 1,
      assertions: [
        {
          player: 'ボブ',
          roles: ['seer'],
          negative: true,
        },
      ]
    })
  })

  test('multi-role CO (ギドラ)', () => {
    const result = S.parseAssertStatement('ボブ　猫狩CO', 1)
    assert.deepEqual(result, {
      actor: 'ボブ',
      type: 'assert',
      line: 1,
      assertions: [
        {
          player: 'ボブ',
          roles: ['bodyguard', 'nekomata'],
        },
      ]
    })
  })

  test('invalid parser function', () => {
    const result = S.parseStatement('', 1)
    assert.deepEqual(result, {
      type: 'unknown',
      line: 1,
      text: '',
    })
  })
})

describe('curse statement', () => {
  test('道連れ keyword', () => {
    const result = S.parseCurseStatement('道連れ ボブ', 1)
    assert.deepEqual(result, { type: 'curse', line: 1, target: 'ボブ' })
  })

  test('猫又の呪い keyword', () => {
    const result = S.parseCurseStatement('猫又の呪い　アリス', 1)
    assert.deepEqual(result, { type: 'curse', line: 1, target: 'アリス' })
  })

  test('reverse pattern: target + 道連れ', () => {
    const result = S.parseCurseStatement('ボブ 道連れ', 1)
    assert.deepEqual(result, { type: 'curse', line: 1, target: 'ボブ' })
  })

  test('reverse pattern: target + 猫又の呪い', () => {
    const result = S.parseCurseStatement('アリス　猫又の呪い', 1)
    assert.deepEqual(result, { type: 'curse', line: 1, target: 'アリス' })
  })

  test('with delimiter', () => {
    const result = S.parseCurseStatement('道連れ：ボブ', 1)
    assert.deepEqual(result, { type: 'curse', line: 1, target: 'ボブ' })
  })

  test('invalid curse statement', () => {
    assert.equal(S.parseCurseStatement('', 1), null)
    assert.equal(S.parseCurseStatement('道連れ', 1), null)
  })
})

describe('follow statement', () => {
  test('後追い keyword', () => {
    const result = S.parseFollowStatement('後追い アリス', 1)
    assert.deepEqual(result, { type: 'follow', line: 1, target: 'アリス' })
  })

  test('reverse pattern: target + 後追い', () => {
    const result = S.parseFollowStatement('チャーリー　後追い', 1)
    assert.deepEqual(result, { type: 'follow', line: 1, target: 'チャーリー' })
  })

  test('with delimiter', () => {
    const result = S.parseFollowStatement('後追い：アリス', 1)
    assert.deepEqual(result, { type: 'follow', line: 1, target: 'アリス' })
  })

  test('invalid follow statement', () => {
    assert.equal(S.parseFollowStatement('', 1), null)
    assert.equal(S.parseFollowStatement('後追い', 1), null)
  })
})

describe('mason statement', () => {
  test('two players', () => {
    const result = S.parseMasonStatement('共有　ボブ　アリス', 1)
    assert.deepEqual(result, {
      type: 'mason',
      line: 1,
      players: ['ボブ', 'アリス'],
    })
  })

  test('three players', () => {
    const result = S.parseMasonStatement('共有　アリス　ボブ　チャーリー', 1)
    assert.deepEqual(result, {
      type: 'mason',
      line: 1,
      players: ['アリス', 'ボブ', 'チャーリー'],
    })
  })

  test('共有者 variant', () => {
    const result = S.parseMasonStatement('共有者　ペガサス　裁縫龍', 1)
    assert.deepEqual(result, {
      type: 'mason',
      line: 1,
      players: ['ペガサス', '裁縫龍'],
    })
  })

  test('invalid mason statement', () => {
    assert.equal(S.parseMasonStatement('', 1), null)
    assert.equal(S.parseMasonStatement('共有', 1), null)
  })
})

describe('setup statement', () => {
  test('all roles with Japanese shorthand', () => {
    const result = S.parseSetupStatement('@ 村4 占1 霊1 狩1 共2 猫1 狼3 狂1 狐1 背1', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: {
        villager: 4, seer: 1, medium: 1, bodyguard: 1,
        mason: 2, nekomata: 1, werewolf: 3, possessed: 1,
        werehamster: 1, immoralist: 1,
      },
    })
  })

  test('full-width @', () => {
    const result = S.parseSetupStatement('＠ 村4 占1 狼3', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { villager: 4, seer: 1, werewolf: 3 },
    })
  })

  test('full-width digits', () => {
    const result = S.parseSetupStatement('@ 村４ 占１ 狼３', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { villager: 4, seer: 1, werewolf: 3 },
    })
  })

  test('longer role names', () => {
    const result = S.parseSetupStatement('@ 村人4 占い師1 霊媒師1 狩人1 人狼3', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { villager: 4, seer: 1, medium: 1, bodyguard: 1, werewolf: 3 },
    })
  })

  test('delimiter variants (comma, 、)', () => {
    const result = S.parseSetupStatement('@ 村4,占1,狼3', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { villager: 4, seer: 1, werewolf: 3 },
    })
  })

  test('no delimiters', () => {
    const result = S.parseSetupStatement('@ 村4占1霊1狩1共2猫1狼3狂1狐1背1', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: {
        villager: 4, seer: 1, medium: 1, bodyguard: 1,
        mason: 2, nekomata: 1, werewolf: 3, possessed: 1,
        werehamster: 1, immoralist: 1,
      },
    })
  })

  test('mixed delimiters and no delimiters', () => {
    const result = S.parseSetupStatement('@ 村4占1 霊1,狼3', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { villager: 4, seer: 1, medium: 1, werewolf: 3 },
    })
  })

  test('fanatic with shorthand 信', () => {
    const result = S.parseSetupStatement('@ 狼3 信1', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { werewolf: 3, fanatic: 1 },
    })
  })

  test('fanatic with 狂信', () => {
    const result = S.parseSetupStatement('@ 狂信1 狂1', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { fanatic: 1, possessed: 1 },
    })
  })

  test('fanatic with 狂信者', () => {
    const result = S.parseSetupStatement('@ 狂信者1 狂人1', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { fanatic: 1, possessed: 1 },
    })
  })

  test('狂 alone maps to possessed, not fanatic', () => {
    const result = S.parseSetupStatement('@ 狂1', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { possessed: 1 },
    })
  })

  test('zero count is allowed', () => {
    const result = S.parseSetupStatement('@ 村4 狼0', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { villager: 4, werewolf: 0 },
    })
  })

  test('returns null for non-@ line', () => {
    assert.equal(S.parseSetupStatement('+Alice', 1), null)
    assert.equal(S.parseSetupStatement('John→Bob', 1), null)
  })

  test('returns null for @ with no valid tokens', () => {
    assert.equal(S.parseSetupStatement('@ abc', 1), null)
  })

  test('returns null for @ with invalid token mixed in', () => {
    assert.equal(S.parseSetupStatement('@ 村4 xyz 狼3', 1), null)
  })

  test('parseStatement routes to setup', () => {
    const result = S.parseStatement('@ 村4 狼2', 1)
    assert.equal(result.type, 'setup')
  })
})

describe('forecast statement', () => {
  test('basic forecast', () => {
    const result = S.parseForecastStatement('さとし 予告 ボム', 1)
    assert.deepEqual(result, {
      type: 'forecast',
      line: 1,
      actor: 'さとし',
      target: 'ボム',
    })
  })

  test('with full-width space', () => {
    const result = S.parseForecastStatement('さとし　予告　ボム', 1)
    assert.deepEqual(result, {
      type: 'forecast',
      line: 1,
      actor: 'さとし',
      target: 'ボム',
    })
  })

  test('with delimiter', () => {
    const result = S.parseForecastStatement('さとし、予告 ボム', 1)
    assert.deepEqual(result, {
      type: 'forecast',
      line: 1,
      actor: 'さとし',
      target: 'ボム',
    })
  })

  test('returns null for empty string', () => {
    assert.equal(S.parseForecastStatement('', 1), null)
  })

  test('returns null for single name', () => {
    assert.equal(S.parseForecastStatement('さとし 予告', 1), null)
  })

  test('returns null for unrelated text', () => {
    assert.equal(S.parseForecastStatement('さとし 占いCO', 1), null)
  })

  test('parseStatement routes to forecast', () => {
    const result = S.parseStatement('さとし 予告 ボム', 1)
    assert.equal(result.type, 'forecast')
  })
})
