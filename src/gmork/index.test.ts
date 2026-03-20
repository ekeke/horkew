import { describe, it } from 'node:test'
import assert from 'node:assert'
import { explain } from './index.ts'
import type { VillageStatus, SystemRole } from '../types/index.ts'

describe('gmork explain', () => {
  it('should return わかりません for any input (stub)', () => {
    const village = {
      statuses: new Map(),
      executions: new Map(),
      kills: new Map(),
      roles: new Map(),
      claims: new Map(),
    } as unknown as VillageStatus
    const setup = new Map<SystemRole, number>([['villager', 8], ['seer', 1], ['werewolf', 2]])

    const result = explain(village, setup, 1, 'seer')
    assert.strictEqual(result, 'わかりません')
  })
})
