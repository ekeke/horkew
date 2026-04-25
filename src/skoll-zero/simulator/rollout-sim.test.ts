import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../types/index.ts'
import type { World } from '../../hati/types.ts'
import { RoleBitIndex } from '../../retar/possibilities.ts'
import { createSimState } from './world-state.ts'
import {
  stepPhase, advancePhase, shouldSkipPhase,
  legalExecuteActions, legalAttackActions, legalDivineActions, legalGuardActions,
  legalClaimTrueActions, legalClaimFakeActions, legalMorningActions,
} from './rollout-sim.ts'

/** テスト用 world 構築ヘルパー */
function makeWorld(assignments: Record<number, SystemRole>): World {
  const maxSeat = Math.max(...Object.keys(assignments).map(Number))
  const roles: SystemRole[] = new Array(maxSeat + 1)
  const roleIds = new Uint8Array(maxSeat + 1)
  let wolfMask = 0
  let hamsterMask = 0
  let immoralistMask = 0
  let seerMask = 0
  let mediumMask = 0
  let nekomataMask = 0
  let bodyguardSeat = -1

  for (const [seatStr, role] of Object.entries(assignments)) {
    const seat = Number(seatStr)
    roles[seat] = role
    roleIds[seat] = RoleBitIndex[role]
    switch (role) {
      case 'werewolf': wolfMask |= (1 << seat); break
      case 'werehamster': hamsterMask |= (1 << seat); break
      case 'immoralist': immoralistMask |= (1 << seat); break
      case 'seer': seerMask |= (1 << seat); break
      case 'medium': mediumMask |= (1 << seat); break
      case 'nekomata': nekomataMask |= (1 << seat); break
      case 'bodyguard': bodyguardSeat = seat; break
    }
  }

  return {
    roles, roleIds, wolfMask, hamsterMask, immoralistMask,
    seerMask, mediumMask, nekomataMask, bodyguardSeat,
  }
}

function aliveOf(seats: number[]): number {
  let mask = 0
  for (const s of seats) mask |= (1 << s)
  return mask
}

describe('shouldSkipPhase', () => {
  it('morning は偽 seer CO 不在で skip', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'morning')
    assert.equal(shouldSkipPhase(state), true)
  })

  it('morning は偽 seer CO 1 件以上で skip しない', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'morning')
    state.claims.set(2, { role: 'seer', isFake: true })
    assert.equal(shouldSkipPhase(state), false)
  })

  it('claim_seer_true は真 seer 不在で skip', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'medium' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'claim_seer_true')
    assert.equal(shouldSkipPhase(state), true)
  })

  it('claim_seer_true は真 seer 既 CO 済で skip', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'claim_seer_true')
    state.claims.set(1, { role: 'seer', isFake: false })
    assert.equal(shouldSkipPhase(state), true)
  })

  it('claim_seer_fake は既偽 seer CO 有で skip', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'claim_seer_fake')
    state.claims.set(2, { role: 'seer', isFake: true })
    assert.equal(shouldSkipPhase(state), true)
  })

  it('claim_seer_fake は wolf/fanatic 全滅で skip', () => {
    const world = makeWorld({ 1: 'seer', 2: 'villager' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'claim_seer_fake')
    assert.equal(shouldSkipPhase(state), true)
  })

  it('night_divine は真 seer 全滅で skip', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'night_divine')
    assert.equal(shouldSkipPhase(state), true)
  })

  it('day は skip しない', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'day')
    assert.equal(shouldSkipPhase(state), false)
  })

  it('night_guard は skip しない (bg 不在でも phase 通過)', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'night_guard')
    assert.equal(shouldSkipPhase(state), false)
  })
})

describe('advancePhase: skip 連鎖', () => {
  it('役職全不在世界で morning から day までスキップ', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'morning')
    advancePhase(state)
    // 真役職不在 + 偽 seer CO 不在 → claim_seer_fake で skip しない (wolf 生存)
    assert.equal(state.phase, 'claim_seer_fake')
  })

  it('真 seer 不在 + wolf 不在で morning から day までスキップ', () => {
    const world = makeWorld({ 1: 'villager', 2: 'villager', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'morning')
    advancePhase(state)
    assert.equal(state.phase, 'day')
  })
})

describe('stepPhase: claim 状態の累積', () => {
  it('claim_seer_true で willClaim:true で claims に真 seer エントリ追加', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'claim_seer_true')
    stepPhase(state, { type: 'claim_true', willClaim: true })
    assert.equal(state.claims.get(1)?.role, 'seer')
    assert.equal(state.claims.get(1)?.isFake, false)
  })

  it('claim_seer_true で willClaim:false なら claims は変更されない', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'claim_seer_true')
    stepPhase(state, { type: 'claim_true', willClaim: false })
    assert.equal(state.claims.size, 0)
  })

  it('claim_seer_fake で willClaim:true で偽 seer エントリ追加', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'claim_seer_fake')
    stepPhase(state, { type: 'claim_fake', willClaim: true, claimerSeat: 2 })
    assert.equal(state.claims.get(2)?.role, 'seer')
    assert.equal(state.claims.get(2)?.isFake, true)
  })
})

describe('stepPhase: morning fake report', () => {
  it('reports が fakeDivineHistory に day と共に積まれる', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 3, 'morning')
    state.claims.set(2, { role: 'seer', isFake: true })
    stepPhase(state, {
      type: 'morning',
      reports: [{ seerSeat: 2, target: 1, color: 'human' }],
    })
    const history = state.fakeDivineHistory.get(2)
    assert.deepEqual(history, [{ day: 3, target: 1, color: 'human' }])
  })

  it('複数の reports が同 seat の履歴に追記される (連日)', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 2, 'morning')
    state.claims.set(2, { role: 'seer', isFake: true })
    state.fakeDivineHistory.set(2, [{ day: 1, target: 3, color: 'wolf' }])
    stepPhase(state, {
      type: 'morning',
      reports: [{ seerSeat: 2, target: 1, color: 'human' }],
    })
    const history = state.fakeDivineHistory.get(2)
    assert.equal(history?.length, 2)
    assert.equal(history?.[1].day, 2)
  })
})

describe('stepPhase: day で outcome 判定', () => {
  it('狼処刑で village_win → terminal', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'day')
    stepPhase(state, { type: 'execute', target: 2 })
    assert.equal(state.phase, 'terminal')
    assert.equal(state.outcome, 'village_win')
  })

  it('村人処刑で ongoing → night_attack へ前進', () => {
    const world = makeWorld({
      1: 'villager', 2: 'seer', 3: 'werewolf', 4: 'werewolf', 5: 'villager', 6: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4, 5, 6]), 1, 'day')
    stepPhase(state, { type: 'execute', target: 1 })
    assert.equal(state.phase, 'night_attack')
    assert.ok(!(state.alive & (1 << 1)), 'seat1 退場')
  })

  it('executedSeat=-1 で処刑スキップ、ongoing なら night_attack へ', () => {
    const world = makeWorld({
      1: 'villager', 2: 'seer', 3: 'werewolf', 4: 'werewolf', 5: 'villager', 6: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4, 5, 6]), 1, 'day')
    stepPhase(state, { type: 'execute', target: -1 })
    assert.equal(state.phase, 'night_attack')
    assert.equal(state.alive, aliveOf([1, 2, 3, 4, 5, 6]))
  })
})

describe('stepPhase: 夜の pending 蓄積と night_guard 一括解決', () => {
  it('night_attack で pendingAttack に保存、attack 中は outcome 判定しない', () => {
    const world = makeWorld({
      1: 'villager', 2: 'seer', 3: 'werewolf', 4: 'werewolf', 5: 'villager', 6: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4, 5, 6]), 1, 'night_attack')
    stepPhase(state, { type: 'attack', target: 1 })
    // pendingAttack に保存され、alive はまだ変わらない
    assert.equal(state.pendingAttack, 1)
    assert.equal(state.alive, aliveOf([1, 2, 3, 4, 5, 6]))
    assert.notEqual(state.phase, 'terminal')
  })

  it('night_divine で pendingDivineTargets に追加', () => {
    const world = makeWorld({
      1: 'villager', 2: 'seer', 3: 'werewolf', 4: 'werewolf', 5: 'villager', 6: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4, 5, 6]), 1, 'night_divine')
    stepPhase(state, { type: 'divine', target: 3 })
    assert.deepEqual(state.pendingDivineTargets, [3])
  })

  it('night_guard で simulateNight 一括実行 + 翌 day の morning へ', () => {
    const world = makeWorld({
      1: 'bodyguard', 2: 'seer', 3: 'werewolf', 4: 'werewolf', 5: 'villager', 6: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4, 5, 6]), 1, 'night_attack')
    // pending を順に積む
    stepPhase(state, { type: 'attack', target: 5 })
    stepPhase(state, { type: 'divine', target: 3 })
    stepPhase(state, { type: 'guard', target: 5 })
    // 護衛成功で seat5 生存、占いで wolf 結果 (state には反映なし)
    assert.ok(state.alive & (1 << 5), 'seat5 護衛成功で生存')
    assert.equal(state.day, 2)
    // pending クリア
    assert.equal(state.pendingAttack, null)
    assert.equal(state.pendingGuard, null)
    assert.deepEqual(state.pendingDivineTargets, [])
  })

  it('night_guard で襲撃成功 → alive 減 + outcome 判定', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'night_attack')
    stepPhase(state, { type: 'attack', target: 1 })
    stepPhase(state, { type: 'guard', target: -1 })
    // night_divine は seer 不在で skip された後、guard 解決 → seat1 退場 → wolf 1 vs villager 1 → wolf_win
    assert.equal(state.phase, 'terminal')
    assert.equal(state.outcome, 'wolf_win')
  })

  it('真 seer 占いで狐呪殺', () => {
    const world = makeWorld({
      1: 'seer', 2: 'werehamster', 3: 'werewolf', 4: 'werewolf', 5: 'villager', 6: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4, 5, 6]), 1, 'night_attack')
    stepPhase(state, { type: 'attack', target: 5 })
    stepPhase(state, { type: 'divine', target: 2 })
    stepPhase(state, { type: 'guard', target: -1 })
    // 狐呪殺 + seat5 襲撃 → alive [1, 3, 4, 6]
    assert.ok(!(state.alive & (1 << 2)), '狐呪殺で seat2 退場')
    assert.ok(!(state.alive & (1 << 5)), 'seat5 襲撃で退場')
  })
})

describe('stepPhase: terminal は no-op', () => {
  it('terminal state は mutate されない', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'terminal')
    state.outcome = 'village_win'
    const beforeAlive = state.alive
    stepPhase(state, { type: 'execute', target: 1 })
    assert.equal(state.phase, 'terminal')
    assert.equal(state.alive, beforeAlive)
  })
})

describe('legalExecuteActions', () => {
  it('生存席数の execute action を返す', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'day')
    const actions = legalExecuteActions(state)
    assert.equal(actions.length, 3)
    const targets = actions.map(a => a.type === 'execute' ? a.target : -99)
    assert.deepEqual(targets.sort((a, b) => a - b), [1, 2, 3])
  })
})

describe('legalAttackActions', () => {
  it('LW 状態で猫又を除外', () => {
    const world = makeWorld({
      1: 'villager', 2: 'werewolf', 3: 'nekomata', 4: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4]), 1, 'night_attack')
    const actions = legalAttackActions(state)
    const targets = actions.map(a => a.type === 'attack' ? a.target : -99).sort((a, b) => a - b)
    assert.deepEqual(targets, [1, 4]) // 猫又 (seat 3) 除外
  })

  it('狼 2 匹なら猫又も噛める', () => {
    const world = makeWorld({
      1: 'villager', 2: 'werewolf', 3: 'nekomata', 4: 'werewolf',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4]), 1, 'night_attack')
    const actions = legalAttackActions(state)
    const targets = actions.map(a => a.type === 'attack' ? a.target : -99).sort((a, b) => a - b)
    assert.deepEqual(targets, [1, 3])
  })

  it('狼全滅で空配列', () => {
    const world = makeWorld({ 1: 'villager', 2: 'villager' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'night_attack')
    assert.equal(legalAttackActions(state).length, 0)
  })
})

describe('legalDivineActions', () => {
  it('真 seer 生存で全 alive 席が候補', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'night_divine')
    const actions = legalDivineActions(state)
    assert.equal(actions.length, 3)
  })

  it('真 seer 不在で空配列', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'night_divine')
    assert.equal(legalDivineActions(state).length, 0)
  })
})

describe('legalGuardActions', () => {
  it('真 bg 生存で他席 + 無護衛 (-1)', () => {
    const world = makeWorld({
      1: 'bodyguard', 2: 'werewolf', 3: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'night_guard')
    const actions = legalGuardActions(state)
    const targets = actions.map(a => a.type === 'guard' ? a.target : -99).sort((a, b) => a - b)
    assert.deepEqual(targets, [-1, 2, 3]) // 自分 (seat 1) 除外
  })

  it('bg 不在で無護衛 (-1) のみ', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'night_guard')
    const actions = legalGuardActions(state)
    assert.equal(actions.length, 1)
    assert.equal(actions[0].type === 'guard' && actions[0].target, -1)
  })
})

describe('legalClaimTrueActions', () => {
  it('真 seer 生存・未 CO で 2 択', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'claim_seer_true')
    const actions = legalClaimTrueActions(state)
    assert.equal(actions.length, 2)
  })

  it('真 seer 既 CO 済で空配列 (skip 条件)', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'claim_seer_true')
    state.claims.set(1, { role: 'seer', isFake: false })
    assert.equal(legalClaimTrueActions(state).length, 0)
  })
})

describe('legalClaimFakeActions', () => {
  it('生存 wolf 数 + 1 (skip) の長さ、既 CO 済を除外', () => {
    const world = makeWorld({
      1: 'seer', 2: 'werewolf', 3: 'werewolf', 4: 'fanatic', 5: 'villager',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4, 5]), 1, 'claim_seer_fake')
    const actions = legalClaimFakeActions(state)
    // skip 1 + (wolf 2 + fanatic 1) = 4
    assert.equal(actions.length, 4)
    // skip が含まれる
    const hasSkip = actions.some(a => a.type === 'claim_fake' && a.willClaim === false)
    assert.ok(hasSkip)
  })

  it('既 CO 済の wolf は除外される', () => {
    const world = makeWorld({
      1: 'seer', 2: 'werewolf', 3: 'werewolf', 4: 'villager',
    })
    // medium 偽 CO 済の wolf が seer fake CO の候補から外れることを確認
    const state = createSimState(world, aliveOf([1, 2, 3, 4]), 1, 'claim_seer_fake')
    state.claims.set(2, { role: 'medium', isFake: true })
    const actions = legalClaimFakeActions(state)
    // skip 1 + wolf seat 3 のみ = 2
    assert.equal(actions.length, 2)
  })

  it('既偽 seer CO 有なら skip 条件で空配列', () => {
    const world = makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 1, 'claim_seer_fake')
    state.claims.set(2, { role: 'seer', isFake: true })
    assert.equal(legalClaimFakeActions(state).length, 0)
  })
})

describe('legalMorningActions', () => {
  it('偽 seer 1 人で alive × color の組合せ', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]), 2, 'morning')
    state.claims.set(2, { role: 'seer', isFake: true })
    const actions = legalMorningActions(state)
    // alive 3 × color 2 = 6
    assert.equal(actions.length, 6)
  })

  it('偽 seer 0 人で空配列', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'morning')
    assert.equal(legalMorningActions(state).length, 0)
  })

  it('偽 seer 2 人で cartesian product (28 × 28 = 784 が出ないよう小さい alive で確認)', () => {
    const world = makeWorld({ 1: 'werewolf', 2: 'fanatic' })
    const state = createSimState(world, aliveOf([1, 2]), 1, 'morning')
    state.claims.set(1, { role: 'seer', isFake: true })
    state.claims.set(2, { role: 'seer', isFake: true })
    const actions = legalMorningActions(state)
    // (alive 2 × color 2)^2 = 16
    assert.equal(actions.length, 16)
    // 各 action は reports 配列が 2 件
    for (const a of actions) {
      assert.equal(a.type === 'morning' && a.reports.length, 2)
    }
  })
})
