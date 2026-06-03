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
 * - `@expect-divine actor:X night:N target:Y result:human|wolf`
 *   (秘匿占い結果が player.divineHistory に記録されているか — engine の能力 dispatch を verify)
 * - `@expect-no-divine actor:X night:N`
 *   (actor X の divineHistory に night N の entry が存在しないことを verify。
 *    role.seer.first-seek=none / no-wolf 等で占いが reject された状況を assert する用)
 * - `@expect-attack actor:X night:N target:Y`
 *   (engine が集約決定した襲撃 target が actor の attackHistory に記録されているか)
 * - `@expect-guard actor:X night:N target:Y`
 *   (狩人個別の護衛 target が actor の guardHistory に記録されているか)
 * - `@expect-medium actor:X day:N target:Y result:human|wolf`
 *   (霊能 trait の自動 push が actor の mediumHistory[day] に記録されているか)
 * - `@expect-view actor:X field:<fieldName> value:<value>`
 *   (buildPlayerView(state, actor) で構築される PlayerView の知識フィールドを検査。
 *    field は wolfTeammates / knownWolves / knownHamster / masonPartner のいずれか。
 *    value は単一名 (例: Bob) / `null` / 配列 (例: [Bob,Carol] — 空 [] も可) を許容)
 *
 * checkpoint 概念は無く、 ゲーム終了時の 1 回のみ検証する (retar の `@expect`
 * とは検証タイミングが異なる)。
 */

import assert from 'node:assert'
import type { GameEvent, GameState } from './types.ts'
import { buildPlayerView } from './player-view.ts'

export type StatusExp = { player: string, value: 'alive' | 'dead' }
export type CauseExp = { player: string, value: string }
export type EventExp = { name: string, params: Record<string, string> }
export type DivineExp = { actor: string, night: number, target: string, result: 'human' | 'wolf' | 'kogitsune' | 'null' }
export type NoDivineExp = { actor: string, night: number }
export type AttackExp = { actor: string, night: number, target: string }
export type GuardExp = { actor: string, night: number, target: string }
export type MediumExp = { actor: string, day: number, target: string, result: 'human' | 'wolf' | 'kogitsune' }
export type ViewExp =
  | { kind: 'single', actor: string, field: 'masonPartner' | 'knownHamster', expected: string | null }
  | { kind: 'array', actor: string, field: 'wolfTeammates' | 'knownWolves', expected: string[] }

export type Expectations = {
  status: StatusExp[]
  cause: CauseExp[]
  event: EventExp[]
  divine: DivineExp[]
  noDivine: NoDivineExp[]
  attack: AttackExp[]
  guard: GuardExp[]
  medium: MediumExp[]
  view: ViewExp[]
  survivors?: string[]
  result?: string
  finished?: boolean
  day?: number
}

const statusRegex = /^#\s*@expect-status\s+(\S+):\s*(alive|dead)\s*$/
const causeRegex = /^#\s*@expect-cause\s+(\S+):\s*(\S+)\s*$/
const eventRegex = /^#\s*@expect-event\s+(\S+)(?:\s+(.+))?\s*$/
const survivorsRegex = /^#\s*@expect-survivors:\s*\[(.+)\]\s*$/
const resultRegex = /^#\s*@expect-result:\s*(\S+)\s*$/
const finishedRegex = /^#\s*@expect-finished:\s*(true|false)\s*$/
const dayRegex = /^#\s*@expect-day:\s*(\d+)\s*$/
const divineRegex = /^#\s*@expect-divine\s+actor:(\S+)\s+night:(\d+)\s+target:(\S+)\s+result:(human|wolf|kogitsune|null)\s*$/
const noDivineRegex = /^#\s*@expect-no-divine\s+actor:(\S+)\s+night:(\d+)\s*$/
const attackRegex = /^#\s*@expect-attack\s+actor:(\S+)\s+night:(\d+)\s+target:(\S+)\s*$/
const guardRegex = /^#\s*@expect-guard\s+actor:(\S+)\s+night:(\d+)\s+target:(\S+)\s*$/
const mediumRegex = /^#\s*@expect-medium\s+actor:(\S+)\s+day:(\d+)\s+target:(\S+)\s+result:(human|wolf|kogitsune)\s*$/
const viewRegex = /^#\s*@expect-view\s+actor:(\S+)\s+field:(\S+)\s+value:(.+?)\s*$/

const SINGLE_FIELDS = new Set(['masonPartner', 'knownHamster'])
const ARRAY_FIELDS = new Set(['wolfTeammates', 'knownWolves'])

export function extractExpectations(rawText: string): Expectations {
  const exps: Expectations = { status: [], cause: [], event: [], divine: [], noDivine: [], attack: [], guard: [], medium: [], view: [] }
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
      if (m[2]) {
        for (const kv of m[2].split(/\s+/)) {
          const idx = kv.indexOf(':')
          if (idx < 0) continue
          params[kv.slice(0, idx)] = kv.slice(idx + 1)
        }
      }
      exps.event.push({ name: m[1], params })
    } else if ((m = divineRegex.exec(line))) {
      exps.divine.push({
        actor: m[1], night: Number(m[2]), target: m[3], result: m[4] as 'human' | 'wolf' | 'kogitsune' | 'null',
      })
    } else if ((m = noDivineRegex.exec(line))) {
      exps.noDivine.push({ actor: m[1], night: Number(m[2]) })
    } else if ((m = attackRegex.exec(line))) {
      exps.attack.push({
        actor: m[1], night: Number(m[2]), target: m[3],
      })
    } else if ((m = guardRegex.exec(line))) {
      exps.guard.push({
        actor: m[1], night: Number(m[2]), target: m[3],
      })
    } else if ((m = mediumRegex.exec(line))) {
      exps.medium.push({
        actor: m[1], day: Number(m[2]), target: m[3], result: m[4] as 'human' | 'wolf' | 'kogitsune',
      })
    } else if ((m = viewRegex.exec(line))) {
      const actor = m[1]
      const field = m[2]
      const rawValue = m[3]
      if (SINGLE_FIELDS.has(field)) {
        const expected = rawValue === 'null' ? null : rawValue
        exps.view.push({ kind: 'single', actor, field: field as 'masonPartner' | 'knownHamster', expected })
      } else if (ARRAY_FIELDS.has(field)) {
        const inner = rawValue.replace(/^\[/, '').replace(/\]$/, '').trim()
        const expected = inner === '' ? [] : inner.split(',').map(s => s.trim()).filter(Boolean)
        exps.view.push({ kind: 'array', actor, field: field as 'wolfTeammates' | 'knownWolves', expected })
      } else {
        throw new Error(`@expect-view: unknown field "${field}" (expected one of: wolfTeammates, knownWolves, knownHamster, masonPartner)`)
      }
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
    || exps.divine.length > 0
    || exps.noDivine.length > 0
    || exps.attack.length > 0
    || exps.guard.length > 0
    || exps.medium.length > 0
    || exps.view.length > 0
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

  for (const d of exps.divine) {
    const actorSeat = seatOf(d.actor)
    const targetSeat = seatOf(d.target)
    const player = state.players.find(p => p.seat === actorSeat)
    assert.ok(player, `player ${d.actor} not in state`)
    const entry = player.divineHistory.get(d.night)
    assert.ok(entry,
      `${d.actor}: no divine entry for night ${d.night}`)
    assert.strictEqual(entry.target, targetSeat,
      `${d.actor} night ${d.night}: expected target ${d.target} but got seat ${entry.target}`)
    const expectedResult = d.result === 'null' ? null : d.result
    assert.strictEqual(entry.result, expectedResult,
      `${d.actor} night ${d.night}: expected result ${d.result} but got ${entry.result}`)
  }

  for (const nd of exps.noDivine) {
    const actorSeat = seatOf(nd.actor)
    const player = state.players.find(p => p.seat === actorSeat)
    assert.ok(player, `player ${nd.actor} not in state`)
    const entry = player.divineHistory.get(nd.night)
    assert.strictEqual(entry, undefined,
      `${nd.actor}: expected no divine entry for night ${nd.night} but got ${JSON.stringify(entry)}`)
  }

  for (const a of exps.attack) {
    const actorSeat = seatOf(a.actor)
    const targetSeat = seatOf(a.target)
    const player = state.players.find(p => p.seat === actorSeat)
    assert.ok(player, `player ${a.actor} not in state`)
    const recorded = player.attackHistory.get(a.night)
    assert.strictEqual(recorded, targetSeat,
      `${a.actor} night ${a.night}: expected attack target ${a.target} but got seat ${recorded}`)
  }

  for (const g of exps.guard) {
    const actorSeat = seatOf(g.actor)
    const targetSeat = seatOf(g.target)
    const player = state.players.find(p => p.seat === actorSeat)
    assert.ok(player, `player ${g.actor} not in state`)
    const recorded = player.guardHistory.get(g.night)
    assert.strictEqual(recorded, targetSeat,
      `${g.actor} night ${g.night}: expected guard target ${g.target} but got seat ${recorded}`)
  }

  for (const m of exps.medium) {
    const actorSeat = seatOf(m.actor)
    const targetSeat = seatOf(m.target)
    const player = state.players.find(p => p.seat === actorSeat)
    assert.ok(player, `player ${m.actor} not in state`)
    const entry = player.mediumHistory.get(m.day)
    assert.ok(entry,
      `${m.actor}: no medium entry for day ${m.day}`)
    assert.strictEqual(entry.target, targetSeat,
      `${m.actor} day ${m.day}: expected target ${m.target} but got seat ${entry.target}`)
    assert.strictEqual(entry.result, m.result,
      `${m.actor} day ${m.day}: expected result ${m.result} but got ${entry.result}`)
  }

  for (const v of exps.view) {
    const actorSeat = seatOf(v.actor)
    const view = buildPlayerView(state, actorSeat)
    if (v.kind === 'single') {
      const actualSeat = view[v.field]
      const expectedSeat = v.expected === null ? null : seatOf(v.expected)
      assert.strictEqual(actualSeat, expectedSeat,
        `${v.actor} view.${v.field}: expected ${v.expected} but got seat ${actualSeat}`)
    } else {
      const actualSeats = (view[v.field] ?? []).slice().sort((a, b) => a - b)
      const expectedSeats = v.expected.map(seatOf).slice().sort((a, b) => a - b)
      assert.deepStrictEqual(actualSeats, expectedSeats,
        `${v.actor} view.${v.field}: expected [${v.expected.join(',')}] but got seats [${actualSeats.join(',')}]`)
    }
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
