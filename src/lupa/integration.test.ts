/**
 * Lupa engine-driven integration test
 *
 * src/lupa/scenarios/*.howl を読み込み、howl-adapter で GameHandlers を生成、
 * runGame で engine を駆動して結果 state / events を annotation で verify する。
 */

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { runGame } from './engine.ts'
import { buildLupaScenario } from './howl-adapter.ts'
import type { GameEvent } from './types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scenariosDir = join(__dirname, 'scenarios')

type StatusExp = { player: string, value: 'alive' | 'dead' }
type CauseExp = { player: string, value: string }
type EventExp = { name: string, params: Record<string, string> }
type Expectations = {
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

function extractExpectations(rawText: string): Expectations {
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

function loadScenarios() {
  if (!existsSync(scenariosDir)) return []
  const files = readdirSync(scenariosDir).filter(f => f.endsWith('.howl'))
  return files.map(file => {
    const content = readFileSync(join(scenariosDir, file), 'utf-8').replace(/\r\n/g, '\n')
    return { file, content }
  })
}

// イベントから死亡原因を逆引き (PlayerState には causeOfDeath が無い)
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

const scenarios = loadScenarios()

if (scenarios.length === 0) {
  describe('lupa engine integration (no scenarios)', () => {
    test('waiting for scenario files in src/lupa/scenarios/*.howl', () => {
      assert.ok(true, 'no scenarios to run')
    })
  })
} else {
  describe('lupa engine integration', () => {
    for (const { file, content } of scenarios) {
      const { meta } = parse(content)
      const title = meta.title || file
      describe(title, () => {
        test('engine runs and matches expectations', async () => {
          const { statements } = parse(content)
          const { vs, setup, players, assumptions, spoilerActions } = buildVillageStatus(statements, meta)
          const { config, handlers } = buildLupaScenario({
            assumptions, spoilerActions, vs, setup, players,
          })
          const { state, events } = await runGame(config, handlers)
          const exps = extractExpectations(content)

          const seatOf = (n: string) => {
            for (const [seat, name] of players) if (name === n) return seat
            throw new Error(`player "${n}" not found`)
          }

          // @expect-status
          for (const s of exps.status) {
            const seat = seatOf(s.player)
            const player = state.players.find(p => p.seat === seat)
            assert.ok(player, `player ${s.player} not in state`)
            const actual = player.alive ? 'alive' : 'dead'
            assert.strictEqual(actual, s.value,
              `${s.player} status: expected ${s.value} but got ${actual}`)
          }

          // @expect-cause
          for (const c of exps.cause) {
            const seat = seatOf(c.player)
            const cause = deathCauseFromEvents(seat, events as GameEvent[])
            assert.strictEqual(cause, c.value,
              `${c.player} cause: expected ${c.value} but got ${cause}`)
          }

          // @expect-event
          for (const e of exps.event) {
            const found = (events as GameEvent[]).some(ev => eventMatches(ev, e.name, e.params, players))
            assert.ok(found,
              `event ${e.name} with ${JSON.stringify(e.params)} not found in events`)
          }

          // @expect-survivors
          if (exps.survivors !== undefined) {
            const aliveSeats = state.players.filter(p => p.alive).map(p => p.seat).sort()
            const expectedSeats = exps.survivors.map(seatOf).sort()
            assert.deepStrictEqual(aliveSeats, expectedSeats,
              `survivors mismatch`)
          }

          // @expect-result
          if (exps.result !== undefined) {
            assert.strictEqual(state.result, exps.result,
              `result: expected ${exps.result} but got ${state.result}`)
          }

          // @expect-finished
          if (exps.finished !== undefined) {
            assert.strictEqual(state.finished, exps.finished,
              `finished: expected ${exps.finished} but got ${state.finished}`)
          }

          // @expect-day
          if (exps.day !== undefined) {
            assert.strictEqual(state.day, exps.day,
              `day: expected ${exps.day} but got ${state.day}`)
          }
        })
      })
    }
  })
}
