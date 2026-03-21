import { describe, it } from 'node:test'
import assert from 'node:assert'
import { explain, findReason, findConfirmationReason, explainConfirmation } from './index.ts'
import { formatReason } from './format.ts'
import { deadWerewolfBounds } from './confirmers.ts'
import type { VillageStatus, SeatStatus, SystemRole } from '../types/index.ts'

function createSeatStatus(overrides: Partial<SeatStatus> = {}): SeatStatus {
  return {
    surviving: true,
    causeOfDeath: 'execution',
    survivedDays: 0,
    diedDay: undefined,
    voted: false,
    claiming: false,
    claimingRole: 'none',
    deniedRoles: [],
    votedCount: 0,
    votedTarget: -1,
    votedOrder: 0,
    actions: new Map(),
    assertions: new Map(),
    ...overrides,
  }
}

function createVillage(opts: {
  playerCount?: number
  statuses?: [number, Partial<SeatStatus>][]
  kills?: [number, number[]][]
  executions?: [number, number[]][]
  claims?: [SystemRole, number[]][]
  result?: VillageStatus['result']
  finished?: boolean
  day?: number
} = {}): VillageStatus {
  const playerCount = opts.playerCount || 10
  const statusMap = new Map<number, SeatStatus>()
  for (let i = 1; i <= playerCount; i++) {
    statusMap.set(i, createSeatStatus())
  }
  if (opts.statuses) {
    for (const [seat, overrides] of opts.statuses) {
      statusMap.set(seat, createSeatStatus(overrides))
    }
  }
  const claimsMap = new Map<number | SystemRole, number[]>()
  if (opts.claims) {
    for (const [role, seats] of opts.claims) {
      claimsMap.set(role, seats)
    }
  }
  return {
    statuses: statusMap,
    executions: new Map(opts.executions || []),
    kills: new Map(opts.kills || []),
    roles: new Map(),
    claims: claimsMap,
    day: opts.day || 3,
    finished: opts.finished || false,
    result: opts.result,
  }
}

const defaultSetup = new Map<SystemRole, number>([
  ['villager', 4],
  ['seer', 1],
  ['medium', 1],
  ['bodyguard', 1],
  ['werewolf', 2],
  ['possessed', 1],
])

describe('gmork explain', () => {
  // ── Tier 1: Direct inference ──────────────────────────────────────

  describe('Tier 1', () => {
    it('6.3: role not in setup', () => {
      const village = createVillage()
      const result = explain(village, defaultSetup, 1, 'nekomata')
      assert.match(result, /配役に猫又が存在しない/)
    })

    it('10.1: no werehamster → no immoralist', () => {
      const setupWithImmoralist = new Map<SystemRole, number>([...defaultSetup, ['immoralist', 1]])
      const village = createVillage()
      const result = explain(village, setupWithImmoralist, 1, 'immoralist')
      assert.match(result, /妖狐がいない/)
    })

    it('1.2/1.3: cursed_by_nekomata confirms werewolf', () => {
      const village = createVillage({
        statuses: [[3, {
          surviving: false,
          causeOfDeath: 'cursed_by_killed_nekomata',
          diedDay: 2,
        }]],
        kills: [[2, [3]]],
      })
      const result = explain(village, defaultSetup, 3, 'villager')
      assert.match(result, /猫又の呪殺道連れ.*人狼/)
    })

    it('1.2/1.3: cursed_by_nekomata does NOT deny werewolf', () => {
      const village = createVillage({
        statuses: [[3, {
          surviving: false,
          causeOfDeath: 'cursed_by_killed_nekomata',
          diedDay: 2,
        }]],
      })
      const reason = findReason(village, defaultSetup, 3, 'werewolf')
      assert.ok(reason === null || reason.type !== 'cursed_by_nekomata')
    })

    it('1.4: follow_hamster confirms immoralist', () => {
      const setupWithFox = new Map<SystemRole, number>([...defaultSetup, ['werehamster', 1], ['immoralist', 1]])
      const village = createVillage({
        statuses: [[5, {
          surviving: false,
          causeOfDeath: 'follow_executed_hamster',
          diedDay: 3,
        }]],
      })
      const result = explain(village, setupWithFox, 5, 'villager')
      assert.match(result, /後追い.*背徳者/)
    })

    it('1.1: sole night kill denies werewolf', () => {
      const village = createVillage({
        statuses: [[4, {
          surviving: false,
          causeOfDeath: 'night_kill',
          diedDay: 2,
        }]],
        kills: [[2, [4]]],
      })
      const result = explain(village, defaultSetup, 4, 'werewolf')
      assert.match(result, /2d夜.*単独.*襲撃死.*人狼/)
    })

    it('1.1: multiple night kills does NOT deny werewolf via sole_night_kill', () => {
      const village = createVillage({
        statuses: [
          [4, { surviving: false, causeOfDeath: 'night_kill', diedDay: 2 }],
          [5, { surviving: false, causeOfDeath: 'night_kill', diedDay: 2 }],
        ],
        kills: [[2, [4, 5]]],
      })
      const reason = findReason(village, defaultSetup, 4, 'werewolf')
      assert.ok(reason === null || reason.type !== 'sole_night_kill')
    })

    it('2.1: villager CO denies village special roles', () => {
      const village = createVillage({
        statuses: [[1, { claimingRole: 'villager' }]],
      })
      assert.match(explain(village, defaultSetup, 1, 'seer'), /村人.*CO.*占い師.*ありえない/)
      assert.match(explain(village, defaultSetup, 1, 'medium'), /村人.*CO.*霊能者.*ありえない/)
      assert.match(explain(village, defaultSetup, 1, 'bodyguard'), /村人.*CO.*狩人.*ありえない/)
    })

    it('2.1: villager CO does NOT deny werewolf', () => {
      const village = createVillage({
        statuses: [[1, { claimingRole: 'villager' }]],
      })
      const reason = findReason(village, defaultSetup, 1, 'werewolf')
      assert.ok(reason === null || reason.type !== 'villager_co')
    })

    it('2.2: surrender CO denies village side roles', () => {
      const village = createVillage({
        statuses: [[2, { claimingRole: 'surrender' }]],
      })
      assert.match(explain(village, defaultSetup, 2, 'villager'), /人外.*CO/)
      assert.match(explain(village, defaultSetup, 2, 'seer'), /人外.*CO/)
    })

    it('2.3: silent execution denies village special roles', () => {
      const village = createVillage({
        statuses: [[6, {
          surviving: false,
          causeOfDeath: 'execution',
          claiming: false,
        }]],
        executions: [[2, [6]]],
      })
      assert.match(explain(village, defaultSetup, 6, 'seer'), /COなし.*処刑.*占い師.*ありえない/)
      assert.match(explain(village, defaultSetup, 6, 'medium'), /COなし.*処刑.*霊能者.*ありえない/)
    })

    it('2.3: silent execution does NOT deny werewolf', () => {
      const village = createVillage({
        statuses: [[6, {
          surviving: false,
          causeOfDeath: 'execution',
          claiming: false,
        }]],
      })
      const reason = findReason(village, defaultSetup, 6, 'werewolf')
      assert.ok(reason === null || reason.type !== 'silent_execution')
    })

    it('deniedRoles: negative CO denies specified role', () => {
      const village = createVillage({
        statuses: [[7, { deniedRoles: ['seer' as SystemRole] }]],
      })
      assert.match(explain(village, defaultSetup, 7, 'seer'), /CO内容.*占い師.*ありえない/)
    })
  })

  // ── Tier 2: Simple combination ────────────────────────────────────

  describe('Tier 2', () => {
    it('3.1: seer white denies werewolf', () => {
      const village = createVillage({
        statuses: [
          [2, {
            claiming: true,
            claimingRole: 'seer',
            assertions: new Map([[1, { target: 5, species: 'human' }]]),
          }],
        ],
        claims: [['seer', [2]]],
      })
      const result = explain(village, defaultSetup, 5, 'werewolf')
      assert.match(result, /占い師.*2d.*白判定.*人狼/)
    })

    it('3.2: seer black confirms werewolf (denies non-werewolf)', () => {
      const village = createVillage({
        statuses: [
          [2, {
            claiming: true,
            claimingRole: 'seer',
            assertions: new Map([[2, { target: 5, species: 'wolf' }]]),
          }],
        ],
        claims: [['seer', [2]]],
      })
      const result = explain(village, defaultSetup, 5, 'villager')
      assert.match(result, /占い師.*3d.*黒判定.*人狼/)
    })

    it('3.3: seer fox kill confirms werehamster', () => {
      const setupWithFox = new Map<SystemRole, number>([...defaultSetup, ['werehamster', 1]])
      const village = createVillage({
        statuses: [
          [2, {
            claiming: true,
            claimingRole: 'seer',
            assertions: new Map([[2, { target: 7, species: 'human' }]]),
          }],
          [7, { surviving: false, causeOfDeath: 'night_kill', diedDay: 2 }],
          [8, { surviving: false, causeOfDeath: 'night_kill', diedDay: 2 }],
        ],
        kills: [[2, [7, 8]]],
        claims: [['seer', [2]]],
      })
      const result = explain(village, setupWithFox, 7, 'villager')
      assert.match(result, /占い師.*3d.*呪殺.*妖狐/)
    })

    it('4.1: medium white denies werewolf', () => {
      const village = createVillage({
        statuses: [
          [3, {
            claiming: true,
            claimingRole: 'medium',
            assertions: new Map([[1, { target: 6, species: 'human' }]]),
          }],
          [6, { surviving: false, causeOfDeath: 'execution', diedDay: 2 }],
        ],
        claims: [['medium', [3]]],
        executions: [[2, [6]]],
      })
      const result = explain(village, defaultSetup, 6, 'werewolf')
      assert.match(result, /霊媒師.*2d.*白判定.*人狼/)
    })

    it('4.2: medium black confirms werewolf', () => {
      const village = createVillage({
        statuses: [
          [3, {
            claiming: true,
            claimingRole: 'medium',
            assertions: new Map([[1, { target: 6, species: 'wolf' }]]),
          }],
          [6, { surviving: false, causeOfDeath: 'execution', diedDay: 2 }],
        ],
        claims: [['medium', [3]]],
        executions: [[2, [6]]],
      })
      const result = explain(village, defaultSetup, 6, 'villager')
      assert.match(result, /霊媒師.*2d.*黒判定.*人狼/)
    })

    it('5.1: mason partner confirms mason', () => {
      const setupWithMason = new Map<SystemRole, number>([...defaultSetup, ['mason', 2]])
      const village = createVillage({
        statuses: [
          [1, {
            claiming: true,
            claimingRole: 'mason',
            assertions: new Map([[-1, { target: 2, species: 'human' }]]),
          }],
          [2, {
            claiming: true,
            claimingRole: 'mason',
            assertions: new Map([[-1, { target: 1, species: 'human' }]]),
          }],
        ],
        claims: [['mason', [1, 2]]],
      })
      const result = explain(village, setupWithMason, 2, 'werewolf')
      assert.match(result, /共有者.*相方.*認定.*共有者/)
    })

    it('6.2: role slots filled denies non-claimant', () => {
      const village = createVillage({
        statuses: [
          [2, { claiming: true, claimingRole: 'seer' }],
        ],
        claims: [['seer', [2]]],
      })
      const result = explain(village, defaultSetup, 5, 'seer')
      assert.match(result, /占い師.*対抗に出なかった/)
    })

    it('6.2: does NOT deny the claimant itself', () => {
      const village = createVillage({
        statuses: [
          [2, { claiming: true, claimingRole: 'seer' }],
        ],
        claims: [['seer', [2]]],
      })
      const reason = findReason(village, defaultSetup, 2, 'seer')
      assert.ok(reason === null || reason.type !== 'role_slots_filled')
    })

    it('8.1: single night death denies nekomata', () => {
      const setupWithNeko = new Map<SystemRole, number>([...defaultSetup, ['nekomata', 1]])
      const village = createVillage({
        statuses: [[4, {
          surviving: false,
          causeOfDeath: 'night_kill',
          diedDay: 2,
        }]],
        kills: [[2, [4]]],
      })
      const result = explain(village, setupWithNeko, 4, 'nekomata')
      assert.match(result, /2d夜.*死者が1人.*猫又/)
    })

    it('9.2: all hamsters dead denies immoralist for survivor', () => {
      const setupWithFox = new Map<SystemRole, number>([
        ...defaultSetup,
        ['werehamster', 1],
        ['immoralist', 1],
      ])
      const village = createVillage({
        statuses: [
          [8, { surviving: false, causeOfDeath: 'follow_executed_hamster', diedDay: 2 }],
        ],
      })
      const result = explain(village, setupWithFox, 1, 'immoralist')
      assert.match(result, /妖狐.*全滅.*背徳者/)
    })
  })

  // ── Tier 3: Chained reasoning ─────────────────────────────────────

  describe('Tier 3', () => {
    it('12.1: village won, survivor not werewolf', () => {
      const village = createVillage({
        finished: true,
        result: 'villager_won',
      })
      const result = explain(village, defaultSetup, 1, 'werewolf')
      assert.match(result, /村.*勝利.*生存者.*人狼/)
    })

    it('7.1: liar budget exceeded', () => {
      // 3 seer COs, 1 real seer slot, 1 evil slot (werewolf only)
      // Seat 1 (non-CO) = villager? → 3 seer COs, 1 real slot, 2 fakes needed
      // Evil capacity = 1 → 2 > 1 → contradiction
      const setup = new Map<SystemRole, number>([
        ['villager', 6],
        ['seer', 1],
        ['werewolf', 1],
      ])
      const village = createVillage({
        playerCount: 8,
        statuses: [
          [2, { claiming: true, claimingRole: 'seer' }],
          [3, { claiming: true, claimingRole: 'seer' }],
          [4, { claiming: true, claimingRole: 'seer' }],
        ],
        claims: [['seer', [2, 3, 4]]],
      })
      const result = explain(village, setup, 1, 'villager')
      assert.match(result, /人外枠.*偽者.*矛盾/)
    })
  })

  // ── Fallback ──────────────────────────────────────────────────────

  describe('fallback', () => {
    it('returns わかりません when no reason found', () => {
      const village = createVillage()
      const result = explain(village, defaultSetup, 1, 'villager')
      assert.strictEqual(result, 'わかりません')
    })

    it('returns わかりません for unknown seat', () => {
      const village = createVillage({ playerCount: 5 })
      const result = explain(village, defaultSetup, 99, 'villager')
      assert.strictEqual(result, 'わかりません')
    })
  })
})

// ── 確定理由 ────────────────────────────────────────────────────────

describe('gmork confirmation', () => {
  describe('death cause', () => {
    it('cursed_by_nekomata confirms werewolf', () => {
      const village = createVillage({
        statuses: [[3, {
          surviving: false,
          causeOfDeath: 'cursed_by_killed_nekomata',
          diedDay: 2,
        }]],
      })
      const reason = findConfirmationReason(village, defaultSetup, 3, 'werewolf')
      assert.ok(reason)
      assert.strictEqual(reason.type, 'cursed_by_nekomata')
    })

    it('cursed_by_nekomata does NOT confirm non-werewolf', () => {
      const village = createVillage({
        statuses: [[3, {
          surviving: false,
          causeOfDeath: 'cursed_by_killed_nekomata',
          diedDay: 2,
        }]],
      })
      const reason = findConfirmationReason(village, defaultSetup, 3, 'villager')
      assert.strictEqual(reason, null)
    })

    it('follow_hamster confirms immoralist', () => {
      const setupWithFox = new Map<SystemRole, number>([...defaultSetup, ['werehamster', 1], ['immoralist', 1]])
      const village = createVillage({
        statuses: [[5, {
          surviving: false,
          causeOfDeath: 'follow_executed_hamster',
          diedDay: 3,
        }]],
      })
      const reason = findConfirmationReason(village, setupWithFox, 5, 'immoralist')
      assert.ok(reason)
      assert.strictEqual(reason.type, 'follow_hamster')
    })
  })

  describe('CO analysis', () => {
    it('all_other_cos_busted confirms true seer', () => {
      // Seat 2: seer CO, perspective budget ok
      // Seat 3: seer CO, perspective budget busted (3 seer COs + 1 medium CO = 3 fakes, but only 2 evil)
      // Seat 4: seer CO, perspective budget busted
      const setup = new Map<SystemRole, number>([
        ['villager', 5],
        ['seer', 1],
        ['medium', 1],
        ['werewolf', 2],
      ])
      const village = createVillage({
        playerCount: 9,
        statuses: [
          [2, {
            claiming: true,
            claimingRole: 'seer',
            assertions: new Map([[1, { target: 5, species: 'human' as const }]]),
          }],
          [3, {
            claiming: true,
            claimingRole: 'seer',
            assertions: new Map([
              [1, { target: 6, species: 'wolf' as const }],
              [2, { target: 7, species: 'wolf' as const }],
              [3, { target: 8, species: 'wolf' as const }],
            ]),
          }],
          [4, {
            claiming: true,
            claimingRole: 'seer',
            assertions: new Map([
              [1, { target: 6, species: 'wolf' as const }],
              [2, { target: 7, species: 'wolf' as const }],
              [3, { target: 8, species: 'wolf' as const }],
            ]),
          }],
        ],
        claims: [['seer', [2, 3, 4]]],
      })

      const reason = findConfirmationReason(village, setup, 2, 'seer')
      assert.ok(reason)
      assert.strictEqual(reason.type, 'all_other_cos_busted')
    })
  })

  describe('consensus', () => {
    it('seer_consensus_black confirms werewolf', () => {
      const village = createVillage({
        statuses: [
          [2, {
            claiming: true,
            claimingRole: 'seer',
            assertions: new Map([[1, { target: 5, species: 'wolf' as const }]]),
          }],
        ],
        claims: [['seer', [2]]],
      })
      const reason = findConfirmationReason(village, defaultSetup, 5, 'werewolf')
      assert.ok(reason)
      assert.strictEqual(reason.type, 'seer_consensus_black')
    })

    it('medium_consensus_black confirms werewolf', () => {
      const village = createVillage({
        statuses: [
          [3, {
            claiming: true,
            claimingRole: 'medium',
            assertions: new Map([[1, { target: 6, species: 'wolf' as const }]]),
          }],
          [6, { surviving: false, causeOfDeath: 'execution', diedDay: 2 }],
        ],
        claims: [['medium', [3]]],
      })
      const reason = findConfirmationReason(village, defaultSetup, 6, 'werewolf')
      assert.ok(reason)
      assert.strictEqual(reason.type, 'medium_consensus_black')
    })
  })

  describe('mason partner', () => {
    it('confirms mason via partner assertion', () => {
      const setupWithMason = new Map<SystemRole, number>([...defaultSetup, ['mason', 2]])
      const village = createVillage({
        statuses: [
          [1, {
            claiming: true,
            claimingRole: 'mason',
            assertions: new Map([[-1, { target: 2, species: 'human' as const }]]),
          }],
        ],
        claims: [['mason', [1, 2]]],
      })
      const reason = findConfirmationReason(village, setupWithMason, 2, 'mason')
      assert.ok(reason)
      assert.strictEqual(reason.type, 'mason_partner')
    })
  })

  describe('fox kill', () => {
    it('seer_fox_kill confirms werehamster', () => {
      const setupWithFox = new Map<SystemRole, number>([...defaultSetup, ['werehamster', 1]])
      const village = createVillage({
        statuses: [
          [2, {
            claiming: true,
            claimingRole: 'seer',
            assertions: new Map([[2, { target: 7, species: 'human' as const }]]),
          }],
          [7, { surviving: false, causeOfDeath: 'night_kill', diedDay: 2 }],
          [8, { surviving: false, causeOfDeath: 'night_kill', diedDay: 2 }],
        ],
        kills: [[2, [7, 8]]],
        claims: [['seer', [2]]],
      })
      const reason = findConfirmationReason(village, setupWithFox, 7, 'werehamster')
      assert.ok(reason)
      assert.strictEqual(reason.type, 'seer_fox_kill')
    })
  })

  describe('format', () => {
    it('formats confirmation reason in Japanese', () => {
      const village = createVillage({
        statuses: [[3, {
          surviving: false,
          causeOfDeath: 'cursed_by_killed_nekomata',
          diedDay: 2,
        }]],
      })
      const result = explainConfirmation(village, defaultSetup, 3, 'werewolf')
      assert.match(result, /猫又.*人狼/)
    })

    it('returns わかりません when no confirmation reason found', () => {
      const village = createVillage()
      const result = explainConfirmation(village, defaultSetup, 1, 'villager')
      assert.strictEqual(result, 'わかりません')
    })
  })
})

// ── 新否定理由: confirmed_role_holder_exists ──────────────────────────

describe('gmork denial: confirmed_role_holder_exists', () => {
  it('denies seer CO when another player is confirmed true seer', () => {
    // Seat 2: true seer (only non-busted)
    // Seat 3: busted seer (perspective liar budget exceeded)
    // Seat 4: busted seer (perspective liar budget exceeded)
    // seer_claim_contradictedがより具体的な理由として先に返る
    // confirmed_role_holder_existsは最低優先
    const setup = new Map<SystemRole, number>([
      ['villager', 5],
      ['seer', 1],
      ['medium', 1],
      ['werewolf', 2],
    ])
    const village = createVillage({
      playerCount: 9,
      statuses: [
        [2, {
          claiming: true,
          claimingRole: 'seer',
          assertions: new Map([[1, { target: 5, species: 'human' as const }]]),
        }],
        [3, {
          claiming: true,
          claimingRole: 'seer',
          assertions: new Map([
            [1, { target: 6, species: 'wolf' as const }],
            [2, { target: 7, species: 'wolf' as const }],
            [3, { target: 8, species: 'wolf' as const }],
          ]),
        }],
        [4, {
          claiming: true,
          claimingRole: 'seer',
          assertions: new Map([
            [1, { target: 6, species: 'wolf' as const }],
            [2, { target: 7, species: 'wolf' as const }],
            [3, { target: 8, species: 'wolf' as const }],
          ]),
        }],
      ],
      claims: [['seer', [2, 3, 4]]],
    })

    const possibilities = new Map<number, Set<SystemRole>>()
    for (let i = 1; i <= 9; i++) {
      possibilities.set(i, new Set(['villager', 'seer', 'werewolf', 'medium'] as SystemRole[]))
    }

    const reason = findReason(village, setup, 3, 'seer', possibilities)
    assert.ok(reason)
    assert.strictEqual(reason.type, 'seer_claim_contradicted')
  })

  it('does NOT deny seer when no confirmed holder exists', () => {
    const village = createVillage({
      statuses: [
        [2, {
          claiming: true,
          claimingRole: 'seer',
          assertions: new Map([[1, { target: 5, species: 'human' as const }]]),
        }],
        [3, {
          claiming: true,
          claimingRole: 'seer',
          assertions: new Map([[1, { target: 6, species: 'wolf' as const }]]),
        }],
      ],
      claims: [['seer', [2, 3]]],
    })

    const possibilities = new Map<number, Set<SystemRole>>()
    for (let i = 1; i <= 10; i++) {
      possibilities.set(i, new Set(['villager', 'seer', 'werewolf', 'possessed'] as SystemRole[]))
    }

    const reason = findReason(village, defaultSetup, 3, 'seer', possibilities)
    assert.ok(reason === null || reason.type !== 'confirmed_role_holder_exists')
  })

  it('formats confirmed_role_holder_exists in Japanese', () => {
    const reason = { type: 'confirmed_role_holder_exists' as const, confirmedSeat: 2 as number, confirmedRole: 'seer' as SystemRole }
    const result = formatReason(reason, 'seer')
    assert.match(result, /占い師.*真確定.*ありえない/)
  })
})

// ── deadWerewolfBounds ──────────────────────────────────────────────

describe('deadWerewolfBounds', () => {
  it('ゲーム続行中: 10人生存、人狼3 → 死亡人狼 1〜2', () => {
    const village = createVillage({ playerCount: 13 })  // 全員生存ではなく…
    // 10人生存、3人死亡の状態を作る
    const v = createVillage({
      playerCount: 13,
      statuses: [
        [11, { surviving: false, causeOfDeath: 'execution', diedDay: 1 }],
        [12, { surviving: false, causeOfDeath: 'night_kill', diedDay: 1 }],
        [13, { surviving: false, causeOfDeath: 'execution', diedDay: 2 }],
      ],
    })
    const setup = new Map<SystemRole, number>([['werewolf', 3], ['villager', 10]])
    const bounds = deadWerewolfBounds(v, setup)
    assert.ok(bounds)
    // 10人生存: maxAlive = min(3, floor(9/2)) = 4 → 3, minAlive = 1
    // 死亡: min = 3 - 3 = 0... wait
    // Actually: 10 alive, floor((10-1)/2) = 4, min(3,4) = 3
    // So maxAlive = 3, minAlive = 1
    // deadMin = 3 - 3 = 0, deadMax = 3 - 1 = 2
    assert.strictEqual(bounds.min, 0)
    assert.strictEqual(bounds.max, 2)
  })

  it('ゲーム続行中: 4人生存、人狼3 → 死亡人狼 2〜2', () => {
    const v = createVillage({
      playerCount: 14,
      statuses: Array.from({ length: 10 }, (_, i) => [i + 5, {
        surviving: false, causeOfDeath: 'execution' as const, diedDay: 1,
      }] as [number, Partial<SeatStatus>]),
    })
    const setup = new Map<SystemRole, number>([['werewolf', 3], ['villager', 11]])
    const bounds = deadWerewolfBounds(v, setup)
    assert.ok(bounds)
    // 4人生存: maxAlive = min(3, floor(3/2)) = 1, minAlive = 1
    // deadMin = 3 - 1 = 2, deadMax = 3 - 1 = 2
    assert.strictEqual(bounds.min, 2)
    assert.strictEqual(bounds.max, 2)
  })

  it('村勝利: 人狼3 → 死亡人狼 3〜3', () => {
    const v = createVillage({ playerCount: 10, result: 'villager_won', finished: true })
    const setup = new Map<SystemRole, number>([['werewolf', 3], ['villager', 7]])
    const bounds = deadWerewolfBounds(v, setup)
    assert.ok(bounds)
    assert.strictEqual(bounds.min, 3)
    assert.strictEqual(bounds.max, 3)
  })

  it('狐勝利: 人狼全滅', () => {
    const v = createVillage({ playerCount: 10, result: 'werehamster_won', finished: true })
    const setup = new Map<SystemRole, number>([['werewolf', 2], ['villager', 7], ['werehamster', 1]])
    const bounds = deadWerewolfBounds(v, setup)
    assert.ok(bounds)
    assert.strictEqual(bounds.min, 2)
    assert.strictEqual(bounds.max, 2)
  })

  it('狼勝利: 6人生存、人狼3 → 死亡人狼 0〜0', () => {
    const v = createVillage({ playerCount: 10, result: 'werewolf_won', finished: true,
      statuses: Array.from({ length: 4 }, (_, i) => [i + 7, {
        surviving: false, causeOfDeath: 'execution' as const, diedDay: 1,
      }] as [number, Partial<SeatStatus>]),
    })
    const setup = new Map<SystemRole, number>([['werewolf', 3], ['villager', 7]])
    const bounds = deadWerewolfBounds(v, setup)
    assert.ok(bounds)
    // 6人生存, 狼勝利: minAlive = ceil(6/2) = 3, maxAlive = min(3,6) = 3
    // dead: min = 0, max = 0
    assert.strictEqual(bounds.min, 0)
    assert.strictEqual(bounds.max, 0)
  })

  it('ゲーム続行中: 4人生存、人狼3、狐1死亡確認 → 非狐生存者4人で計算', () => {
    // 狐が死亡確認済み（後追いあり）→ 生存者から狐を除外しない
    const v = createVillage({
      playerCount: 14,
      statuses: [
        ...Array.from({ length: 9 }, (_, i) => [i + 5, {
          surviving: false, causeOfDeath: 'execution' as const, diedDay: 1,
        }] as [number, Partial<SeatStatus>]),
        [14, { surviving: false, causeOfDeath: 'follow_killed_hamster' as const, diedDay: 2 }],
      ],
    })
    const setup = new Map<SystemRole, number>([['werewolf', 3], ['villager', 9], ['werehamster', 1], ['immoralist', 1]])
    const bounds = deadWerewolfBounds(v, setup)
    assert.ok(bounds)
    // 4人生存、狐1死亡確認 → maxAliveHamsters = 0 → nonHamsterAlive = 4
    // maxAlive = min(3, floor(3.9/2)) = 1
    assert.strictEqual(bounds.min, 2)
    assert.strictEqual(bounds.max, 2)
  })

  it('ゲーム続行中: 4人生存、人狼3、狐1生存の可能性 → 非狐生存者3人で計算', () => {
    // 狐がまだ生存している可能性がある（後追いなし）
    const v = createVillage({
      playerCount: 14,
      statuses: Array.from({ length: 10 }, (_, i) => [i + 5, {
        surviving: false, causeOfDeath: 'execution' as const, diedDay: 1,
      }] as [number, Partial<SeatStatus>]),
    })
    const setup = new Map<SystemRole, number>([['werewolf', 3], ['villager', 9], ['werehamster', 1], ['immoralist', 1]])
    const bounds = deadWerewolfBounds(v, setup)
    assert.ok(bounds)
    // 4人生存、狐が生存している可能性 → maxAliveHamsters = 1 → nonHamsterAlive = 3
    // maxAlive = min(3, floor(2.9/2)) = 1
    assert.strictEqual(bounds.min, 2)
    assert.strictEqual(bounds.max, 2)
  })

  it('人狼0の配役 → null', () => {
    const v = createVillage({ playerCount: 5 })
    const setup = new Map<SystemRole, number>([['villager', 5]])
    assert.strictEqual(deadWerewolfBounds(v, setup), null)
  })
})
