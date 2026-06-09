/**
 * Roundtrip tests: factory → serialize → parse で元の Statement と一致することを確認。
 *
 * 目的:
 * - serializeStatement の出力が parseStatement で受理可能な形式であることを保証
 * - 今後の Howl 表記変更で serializer / parser の片側だけが壊れるのを防ぐ
 *
 * 比較時は `line` / `day` / `timestamp` を無視する（パース結果は実行時の行番号を持ち、
 * factory 出力は line=0 のため）。
 */

import { describe, test } from 'node:test'
import assert from 'node:assert'

import { parseStatement } from './statement.ts'
import type { Statement } from './statement.ts'
import * as F from './serialize.ts'

/**
 * line/day/timestamp を除いた構造で deepEqual する。
 */
function stripMeta<T extends Statement>(stmt: T): Omit<T, 'line' | 'day' | 'timestamp'> {
  const { line: _l, day: _d, timestamp: _t, ...rest } = stmt
  return rest as Omit<T, 'line' | 'day' | 'timestamp'>
}

/**
 * factory で作った Statement をシリアライズ → パースして構造が一致することを確認。
 */
function assertRoundtrip(original: Statement): { serialized: string; parsed: Statement } {
  const serialized = F.serializeStatement(original)
  const parsed = parseStatement(serialized, 1)
  assert.deepEqual(
    stripMeta(parsed),
    stripMeta(original),
    `Roundtrip mismatch:\n  original:   ${JSON.stringify(stripMeta(original))}\n  serialized: ${serialized}\n  parsed:     ${JSON.stringify(stripMeta(parsed))}`,
  )
  return { serialized, parsed }
}

// ----------------------------------------------------------------------

describe('roundtrip: setup', () => {
  test('14-player werewolf setup', () => {
    assertRoundtrip(F.makeSetup({
      villager: 2, werewolf: 3, seer: 1, medium: 1, bodyguard: 1,
      mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1,
    }))
  })

  test('minimal 5-player setup', () => {
    assertRoundtrip(F.makeSetup({ villager: 3, werewolf: 1, seer: 1 }))
  })
})

describe('roundtrip: join', () => {
  test('name only', () => {
    assertRoundtrip(F.makeJoin('Alice'))
  })

  test('Japanese name', () => {
    assertRoundtrip(F.makeJoin('アリス'))
  })

  test('with shortName (ASCII)', () => {
    assertRoundtrip(F.makeJoin('Alice', { shortName: 'Al' }))
  })

  test('with shortName (Japanese)', () => {
    assertRoundtrip(F.makeJoin('アリス', { shortName: 'アリ' }))
  })

  test('with aliases only', () => {
    assertRoundtrip(F.makeJoin('Alice', { aliases: ['Aliceちゃん', 'アリス'] }))
  })

  test('with shortName and aliases', () => {
    assertRoundtrip(F.makeJoin('Alice', { shortName: 'Al', aliases: ['Aliceちゃん'] }))
  })
})

describe('roundtrip: vote', () => {
  test('basic vote', () => {
    assertRoundtrip(F.makeVote('Alice', 'Bob'))
  })

  test('Japanese names', () => {
    assertRoundtrip(F.makeVote('ダンカン', '藤澤'))
  })

  test('seat-style names', () => {
    assertRoundtrip(F.makeVote('P1', 'P2'))
  })
})

describe('roundtrip: lynch', () => {
  test('with target', () => {
    assertRoundtrip(F.makeLynch('Alice'))
  })

  test('no execution', () => {
    assertRoundtrip(F.makeLynch(null))
  })
})

describe('roundtrip: attack', () => {
  test('single target', () => {
    assertRoundtrip(F.makeAttack(['Alice']))
  })
})

describe('roundtrip: peace', () => {
  test('peace night', () => {
    assertRoundtrip(F.makePeace())
  })
})

describe('roundtrip: grelan', () => {
  test('grelan', () => {
    assertRoundtrip(F.makeGrelan())
  })
})

describe('roundtrip: curse / follow', () => {
  test('curse (nekomata 道連れ)', () => {
    assertRoundtrip(F.makeCurse('Alice'))
  })

  test('follow (背徳者 後追い)', () => {
    assertRoundtrip(F.makeFollow('Bob'))
  })
})

describe('roundtrip: forecast', () => {
  test('seer forecast', () => {
    assertRoundtrip(F.makeForecast('Alice', 'Bob'))
  })
})

describe('roundtrip: over (game result)', () => {
  test('village win', () => {
    assertRoundtrip(F.makeOver('villageWin'))
  })

  test('wolf win', () => {
    assertRoundtrip(F.makeOver('wolfWin'))
  })

  test('hamster win', () => {
    assertRoundtrip(F.makeOver('hamsterWin'))
  })

  test('draw', () => {
    assertRoundtrip(F.makeOver('draw'))
  })
})

describe('roundtrip: reveal', () => {
  test('villager reveal', () => {
    assertRoundtrip(F.makeReveal('Alice', '村人'))
  })

  test('werewolf reveal', () => {
    assertRoundtrip(F.makeReveal('Bob', '人狼'))
  })
})

describe('roundtrip: assert (CO)', () => {
  test('seer CO with no results', () => {
    assertRoundtrip(F.makeSeerCO('Alice'))
  })

  test('seer CO with one 白 result', () => {
    assertRoundtrip(F.makeSeerCO('Alice', [{ target: 'Bob', result: 'isHuman' }]))
  })

  test('seer CO with 黒 result', () => {
    assertRoundtrip(F.makeSeerCO('Alice', [{ target: 'Bob', result: 'isWolf' }]))
  })

  test('seer CO with multiple results', () => {
    assertRoundtrip(F.makeSeerCO('Alice', [
      { target: 'Bob', result: 'isHuman' },
      { target: 'Carol', result: 'isWolf' },
    ]))
  })

  test('medium CO with past result', () => {
    assertRoundtrip(F.makeMediumCO('Alice', [{ target: 'Bob', result: 'isWolf' }]))
  })

  test('bodyguard CO with one guard', () => {
    assertRoundtrip(F.makeBodyguardCO('Alice', ['Bob']))
  })

  test('bodyguard CO with multiple guards', () => {
    assertRoundtrip(F.makeBodyguardCO('Alice', ['Bob', 'Carol']))
  })

  test('bodyguard CO with no guards', () => {
    assertRoundtrip(F.makeBodyguardCO('Alice'))
  })

  test('mason CO', () => {
    assertRoundtrip(F.makeMasonCO('Alice'))
  })

  test('nekomata CO', () => {
    assertRoundtrip(F.makeNekomataCO('Alice'))
  })
})

describe('roundtrip: assert (result only)', () => {
  test('seer result 白', () => {
    assertRoundtrip(F.makeSeerResult('Alice', 'Bob', 'isHuman'))
  })

  test('seer result 黒', () => {
    assertRoundtrip(F.makeSeerResult('Alice', 'Bob', 'isWolf'))
  })

  test('medium result', () => {
    assertRoundtrip(F.makeMediumResult('Alice', 'Bob', 'isWolf'))
  })
})

// ----------------------------------------------------------------------
// 全 25 StatementType のラウンドトリップ網羅
// (rename 経路で statement type ごとに serialize→parse が壊れないことを保証)
// ----------------------------------------------------------------------

describe('roundtrip: joinMulti', () => {
  test('multiple players', () => {
    assertRoundtrip(F.makeJoinMulti(['Alice', 'Bob', 'Carol']))
  })
  test('Japanese names', () => {
    assertRoundtrip(F.makeJoinMulti(['アリス', 'ボブ', 'チャーリー']))
  })
})

describe('roundtrip: multiVote', () => {
  test('single voter', () => {
    assertRoundtrip(F.makeMultiVote(['Alice'], 'Bob'))
  })
  test('multiple voters', () => {
    assertRoundtrip(F.makeMultiVote(['Alice', 'Carol'], 'Bob'))
  })
})

describe('roundtrip: attack (additional)', () => {
  test('multiple targets', () => {
    assertRoundtrip(F.makeAttack(['Alice', 'Bob']))
  })
})

describe('roundtrip: suddenDeath', () => {
  test('with reason', () => {
    assertRoundtrip(F.makeSuddenDeath('Alice', '回線落ち'))
  })
  test('without reason', () => {
    assertRoundtrip(F.makeSuddenDeath('Alice', ''))
  })
})

describe('roundtrip: corpseFound', () => {
  test('Japanese name (死体発見)', () => {
    const stmt = { type: 'corpseFound' as const, line: 0, target: 'アリス' }
    assertRoundtrip(stmt)
  })
  test('ASCII name', () => {
    const stmt = { type: 'corpseFound' as const, line: 0, target: 'Alice' }
    assertRoundtrip(stmt)
  })
})

describe('roundtrip: revote', () => {
  test('no targets', () => {
    assertRoundtrip(F.makeRevote([]))
  })
  test('with targets', () => {
    assertRoundtrip(F.makeRevote(['Alice', 'Bob']))
  })
})

describe('roundtrip: mason', () => {
  test('two masons', () => {
    assertRoundtrip(F.makeMason(['Alice', 'Bob']))
  })
})

describe('roundtrip: dayMark', () => {
  test('Day 1', () => {
    const stmt = { type: 'dayMark' as const, line: 0, day: 1 }
    assertRoundtrip(stmt)
  })
  test('Day 5', () => {
    const stmt = { type: 'dayMark' as const, line: 0, day: 5 }
    assertRoundtrip(stmt)
  })
})

describe('roundtrip: speech', () => {
  test('ASCII actor + ASCII text', () => {
    const stmt = { type: 'speech' as const, line: 0, actor: 'Alice', text: 'hello' }
    assertRoundtrip(stmt)
  })
  test('Japanese actor + Japanese text', () => {
    const stmt = { type: 'speech' as const, line: 0, actor: 'アリス', text: 'こんにちは' }
    assertRoundtrip(stmt)
  })
})

describe('roundtrip: spoiler (role pin)', () => {
  test('Japanese player + Japanese role', () => {
    assertRoundtrip(F.makeSpoiler('アリス', '占い'))
  })
  test('ASCII player + English role', () => {
    assertRoundtrip(F.makeSpoiler('Alice', 'seer'))
  })
  test('faction alias (狼陣営)', () => {
    assertRoundtrip(F.makeSpoiler('アリス', '狼陣営'))
  })
})

describe('roundtrip: spoiler (action)', () => {
  test('divine action', () => {
    const stmt = {
      type: 'spoiler' as const, line: 0,
      player: 'アリス', day: 1, action: 'divine' as const, target: 'ボブ',
    }
    assertRoundtrip(stmt)
  })
  test('guard action', () => {
    const stmt = {
      type: 'spoiler' as const, line: 0,
      player: 'アリス', day: 2, action: 'guard' as const, target: 'ボブ',
    }
    assertRoundtrip(stmt)
  })
  test('attack action', () => {
    const stmt = {
      type: 'spoiler' as const, line: 0,
      player: 'アリス', day: 3, action: 'attack' as const, target: 'ボブ',
    }
    assertRoundtrip(stmt)
  })
})
