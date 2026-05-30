import { describe, it } from 'node:test'
import assert from 'node:assert'
import * as Vocabulary from './vocabulary.ts'

// *********************************** Basic syntax elements

describe('whitespace', () => {
  const regex = new RegExp(Vocabulary.whiteSpace)

  it('should match white spaces', () => {
    assert.match(' ', regex, 'Whitespace should match')
    assert.match('\t', regex, 'Tab should match')
    assert.match('　', regex, 'Full-width space should match')
  })

  it('should not match non-whitespace', () => {
    assert.doesNotMatch('\n', regex, 'Non-whitespace should not match')
  })
})

describe('optionalSpace', () => {
  const regex = new RegExp(Vocabulary.optionalSpace)

  it('should match optional spaces', () => {
    assert.match(' ', regex, 'Whitespace should match')
    assert.match('\t', regex, 'Tab should match')
    assert.match('　', regex, 'Full-width space should match')
    assert.match('', regex, 'Empty string should match')
  })
})

describe('whiteSpaces', () => {
  const regex = new RegExp(Vocabulary.whiteSpaces)

  it('should match white spaces', () => {
    assert.match(' ', regex, 'Whitespace should match')
    assert.match('\t', regex, 'Tab should match')
    assert.match('　', regex, 'Full-width space should match')
    assert.match(' 　\t　 ', regex, 'Multiple white spaces should match')
  })

  it('should not match non-whitespace', () => {
    assert.doesNotMatch('\n', regex, 'Non-whitespace should not match')
    assert.doesNotMatch('', regex, 'Empty string should not match')
  })
})

describe('rightArrow', () => {
  const regex = new RegExp(Vocabulary.rightArrow)

  it('should match right arrows', () => {
    assert.match('→', regex, 'Right arrow should match')
    assert.match('⇒', regex, 'Right arrow should match')
    assert.match('⟶', regex, 'Right arrow should match')
    assert.match('⟹', regex, 'Right arrow should match')
    assert.match('➡️', regex, 'Right arrow should match')
    assert.match('->', regex, 'Right arrow should match')
    assert.match('=>', regex, 'Right arrow should match')
  })

  it('should not match non-right arrows', () => {
    assert.doesNotMatch('<-', regex, 'Left arrow should not match')
  })
})

describe('leftArrow', () => {
  const regex = new RegExp(Vocabulary.leftArrow)

  it('should match left arrows', () => {
    assert.match('←', regex, 'Left arrow should match')
    assert.match('⇐', regex, 'Left arrow should match')
    assert.match('⟵', regex, 'Left arrow should match')
    assert.match('⟸', regex, 'Left arrow should match')
    assert.match('⬅️', regex, 'Left arrow should match')
    assert.match('<-', regex, 'Left arrow should match')
    assert.match('<=', regex, 'Left arrow should match')
  })

  it('should not match non-left arrows', () => {
    assert.doesNotMatch('->', regex, 'Right arrow should not match')
  })
})

describe('plus', () => {
  const regex = new RegExp(Vocabulary.plus)

  it('should match plus signs', () => {
    assert.match('+', regex, 'Plus sign should match')
    assert.match('＋', regex, 'Full-width plus sign should match')
  })

  it('should not match non-plus signs', () => {
    assert.doesNotMatch('-', regex, 'Minus sign should not match')
  })
})

describe('delimiter', () => {
  const regex = new RegExp(Vocabulary.delimiter)

  it('should match delimiters', () => {
    assert.match(',', regex, 'Comma should match')
    assert.match('，', regex, 'Chinese comma should match')
    assert.match('、', regex, 'Japanese comma should match')
    assert.match(';', regex, 'Semicolon should match')
    assert.match('；', regex, 'Chinese semicolon should match')
    assert.match(':', regex, 'Colon should match')
    assert.match('：', regex, 'Chinese colon should match')
    assert.match(' ', regex, 'Space should match')
  })

  it('should not match non-delimiters', () => {
    assert.doesNotMatch('a', regex, 'Non-delimiter should not match')
  })
})

describe('possibleName', () => {
  const regex = new RegExp(Vocabulary.possibleName)

  it('should match possible names', () => {
    assert.match('John', regex, 'Name should match')
    assert.match('村人', regex, 'Japanese name should match')
  })

  it('should capture the name', () => {
    const match = 'John'.match(regex)
    assert.ok(match, 'Match should be found')
    if (!match) return // TypeScript guard
    assert.strictEqual(match[0], 'John', 'Captured name should match')
  })

  it(`should match name with other terms`, () => {
    const regex = new RegExp(`(${Vocabulary.possibleName})${Vocabulary.rightArrow}(${Vocabulary.possibleName})`)
    const match = 'Peter→Paul'.match(regex)
    assert.ok(match, 'Match should be found')
    if (!match) return // TypeScript guard
    assert.strictEqual(match[1], 'Peter', '1st captured name should match')
    assert.strictEqual(match[2], 'Paul', '2nd captured name should match')
  })
})

describe('day', () => {
  const regex = new RegExp(`(?<day>${Vocabulary.dayNumber})${Vocabulary.dayUnit}`)

  it('should match day terms', () => {
    assert.match('1日目', regex, '1日目 should match')
    assert.match('2d', regex, '2d should match')
    assert.match('3日', regex, '3日 should match')
    assert.match('42Day', regex, '42Day should match')
    assert.match('5日目', regex, '5日目 should match')
  })

  it('should not match non-day terms', () => {
    assert.doesNotMatch('0日目', regex, '0日目 should not match')
    assert.doesNotMatch('日', regex, '日 should not match')
    assert.doesNotMatch('10', regex, '10 should not match')
  })
})

// *********************************** Basic gaming vocabulary

describe('win', () => {
  const regex = new RegExp(Vocabulary.win)

  it('should match win terms', () => {
    assert.match('勝利', regex, '勝利 should match')
    assert.match('勝ち', regex, '勝ち should match')
    assert.match('勝', regex, '勝 should match')
  })

  it('should not match non-win terms', () => {
    assert.doesNotMatch('敗北', regex, '敗北 should not match')
  })
})

describe('lose', () => {
  const regex = new RegExp(Vocabulary.lose)

  it('should match lose terms', () => {
    assert.match('敗北', regex, '敗北 should match')
    assert.match('敗け', regex, '敗け should match')
    assert.match('敗', regex, '敗 should match')
  })

  it('should not match non-lose terms', () => {
    assert.doesNotMatch('勝利', regex, '勝利 should not match')
  })
})

describe('draw', () => {
  const regex = new RegExp(Vocabulary.draw)

  it('should match draw terms', () => {
    assert.match('引き分け', regex, '引き分け should match')
    assert.match('引分け', regex, '引分け should match')
    assert.match('引き分ける', regex, '引き分ける should match')
  })

  it('should not match non-draw terms', () => {
    assert.doesNotMatch('勝利', regex, '勝利 should not match')
    assert.doesNotMatch('敗北', regex, '敗北 should not match')
  })
})

describe('claim', () => {
  const regex = new RegExp(Vocabulary.claim)

  it('should match claim terms', () => {
    assert.match('co', regex, 'co should match')
    assert.match('ｃｏ', regex, 'ｃｏ should match')
  })

  it('should not match non-claim terms', () => {
    assert.doesNotMatch('claim', regex, 'claim should not match')
  })
})

describe('equal', () => {
  const regex = new RegExp(Vocabulary.equal)

  it('should match equal terms', () => {
    assert.match('=', regex, '= should match')
    assert.match('＝', regex, '＝ should match')
  })

  it('should not match non-equal terms', () => {
    assert.doesNotMatch('≠', regex, '≠ should not match')
  })
})

describe('attack', () => {
  const regex = new RegExp(Vocabulary.attack)

  it('should match attack terms', () => {
    assert.match('噛み', regex, '噛み should match')
    assert.match('噛', regex, '噛 should match')
    assert.match('襲撃', regex, '襲撃 should match')
  })

  it('should not match non-attack terms', () => {
    assert.doesNotMatch('防御', regex, '防御 should not match')
  })

})

describe('lynch', () => {
  const regex = new RegExp(Vocabulary.lynch)

  it('should match lynch terms', () => {
    assert.match('吊る', regex, '吊る should match')
    assert.match('吊', regex, '吊 should match')
    assert.match('処刑', regex, '処刑 should match')
  })

})

describe('revote', () => {
  const regex = new RegExp(Vocabulary.revote)

  it('should match revote terms', () => {
    assert.match('再投票', regex, '再投票 should match')
    assert.match('--', regex, '-- should match')
    assert.match('---', regex, '--- should match')
    assert.match('----', regex, '---- should match')
    assert.match('==', regex, '== should match')
    assert.match('===', regex, '=== should match')
    assert.match('====', regex, '==== should match')

  })

  it('should not match non-revote terms', () => {
    assert.doesNotMatch('投票', regex, '投票 should not match')
    assert.doesNotMatch('-', regex, '- should not match')
    assert.doesNotMatch('=', regex, '= should not match')
  })
})

// *********************************** Roles

describe('villager', () => {
  const regex = new RegExp(Vocabulary.villager)

  it('should match villager terms', () => {
    assert.match('村人', regex, '村人 should match')
    assert.match('村', regex, '村 should match')
  })

  it('should not match non-villager terms', () => {
    assert.doesNotMatch('狼', regex, 'Non-villager term should not match')
  })
})

describe('seer', () => {
  const regex = new RegExp(Vocabulary.seer)

  it('should match seer terms', () => {
    assert.match('占い師', regex, '占い師 should match')
    assert.match('占い', regex, '占い should match')
    assert.match('占師', regex, '占師 should match')
    assert.match('占', regex, '占 should match')
    assert.match('預言者', regex, '預言者 should match')
    assert.match('予言者', regex, '予言者 should match')
    assert.match('預言', regex, '預言 should match')
    assert.match('予言', regex, '予言 should match')
    assert.match('預', regex, '預 should match')
    assert.match('予', regex, '予 should match')
  })

  it('should not match non-seer terms', () => {
    assert.doesNotMatch('霊媒師', regex, 'Non-seer term should not match')
  })
})

describe('medium', () => {
  const regex = new RegExp(Vocabulary.medium)

  it('should match medium terms', () => {
    assert.match('霊媒師', regex, '霊媒師 should match')
    assert.match('霊媒', regex, '霊媒 should match')
    assert.match('霊能者', regex, '霊能者 should match')
    assert.match('霊能', regex, '霊能 should match')
    assert.match('霊', regex, '霊 should match')
  })

  it('should not match non-medium terms', () => {
    assert.doesNotMatch('占い師', regex, 'Non-medium term should not match')
  })
})

describe('bodyguard', () => {
  const regex = new RegExp(Vocabulary.bodyguard)

  it('should match bodyguard terms', () => {
    assert.match('護衛', regex, '護衛 should match')
    assert.match('護', regex, '護 should match')
    assert.match('狩人', regex, '狩人 should match')
    assert.match('狩', regex, '狩 should match')
  })

  it('should not match non-bodyguard terms', () => {
    assert.doesNotMatch('占い師', regex, 'Non-bodyguard term should not match')
  })
})

describe('mason', () => {
  const regex = new RegExp(Vocabulary.mason)

  it('should match mason terms', () => {
    assert.match('共有者', regex, '共有者 should match')
    assert.match('共', regex, '共 should match')
  })

  it('should not match non-mason terms', () => {
    assert.doesNotMatch('占い師', regex, 'Non-mason term should not match')
  })
})

describe('nekomata', () => {
  const regex = new RegExp(Vocabulary.nekomata)

  it('should match nekomata terms', () => {
    assert.match('猫又', regex, '猫又 should match')
    assert.match('猫', regex, '猫 should match')
  })

  it('should not match non-nekomata terms', () => {
    assert.doesNotMatch('占い師', regex, 'Non-nekomata term should not match')
  })
})

describe('werewolf', () => {
  const regex = new RegExp(Vocabulary.werewolf)

  it('should match werewolf terms', () => {
    assert.match('人狼', regex, '人狼 should match')
    assert.match('狼', regex, '狼 should match')
  })

  it('should not match non-werewolf terms', () => {
    assert.doesNotMatch('村人', regex, 'Non-werewolf term should not match')
  })
})

describe('possessed', () => {
  const regex = new RegExp(Vocabulary.possessed)

  it('should match possessed terms', () => {
    assert.match('狂人', regex, '狂人 should match')
    assert.match('狂信者', regex, '狂信者 should match')
    assert.match('狂', regex, '狂 should match')
  })

  it('should not match non-possessed terms', () => {
    assert.doesNotMatch('占い師', regex, 'Non-possessed term should not match')
  })
})

describe('werehamster', () => {
  const regex = new RegExp(Vocabulary.hamster)

  it('should match werehamster terms', () => {
    assert.match('妖狐', regex, '妖狐 should match')
    assert.match('狐', regex, '狐 should match')
  })

  it('should not match non-werehamster terms', () => {
    assert.doesNotMatch('村人', regex, 'Non-werehamster term should not match')
  })
})

describe('immoralist', () => {
  const regex = new RegExp(Vocabulary.immoralist)

  it('should match immoralist terms', () => {
    assert.match('背徳者', regex, '背徳者 should match')
    assert.match('背徳', regex, '背徳 should match')
    assert.match('背', regex, '背 should match')
  })

  it('should not match non-immoralist terms', () => {
    assert.doesNotMatch('占い師', regex, 'Non-immoralist term should not match')
  })
})

describe('paparazzi', () => {
  const regex = new RegExp(`^${Vocabulary.paparazzi}$`)

  it('should match paparazzi terms', () => {
    assert.match('パパラッチ', regex, 'パパラッチ should match')
    assert.match('paparazzi', regex, 'paparazzi should match')
  })

  it('should not match non-paparazzi terms', () => {
    assert.doesNotMatch('占い師', regex, 'Non-paparazzi term should not match')
    assert.doesNotMatch('パ', regex, '単独パ should not match')
    assert.doesNotMatch('パパラ', regex, '短縮パパラ should not match')
  })
})


// *********************************** Alignment
describe('village', () => {
  const regex = new RegExp(Vocabulary.villager)

  it('should match villager terms', () => {
    assert.match('村人', regex, '村人 should match')
    assert.match('村', regex, '村 should match')
  })

  it('should not match non-villager terms', () => {
    assert.doesNotMatch('狼', regex, 'Non-villager term should not match')
  })
})

describe('wolf', () => {
  const regex = new RegExp(Vocabulary.werewolf)

  it('should match werewolf terms', () => {
    assert.match('人狼', regex, '人狼 should match')
    assert.match('狼', regex, '狼 should match')
  })

  it('should not match non-werewolf terms', () => {
    assert.doesNotMatch('村人', regex, 'Non-werewolf term should not match')
  })
})

describe('hamster', () => {
  const regex = new RegExp(Vocabulary.hamster)

  it('should match werehamster terms', () => {
    assert.match('妖狐', regex, '妖狐 should match')
    assert.match('狐', regex, '狐 should match')
  })

  it('should not match non-werehamster terms', () => {
    assert.doesNotMatch('村人', regex, 'Non-werehamster term should not match')
  })
})

describe('isHuman', () => {
  const regex = new RegExp(Vocabulary.isHuman)

  it('should match human terms', () => {
    assert.match('白', regex, '白 should match')
    assert.match('◯', regex, '◯ should match')
    assert.match('○', regex, '○ should match')
  })

  it('should not match non-human terms', () => {
    assert.doesNotMatch('黒', regex, '黒 should not match')
  })
})

describe('isWolf', () => {
  const regex = new RegExp(Vocabulary.isWolf)

  it('should match wolf terms', () => {
    assert.match('黒', regex, '黒 should match')
    assert.match('●', regex, '● should match')
  })

  it('should not match non-wolf terms', () => {
    assert.doesNotMatch('白', regex, '白 should not match')
  })
})


describe('anyRole', () => {
  const regex = new RegExp(Vocabulary.anyRole)

  it('should match any role terms', () => {
    assert.match('村人', regex, '村人 should match')
    assert.match('占い師', regex, '占い師 should match')
    assert.match('霊媒師', regex, '霊媒師 should match')
    assert.match('護衛', regex, '護衛 should match')
    assert.match('共有者', regex, '共有者 should match')
    assert.match('猫又', regex, '猫又 should match')
    assert.match('人狼', regex, '人狼 should match')
    assert.match('狂人', regex, '狂人 should match')
    assert.match('妖狐', regex, '妖狐 should match')
    assert.match('背徳者', regex, '背徳者 should match')
    assert.match('パパラッチ', regex, 'パパラッチ should match')
    assert.match('paparazzi', regex, 'paparazzi should match')
  })

  it('should not match non-role terms', () => {
    assert.doesNotMatch('恋', regex, '恋 should not match')
  })
})
