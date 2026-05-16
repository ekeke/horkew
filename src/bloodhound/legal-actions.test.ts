import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../types/index.ts'
import type { BloodhoundPhase } from './types.ts'
import { legalActions, type LegalActionsInput } from './legal-actions.ts'

const ALL_SEATS = Array.from({ length: 14 }, (_, i) => i + 1)
const ALL_ALIVE = ALL_SEATS

function input(over: Partial<LegalActionsInput>): LegalActionsInput {
  return {
    phase: 'discussion',
    role: 'villager',
    selfSeat: 1,
    alivePlayers: ALL_ALIVE,
    allSeats: ALL_SEATS,
    ...over,
  }
}

describe('legalActions: discussion phase', () => {
  test('exposes full discussion toolset', () => {
    const result = legalActions(input({ phase: 'discussion' }))
    assert.deepEqual(result.toolNames, [
      'say', 'pass',
      'seer_co', 'medium_co', 'bodyguard_co', 'mason_co', 'nekomata_co',
      'report_divination', 'report_medium',
      'retar',
    ])
  })

  test('report_* targets span all seats (alive + dead)', () => {
    const aliveSubset = [1, 2, 3, 4, 5]
    const result = legalActions(input({ phase: 'discussion', alivePlayers: aliveSubset }))
    assert.deepEqual(result.targets.report_divination, ALL_SEATS)
    assert.deepEqual(result.targets.report_medium, ALL_SEATS)
  })

  test('village roles share an identical toolset (no leakage)', () => {
    const villageRoles: SystemRole[] = [
      'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
    ]
    const reference = legalActions(input({ phase: 'discussion', role: 'villager' }))
    for (const role of villageRoles) {
      const r = legalActions(input({ phase: 'discussion', role }))
      assert.deepEqual(r.toolNames, reference.toolNames, `role=${role} sees different toolset from villager`)
    }
    assert.ok(!reference.toolNames.includes('craft_deception'),
      'village toolset should NOT include craft_deception')
  })

  test('non-village roles get craft_deception, village does not', () => {
    const nonVillage: SystemRole[] = ['werewolf', 'fanatic', 'werehamster', 'immoralist']
    for (const role of nonVillage) {
      const r = legalActions(input({ phase: 'discussion', role }))
      assert.ok(r.toolNames.includes('craft_deception'),
        `non-village role=${role} should include craft_deception`)
    }
    const village: SystemRole[] = [
      'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
    ]
    for (const role of village) {
      const r = legalActions(input({ phase: 'discussion', role }))
      assert.ok(!r.toolNames.includes('craft_deception'),
        `village role=${role} should NOT include craft_deception`)
    }
  })

  test('non-village roles share an identical toolset among themselves', () => {
    const nonVillage: SystemRole[] = ['werewolf', 'fanatic', 'werehamster', 'immoralist']
    const reference = legalActions(input({ phase: 'discussion', role: 'werewolf' }))
    for (const role of nonVillage) {
      const r = legalActions(input({ phase: 'discussion', role }))
      assert.deepEqual(r.toolNames, reference.toolNames, `non-village role=${role} differs from werewolf`)
    }
  })

  test('craft_deception is discussion-only (not exposed in vote / night / last_will)', () => {
    const phases: BloodhoundPhase[] = [
      'vote', 'revote', 'night_seer', 'night_bodyguard', 'night_wolf', 'last_will',
    ]
    for (const phase of phases) {
      const r = legalActions(input({ phase, role: 'werewolf', fellowWolves: [] }))
      assert.ok(!r.toolNames.includes('craft_deception'),
        `craft_deception leaked into phase=${phase}`)
    }
  })
})

describe('legalActions: vote phase', () => {
  test('initial vote (voteCandidates null) → all alive minus self', () => {
    const result = legalActions(input({ phase: 'vote', selfSeat: 7, voteCandidates: null }))
    assert.deepEqual(result.toolNames, ['vote', 'retar'])
    assert.deepEqual(result.targets.vote, [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14])
  })

  test('initial vote with reduced alive list', () => {
    const result = legalActions(input({
      phase: 'vote', selfSeat: 3, alivePlayers: [1, 2, 3, 4, 5], voteCandidates: null,
    }))
    assert.deepEqual(result.targets.vote, [1, 2, 4, 5])
  })

  test('revote restricts to candidates, still excludes self', () => {
    const result = legalActions(input({
      phase: 'revote', selfSeat: 3, voteCandidates: [2, 3, 7],
    }))
    assert.deepEqual(result.targets.vote, [2, 7])
  })

  test('revote with empty candidates falls back to all alive', () => {
    const result = legalActions(input({
      phase: 'revote', selfSeat: 1, alivePlayers: [1, 2, 3], voteCandidates: [],
    }))
    assert.deepEqual(result.targets.vote, [2, 3])
  })
})

describe('legalActions: night phases', () => {
  test('night_seer: divine candidates exclude self', () => {
    const result = legalActions(input({ phase: 'night_seer', role: 'seer', selfSeat: 4, alivePlayers: [1, 2, 4, 5] }))
    assert.deepEqual(result.toolNames, ['divine', 'retar'])
    assert.deepEqual(result.targets.divine, [1, 2, 5])
  })

  test('night_bodyguard: guard candidates exclude self', () => {
    const result = legalActions(input({ phase: 'night_bodyguard', role: 'bodyguard', selfSeat: 4, alivePlayers: [1, 2, 4, 5] }))
    assert.deepEqual(result.toolNames, ['guard', 'retar'])
    assert.deepEqual(result.targets.guard, [1, 2, 5])
  })

  test('night_wolf: attack excludes self + fellow wolves', () => {
    const result = legalActions(input({
      phase: 'night_wolf', role: 'werewolf', selfSeat: 2,
      alivePlayers: [1, 2, 3, 5, 8], fellowWolves: [5, 8],
    }))
    assert.deepEqual(result.toolNames, ['attack', 'retar'])
    assert.deepEqual(result.targets.attack, [1, 3])
  })

  test('night_wolf: lone wolf (no fellows) attacks anyone alive except self', () => {
    const result = legalActions(input({
      phase: 'night_wolf', role: 'werewolf', selfSeat: 5,
      alivePlayers: [1, 3, 5, 9], fellowWolves: [],
    }))
    assert.deepEqual(result.targets.attack, [1, 3, 9])
  })

  test('night_wolf: fellowWolves undefined defaults to lone wolf behaviour', () => {
    const result = legalActions(input({
      phase: 'night_wolf', role: 'werewolf', selfSeat: 5,
      alivePlayers: [1, 3, 5, 9],
    }))
    assert.deepEqual(result.targets.attack, [1, 3, 9])
  })
})

describe('legalActions: last_will phase', () => {
  test('exposes CO + report tools only (no say/pass)', () => {
    const result = legalActions(input({ phase: 'last_will' }))
    assert.deepEqual(result.toolNames, [
      'seer_co', 'medium_co', 'bodyguard_co', 'mason_co', 'nekomata_co',
      'report_divination', 'report_medium',
      'retar',
    ])
    assert.deepEqual(result.targets.report_divination, ALL_SEATS)
    assert.deepEqual(result.targets.report_medium, ALL_SEATS)
  })
})

describe('legalActions: invariants', () => {
  const phases: BloodhoundPhase[] = [
    'discussion', 'vote', 'revote', 'night_seer', 'night_bodyguard', 'night_wolf', 'last_will',
  ]

  test('retar tool is always exposed', () => {
    for (const phase of phases) {
      const result = legalActions(input({ phase, fellowWolves: [] }))
      assert.ok(result.toolNames.includes('retar'), `phase=${phase} missing retar`)
    }
  })

  test('no phase exposes nekomata_curse (engine resolves it internally)', () => {
    for (const phase of phases) {
      const result = legalActions(input({ phase, fellowWolves: [] }))
      assert.ok(
        // @ts-expect-error nekomata_curse intentionally not in ToolName union
        !result.toolNames.includes('nekomata_curse'),
        `phase=${phase} unexpectedly exposes nekomata_curse`,
      )
    }
  })

  test('no phase exposes villager_co (no such DayClaim variant in lupa)', () => {
    for (const phase of phases) {
      const result = legalActions(input({ phase, fellowWolves: [] }))
      assert.ok(
        // @ts-expect-error villager_co intentionally not in ToolName union
        !result.toolNames.includes('villager_co'),
        `phase=${phase} unexpectedly exposes villager_co`,
      )
    }
  })
})
