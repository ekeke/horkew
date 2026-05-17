import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { formatHowl } from './format.ts'
import type { GameState, LupaConfig } from './types.ts'
import { parse } from '../howl/parser.ts'

function minimalState(): GameState {
  return {
    day: 1,
    players: [
      { seat: 1, name: 'seat-1', role: 'villager', alive: true, divineHistory: new Map(), guardHistory: new Map(), attackHistory: new Map() },
      { seat: 2, name: 'seat-2', role: 'villager', alive: true, divineHistory: new Map(), guardHistory: new Map(), attackHistory: new Map() },
    ] as unknown as GameState['players'],
    phase: 'discussion',
    executionHistory: new Map(),
    nightDeaths: [],
    revoteHistory: new Map(),
    result: undefined,
    ext: undefined,
  } as unknown as GameState
}

const config: LupaConfig = {
  roles: new Map([['villager', 2]]) as unknown as LupaConfig['roles'],
  seed: 1,
  nameStyle: 'seat',
} as LupaConfig

describe('formatHowl: speech event', () => {
  test('speech with embedded newlines is collapsed to a single line', () => {
    const events = [
      { type: 'speech' as const, actor: 1, text: '一行目\n二行目\n三行目' },
    ]
    const out = formatHowl(events, minimalState(), config)
    const speechLines = out.split('\n').filter(l => l.includes(' > '))
    assert.equal(speechLines.length, 1, 'speech should occupy exactly one howl line')
    assert.match(speechLines[0], /一行目 二行目 三行目/, 'newlines should become single spaces')
  })

  test('speech with CRLF newlines is collapsed too', () => {
    const events = [
      { type: 'speech' as const, actor: 2, text: 'aaa\r\nbbb' },
    ]
    const out = formatHowl(events, minimalState(), config)
    assert.match(out, /seat-2 > aaa bbb/, 'CRLF should be collapsed')
  })

  test('collapsed speech parses cleanly (no unknown statements)', () => {
    // Without the newline collapse the howl parser would split this into
    // multiple statements and the second one ("現状を整理…") would become
    // an `unknown` — which in turn makes analyzeFromEventsDetailed bail out
    // and breaks every retar/skoll/hati downstream.
    const events = [
      { type: 'speech' as const, actor: 1, text: '共有者としてCOします。\n\n現状を整理させて。占い師COが seat-1 と seat-7 の二人出ています。' },
    ]
    const howl = formatHowl(events, minimalState(), config)
    const { statements } = parse(howl)
    const unknowns = statements.filter(s => s.type === 'unknown')
    assert.equal(unknowns.length, 0, `expected no unknown statements, got: ${JSON.stringify(unknowns)}`)
  })
})
