import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../types/index.ts'
import { Possibilities, RoleSignatureBits } from '../../retar/possibilities.ts'
import { createSimState } from '../simulator/world-state.ts'
import { Determinizer } from './determinize.ts'
import { DummyNN } from './nn.ts'
import { runMCTS, outcomeToMasonValue, DEFAULT_MCTS_CONFIG } from './ismcts.ts'

/** seed 化された xorshift32 PRNG（テスト再現性のため） */
function seededRng(seed: number): () => number {
  let x = seed | 0
  if (x === 0) x = 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return ((x >>> 0) % 0x100000000) / 0x100000000
  }
}

function aliveOf(seats: number[]): number {
  let mask = 0
  for (const s of seats) mask |= (1 << s)
  return mask
}

function makePossibilitiesAllOpen(
  setup: Map<SystemRole, number>,
  seatCount: number,
  roleMask: number,
): Possibilities {
  const poss = new Possibilities(setup)
  for (let s = 1; s <= seatCount; s++) poss.possibilities[s] = roleMask
  return poss
}

describe('outcomeToMasonValue', () => {
  it('村勝 +1, 狼勝 -1, 狐勝 -1.3, ongoing 0', () => {
    assert.equal(outcomeToMasonValue('village_win'), 1.0)
    assert.equal(outcomeToMasonValue('wolf_win'), -1.0)
    assert.equal(outcomeToMasonValue('hamster_win'), -1.3)
    assert.equal(outcomeToMasonValue('ongoing'), 0)
    assert.equal(outcomeToMasonValue(null), 0)
  })
})

describe('Determinizer', () => {
  it('5人 setup で全 world 列挙、sample が世界に含まれる', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 3], ['mason', 1], ['werewolf', 1],
    ])
    const roleMask = RoleSignatureBits.villager | RoleSignatureBits.mason | RoleSignatureBits.werewolf
    const poss = makePossibilitiesAllOpen(setup, 5, roleMask)
    const det = new Determinizer(poss, setup)
    assert.ok(det.size() > 0, 'world が列挙されている')
    assert.ok(!det.isOverflow(), 'overflow ではない')
    const w = det.sample(seededRng(42))
    assert.ok(w !== null, 'sample は世界を返す')
    // mason 1 + wolf 1 + villager 3 の総数チェック
    const wolfCount = w!.roleIds.reduce((sum, id) => sum + (id === 6 ? 1 : 0), 0)
    assert.equal(wolfCount, 1, '狼ちょうど 1')
  })
})

describe('DummyNN', () => {
  it('uniform policy + value 0、合法 action のみ', () => {
    const nn = new DummyNN()
    const state = createSimState({} as any, aliveOf([1, 2, 3, 4, 5]))
    const out = nn.forward(state, 2)
    assert.equal(out.value, 0)
    assert.equal(out.policy.size, 4, 'mason 自席を除いた 4 候補')
    let sum = 0
    for (const p of out.policy.values()) sum += p
    assert.ok(Math.abs(sum - 1) < 1e-9, 'probability sum = 1')
    assert.ok(!out.policy.has(2), 'mason 自席は含まない')
  })
})

describe('runMCTS: 基本動作', () => {
  it('5人 setup で 100 rollouts、visits 合計 ~99 (root 自身の expansion 1 を除く)', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 3], ['mason', 1], ['werewolf', 1],
    ])
    const roleMask = RoleSignatureBits.villager | RoleSignatureBits.mason | RoleSignatureBits.werewolf
    const poss = makePossibilitiesAllOpen(setup, 5, roleMask)
    const det = new Determinizer(poss, setup)
    const nn = new DummyNN()
    // mason 席を seat 1 と仮定した root infoState（world は仮置き、Determinizer で上書き）
    const dummyWorld = det.sample(seededRng(1))!
    const root = createSimState(dummyWorld, aliveOf([1, 2, 3, 4, 5]))
    const result = runMCTS(root, 1, det, nn, {
      cPuct: 1.5, nRollouts: 100, rng: seededRng(123),
    })

    let visitSum = 0
    for (const v of result.visits.values()) visitSum += v
    // 初回 rollout は root expansion で path=[]、後続 99 が root.edge を 1 ずつ更新
    assert.equal(visitSum, 99, 'root child visits = nRollouts - 1')
    assert.equal(result.abortReason, null)
  })

  it('400 rollouts のレイテンシ < 100ms (M2 acceptance)', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 5], ['seer', 1], ['medium', 1], ['bodyguard', 1],
      ['mason', 2], ['nekomata', 1], ['werewolf', 2], ['werehamster', 1],
    ])
    const roleMask = Object.values(RoleSignatureBits).reduce((a, b) => a | b, 0)
    const poss = makePossibilitiesAllOpen(setup, 14, roleMask)
    // mason 1 席は確定
    poss.possibilities[1] = RoleSignatureBits.mason
    const det = new Determinizer(poss, setup, 100000)
    if (det.isOverflow()) {
      // 14 席 full open は overflow するので、もう少し制約を入れる
      // mason 2席を確定、wolf 2席を確定
      const poss2 = makePossibilitiesAllOpen(setup, 14, roleMask)
      poss2.possibilities[1] = RoleSignatureBits.mason
      poss2.possibilities[2] = RoleSignatureBits.mason
      poss2.possibilities[3] = RoleSignatureBits.werewolf
      poss2.possibilities[4] = RoleSignatureBits.werewolf
      const det2 = new Determinizer(poss2, setup, 100000)
      assert.ok(!det2.isOverflow(), `world 数: ${det2.size()}`)
      runLatencyCheck(setup, det2)
    } else {
      runLatencyCheck(setup, det)
    }
  })

  it('mason 自席は visit に含まれない (合法 action のみ)', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 3], ['mason', 1], ['werewolf', 1],
    ])
    const roleMask = RoleSignatureBits.villager | RoleSignatureBits.mason | RoleSignatureBits.werewolf
    const poss = makePossibilitiesAllOpen(setup, 5, roleMask)
    const det = new Determinizer(poss, setup)
    const nn = new DummyNN()
    const dummyWorld = det.sample(seededRng(1))!
    const root = createSimState(dummyWorld, aliveOf([1, 2, 3, 4, 5]))
    const masonSeat = 3
    const result = runMCTS(root, masonSeat, det, nn, {
      cPuct: 1.5, nRollouts: 200, rng: seededRng(456),
    })
    assert.ok(!result.visits.has(masonSeat), `mason 自席 ${masonSeat} は action にない`)
    for (const action of result.visits.keys()) {
      assert.ok(action !== masonSeat, 'visits は mason 自席を含まない')
      assert.ok(action >= 1 && action <= 5, `action ${action} は alive 範囲内`)
    }
  })

  it('seed 同じなら visit 分布も同じ（決定論性）', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 3], ['mason', 1], ['werewolf', 1],
    ])
    const roleMask = RoleSignatureBits.villager | RoleSignatureBits.mason | RoleSignatureBits.werewolf
    const poss = makePossibilitiesAllOpen(setup, 5, roleMask)
    const det = new Determinizer(poss, setup)
    const nn = new DummyNN()
    const dummyWorld = det.sample(seededRng(1))!
    const root = createSimState(dummyWorld, aliveOf([1, 2, 3, 4, 5]))

    const r1 = runMCTS(root, 1, det, nn, { cPuct: 1.5, nRollouts: 200, rng: seededRng(789) })
    const r2 = runMCTS(root, 1, det, nn, { cPuct: 1.5, nRollouts: 200, rng: seededRng(789) })

    assert.deepEqual(
      [...r1.visits.entries()].sort(),
      [...r2.visits.entries()].sort(),
      '同 seed → 同 visit 分布',
    )
  })

  it('初日 mason の vote: 神視点 simulator なので village_win 期待 → action は均等近く分散', () => {
    // 5 人 1 狼: dummy NN は uniform、UCB 探索でほぼ均等に visit
    const setup = new Map<SystemRole, number>([
      ['villager', 3], ['mason', 1], ['werewolf', 1],
    ])
    const roleMask = RoleSignatureBits.villager | RoleSignatureBits.mason | RoleSignatureBits.werewolf
    const poss = makePossibilitiesAllOpen(setup, 5, roleMask)
    const det = new Determinizer(poss, setup)
    const nn = new DummyNN()
    const dummyWorld = det.sample(seededRng(1))!
    const root = createSimState(dummyWorld, aliveOf([1, 2, 3, 4, 5]))

    const result = runMCTS(root, 1, det, nn, {
      cPuct: 1.5, nRollouts: 400, rng: seededRng(2024),
    })
    // 4 candidates、合計 visit ~399
    let sum = 0
    let maxV = 0
    let minV = Infinity
    for (const v of result.visits.values()) {
      sum += v
      if (v > maxV) maxV = v
      if (v < minV) minV = v
    }
    assert.equal(result.visits.size, 4)
    assert.equal(sum, 399, 'sum = nRollouts - 1')
    // value=0 の dummy NN では UCB 探索項のみで均等寄り
    // 期待 ~100/action、極端な偏りがないこと
    assert.ok(maxV - minV < 200, `分散が極端ではない (max-min=${maxV - minV})`)
  })
})

function runLatencyCheck(_setup: Map<SystemRole, number>, det: Determinizer): void {
  const nn = new DummyNN()
  const dummyWorld = det.sample(seededRng(1))!
  // 14 席フル生存
  let alive = 0
  for (let s = 1; s <= 14; s++) alive |= (1 << s)
  const root = createSimState(dummyWorld, alive)

  // 1 回ウォームアップ
  runMCTS(root, 1, det, nn, { ...DEFAULT_MCTS_CONFIG, rng: seededRng(1) })

  const t0 = Date.now()
  runMCTS(root, 1, det, nn, { ...DEFAULT_MCTS_CONFIG, rng: seededRng(2) })
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 100, `400 rollouts は <100ms (実測 ${elapsed}ms)`)
}
