import { describe, test } from 'node:test'
import assert from 'node:assert'
import * as S from './statement.ts'



describe('join statement', () => {
  test('valid join statement', () => {
    const result = S.parseJoinStatement('+John, Curt', 1)
    assert.deepEqual(result, {
      type: 'join',
      line: 1,
      players: ['John', 'Curt'],
    })
  })

  test('Accepts roughly inputted players on Japanese IME', () => {
    const result = S.parseJoinStatement('　　＋ボブ　,　マックス、John', 1)
    assert.deepEqual(result, {
      type: 'join',
      line: 1,
      players: ['ボブ', 'マックス', 'John'],
    })
  })

  test('invalid join statement', () => {
    const result = S.parseJoinStatement('', 1)
    assert.equal(result, null)
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
  test('valid parser function', () => {
    const result = S.parseStatement('　　＋John, Curt　', 1)
    assert.deepEqual(result, {
      type: 'join',
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

  test('invalid parser function', () => {
    const result = S.parseStatement('', 1)
    assert.deepEqual(result, {
      type: 'unknown',
      line: 1,
      text: '',
    })
  })
})
