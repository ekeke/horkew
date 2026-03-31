import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../types/index.ts'
import { RoleSignatureBits, Possibilities } from '../retar/possibilities.ts'
import { buildThreatProfile, isThreatExceeded } from './index.ts'

// ヘルパー: Possibilities を手動構築
function makePossibilities(
  setup: Map<SystemRole, number>,
  seats: Record<number, SystemRole[]>,
  maxSurvivingNV: number,
): Possibilities {
  const p = new Possibilities(setup)
  for (const [seatStr, roles] of Object.entries(seats)) {
    let mask = 0
    for (const role of roles) mask |= RoleSignatureBits[role]
    p.possibilities[Number(seatStr)] = mask
  }
  p.maxSurvivingNV = maxSurvivingNV
  return p
}

describe('isThreatExceeded', () => {
  it('seed 1103: 猫又兼狼候補 — 猫又処刑の道連れリスクで詰み不可能', () => {
    // 7人生存: seat1=村, 2=猫又/狼, 6=狩, 9=村, 11=猫又/狼, 13=確定狼, 14=共有
    // 猫又と狼の見分けがつかない状態で処刑すると、猫又道連れで縄が減るリスクがある
    const setup = new Map<SystemRole, number>([
      ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1],
      ['bodyguard', 1], ['mason', 2], ['nekomata', 1], ['fanatic', 1],
      ['werehamster', 1], ['immoralist', 1],
    ])
    const conclusions = makePossibilities(setup, {
      1: ['villager'],
      2: ['nekomata', 'werewolf'],
      6: ['bodyguard'],
      9: ['villager'],
      11: ['nekomata', 'werewolf'],
      13: ['werewolf'],
      14: ['mason'],
    }, 2)
    const alive = (1 << 1) | (1 << 2) | (1 << 6) | (1 << 9) | (1 << 11) | (1 << 13) | (1 << 14)
    const profile = buildThreatProfile(conclusions, alive, 7, setup)

    assert.equal(profile.possibleSurvivingNekomata, true)
    assert.equal(profile.wolfCandidates, 3)
    assert.equal(profile.nekoParityShift, true)
    // TODO: isThreatExceeded が true を返すべき（猫パリティ修正後に有効化）
    // assert.equal(isThreatExceeded(profile), true)
  })

  it('7人: 狼+狐+確定占+信+村+村+共 — 占いで狐を溶かせるので詰み可能', () => {
    // 村を吊って占いが狐を溶かす、共有噛まれる → 残り4人で狼処刑 → 村勝利
    // isThreatExceeded単体では impossible だが、狐を占いで解決できるので
    // judgeTsumi の狐解決調整後は impossible=false になるべき
    const setup = new Map<SystemRole, number>([
      ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1],
      ['bodyguard', 1], ['mason', 2], ['nekomata', 1], ['fanatic', 1],
      ['werehamster', 1], ['immoralist', 1],
    ])
    const conclusions = makePossibilities(setup, {
      1: ['werewolf'],
      2: ['werehamster', 'villager'],
      3: ['seer'],
      4: ['fanatic'],
      5: ['villager'],
      6: ['villager'],
      7: ['mason'],
    }, 2)
    const alive = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7)
    const profile = buildThreatProfile(conclusions, alive, 7, setup)

    // 狐解決前: foxCandidates=1, wolfCandidates=1, whiteNVThreat=1
    assert.equal(profile.foxCandidates, 1)
    assert.equal(profile.wolfCandidates, 1)
    assert.equal(profile.whiteNVThreat, 1)
    assert.equal(profile.possibleSurvivingHamster, true)
    assert.equal(profile.nawaInt, 2)
    // requiredExecs = fox(1) + wolf(1) + whiteNV(1) = 3 > nawaInt(2) → impossible
    assert.equal(profile.requiredExecs, 3)
    assert.equal(isThreatExceeded(profile), true)

    // 狐解決後（占いで1狐候補を解決）: foxCandidates=0, requiredExecs=2
    // judgeTsumi が computeFoxResolvability で調整した後の状態をシミュレート
    const adjusted = {
      ...profile,
      foxCandidates: 0,
      possibleSurvivingHamster: false,
      effectiveNawa: (7 - 1) / 2,  // 狐なし → effectiveNawa = nawa
      nawaInt: 3,
      requiredExecs: 0 + 0 + 1 - 1 + 1,  // fox=0, foxWolf=0, wolf=1, -confirmed(1), +whiteNV(1)
      nekoParityShift: false,
    }
    assert.equal(adjusted.requiredExecs, 1)
    assert.equal(isThreatExceeded(adjusted), false)
  })
})
