import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeIter, type GameSummary } from './eval-summary.ts'
import type { SeatStatus } from '../../types/index.ts'

describe('summarizeIter', () => {
  function makeSeatStatus(overrides: Partial<SeatStatus>): SeatStatus {
    return {
      surviving: true,
      causeOfDeath: 'execution',
      survivedDays: 0,
      claiming: false,
      claimingRole: 'none',
      ...overrides,
    } as SeatStatus
  }

  it('computes win rates correctly', () => {
    const games: GameSummary[] = [
      { seed: 's1', result: 'villager_won', day: 5, roles: new Map(), statuses: new Map() },
      { seed: 's2', result: 'villager_won', day: 4, roles: new Map(), statuses: new Map() },
      { seed: 's3', result: 'werewolf_won', day: 6, roles: new Map(), statuses: new Map() },
    ]
    const s = summarizeIter('test', games)
    assert.equal(s.gameCount, 3)
    assert.equal(s.results['villager_won'], 2)
    assert.equal(s.results['werewolf_won'], 1)
    assert.equal(s.avgDays, 5)
  })

  it('computes per-role stats', () => {
    const statuses1 = new Map<number, SeatStatus>([
      [0, makeSeatStatus({ surviving: false, diedDay: 2, causeOfDeath: 'execution' })],
      [1, makeSeatStatus({ surviving: true })],
    ])
    const roles1 = new Map([[0, '村'], [1, '占い']])

    const statuses2 = new Map<number, SeatStatus>([
      [0, makeSeatStatus({ surviving: false, diedDay: 4, causeOfDeath: 'night_kill' })],
      [1, makeSeatStatus({ surviving: false, diedDay: 3, causeOfDeath: 'execution' })],
    ])
    const roles2 = new Map([[0, '村'], [1, '占い']])

    const games: GameSummary[] = [
      { seed: 's1', result: 'villager_won', day: 5, roles: roles1, statuses: statuses1 },
      { seed: 's2', result: 'werewolf_won', day: 6, roles: roles2, statuses: statuses2 },
    ]

    const s = summarizeIter('test', games)
    const vill = s.roleStats.get('村')!
    assert.equal(vill.games, 2)
    assert.equal(vill.survived, 0)
    assert.equal(vill.minDaysAlive, 2)
    assert.equal(vill.maxDaysAlive, 4)
    assert.equal(vill.totalDaysAlive, 6)
    assert.equal(vill.deathCauses['execution'], 1)
    assert.equal(vill.deathCauses['night_kill'], 1)

    const seer = s.roleStats.get('占い')!
    assert.equal(seer.games, 2)
    assert.equal(seer.survived, 1)
    assert.equal(seer.minDaysAlive, 3)
    assert.equal(seer.maxDaysAlive, 5)
  })

  it('handles games with no reveals', () => {
    const games: GameSummary[] = [
      { seed: 's1', result: 'draw', day: 3, roles: new Map(), statuses: new Map() },
    ]
    const s = summarizeIter('test', games)
    assert.equal(s.gameCount, 1)
    assert.equal(s.results['draw'], 1)
    assert.equal(s.roleStats.size, 0)
  })
})
