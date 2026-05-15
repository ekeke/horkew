import { describe, it } from 'node:test'
import assert from 'node:assert'
import { findTsumiPuzzle, generateRandomSetup } from './puzzle.ts'
import { Rng } from '../lupa/random.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import type { SystemRole } from '../types/index.ts'

const VILLAGE_ROLES: SystemRole[] = [
  'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
]
const OUTSIDER_ROLES: SystemRole[] = [
  'possessed', 'fanatic', 'immoralist', 'werehamster', 'werewolf',
]

describe('generateRandomSetup', () => {
  it('satisfies all constraints across many samples', () => {
    const rng = new Rng(1)
    for (let i = 0; i < 200; i++) {
      const setup = generateRandomSetup(rng)
      const n = Array.from(setup.values()).reduce((a, b) => a + b, 0)
      assert.ok(n >= 9 && n <= 14, `player count out of range: ${n}`)

      const wolves = setup.get('werewolf') ?? 0
      let village = 0
      for (const r of VILLAGE_ROLES) village += setup.get(r) ?? 0
      let outsiders = 0
      for (const r of OUTSIDER_ROLES) outsiders += setup.get(r) ?? 0

      assert.ok(wolves >= 1, `wolves must be >= 1`)
      assert.ok(village >= 1, `village must be >= 1`)
      assert.ok((wolves + 1) * 2 < n, `wolves+1 < n/2 violated: wolves=${wolves}, n=${n}`)
      assert.ok(outsiders * 2 < n, `outsiders < n/2 violated: outsiders=${outsiders}, n=${n}`)
      assert.ok((setup.get('nekomata') ?? 0) <= 1, `nekomata must be <= 1`)
    }
  })
})

describe('findTsumiPuzzle', () => {
  it('is deterministic for the same seed', async () => {
    const a = await findTsumiPuzzle(42, { maxGames: 5 })
    const b = await findTsumiPuzzle(42, { maxGames: 5 })
    assert.deepStrictEqual(a, b)
  })

  it('returns parseable howl when found', async () => {
    let foundOnce = false
    for (let seed = 1; seed <= 30 && !foundOnce; seed++) {
      const howl = await findTsumiPuzzle(seed, { maxGames: 3 })
      if (howl === null) continue
      foundOnce = true
      const parsed = parse(howl)
      const { vs } = buildVillageStatus(parsed.statements, parsed.meta)
      assert.ok(vs.statuses.size > 0, 'village must have players')
    }
    assert.ok(foundOnce, 'expected at least one tsumi to be found across 30 seeds')
  })
})
