/**
 * Howl シナリオに埋め込まれた `@expect-*` 系アノテーションを解析・検証する helper。
 *
 * lupa engine の最終 state / events に対する assertion を司る。
 * - `@expect-status <player>: alive|dead`
 * - `@expect-cause <player>: <cause>` (death cause を events から逆引き)
 * - `@expect-event <name> <key:value...>` (events 内に該当 event が存在)
 * - `@expect-survivors: [players]`
 * - `@expect-result: <result>`
 * - `@expect-finished: true|false`
 * - `@expect-day: <n>`
 *
 * checkpoint 概念は無く、 ゲーム終了時の 1 回のみ検証する (retar の `@expect`
 * とは検証タイミングが異なる)。
 */

import assert from 'node:assert'
import type { GameEvent, GameState } from './types.ts'

export type StatusExp = { player: string, value: 'alive' | 'dead' }
export type CauseExp = { player: string, value: string }
export type EventExp = { name: string, params: Record<string, string> }

export type Expectations = {
  status: StatusExp[]
  cause: CauseExp[]
  event: EventExp[]
  survivors?: string[]
  result?: string
  finished?: boolean
  day?: number
}

const statusRegex = /^#\s*@expect-status\s+(\S+):\s*(alive|dead)\s*$/
const causeRegex = /^#\s*@expect-cause\s+(\S+):\s*(\S+)\s*$/
const eventRegex = /^#\s*@expect-event\s+(\S+)\s+(.+)$/
const survivorsRegex = /^#\s*@expect-survivors:\s*\[(.+)\]\s*$/
const resultRegex = /^#\s*@expect-result:\s*(\S+)\s*$/
const finishedRegex = /^#\s*@expect-finished:\s*(true|false)\s*$/
const dayRegex = /^#\s*@expect-day:\s*(\d+)\s*$/

export function extractExpectations(rawText: string): Expectations {
  const exps: Expectations = { status: [], cause: [], event: [] }
  const lines = rawText.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    let m: RegExpExecArray | null

    if ((m = statusRegex.exec(line))) {
      exps.status.push({ player: m[1], value: m[2] as 'alive' | 'dead' })
    } else if ((m = causeRegex.exec(line))) {
      exps.cause.push({ player: m[1], value: m[2] })
    } else if ((m = eventRegex.exec(line))) {
      const params: Record<string, string> = {}
      for (const kv of m[2].split(/\s+/)) {
        const idx = kv.indexOf(':')
        if (idx < 0) continue
        params[kv.slice(0, idx)] = kv.slice(idx + 1)
      }
      exps.event.push({ name: m[1], params })
    } else if ((m = survivorsRegex.exec(line))) {
      exps.survivors = m[1].split(',').map(s => s.trim()).filter(Boolean)
    } else if ((m = resultRegex.exec(line))) {
      exps.result = m[1]
    } else if ((m = finishedRegex.exec(line))) {
      exps.finished = m[1] === 'true'
    } else if ((m = dayRegex.exec(line))) {
      exps.day = Number(m[1])
    }
  }
  return exps
}

export function hasAnyExpectations(exps: Expectations): boolean {
  return exps.status.length > 0
    || exps.cause.length > 0
    || exps.event.length > 0
    || exps.survivors !== undefined
    || exps.result !== undefined
    || exps.finished !== undefined
    || exps.day !== undefined
}

// イベント列から死亡原因を逆引き (PlayerState 自体に死因は持たない)
function deathCauseFromEvents(seat: number, events: GameEvent[]): string | null {
  for (const e of events) {
    if (e.type === 'night_kill' && e.target === seat) return 'night_kill'
    if (e.type === 'fox_kill' && e.target === seat) return 'fox_kill'
    if (e.type === 'execution' && e.target === seat) return 'execution'
    if (e.type === 'curse_kill' && e.target === seat) return 'curse_kill'
    if (e.type === 'follow_kill' && e.target === seat) return 'follow_kill'
  }
  return null
}

function eventMatches(event: GameEvent, name: string, params: Record<string, string>, players: Map<number, string>): boolean {
  if (event.type !== name) return false
  const seatOf = (n: string) => [...players.entries()].find(([, x]) => x === n)?.[0]
  for (const [key, val] of Object.entries(params)) {
    if (key === 'day') {
      // day は event 自体には乗っていない (event は順序のみ)。skip。
      continue
    }
    if (key === 'target' || key === 'actor' || key === 'seat' || key === 'voter') {
      const seat = seatOf(val)
      if (seat === undefined) return false
      if ((event as any)[key] !== seat) return false
    } else {
      if ((event as any)[key] !== val) return false
    }
  }
  return true
}

export function verifyExpectations(
  exps: Expectations,
  state: GameState,
  events: GameEvent[],
  players: Map<number, string>,
): void {
  const seatOf = (n: string) => {
    for (const [seat, name] of players) if (name === n) return seat
    throw new Error(`player "${n}" not found`)
  }

  for (const s of exps.status) {
    const seat = seatOf(s.player)
    const player = state.players.find(p => p.seat === seat)
    assert.ok(player, `player ${s.player} not in state`)
    const actual = player.alive ? 'alive' : 'dead'
    assert.strictEqual(actual, s.value,
      `${s.player} status: expected ${s.value} but got ${actual}`)
  }

  for (const c of exps.cause) {
    const seat = seatOf(c.player)
    const cause = deathCauseFromEvents(seat, events)
    assert.strictEqual(cause, c.value,
      `${c.player} cause: expected ${c.value} but got ${cause}`)
  }

  for (const e of exps.event) {
    const found = events.some(ev => eventMatches(ev, e.name, e.params, players))
    assert.ok(found,
      `event ${e.name} with ${JSON.stringify(e.params)} not found in events`)
  }

  if (exps.survivors !== undefined) {
    const aliveSeats = state.players.filter(p => p.alive).map(p => p.seat).sort()
    const expectedSeats = exps.survivors.map(seatOf).sort()
    assert.deepStrictEqual(aliveSeats, expectedSeats, `survivors mismatch`)
  }

  if (exps.result !== undefined) {
    assert.strictEqual(state.result, exps.result,
      `result: expected ${exps.result} but got ${state.result}`)
  }

  if (exps.finished !== undefined) {
    assert.strictEqual(state.finished, exps.finished,
      `finished: expected ${exps.finished} but got ${state.finished}`)
  }

  if (exps.day !== undefined) {
    assert.strictEqual(state.day, exps.day,
      `day: expected ${exps.day} but got ${state.day}`)
  }
}
