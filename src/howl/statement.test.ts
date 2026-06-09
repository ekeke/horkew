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

describe('suddenDeath statement', () => {
  test('basic without reason', () => {
    assert.deepEqual(S.parseSuddenDeathStatement('John突然死', 1), {
      type: 'suddenDeath', line: 1, target: 'John', reason: '',
    })
  })

  test('with full-width parenthesized reason', () => {
    assert.deepEqual(S.parseSuddenDeathStatement('太郎突然死（回線落ち）', 1), {
      type: 'suddenDeath', line: 1, target: '太郎', reason: '回線落ち',
    })
  })

  test('with half-width parenthesized reason', () => {
    assert.deepEqual(S.parseSuddenDeathStatement('Alice突然死(disconnected)', 1), {
      type: 'suddenDeath', line: 1, target: 'Alice', reason: 'disconnected',
    })
  })

  test('empty full-width parens', () => {
    assert.deepEqual(S.parseSuddenDeathStatement('太郎突然死（）', 1), {
      type: 'suddenDeath', line: 1, target: '太郎', reason: '',
    })
  })

  test('empty half-width parens', () => {
    assert.deepEqual(S.parseSuddenDeathStatement('太郎突然死()', 1), {
      type: 'suddenDeath', line: 1, target: '太郎', reason: '',
    })
  })

  test('ASCII keyword suddenDeath', () => {
    assert.deepEqual(S.parseSuddenDeathStatement('John suddenDeath', 1), {
      type: 'suddenDeath', line: 1, target: 'John', reason: '',
    })
  })

  test('ASCII keyword with reason', () => {
    assert.deepEqual(S.parseSuddenDeathStatement('John suddenDeath(network issue)', 1), {
      type: 'suddenDeath', line: 1, target: 'John', reason: 'network issue',
    })
  })

  test('reason with symbols and mixed characters', () => {
    assert.deepEqual(S.parseSuddenDeathStatement('花子突然死(理由に 記号! も?含む)', 1), {
      type: 'suddenDeath', line: 1, target: '花子', reason: '理由に 記号! も?含む',
    })
  })

  test('surrounding whitespace', () => {
    assert.deepEqual(S.parseSuddenDeathStatement('　　太郎突然死　', 1), {
      type: 'suddenDeath', line: 1, target: '太郎', reason: '',
    })
  })

  test('missing player name returns null', () => {
    assert.equal(S.parseSuddenDeathStatement('突然死', 1), null)
  })

  test('missing player name with reason returns null', () => {
    assert.equal(S.parseSuddenDeathStatement('突然死（回線落ち）', 1), null)
  })

  test('unclosed paren returns null', () => {
    assert.equal(S.parseSuddenDeathStatement('太郎突然死（回線落ち', 1), null)
  })

  test('empty string returns null', () => {
    assert.equal(S.parseSuddenDeathStatement('', 1), null)
  })

  test('does not match attack-style 死亡', () => {
    // 「Alice死亡」is an attack statement, not suddenDeath
    assert.equal(S.parseSuddenDeathStatement('Alice死亡', 1), null)
  })

  test('parseStatement routes 突然死 to suddenDeath, not attack', () => {
    const result = S.parseStatement('Alice突然死', 1)
    assert.equal(result.type, 'suddenDeath')
  })

  test('parseStatement still routes 死亡 to attack', () => {
    const result = S.parseStatement('Alice死亡', 1)
    assert.equal(result.type, 'attack')
  })
})

describe('corpseFound statement (焔薙退場)', () => {
  test('forward order with で', () => {
    assert.deepEqual(S.parseCorpseFoundStatement('Alice 死体で発見', 1), {
      type: 'corpseFound', line: 1, target: 'Alice',
    })
  })

  test('forward order without で (短縮形)', () => {
    assert.deepEqual(S.parseCorpseFoundStatement('Alice 死体発見', 1), {
      type: 'corpseFound', line: 1, target: 'Alice',
    })
  })

  test('forward order without delimiter', () => {
    assert.deepEqual(S.parseCorpseFoundStatement('太郎死体で発見', 1), {
      type: 'corpseFound', line: 1, target: '太郎',
    })
  })

  test('reverse order with で', () => {
    assert.deepEqual(S.parseCorpseFoundStatement('死体で発見 Alice', 1), {
      type: 'corpseFound', line: 1, target: 'Alice',
    })
  })

  test('reverse order without で', () => {
    assert.deepEqual(S.parseCorpseFoundStatement('死体発見 太郎', 1), {
      type: 'corpseFound', line: 1, target: '太郎',
    })
  })

  test('surrounding full-width whitespace', () => {
    assert.deepEqual(S.parseCorpseFoundStatement('　　太郎 死体で発見　', 1), {
      type: 'corpseFound', line: 1, target: '太郎',
    })
  })

  test('missing player name returns null', () => {
    assert.equal(S.parseCorpseFoundStatement('死体で発見', 1), null)
  })

  test('empty string returns null', () => {
    assert.equal(S.parseCorpseFoundStatement('', 1), null)
  })

  test('plain 発見 alone is not accepted', () => {
    assert.equal(S.parseCorpseFoundStatement('Alice 発見', 1), null)
  })

  test('parseStatement routes 死体で発見 to corpseFound, not attack', () => {
    // attack vocab には「死亡」が含まれるが、「死体で発見」は別 token として識別される
    const result = S.parseStatement('Alice 死体で発見', 1)
    assert.equal(result.type, 'corpseFound')
  })

  test('parseStatement routes reverse 死体発見 to corpseFound', () => {
    const result = S.parseStatement('死体発見 Alice', 1)
    assert.equal(result.type, 'corpseFound')
  })
})

describe('announce statement (GM 公示)', () => {
  test('※ + 単独プレイヤー + 役職', () => {
    assert.deepEqual(S.parseAnnounceStatement('※ Alice 契約者', 1), {
      type: 'announce', line: 1, kind: 'rolePin', targets: ['Alice'], role: '契約者',
    })
  })

  test('※ + ペア (全角読点区切り) + 役職', () => {
    assert.deepEqual(S.parseAnnounceStatement('※ Alice、Bob 契約者', 1), {
      type: 'announce', line: 1, kind: 'rolePin', targets: ['Alice', 'Bob'], role: '契約者',
    })
  })

  test('※ + 3 名 + 役職', () => {
    assert.deepEqual(S.parseAnnounceStatement('※ Alice、Bob、Carol 契約者', 1), {
      type: 'announce', line: 1, kind: 'rolePin', targets: ['Alice', 'Bob', 'Carol'], role: '契約者',
    })
  })

  test('* (ASCII アスタリスク) も同等', () => {
    assert.deepEqual(S.parseAnnounceStatement('* Alice 契約者', 1), {
      type: 'announce', line: 1, kind: 'rolePin', targets: ['Alice'], role: '契約者',
    })
  })

  test('＊ (全角アスタリスク) も同等', () => {
    assert.deepEqual(S.parseAnnounceStatement('＊ Alice 契約者', 1), {
      type: 'announce', line: 1, kind: 'rolePin', targets: ['Alice'], role: '契約者',
    })
  })

  test('GM: ラベル形式', () => {
    assert.deepEqual(S.parseAnnounceStatement('GM: Alice 契約者', 1), {
      type: 'announce', line: 1, kind: 'rolePin', targets: ['Alice'], role: '契約者',
    })
  })

  test('GM： 全角コロンも同等', () => {
    assert.deepEqual(S.parseAnnounceStatement('GM: Alice 契約者', 1), {
      type: 'announce', line: 1, kind: 'rolePin', targets: ['Alice'], role: '契約者',
    })
    assert.deepEqual(S.parseAnnounceStatement('GM： Alice 契約者', 1), {
      type: 'announce', line: 1, kind: 'rolePin', targets: ['Alice'], role: '契約者',
    })
  })

  test('システム: ラベル形式', () => {
    assert.deepEqual(S.parseAnnounceStatement('システム: Alice 契約者', 1), {
      type: 'announce', line: 1, kind: 'rolePin', targets: ['Alice'], role: '契約者',
    })
  })

  test('アナウンス: ラベル形式', () => {
    assert.deepEqual(S.parseAnnounceStatement('アナウンス: Alice、Bob 契約者', 1), {
      type: 'announce', line: 1, kind: 'rolePin', targets: ['Alice', 'Bob'], role: '契約者',
    })
  })

  test('「契」 1 字短縮形も受ける', () => {
    assert.deepEqual(S.parseAnnounceStatement('※ Alice、Bob 契', 1), {
      type: 'announce', line: 1, kind: 'rolePin', targets: ['Alice', 'Bob'], role: '契',
    })
  })

  test('日本語プレイヤー名', () => {
    assert.deepEqual(S.parseAnnounceStatement('※ 美耶子、亜矢子 契約者', 1), {
      type: 'announce', line: 1, kind: 'rolePin', targets: ['美耶子', '亜矢子'], role: '契約者',
    })
  })

  test('marker のみ (中身なし) は null', () => {
    assert.equal(S.parseAnnounceStatement('※', 1), null)
  })

  test('役職トークン無しは null', () => {
    assert.equal(S.parseAnnounceStatement('※ Alice', 1), null)
  })

  test('未知の役職トークンは null', () => {
    assert.equal(S.parseAnnounceStatement('※ Alice なんとか', 1), null)
  })

  test('parseStatement routes ※ to announce', () => {
    const result = S.parseStatement('※ Alice 契約者', 1)
    assert.equal(result.type, 'announce')
  })

  test('parseStatement routes GM: to announce', () => {
    const result = S.parseStatement('GM: Alice、Bob 契約者', 1)
    assert.equal(result.type, 'announce')
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
    const result = S.parseSetupStatement('配役 村4 占1 霊1 狩1 共2 猫1 狼3 狂1 狐1 背1', 1)
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

  test('setup keyword', () => {
    const result = S.parseSetupStatement('setup 村4 占1 狼3', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { villager: 4, seer: 1, werewolf: 3 },
    })
  })

  test('レギュ keyword', () => {
    const result = S.parseSetupStatement('レギュ 村4 占1 狼3', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { villager: 4, seer: 1, werewolf: 3 },
    })
  })

  test('レギュレーション keyword', () => {
    const result = S.parseSetupStatement('レギュレーション 村4 占1 狼3', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { villager: 4, seer: 1, werewolf: 3 },
    })
  })

  test('full-width digits', () => {
    const result = S.parseSetupStatement('配役 村４ 占１ 狼３', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { villager: 4, seer: 1, werewolf: 3 },
    })
  })

  test('longer role names', () => {
    const result = S.parseSetupStatement('配役 村人4 占い師1 霊媒師1 狩人1 人狼3', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { villager: 4, seer: 1, medium: 1, bodyguard: 1, werewolf: 3 },
    })
  })

  test('delimiter variants (comma, 、)', () => {
    const result = S.parseSetupStatement('配役 村4,占1,狼3', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { villager: 4, seer: 1, werewolf: 3 },
    })
  })

  test('no delimiters', () => {
    const result = S.parseSetupStatement('配役 村4占1霊1狩1共2猫1狼3狂1狐1背1', 1)
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
    const result = S.parseSetupStatement('配役 村4占1 霊1,狼3', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { villager: 4, seer: 1, medium: 1, werewolf: 3 },
    })
  })

  test('fanatic with shorthand 信', () => {
    const result = S.parseSetupStatement('配役 狼3 信1', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { werewolf: 3, fanatic: 1 },
    })
  })

  test('fanatic with 狂信', () => {
    const result = S.parseSetupStatement('配役 狂信1 狂1', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { fanatic: 1, possessed: 1 },
    })
  })

  test('fanatic with 狂信者', () => {
    const result = S.parseSetupStatement('配役 狂信者1 狂人1', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { fanatic: 1, possessed: 1 },
    })
  })

  test('狂 alone maps to possessed, not fanatic', () => {
    const result = S.parseSetupStatement('配役 狂1', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { possessed: 1 },
    })
  })

  test('zero count is allowed', () => {
    const result = S.parseSetupStatement('配役 村4 狼0', 1)
    assert.deepEqual(result, {
      type: 'setup',
      line: 1,
      roles: { villager: 4, werewolf: 0 },
    })
  })

  test('returns null for non-配役 line', () => {
    assert.equal(S.parseSetupStatement('+Alice', 1), null)
    assert.equal(S.parseSetupStatement('John→Bob', 1), null)
  })

  test('returns null for 配役 with no valid tokens', () => {
    assert.equal(S.parseSetupStatement('配役 abc', 1), null)
  })

  test('returns null for 配役 with invalid token mixed in', () => {
    assert.equal(S.parseSetupStatement('配役 村4 xyz 狼3', 1), null)
  })

  test('parseStatement routes to setup', () => {
    const result = S.parseStatement('配役 村4 狼2', 1)
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

describe('videoSource statement', () => {
  test('YouTube URL', () => {
    const result = S.parseVideoSourceStatement('@https://youtube.com/watch?v=XXXXX', 1)
    assert.deepEqual(result, {
      type: 'videoSource',
      line: 1,
      url: 'https://youtube.com/watch?v=XXXXX',
    })
  })

  test('Nicovideo URL', () => {
    const result = S.parseVideoSourceStatement('@https://www.nicovideo.jp/watch/sm12345', 1)
    assert.deepEqual(result, {
      type: 'videoSource',
      line: 1,
      url: 'https://www.nicovideo.jp/watch/sm12345',
    })
  })

  test('full-width ＠', () => {
    const result = S.parseVideoSourceStatement('＠https://youtube.com/watch?v=ABC', 1)
    assert.deepEqual(result, {
      type: 'videoSource',
      line: 1,
      url: 'https://youtube.com/watch?v=ABC',
    })
  })

  test('http URL', () => {
    const result = S.parseVideoSourceStatement('@http://example.com/video', 1)
    assert.deepEqual(result, {
      type: 'videoSource',
      line: 1,
      url: 'http://example.com/video',
    })
  })

  test('with surrounding whitespace', () => {
    const result = S.parseVideoSourceStatement('  @https://example.com  ', 1)
    assert.deepEqual(result, {
      type: 'videoSource',
      line: 1,
      url: 'https://example.com',
    })
  })

  test('returns null for non-URL', () => {
    assert.equal(S.parseVideoSourceStatement('@not-a-url', 1), null)
  })

  test('returns null for bare @', () => {
    assert.equal(S.parseVideoSourceStatement('@', 1), null)
  })

  test('parseStatement routes to videoSource', () => {
    const result = S.parseStatement('@https://youtube.com/watch?v=XXXXX', 1)
    assert.equal(result.type, 'videoSource')
  })
})

describe('timestamp statement', () => {
  test('MM:SS format', () => {
    const result = S.parseTimestampStatement('@15:40', 1)
    assert.deepEqual(result, {
      type: 'timestamp',
      line: 1,
      seconds: 940,
      raw: '15:40',
    })
  })

  test('H:MM:SS format', () => {
    const result = S.parseTimestampStatement('@1:15:40', 1)
    assert.deepEqual(result, {
      type: 'timestamp',
      line: 1,
      seconds: 4540,
      raw: '1:15:40',
    })
  })

  test('full-width ＠', () => {
    const result = S.parseTimestampStatement('＠15:40', 1)
    assert.deepEqual(result, {
      type: 'timestamp',
      line: 1,
      seconds: 940,
      raw: '15:40',
    })
  })

  test('0:00', () => {
    const result = S.parseTimestampStatement('@0:00', 1)
    assert.deepEqual(result, {
      type: 'timestamp',
      line: 1,
      seconds: 0,
      raw: '0:00',
    })
  })

  test('returns null for single number (no colon)', () => {
    assert.equal(S.parseTimestampStatement('@15', 1), null)
  })

  test('returns null for non-timestamp', () => {
    assert.equal(S.parseTimestampStatement('@abc', 1), null)
  })

  test('returns null for 4 segments', () => {
    assert.equal(S.parseTimestampStatement('@1:02:03:04', 1), null)
  })

  test('parseStatement routes to timestamp', () => {
    const result = S.parseStatement('@15:40', 1)
    assert.equal(result.type, 'timestamp')
  })
})

describe('inline timestamp', () => {
  test('lynch with inline timestamp', () => {
    const result = S.parseStatement('処刑 アリス @15:40', 1)
    assert.equal(result.type, 'lynch')
    assert.equal(result.timestamp, 940)
  })

  test('vote with inline timestamp', () => {
    const result = S.parseStatement('ボブ→アリス @1:00:00', 1)
    assert.equal(result.type, 'vote')
    assert.equal(result.timestamp, 3600)
  })

  test('full-width ＠ inline', () => {
    const result = S.parseStatement('処刑 アリス ＠15:40', 1)
    assert.equal(result.type, 'lynch')
    assert.equal(result.timestamp, 940)
  })

  test('standalone @timestamp is NOT treated as inline', () => {
    const result = S.parseStatement('@15:40', 1)
    assert.equal(result.type, 'timestamp')
    assert.equal(result.timestamp, undefined)
  })

  test('no inline match when @ is not at end', () => {
    const result = S.parseStatement('text @15:40 more text', 1)
    assert.equal(result.timestamp, undefined)
  })
})

describe('spoiler statement', () => {
  test('basic ASCII: !Alice=seer', () => {
    const result = S.parseSpoilerStatement('!Alice=seer', 1)
    assert.deepEqual(result, { type: 'spoiler', line: 1, player: 'Alice', role: 'seer' })
  })

  test('Japanese role name: !マドック=霊媒', () => {
    const result = S.parseSpoilerStatement('!マドック=霊媒', 1)
    assert.deepEqual(result, { type: 'spoiler', line: 1, player: 'マドック', role: '霊媒' })
  })

  test('full-width ！ and ＝', () => {
    const result = S.parseSpoilerStatement('！マドック＝人狼', 1)
    assert.deepEqual(result, { type: 'spoiler', line: 1, player: 'マドック', role: '人狼' })
  })

  test('whitespace around = is allowed', () => {
    const result = S.parseSpoilerStatement('! アリス = 狼', 1)
    assert.deepEqual(result, { type: 'spoiler', line: 1, player: 'アリス', role: '狼' })
  })

  test('abbreviated role: !アリス=占', () => {
    const result = S.parseSpoilerStatement('!アリス=占', 1)
    assert.deepEqual(result, { type: 'spoiler', line: 1, player: 'アリス', role: '占' })
  })

  test('no prefix returns null', () => {
    const result = S.parseSpoilerStatement('Alice=seer', 1)
    assert.equal(result, null)
  })

  test('missing = returns null', () => {
    const result = S.parseSpoilerStatement('!Alice seer', 1)
    assert.equal(result, null)
  })

  test('unknown role returns null (falls through to Unknown)', () => {
    const result = S.parseSpoilerStatement('!Alice=something', 1)
    assert.equal(result, null)
  })

  test('integrated with parseStatement', () => {
    const result = S.parseStatement('!マドック=人狼', 42)
    assert.equal(result.type, 'spoiler')
    assert.equal((result as S.SpoilerStatement).player, 'マドック')
    assert.equal((result as S.SpoilerStatement).role, '人狼')
    assert.equal(result.line, 42)
  })
})

describe('speech statement', () => {
  test('basic ASCII', () => {
    const result = S.parseSpeechStatement('Alice > こんにちは', 1)
    assert.deepEqual(result, { type: 'speech', line: 1, actor: 'Alice', text: 'こんにちは' })
  })

  test('full-width arrow with Japanese name', () => {
    const result = S.parseSpeechStatement('アリス ＞ こんばんは', 2)
    assert.deepEqual(result, { type: 'speech', line: 2, actor: 'アリス', text: 'こんばんは' })
  })

  test('no spaces around arrow', () => {
    const result = S.parseSpeechStatement('Bob>hi', 3)
    assert.deepEqual(result, { type: 'speech', line: 3, actor: 'Bob', text: 'hi' })
  })

  test('content contains > (split on first only)', () => {
    const result = S.parseSpeechStatement('Alice > a > b > c', 4)
    assert.deepEqual(result, { type: 'speech', line: 4, actor: 'Alice', text: 'a > b > c' })
  })

  test('leading/trailing spaces in content are trimmed', () => {
    const result = S.parseSpeechStatement('Alice >   hello world   ', 5)
    assert.deepEqual(result, { type: 'speech', line: 5, actor: 'Alice', text: 'hello world' })
  })

  test('empty content returns null', () => {
    const result = S.parseSpeechStatement('Alice > ', 6)
    assert.equal(result, null)
  })

  test('missing arrow returns null', () => {
    const result = S.parseSpeechStatement('Alice hello', 7)
    assert.equal(result, null)
  })

  test('integrated with parseStatement', () => {
    const result = S.parseStatement('マドック ＞ 占いCOします', 42)
    assert.equal(result.type, 'speech')
    assert.equal((result as S.SpeechStatement).actor, 'マドック')
    assert.equal((result as S.SpeechStatement).text, '占いCOします')
    assert.equal(result.line, 42)
  })

  test('does not conflict with vote (->) via parseStatement', () => {
    const result = S.parseStatement('Alice -> Bob', 1)
    assert.equal(result.type, 'vote')
  })
})

describe('dayMark statement', () => {
  test('ASCII `Day N:` form', () => {
    const result = S.parseDayMarkStatement('Day 2:', 7)
    assert.deepEqual(result, { type: 'dayMark', line: 7, day: 2 })
  })

  test('lowercase `day N:` accepted', () => {
    const result = S.parseDayMarkStatement('day 5:', 1)
    assert.deepEqual(result, { type: 'dayMark', line: 1, day: 5 })
  })

  test('mixed case `DaY N:` accepted', () => {
    const result = S.parseDayMarkStatement('DaY 3:', 1)
    assert.deepEqual(result, { type: 'dayMark', line: 1, day: 3 })
  })

  test('Japanese `N日目:` form', () => {
    const result = S.parseDayMarkStatement('2日目:', 9)
    assert.deepEqual(result, { type: 'dayMark', line: 9, day: 2 })
  })

  test('Japanese short `N日:` form', () => {
    const result = S.parseDayMarkStatement('3日:', 1)
    assert.deepEqual(result, { type: 'dayMark', line: 1, day: 3 })
  })

  test('full-width colon accepted', () => {
    const result = S.parseDayMarkStatement('Day 2：', 1)
    assert.deepEqual(result, { type: 'dayMark', line: 1, day: 2 })
  })

  test('leading and trailing whitespace tolerated', () => {
    const result = S.parseDayMarkStatement('  Day 2:  ', 4)
    assert.deepEqual(result, { type: 'dayMark', line: 4, day: 2 })
  })

  test('missing colon returns null', () => {
    assert.equal(S.parseDayMarkStatement('Day 2', 1), null)
    assert.equal(S.parseDayMarkStatement('2日目', 1), null)
  })

  test('zero day rejected (dayNumber starts at 1)', () => {
    assert.equal(S.parseDayMarkStatement('Day 0:', 1), null)
    assert.equal(S.parseDayMarkStatement('0日目:', 1), null)
  })

  test('Day with no number rejected', () => {
    assert.equal(S.parseDayMarkStatement('Day:', 1), null)
    assert.equal(S.parseDayMarkStatement('Day :', 1), null)
  })

  test('multi-digit day accepted', () => {
    const result = S.parseDayMarkStatement('Day 12:', 1)
    assert.deepEqual(result, { type: 'dayMark', line: 1, day: 12 })
  })

  test('integrated with parseStatement', () => {
    const result = S.parseStatement('Day 2:', 5)
    assert.equal(result.type, 'dayMark')
    assert.equal((result as S.DayMarkStatement).day, 2)
    assert.equal(result.line, 5)
  })

  test('integrated with parseStatement (Japanese)', () => {
    const result = S.parseStatement('2日目:', 5)
    assert.equal(result.type, 'dayMark')
    assert.equal((result as S.DayMarkStatement).day, 2)
  })

  test('does not match arbitrary text via parseStatement', () => {
    const result = S.parseStatement('Day is fine', 1)
    assert.notEqual(result.type, 'dayMark')
  })
})
