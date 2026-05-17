import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { PlayerState } from '../lupa/types.ts'
import { renameSeatNames, rewriteSetupLine, stripPrivateComments } from './rename-seats.ts'

function p(seat: number, name: string): PlayerState {
  return {
    seat, name,
    role: 'villager', alive: true, claimedRole: null, claimedDay: null,
    divineHistory: new Map(), guardHistory: new Map(),
    fakeDivineHistory: new Map(), forecastTarget: null,
  }
}

describe('renameSeatNames', () => {
  test('replaces single-digit names', () => {
    const players = [p(1, '占1'), p(4, '狼4'), p(7, '占7')]
    const text = '++占1、狼4、占7'
    assert.equal(renameSeatNames(text, players), '++P1、P4、P7')
  })

  test('handles two-digit names without partial-match corruption', () => {
    // If "狼1" were replaced before "狼12", we'd corrupt "狼12" into "P12".
    // The function must replace longest-name-first.
    const players = [p(1, '狼1'), p(12, '狼12'), p(13, '狼13')]
    const text = '狼1、狼12、狼13'
    assert.equal(renameSeatNames(text, players), 'P1、P12、P13')
  })

  test('mixed role abbreviations', () => {
    const players = [
      p(1, '信1'), p(2, '狐2'), p(3, '村3'),
      p(10, '共10'), p(12, '霊12'),
    ]
    const text = '++信1、狐2、村3、共10、霊12'
    assert.equal(
      renameSeatNames(text, players),
      '++P1、P2、P3、P10、P12',
    )
  })

  test('idempotent on already-renamed text', () => {
    const players = [p(1, '占1')]
    const text = 'P1 said hello'
    assert.equal(renameSeatNames(text, players), 'P1 said hello')
  })
})

describe('rewriteSetupLine', () => {
  test('translates 14d-neko setup line to English notation', () => {
    const input = '配役 狼3 村2 占1 霊1 狩1 共2 猫1 信1 狐1 背1\n\n# seed: 1'
    const out = rewriteSetupLine(input)
    assert.ok(out.startsWith('Setup: werewolf=3 villager=2 seer=1 medium=1 bodyguard=1 mason=2 nekomata=1 fanatic=1 werehamster=1 immoralist=1'),
      `setup line not rewritten: ${out.split('\n')[0]}`)
    assert.ok(out.includes('# seed: 1'), 'unrelated lines must be preserved')
  })

  test('no-op when no 配役 line is present', () => {
    const input = 'just some text\nno setup here'
    assert.equal(rewriteSetupLine(input), input)
  })

  test('handles unknown role abbreviation by keeping it', () => {
    const input = '配役 狼2 ?5'
    const out = rewriteSetupLine(input)
    assert.equal(out, 'Setup: werewolf=2 ?=5')
  })
})

describe('stripPrivateComments', () => {
  test('removes Howl # comment lines (truth leakage from resolveNight)', () => {
    const input = [
      'Setup: werewolf=3',
      '++seat-1, seat-2',
      '# 占い: seat-1 → seat-7 ●',
      '# 護衛: seat-5 → seat-3',
      '# 襲撃: seat-9 → seat-7',
      'seat-7 死亡',
      '# seed: 1',
    ].join('\n')
    const out = stripPrivateComments(input)
    assert.equal(out, [
      'Setup: werewolf=3',
      '++seat-1, seat-2',
      'seat-7 死亡',
    ].join('\n'))
  })

  test('preserves non-comment lines unchanged', () => {
    const input = 'no comments here\nseat-3 > hello'
    assert.equal(stripPrivateComments(input), input)
  })

  test('handles leading whitespace on comment lines', () => {
    const input = 'seat-1 voted\n  # leaked comment\n  seat-2 voted'
    const out = stripPrivateComments(input)
    assert.equal(out, 'seat-1 voted\n  seat-2 voted')
  })
})
