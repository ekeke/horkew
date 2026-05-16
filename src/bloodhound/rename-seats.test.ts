import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { PlayerState } from '../lupa/types.ts'
import { renameSeatNames } from './rename-seats.ts'

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
    assert.equal(renameSeatNames(text, players), '++seat-1、seat-4、seat-7')
  })

  test('handles two-digit names without partial-match corruption', () => {
    // If "狼1" were replaced before "狼12", we'd corrupt "狼12" into "seat-12".
    // The function must replace longest-name-first.
    const players = [p(1, '狼1'), p(12, '狼12'), p(13, '狼13')]
    const text = '狼1、狼12、狼13'
    assert.equal(renameSeatNames(text, players), 'seat-1、seat-12、seat-13')
  })

  test('mixed role abbreviations', () => {
    const players = [
      p(1, '信1'), p(2, '狐2'), p(3, '村3'),
      p(10, '共10'), p(12, '霊12'),
    ]
    const text = '++信1、狐2、村3、共10、霊12'
    assert.equal(
      renameSeatNames(text, players),
      '++seat-1、seat-2、seat-3、seat-10、seat-12',
    )
  })

  test('idempotent on already-renamed text', () => {
    const players = [p(1, '占1')]
    const text = 'seat-1 said hello'
    assert.equal(renameSeatNames(text, players), 'seat-1 said hello')
  })
})
