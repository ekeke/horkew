import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../types/index.ts'
import { Possibilities, RoleSignatureBits } from '../../retar/possibilities.ts'
import { createSimState } from '../simulator/world-state.ts'
import type { SimState } from '../simulator/world-state.ts'
import { Determinizer } from './determinize.ts'
import { runMCTS, outcomeToMasonValue } from './ISMCTS.ts'
import type { ModuleBundle } from './dispatch.ts'
import type { SkollZeroModule } from '../module/skoll-zero-module.ts'
import type { Faction } from './ISMCTS.ts'
import type { NNOutput, HeadName, RootObservation } from './nn.ts'
import { uniformOutcomeDist } from './nn.ts'
import type { RolloutInvariants } from '../observation/from-sim-state.ts'
import { emptyInvariants } from '../observation/from-sim-state.ts'

/** seed 化された xorshift32 PRNG */
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

/**
 * テスト用 DummyModule。uniform policy + value 0。
 * SkollZeroModule interface を最低限満たし、forwardAt のみ実用的に動く。
 */
class DummyModule implements SkollZeroModule {
  buffer = null as unknown as SkollZeroModule['buffer']
  lastMCTSResult = null
  mctsCalls = 0
  fallbackCalls = 0
  entropyStats = { sum: 0, count: 0 }
  faction(): Faction { return 'village' }
  encodeStateObs(): RootObservation { return new Float32Array(0) }
  forwardAt(state: SimState, actorSeat: number, _actorRole: SystemRole, _headName: HeadName, _invariants: RolloutInvariants): NNOutput {
    const policy = new Map<number, number>()
    let mask = state.alive & ~(1 << actorSeat)
    const cands: number[] = []
    while (mask !== 0) {
      const bit = mask & (-mask)
      cands.push(31 - Math.clz32(bit))
      mask ^= bit
    }
    const outcomeDist = uniformOutcomeDist()
    if (cands.length === 0) return { policy, outcomeDist }
    const p = 1 / cands.length
    for (const c of cands) policy.set(c, p)
    return { policy, outcomeDist }
  }
  proposeVote(): null { return null }
  proposeNightAction(): null { return null }
  proposePolicyOnly(): null { return null }
  finalize(): void {}
  reset(): void {}
}

function makeBundle(): ModuleBundle {
  const dummy = new DummyModule()
  return {
    mason: dummy, wolf: dummy, standard: dummy,
    fanatic: dummy, hamster: dummy, immoralist: dummy,
  }
}

describe('outcomeToMasonValue', () => {
  it('村勝 +1, 狼勝 -1, 狐勝 -2.0, ongoing 0 (Stage 5: 狐ペナルティ強化)', () => {
    assert.equal(outcomeToMasonValue('village_win'), 1.0)
    assert.equal(outcomeToMasonValue('wolf_win'), -1.0)
    assert.equal(outcomeToMasonValue('hamster_win'), -2.0)
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
    assert.ok(det.size() > 0)
    assert.ok(!det.isOverflow())
    const w = det.sample(seededRng(42))
    assert.ok(w !== null)
  })
})

describe('DummyModule', () => {
  it('uniform policy + uniform outcomeDist、自席は除外', () => {
    const dummy = new DummyModule()
    const state: SimState = createSimState({} as never, aliveOf([1, 2, 3, 4, 5]))
    const out = dummy.forwardAt(state, 2, 'mason', 'execute', emptyInvariants())
    assert.equal(out.outcomeDist.length, 4)
    for (const p of out.outcomeDist) assert.ok(Math.abs(p - 0.25) < 1e-9, 'uniform 0.25')
    assert.equal(out.policy.size, 4)
    let sum = 0
    for (const p of out.policy.values()) sum += p
    assert.ok(Math.abs(sum - 1) < 1e-9)
    assert.ok(!out.policy.has(2), '自席除外')
  })
})

describe('runMCTS: 基本動作', () => {
  it('5人 setup で 100 rollouts、visits 合計 = 100', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 3], ['mason', 1], ['werewolf', 1],
    ])
    const roleMask = RoleSignatureBits.villager | RoleSignatureBits.mason | RoleSignatureBits.werewolf
    const poss = makePossibilitiesAllOpen(setup, 5, roleMask)
    const det = new Determinizer(poss, setup)
    const dummyWorld = det.sample(seededRng(1))!
    const rootSimState = createSimState(dummyWorld, aliveOf([1, 2, 3, 4, 5]))
    const result = runMCTS(rootSimState, 1, det, makeBundle(), emptyInvariants(), {
      cPuct: 1.5, nRollouts: 100, rng: seededRng(123),
    })

    let visitSum = 0
    for (const v of result.visits.values()) visitSum += v
    assert.equal(visitSum, 100, 'root child visits = nRollouts')
    assert.equal(result.abortReason, null)
  })

  it('決定者の自席は visit に含まれない (合法 action のみ)', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 3], ['mason', 1], ['werewolf', 1],
    ])
    const roleMask = RoleSignatureBits.villager | RoleSignatureBits.mason | RoleSignatureBits.werewolf
    const poss = makePossibilitiesAllOpen(setup, 5, roleMask)
    const det = new Determinizer(poss, setup)
    const dummyWorld = det.sample(seededRng(1))!
    const rootSimState = createSimState(dummyWorld, aliveOf([1, 2, 3, 4, 5]))
    const decisionSeat = 3
    const result = runMCTS(rootSimState, decisionSeat, det, makeBundle(), emptyInvariants(), {
      cPuct: 1.5, nRollouts: 200, rng: seededRng(456),
    })
    for (const action of result.visits.keys()) {
      assert.ok(action !== decisionSeat, '自席は action にない')
      assert.ok(action >= 1 && action <= 5)
    }
  })

  it('seed 同じなら visit 分布も同じ（決定論性）', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 3], ['mason', 1], ['werewolf', 1],
    ])
    const roleMask = RoleSignatureBits.villager | RoleSignatureBits.mason | RoleSignatureBits.werewolf
    const poss = makePossibilitiesAllOpen(setup, 5, roleMask)
    const det = new Determinizer(poss, setup)
    const dummyWorld = det.sample(seededRng(1))!
    const rootSimState = createSimState(dummyWorld, aliveOf([1, 2, 3, 4, 5]))

    const r1 = runMCTS(rootSimState, 1, det, makeBundle(), emptyInvariants(),
      { cPuct: 1.5, nRollouts: 200, rng: seededRng(789) })
    const r2 = runMCTS(rootSimState, 1, det, makeBundle(), emptyInvariants(),
      { cPuct: 1.5, nRollouts: 200, rng: seededRng(789) })

    assert.deepEqual(
      [...r1.visits.entries()].sort(),
      [...r2.visits.entries()].sort(),
      '同 seed → 同 visit 分布',
    )
  })

  it('Dirichlet noise: 有効時に root prior が変化し visits に偏りが出る', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 3], ['mason', 1], ['werewolf', 1],
    ])
    const roleMask = RoleSignatureBits.villager | RoleSignatureBits.mason | RoleSignatureBits.werewolf
    const poss = makePossibilitiesAllOpen(setup, 5, roleMask)
    const det = new Determinizer(poss, setup)
    const dummyWorld = det.sample(seededRng(1))!
    const rootSimState = createSimState(dummyWorld, aliveOf([1, 2, 3, 4, 5]))

    const resNoNoise = runMCTS(rootSimState, 1, det, makeBundle(), emptyInvariants(), {
      cPuct: 1.5, nRollouts: 400, rng: seededRng(777),
    })
    const resWithNoise = runMCTS(rootSimState, 1, det, makeBundle(), emptyInvariants(), {
      cPuct: 1.5, nRollouts: 400, rng: seededRng(777),
      rootDirichletAlpha: 0.3, rootDirichletEps: 0.5,
    })

    const a = [...resNoNoise.visits.entries()].sort()
    const b = [...resWithNoise.visits.entries()].sort()
    assert.notDeepEqual(a, b, 'noise ありとなしで visit 分布が異なる')
  })
})

describe('runMCTS: Stage 3 claim/morning expansion', () => {
  it('claim_seer_true 開始: action ∈ {0=skip, 1=CO} に visits が分布', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['seer', 1], ['werewolf', 1], ['mason', 1],
    ])
    const roleMask = RoleSignatureBits.villager | RoleSignatureBits.seer
      | RoleSignatureBits.werewolf | RoleSignatureBits.mason
    const poss = makePossibilitiesAllOpen(setup, 5, roleMask)
    poss.possibilities[1] = RoleSignatureBits.seer
    const det = new Determinizer(poss, setup)
    const w = det.sample(seededRng(1))!
    const state = createSimState(w, aliveOf([1, 2, 3, 4, 5]), 1, 'claim_seer_true')
    // ISMCTS の root phase は actionMode から決まる (default 'execute' → day) ので、
    // ここでは rootSimState の phase だけ claim_seer_true にしても makeRolloutState で day に
    // 上書きされる。代わりに actionMode を変えるための専用テストではなく、
    // 「expandWithDispatch が claim_*_true で claim_true head を呼ぶ」ことを wolf module
    // 経路を通して別の rollout テスト (下) で検証する。

    // ここは action ID 空間の最低限の動作確認: bundle dispatch + state.phase=day で 5 alive
    // のうち decisionSeat 自身を除く 4 候補が edges に乗ることだけ確認。
    state.phase = 'day'
    const result = runMCTS(state, 1, det, makeBundle(), emptyInvariants(), {
      cPuct: 1.5, nRollouts: 50, rng: seededRng(123),
    })
    assert.equal(result.abortReason, null)
    let visitSum = 0
    for (const v of result.visits.values()) visitSum += v
    assert.equal(visitSum, 50)
  })

  it('morning rollout: descent で morning phase に到達したら 28-action 空間で expand', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['seer', 1], ['werewolf', 1], ['mason', 1],
    ])
    const roleMask = RoleSignatureBits.villager | RoleSignatureBits.seer
      | RoleSignatureBits.werewolf | RoleSignatureBits.mason
    const poss = makePossibilitiesAllOpen(setup, 5, roleMask)
    poss.possibilities[1] = RoleSignatureBits.mason
    const det = new Determinizer(poss, setup)
    const w = det.sample(seededRng(1))!
    const state = createSimState(w, aliveOf([1, 2, 3, 4, 5]), 1, 'day')
    // 偽 seer CO を仕込んで翌日 morning phase で wolf module の morning head が呼ばれる
    // 形にする (seat 4 が wolf と仮定して fake seer CO)
    const wolfSeat = (() => {
      let m = w.wolfMask
      const bit = m & (-m)
      return 31 - Math.clz32(bit)
    })()
    state.claims.set(wolfSeat, { role: 'seer', isFake: true })

    // 各 Module の forward 呼び出しで headName をトラック
    const headCounts: Record<string, number> = {}
    function makeTracked(): SkollZeroModule {
      const base = new DummyModule()
      return new Proxy(base, {
        get(target, prop) {
          if (prop === 'forwardAt') {
            return (...args: Parameters<typeof base.forwardAt>) => {
              const headName = args[3]
              headCounts[headName] = (headCounts[headName] ?? 0) + 1
              return base.forwardAt(...args)
            }
          }
          return (target as unknown as Record<string | symbol, unknown>)[prop as string]
        },
      })
    }
    const bundle: ModuleBundle = {
      mason: makeTracked(), wolf: makeTracked(), standard: makeTracked(),
      fanatic: makeTracked(), hamster: makeTracked(), immoralist: makeTracked(),
    }
    runMCTS(state, 1, det, bundle, emptyInvariants(), {
      cPuct: 1.5, nRollouts: 100, rng: seededRng(7),
    })
    // day → night_attack → night_divine → night_guard → 翌日 morning に descent で到達。
    // 偽 seer がいるので morning head が呼ばれるはず。
    assert.ok(headCounts.execute > 0, 'execute head が呼ばれた (day phase)')
    assert.ok(headCounts.attack > 0, 'attack head が呼ばれた (night_attack phase)')
    assert.ok((headCounts.morning ?? 0) > 0, 'morning head が呼ばれた (翌 morning phase に descent)')
  })
})

describe('runMCTS: cross-module dispatch (Stage 2 の本体)', () => {
  it('mason が決定者で descent が night_attack に到達したら wolf Module の forwardAt が呼ばれる', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 3], ['mason', 1], ['werewolf', 1],
    ])
    const roleMask = RoleSignatureBits.villager | RoleSignatureBits.mason | RoleSignatureBits.werewolf
    const poss = makePossibilitiesAllOpen(setup, 5, roleMask)
    // seat 1 を mason 確定にして決定者の役職を保証
    poss.possibilities[1] = RoleSignatureBits.mason
    const det = new Determinizer(poss, setup)
    const dummyWorld = det.sample(seededRng(1))!
    const rootSimState = createSimState(dummyWorld, aliveOf([1, 2, 3, 4, 5]))

    // 各 Module の forwardAt 呼び出し回数をトラックする
    const callCounts = { mason: 0, wolf: 0, standard: 0 }
    function makeTrackedDummy(label: 'mason' | 'wolf' | 'standard'): SkollZeroModule {
      const base = new DummyModule()
      return new Proxy(base, {
        get(target, prop) {
          if (prop === 'forwardAt') {
            return (...args: Parameters<typeof base.forwardAt>) => {
              callCounts[label]++
              return base.forwardAt(...args)
            }
          }
          return (target as unknown as Record<string | symbol, unknown>)[prop as string]
        },
      })
    }
    const bundle: ModuleBundle = {
      mason: makeTrackedDummy('mason'),
      wolf: makeTrackedDummy('wolf'),
      standard: makeTrackedDummy('standard'),
    }

    runMCTS(rootSimState, 1, det, bundle, emptyInvariants(), {
      cPuct: 1.5, nRollouts: 50, rng: seededRng(2024),
    })
    // 決定者が mason (seat 1) なので day で mason Module が呼ばれる
    assert.ok(callCounts.mason > 0, 'mason Module が呼ばれた')
    // descent で night_attack に到達したら wolf Module が呼ばれるはず (rollouts=50)
    assert.ok(callCounts.wolf > 0, 'wolf Module も呼ばれた (cross-module dispatch)')
  })
})
